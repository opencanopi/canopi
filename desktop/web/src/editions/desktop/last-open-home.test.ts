import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignSummary, Settings } from '../../generated/contracts'
import type { DesignHome } from '../../app/document-session/continuous-save'
import { installLaunchFile } from '../../app/document-session/launch-file'
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

const openDesignFromPath = vi.hoisted(() => vi.fn(async (_path: string): Promise<void> => undefined))
const openDesignDraft = vi.hoisted(() => vi.fn(async (_id: string): Promise<void> => undefined))
const presentDesignOpenFailure = vi.hoisted(() => vi.fn((_error: unknown): void => undefined))

vi.mock('../../app/document-session/actions', () => ({ openDesignFromPath, openDesignDraft }))
vi.mock('../../app/document-session/open-failure', () => ({ presentDesignOpenFailure }))

function createPersistentDesktopWireStore(initial: Partial<Settings> = {}) {
  const defaults = decodeSettingsRecord(null).values
  let stored: Settings = {
    ...(defaults as unknown as Settings),
    ...initial,
  }
  return {
    read: () => stored,
    createAdapter: () =>
      createDesktopSettingsPlatformAdapter({
        getSettings: async () => ({ ...stored }),
        setSettings: async (next) => {
          stored = { ...next }
        },
        env: () => ({ languages: ['en-GB'], region: 'GB' }),
      }),
  }
}

describe('Desktop durable last_open_home boot -> reopen (2b-4 B2, 2.1-Q127, 2.1-M523)', () => {
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    resetSettingsProjectionForTests()
    openDesignFromPath.mockReset().mockResolvedValue(undefined)
    openDesignDraft.mockReset().mockResolvedValue(undefined)
    presentDesignOpenFailure.mockReset()
  })

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
    resetSettingsProjectionForTests()
  })

  it('persists an opened file home through Desktop settings and reopens it on relaunch without storing raw paths', async () => {
    const wire = createPersistentDesktopWireStore()
    const recentFiles: DesignSummary[] = [
      { path: '/home/alice/Orchard.canopi', name: 'Orchard', updated_at: '2026-11-25T08:00:00Z' },
    ]

    // Session 1: boot, open a saved file, and quit.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const currentDesign = signal<object | null>(null)
    const designPath = signal<string | null>(null)
    const saveStatus = signal<string>('saved')
    let activeHome: DesignHome | null = null

    const stopWriter = installDesktopLastOpenHomeWriter({
      currentDesign,
      designPath,
      saveStatus,
      readHome: () => activeHome,
    })
    cleanups.push(stopWriter)

    activeHome = { kind: 'file', path: '/home/alice/Orchard.canopi', fingerprint: 'abc' }
    designPath.value = '/home/alice/Orchard.canopi'
    currentDesign.value = { name: 'Orchard' }

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
    expect(lastOpenHome.value).toBe(persistedToken)

    // Session 2 (simulated relaunch): hydrate from persisted wire store and run boot launchIntent.
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
      expect(openDesignFromPath).toHaveBeenCalledWith('/home/alice/Orchard.canopi')
    })
    expect(openDesignDraft).not.toHaveBeenCalled()
  })

  it('persists an opened Draft home and reopens it on relaunch, and clears on close', async () => {
    const wire = createPersistentDesktopWireStore()

    // Session 1: open a Draft, verify durable write.
    const install1 = installSettingsProjection(wire.createAdapter())
    cleanups.push(() => install1.dispose())
    await install1.ready

    const currentDesign = signal<object | null>(null)
    const designPath = signal<string | null>(null)
    const saveStatus = signal<string>('draft')
    let activeHome: DesignHome | null = null

    const stopWriter = installDesktopLastOpenHomeWriter({
      currentDesign,
      designPath,
      saveStatus,
      readHome: () => activeHome,
    })
    cleanups.push(stopWriter)

    activeHome = { kind: 'draft', id: 'draft-42' }
    currentDesign.value = { name: 'Untitled' }

    await vi.waitFor(() => expect(lastOpenHome.value).toBe('draft:draft-42'))
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBe('draft:draft-42')

    // Session 2: relaunch reopens Draft 42.
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

    await vi.waitFor(() => expect(openDesignDraft).toHaveBeenCalledWith('draft-42'))

    // Now close the open Design -> writer clears last_open_home so Session 3 stays on Start screen.
    const currentDesign2 = signal<object | null>({ name: 'Untitled' })
    const stopWriter2 = installDesktopLastOpenHomeWriter({
      currentDesign: currentDesign2,
      designPath: signal<string | null>(null),
      saveStatus: signal<string>('draft'),
      readHome: () => (currentDesign2.peek() ? { kind: 'draft', id: 'draft-42' } : null),
    })
    cleanups.push(stopWriter2)
    currentDesign2.value = null

    await vi.waitFor(() => expect(lastOpenHome.value).toBeNull())
    await flushSettingsProjection()
    expect(wire.read().last_open_home).toBeNull()
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
