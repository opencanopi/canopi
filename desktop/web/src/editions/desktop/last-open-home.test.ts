import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignSummary, Settings } from '../../generated/contracts'
import type * as DesignIpc from '../../ipc/design'
import type { CanopiFile, LoadedDesign } from '../../types/design'
import type { DesignHome } from '../../app/document-session/continuous-save'
import { closeDesign } from '../../app/document-session/actions'
import { installLaunchFile } from '../../app/document-session/launch-file'
import {
  registerDesignOpenFailurePresenter,
  type DesignOpenFailureNotice,
} from '../../app/document-session/open-failure'
import { currentDesign, designPath } from '../../app/document-session/store'
import { resetDesignSessionStateForTests } from '../../app/document-session/transition'
import { decodeSettingsRecord } from '../../app/settings/interpreter'
import {
  flushSettingsProjection,
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../../app/settings/projection'
import { lastOpenHome } from '../../app/settings/state'
import { createDesktopSettingsPlatformAdapter } from './settings'
import {
  createDesktopLastOpenHomePort,
  installDesktopLastOpenHomeWriter,
} from './last-open-home'

const ipcMocks = vi.hoisted(() => ({
  loadDesign: vi.fn<(path: string) => Promise<LoadedDesign>>(),
  loadDesignDraft: vi.fn<(id: string) => Promise<CanopiFile>>(),
}))

vi.mock('../../ipc/design', async (importOriginal) => {
  const actual = await importOriginal<typeof DesignIpc>()
  return {
    ...actual,
    loadDesign: ipcMocks.loadDesign,
    loadDesignDraft: ipcMocks.loadDesignDraft,
  }
})

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

describe('Desktop durable last_open_home boot -> reopen (2b-4 B2/B5, 2.1-Q127, 2.1-M523)', () => {
  const cleanups: Array<() => void> = []
  const presenter = vi.fn<(notice: DesignOpenFailureNotice) => void>()

  beforeEach(async () => {
    resetSettingsProjectionForTests()
    resetDesignSessionStateForTests()
    await closeDesign()
    ipcMocks.loadDesign.mockReset()
    ipcMocks.loadDesignDraft.mockReset()
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
  })

  afterEach(async () => {
    while (cleanups.length > 0) cleanups.pop()?.()
    registerDesignOpenFailurePresenter(null)
    resetDesignSessionStateForTests()
    await closeDesign()
    resetSettingsProjectionForTests()
  })

  it('persists an opened file home through Desktop settings and reopens it on relaunch without storing raw paths', async () => {
    const wire = createPersistentDesktopWireStore()
    const recentFiles: DesignSummary[] = [
      { path: '/home/alice/Orchard.canopi', name: 'Orchard', updated_at: '2026-11-25T08:00:00Z' },
    ]
    ipcMocks.loadDesign.mockResolvedValueOnce({
      file: sampleDesign('Orchard'),
      fingerprint: 'fp-1',
    })

    // Session 1: boot, open a saved file, and quit.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const sessionDesign = signal<object | null>(null)
    const sessionPath = signal<string | null>(null)
    const saveStatus = signal<string>('saved')
    let activeHome: DesignHome | null = null

    const stopWriter = installDesktopLastOpenHomeWriter({
      currentDesign: sessionDesign,
      designPath: sessionPath,
      saveStatus,
      readHome: () => activeHome,
    })
    cleanups.push(stopWriter)

    activeHome = { kind: 'file', path: '/home/alice/Orchard.canopi', fingerprint: 'fp-1' }
    sessionPath.value = '/home/alice/Orchard.canopi'
    sessionDesign.value = { name: 'Orchard' }

    await vi.waitFor(() => {
      expect(lastOpenHome.value).toMatch(/^file:[0-9a-f]{64}$/)
    })
    const persistedToken = lastOpenHome.value
    await flushSettingsProjection()

    // Raw filesystem path never reaches the persisted settings record.
    expect(wire.read().last_open_home).toBe(persistedToken)
    expect(wire.read().last_open_home).not.toContain('alice')
    expect(wire.read().last_open_home).not.toContain('Orchard.canopi')

    // Tear down Session 1 (simulated quit).
    stopWriter()
    install1.dispose()
    resetSettingsProjectionForTests()

    // Session 2 (simulated relaunch): hydrate from persisted wire store and run boot launchIntent
    // through the real actions -> transition -> state-machine -> open-failure path.
    const install2 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install2.dispose())

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
      expect(ipcMocks.loadDesign).toHaveBeenCalledWith('/home/alice/Orchard.canopi')
      expect(currentDesign.value?.name).toBe('Orchard')
    })
    expect(designPath.value).toBe('/home/alice/Orchard.canopi')
    expect(presenter).not.toHaveBeenCalled()
  })

  it('persists an opened Draft home and reopens it on relaunch, and clears on close', async () => {
    const wire = createPersistentDesktopWireStore()
    ipcMocks.loadDesignDraft.mockResolvedValueOnce(sampleDesign('Untitled'))

    // Session 1: open a Draft, verify durable write.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const sessionDesign = signal<object | null>(null)
    const sessionPath = signal<string | null>(null)
    const saveStatus = signal<string>('draft')
    let activeHome: DesignHome | null = null

    const stopWriter = installDesktopLastOpenHomeWriter({
      currentDesign: sessionDesign,
      designPath: sessionPath,
      saveStatus,
      readHome: () => activeHome,
    })
    cleanups.push(stopWriter)

    activeHome = { kind: 'draft', id: 'draft-42' }
    sessionDesign.value = { name: 'Untitled' }

    await vi.waitFor(() => expect(lastOpenHome.value).toBe('draft:draft-42'))
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBe('draft:draft-42')

    // Session 2: relaunch reopens Draft 42 through the real actions/transition path.
    stopWriter()
    install1.dispose()
    resetSettingsProjectionForTests()

    const install2 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install2.dispose())
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
      expect(ipcMocks.loadDesignDraft).toHaveBeenCalledWith('draft-42')
      expect(currentDesign.value?.name).toBe('Untitled')
    })
    expect(presenter).not.toHaveBeenCalled()

    // Now close the open Design -> writer clears last_open_home so Session 3 stays on Start screen.
    const sessionDesign2 = signal<object | null>({ name: 'Untitled' })
    const stopWriter2 = installDesktopLastOpenHomeWriter({
      currentDesign: sessionDesign2,
      designPath: signal<string | null>(null),
      saveStatus: signal<string>('draft'),
      readHome: () => (sessionDesign2.peek() ? { kind: 'draft', id: 'draft-42' } : null),
    })
    cleanups.push(stopWriter2)
    sessionDesign2.value = null

    await vi.waitFor(() => expect(lastOpenHome.value).toBeNull())
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBeNull()
  })

  it('B5 regression: unreadable or newer last_open_home file falls back silently to Start screen with zero refusal dialog', async () => {
    const failures = [
      { kind: 'unreadable', message: 'permission denied' },
      { kind: 'newer_version', message: 'version 11', field_path: '$.version' },
    ] as const

    for (const failure of failures) {
      resetSettingsProjectionForTests()
      resetDesignSessionStateForTests()
      await closeDesign()
      ipcMocks.loadDesign.mockReset()
      presenter.mockReset()

      const wire = createPersistentDesktopWireStore()
      const recentFiles: DesignSummary[] = [
        { path: '/home/alice/Broken.canopi', name: 'Broken', updated_at: '2026-11-25T08:00:00Z' },
      ]

      // Persist a valid file token first through the real writer.
      const install1 = installSettingsProjection(wire.createAdapter())
      cleanups.push(() => install1.dispose())
      await install1.ready
      const sessionDesign = signal<object | null>({ name: 'Broken' })
      const stopWriter = installDesktopLastOpenHomeWriter({
        currentDesign: sessionDesign,
        designPath: signal<string | null>('/home/alice/Broken.canopi'),
        saveStatus: signal<string>('saved'),
        readHome: () => ({ kind: 'file', path: '/home/alice/Broken.canopi', fingerprint: 'fp-broken' }),
      })
      await vi.waitFor(() => expect(lastOpenHome.value).toMatch(/^file:[0-9a-f]{64}$/))
      await flushSettingsProjection()
      stopWriter()
      install1.dispose()
      resetSettingsProjectionForTests()

      // Relaunch with IPC load failing through the REAL actions -> transition -> open-failure path.
      ipcMocks.loadDesign.mockRejectedValueOnce(failure)
      const install2 = installSettingsProjection(wire.createAdapter())
      cleanups.push(() => install2.dispose())
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
        expect(ipcMocks.loadDesign).toHaveBeenCalledWith('/home/alice/Broken.canopi')
        expect(lastOpenHome.value).toBeNull()
      })
      await flushSettingsProjection()

      expect(wire.read().last_open_home).toBeNull()
      expect(currentDesign.value).toBeNull()
      expect(presenter).not.toHaveBeenCalled()

      stopLaunch()
      install2.dispose()
    }
  })

  it('B5 regression: missing last_open_home Draft falls back silently to Start screen with zero refusal dialog', async () => {
    const wire = createPersistentDesktopWireStore({ last_open_home: 'draft:draft-gone' })
    ipcMocks.loadDesignDraft.mockRejectedValueOnce({ kind: 'missing', message: 'draft not found' })

    const install = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install.dispose())
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
      expect(ipcMocks.loadDesignDraft).toHaveBeenCalledWith('draft-gone')
      expect(lastOpenHome.value).toBeNull()
    })
    await flushSettingsProjection()

    expect(wire.read().last_open_home).toBeNull()
    expect(currentDesign.value).toBeNull()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('explicit file-argument launch still presents a refusal dialog when load fails', async () => {
    // Open an initial Draft so the subsequent explicit file launch executes immediately (not deferred).
    ipcMocks.loadDesignDraft.mockResolvedValueOnce(sampleDesign('Open'))
    const wire = createPersistentDesktopWireStore({ last_open_home: 'draft:draft-open' })
    const install = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install.dispose())

    let pending: { path: string; several: boolean } | null = null
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

    // Forward an explicit file-argument launch whose IPC load fails -> refusal MUST be presented.
    ipcMocks.loadDesign.mockRejectedValueOnce({ kind: 'unreadable', message: 'permission denied' })
    pending = { path: '/home/alice/ExplicitBroken.canopi', several: false }
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
      expect(await port.resolveFilePath?.('nonexistent')).toBeNull()
      install.dispose()
    }
  })
})
