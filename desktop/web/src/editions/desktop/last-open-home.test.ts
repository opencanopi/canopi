import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignSummary, Settings } from '../../generated/contracts'
import type { CanopiFile } from '../../types/design'
import { createInMemoryDesignHomeStore } from '../../__tests__/support/session-core-fixture'
import {
  createJsonSessionCodec,
  createSessionCore,
  installLiveSessionCore,
  type SessionCore,
} from '../../app/document-session/live-core'
import { closeDesign } from '../../app/document-session/actions'
import { installLaunchFile } from '../../app/document-session/launch-file'
import {
  registerDesignOpenFailurePresenter,
  type DesignOpenFailureNotice,
} from '../../app/document-session/open-failure'
import { currentDesign, designPath } from '../../app/document-session/store'
import { decodeSettingsRecord } from '../../app/settings/interpreter'
import {
  flushSettingsProjection,
  installSettingsProjection,
  mutateSettingsProjection,
  resetSettingsProjectionForTests,
} from '../../app/settings/projection'
import { lastOpenHome } from '../../app/settings/state'
import { decodeLastOpenHome, type DesignHome, type DraftId } from '../../platform/design-home'
import { createDesktopSettingsPlatformAdapter } from './settings'
import {
  createDesktopLastOpenHomePort,
  encodeDesktopLastOpenHome,
} from './last-open-home'

function sampleDesign(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plants: [],
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-11-25T08:00:00Z',
    updated_at: '2026-11-25T08:00:00Z',
    extra: {},
  }
}

function createPersistentDesktopWireStore(initial: Partial<Settings> = {}) {
  const defaults = decodeSettingsRecord(null).values
  let stored: Record<string, unknown> = {
    version: 2,
    ...defaults,
    ...initial,
  }
  return {
    read: () => stored as unknown as Settings,
    createAdapter: () =>
      createDesktopSettingsPlatformAdapter({
        getSettingsRecord: async () => ({
          record: { ...stored },
          reset_fields: [],
          newer_read_only: false,
        }),
        patchSettingsRecord: async (patch) => {
          stored = { ...stored, ...patch, version: 2 }
        },
        env: () => ({ languages: ['en-GB'], region: 'GB' }),
      }),
  }
}

function installDesktopSessionCore(
  home: ReturnType<typeof createInMemoryDesignHomeStore>,
): { core: SessionCore; dispose: () => void } {
  const core = createSessionCore({
    designHome: home,
    fileAccess: {
      pickOpen: async () => ({ kind: 'cancelled' }),
      pickHomeTarget: async () => ({ kind: 'cancelled' }),
    },
    lifecycle: { subscribe: () => () => {} },
    codec: createJsonSessionCodec(),
    settings: {
      async readLastOpenHome() {
        return decodeLastOpenHome(lastOpenHome.peek())
      },
      async writeLastOpenHome(next: DesignHome | null) {
        const token = await encodeDesktopLastOpenHome(next)
        mutateSettingsProjection((draft) => {
          draft.lastOpenHome = token
        })
      },
      flushSettings: flushSettingsProjection,
    },
    newDesignFactory: () => sampleDesign('Untitled'),
  })
  const dispose = installLiveSessionCore(core)
  return { core, dispose }
}

describe('Desktop durable last_open_home boot -> reopen (2b-4 B2/B5, 2.1-Q127, 2.1-M523)', () => {
  const cleanups: Array<() => void> = []
  const presenter = vi.fn<(notice: DesignOpenFailureNotice) => void>()

  beforeEach(() => {
    resetSettingsProjectionForTests()
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
  })

  afterEach(async () => {
    while (cleanups.length > 0) cleanups.pop()?.()
    registerDesignOpenFailurePresenter(null)
    await closeDesign()
    resetSettingsProjectionForTests()
  })

  it('persists an opened file home through Desktop settings and reopens it on relaunch without storing raw paths', async () => {
    const wire = createPersistentDesktopWireStore()
    const home = createInMemoryDesignHomeStore()
    const recentId = 'a'.repeat(64)
    home.seedFile('grant:orchard', sampleDesign('Orchard'), 'v-1')
    const recentFiles: DesignSummary[] = [
      {
        path: '/home/alice/Orchard.canopi',
        name: 'Orchard',
        updated_at: '2026-11-25T08:00:00Z',
        grant: 'grant:orchard',
        recent_id: recentId,
      },
    ]

    // Session 1: boot, open a saved file through SessionCore, and quit.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const s1 = installDesktopSessionCore(home)
    cleanups.push(s1.dispose)

    const opened = await s1.core.openFrom({
      kind: 'file',
      grant: 'grant:orchard',
      displayName: 'Orchard.canopi',
      recentId,
    })
    expect(opened.status).toBe('opened')
    expect(lastOpenHome.value).toBe(`file:${recentId}`)
    const persistedToken = lastOpenHome.value
    await flushSettingsProjection()

    // Raw filesystem path never reaches the persisted settings record.
    expect(wire.read().last_open_home).toBe(persistedToken)
    expect(wire.read().last_open_home).not.toContain('alice')
    expect(wire.read().last_open_home).not.toContain('Orchard.canopi')

    // Tear down Session 1 (simulated quit).
    s1.dispose()
    install1.dispose()
    resetSettingsProjectionForTests()

    // Session 2 (simulated relaunch): hydrate from persisted wire store and run boot launchIntent.
    const install2 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install2.dispose())
    const s2 = installDesktopSessionCore(home)
    cleanups.push(s2.dispose)

    const stopLaunch = installLaunchFile({
      take: async () => null,
      subscribe: () => () => undefined,
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: install2.ready,
        getRecentFiles: async () => recentFiles,
        grantForRecent: async (id) => (id === recentId
          ? { grant: 'grant:orchard', display_name: 'Orchard.canopi', recent_id: recentId }
          : null),
      }),
    })
    cleanups.push(stopLaunch)

    await vi.waitFor(() => {
      expect(currentDesign.value?.name).toBe('Orchard')
    })
    expect(designPath.value).toBe('grant:orchard')
    expect(s2.core.currentDesign.value?.home).toMatchObject({
      kind: 'file',
      key: 'grant:orchard',
      displayName: 'Orchard.canopi',
      recentId,
    })
    expect(presenter).not.toHaveBeenCalled()
  })

  it('persists an opened Draft home and reopens it on relaunch, and clears on close', async () => {
    const wire = createPersistentDesktopWireStore()
    const home = createInMemoryDesignHomeStore()
    home.seedFile('draft-42', sampleDesign('Untitled'), 'v-draft-42')

    // Session 1: open a Draft, verify durable write.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const s1 = installDesktopSessionCore(home)
    cleanups.push(s1.dispose)

    await s1.core.openFrom({ kind: 'draft', id: 'draft-42' as DraftId })
    expect(lastOpenHome.value).toBe('draft:draft-42')
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBe('draft:draft-42')

    // Session 2: relaunch reopens Draft 42.
    s1.dispose()
    install1.dispose()
    resetSettingsProjectionForTests()

    const install2 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install2.dispose())
    const s2 = installDesktopSessionCore(home)
    cleanups.push(s2.dispose)

    const stopLaunch2 = installLaunchFile({
      take: async () => null,
      subscribe: () => () => undefined,
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: install2.ready,
        getRecentFiles: async () => [],
      }),
    })
    cleanups.push(stopLaunch2)

    await vi.waitFor(() => {
      expect(currentDesign.value?.name).toBe('Untitled')
    })
    expect(presenter).not.toHaveBeenCalled()

    // Close the open Design -> SessionCore clears last_open_home so Session 3 stays on Start screen.
    await s2.core.close('close')
    expect(lastOpenHome.value).toBeNull()
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBeNull()
  })

  it('B5 regression: unreadable or missing last_open_home file falls back silently to Start screen with zero refusal dialog', async () => {
    const wire = createPersistentDesktopWireStore()
    const recentFiles: DesignSummary[] = [
      { path: '/home/alice/Broken.canopi', name: 'Broken', updated_at: '2026-11-25T08:00:00Z' },
    ]

    // Persist a valid file token first using encodeDesktopLastOpenHome.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready
    const token = await encodeDesktopLastOpenHome({
      kind: 'file',
      key: '/home/alice/Broken.canopi',
      displayName: 'Broken.canopi',
      version: 'v-1',
    })
    mutateSettingsProjection((draft) => { draft.lastOpenHome = token })
    await flushSettingsProjection()
    install1.dispose()
    resetSettingsProjectionForTests()

    // Relaunch with file absent/unreadable in DesignHomeStore.
    const emptyHome = createInMemoryDesignHomeStore()
    const install2 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install2.dispose())
    const s2 = installDesktopSessionCore(emptyHome)
    cleanups.push(s2.dispose)

    const stopLaunch = installLaunchFile({
      take: async () => null,
      subscribe: () => () => undefined,
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: install2.ready,
        getRecentFiles: async () => recentFiles,
      }),
    })
    cleanups.push(stopLaunch)

    await vi.waitFor(() => {
      expect(lastOpenHome.value).toBeNull()
    })
    await flushSettingsProjection()

    expect(wire.read().last_open_home).toBeNull()
    expect(currentDesign.value).toBeNull()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('B5 regression: missing last_open_home Draft falls back silently to Start screen with zero refusal dialog', async () => {
    const wire = createPersistentDesktopWireStore({ last_open_home: 'draft:draft-gone' })
    const home = createInMemoryDesignHomeStore()

    const install = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install.dispose())
    const session = installDesktopSessionCore(home)
    cleanups.push(session.dispose)

    const stopLaunch = installLaunchFile({
      take: async () => null,
      subscribe: () => () => undefined,
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: install.ready,
        getRecentFiles: async () => [],
      }),
    })
    cleanups.push(stopLaunch)

    await vi.waitFor(() => {
      expect(lastOpenHome.value).toBeNull()
    })
    await flushSettingsProjection()

    expect(wire.read().last_open_home).toBeNull()
    expect(currentDesign.value).toBeNull()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('explicit file-argument launch still presents a refusal dialog when load fails', async () => {
    const home = createInMemoryDesignHomeStore()
    home.seedFile('draft-open', sampleDesign('Open'), 'v-open')
    const wire = createPersistentDesktopWireStore({ last_open_home: 'draft:draft-open' })
    const install = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install.dispose())
    const session = installDesktopSessionCore(home)
    cleanups.push(session.dispose)

    let pending: { path: string; several: boolean; grant?: string; display_name?: string } | null = null
    const notify: { fn: (() => void) | null } = { fn: null }
    const stopLaunch = installLaunchFile({
      take: async () => {
        const next = pending
        pending = null
        return next
      },
      subscribe: (cb) => {
        notify.fn = cb
        return () => {
          notify.fn = null
        }
      },
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: install.ready,
        getRecentFiles: async () => [],
      }),
    })
    cleanups.push(stopLaunch)

    await vi.waitFor(() => expect(currentDesign.value?.name).toBe('Open'))
    expect(presenter).not.toHaveBeenCalled()

    // Forward an explicit file-argument launch whose load fails -> refusal MUST be presented.
    pending = {
      path: '/home/alice/ExplicitBroken.canopi',
      several: false,
      grant: 'grant:explicit-broken',
      display_name: 'ExplicitBroken.canopi',
    }
    notify.fn?.()

    await vi.waitFor(() => expect(presenter).toHaveBeenCalledTimes(1))
    expect(presenter.mock.calls[0]?.[0]).toMatchObject({ tone: 'error', title: 'start.cantOpenTitle' })
  })

  it('treats malformed persisted last_open_home values and missing recent entries as absent', async () => {
    for (const raw of ['draft:   ', 'unknown:123', null]) {
      resetSettingsProjectionForTests()
      const wire = createPersistentDesktopWireStore({ last_open_home: raw })
      const install = installSettingsProjection(wire.createAdapter())
      cleanups.push(() => install.dispose())
      const port = createDesktopLastOpenHomePort({
        settingsReady: install.ready,
        getRecentFiles: async () => [],
      })
      expect(await port.read()).toBeNull()
      expect(await port.resolveFileHome('nonexistent')).toBeNull()
      install.dispose()
    }
  })

  it('encodeDesktopLastOpenHome encodes draft, file (hashed), and null homes', async () => {
    expect(await encodeDesktopLastOpenHome(null)).toBeNull()
    expect(await encodeDesktopLastOpenHome({ kind: 'draft', key: 'd-9' as DraftId, version: null })).toBe('draft:d-9')
    const recentId = 'b'.repeat(64)
    const fileToken = await encodeDesktopLastOpenHome({
      kind: 'file',
      key: 'grant:7',
      displayName: 'Garden.canopi',
      recentId,
      version: 'v-1',
    })
    expect(fileToken).toBe(`file:${recentId}`)
    expect(fileToken).not.toContain('alice')
    expect(await encodeDesktopLastOpenHome({
      kind: 'file',
      key: 'grant:7',
      displayName: 'Garden.canopi',
      version: 'v-1',
    })).toBeNull()
  })
})
