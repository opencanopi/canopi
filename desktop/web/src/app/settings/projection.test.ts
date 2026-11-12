// SET-05 (canopi-f47t.52.40, 2.1-Q67, 2.1-Q295): a settings record that cannot be read is retried a bounded number of
// times, then settings are unavailable for the session: defaults apply, every change stays in memory, the record is
// never written, and the health model says so once. On Web through the real browser adapter and record store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStoreHealthForTests, storeStatus } from '../../failures/health'
import { installHealthNotices } from '../../failures/health-notices'
import { notices, resetNoticesForTests } from '../../failures/notices'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../../failures/ring'
import { createBrowserSettingsPlatformAdapter } from '../../platform/settings.browser'
import type { Settings } from '../../types/settings'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../../web/browser-app-data'
import { snapToGridEnabled } from '../canvas-settings/signals'
import {
  flushSettingsProjection,
  installSettingsProjection,
  mutateSettingsProjection,
  resetSettingsProjectionForTests,
  retrySettingsLoad,
  type SettingsProjectionInstallation,
} from './projection'
import { scrollWheel, theme } from './state'

const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'

function memoryStorage(initial: Record<string, string> = {}): BrowserStorageAdapter & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value) },
    removeItem: (key) => { items.delete(key) },
  }
}

function storedSettings(overrides: Partial<Settings> = {}): Record<string, unknown> {
  return { theme: 'dark', snap_to_grid: true, ...overrides }
}

let installation: SettingsProjectionInstallation | null = null

/** Installs the projection and lets its bounded retry run out. */
async function install(load: () => Settings | Promise<Settings>, save: (settings: Settings) => Promise<void>) {
  installation = installSettingsProjection({ load, save })
  const ready = installation.ready.catch(() => undefined)
  await vi.runAllTimersAsync()
  await ready
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSettingsProjectionForTests()
  resetStoreHealthForTests()
  resetNoticesForTests()
  resetFrontendDiagnosticsForTests()
  theme.value = 'light'
  snapToGridEnabled.value = false
})

afterEach(() => {
  installation?.dispose()
  installation = null
  resetSettingsProjectionForTests()
  vi.useRealTimers()
})

describe('settings projection load failures', () => {
  it('[canopi-f47t.52.40] SET-05: a transient load failure never overwrites the stored record', async () => {
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(() => { throw new Error('database is locked') }, save)

    // The stored record could not be read: the session's change stays in the session, never written over it.
    mutateSettingsProjection((draft) => { draft.snapToGrid = !draft.snapToGrid })
    await flushSettingsProjection().catch(() => undefined)

    expect(snapToGridEnabled.value).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('[canopi-f47t.52.40] settings busy at start are read again, then unavailable with defaults, never written', async () => {
    const load = vi.fn(async (): Promise<Settings> => { throw new Error('Native user data operations are busy; try again') })
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(load, save)

    expect(load).toHaveBeenCalledTimes(3)
    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'internal' } })
    expect(theme.value).toBe('light')
    expect(save).not.toHaveBeenCalled()
    // The failure reached the sink once, under its source.
    expect(ringEntries().filter((entry) => entry.source === 'settings.load')).toHaveLength(1)
  })

  it('[canopi-f47t.52.40] a busy store that answers on a retry is read, ready and written as usual', async () => {
    const load = vi.fn<() => Promise<Settings>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(storedSettingsAsSettings())
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(load, save)

    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(theme.value).toBe('dark')
    mutateSettingsProjection((draft) => { draft.theme = 'light' })
    await flushSettingsProjection()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }))
  })

  it('[canopi-f47t.52.40] a change after settings degrade stays in memory, with the one notice and no second', async () => {
    const dispose = installHealthNotices({ report: null, update: null })
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(() => Promise.reject(new Error('locked')), save)

    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    mutateSettingsProjection((draft) => { draft.snapToGrid = true }, { persist: 'queued' })
    await vi.runAllTimersAsync()

    expect(theme.value).toBe('dark')
    expect(save).not.toHaveBeenCalled()
    expect(notices.value.map((notice) => notice.message)).toEqual(['health.settingsUnavailable'])
    dispose()
  })

  it('[canopi-f47t.52.40] Try again reads the record, applies the session\'s changes over it and saves them', async () => {
    const load = vi.fn<() => Promise<Settings>>().mockRejectedValue(new Error('locked'))
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(load, save)
    mutateSettingsProjection((draft) => { draft.snapToGrid = true })

    load.mockResolvedValue(storedSettingsAsSettings({ snap_to_grid: false }))
    await retrySettingsLoad()

    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(theme.value).toBe('dark')
    expect(snapToGridEnabled.value).toBe(true)
    await flushSettingsProjection()
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark', snap_to_grid: true }))
  })

  it('[canopi-f47t.52.40] Try again pressed twice during a slow read reads once and keeps the session\'s change', async () => {
    const load = vi.fn<() => Promise<Settings>>().mockRejectedValue(new Error('busy'))
    const save = vi.fn(async (_settings: Settings) => undefined)
    await install(load, save)
    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    const readsBefore = load.mock.calls.length

    const answers: Array<(settings: Settings) => void> = []
    load.mockImplementation(() => new Promise<Settings>((resolve) => { answers.push(resolve) }))
    const first = retrySettingsLoad()
    const second = retrySettingsLoad()
    await vi.runAllTimersAsync()
    for (const answer of answers) {
      answer(storedSettingsAsSettings({ theme: 'light' }))
      await vi.runAllTimersAsync()
    }
    await Promise.all([first, second])
    await flushSettingsProjection()

    expect(load).toHaveBeenCalledTimes(readsBefore + 1)
    expect(theme.value).toBe('dark')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('[canopi-f47t.52.36] Try again pressed during the first settings read joins it instead of starting a second read', async () => {
    const answers: Array<(settings: Settings) => void> = []
    const load = vi.fn(() => new Promise<Settings>((resolve) => { answers.push(resolve) }))
    const save = vi.fn(async (_settings: Settings) => undefined)
    installation = installSettingsProjection({ load, save })

    const pressed = retrySettingsLoad()
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledTimes(1)
    for (const answer of answers) answer(storedSettingsAsSettings({ theme: 'light' }))
    await Promise.all([pressed, installation.ready])

    expect(load).toHaveBeenCalledTimes(1)
    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(theme.value).toBe('light')
  })

  it('[canopi-f47t.52.40] a projection retired mid-load (HMR) writes nothing when its load settles', async () => {
    let fail!: (error: Error) => void
    const save = vi.fn(async (_settings: Settings) => undefined)
    installation = installSettingsProjection({ load: () => new Promise<Settings>((_resolve, reject) => { fail = reject }), save })
    const retired = installation
    retired.dispose()
    installation = null
    fail(new Error('locked'))
    await retired.ready.catch(() => undefined)
    await vi.runAllTimersAsync()

    expect(storeStatus('settings')).toEqual({ kind: 'opening' })
    expect(ringEntries()).toHaveLength(0)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('Web settings load failures', () => {
  it('[canopi-f47t.52.40] a malformed Web settings record is byte-identical after the session', async () => {
    const malformed = '{"version":3,"settings":["not", "a", "record"]'
    const storage = memoryStorage({ [SETTINGS_KEY]: malformed })
    const adapter = createBrowserSettingsPlatformAdapter(createBrowserAppDataStore({ storage, session: memoryStorage() }))
    await install(adapter.load, adapter.save)

    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    await flushSettingsProjection().catch(() => undefined)
    installation?.dispose()
    installation = null
    await vi.runAllTimersAsync()

    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'invalid' } })
    expect(storage.items.get(SETTINGS_KEY)).toBe(malformed)
  })

  it('[canopi-f47t.52.40] localStorage refusing access (SecurityError) makes settings unavailable on Web', async () => {
    const refusing: BrowserStorageAdapter = {
      getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
      setItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
      removeItem: () => undefined,
    }
    const adapter = createBrowserSettingsPlatformAdapter(createBrowserAppDataStore({ storage: refusing, session: memoryStorage() }))
    const save = vi.spyOn(adapter, 'save')
    await install(adapter.load, adapter.save)

    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'io', io: 'permission_denied' } })
    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    await flushSettingsProjection().catch(() => undefined)
    expect(save).not.toHaveBeenCalled()
  })

  it('[canopi-f47t.52.40] a readable Web record loads and is ready', async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ version: 3, settings: storedSettings() }) })
    const adapter = createBrowserSettingsPlatformAdapter(createBrowserAppDataStore({ storage, session: memoryStorage() }))
    await install(adapter.load, adapter.save)
    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(theme.value).toBe('dark')
  })
})

// 2.1-Q309, 2.1-M473: settings that cannot be read run on the platform's first-run default (Trackpad on a Mac) in memory,
// writing nothing; a choice the session made, or a record read later, keeps its own.
describe('unreadable settings on the platform\'s first-run default (canopi-pqxl)', () => {
  const trackpad = (): Partial<Settings> => ({ scroll_wheel: 'pan' })

  beforeEach(() => { scrollWheel.value = 'zoom' })

  async function installFailing(load: () => Settings | Promise<Settings>, save: (settings: Settings) => Promise<void>) {
    installation = installSettingsProjection({ load, save, firstRunSettings: trackpad })
    const ready = installation.ready.catch(() => undefined)
    await vi.runAllTimersAsync()
    await ready
  }

  it('U canopi-pqxl: settings that cannot be read start on the platform\'s first-run default and write nothing', async () => {
    const save = vi.fn(async (_settings: Settings) => undefined)
    await installFailing(() => Promise.reject(new Error('locked')), save)

    expect(storeStatus('settings')).toMatchObject({ kind: 'unavailable' })
    expect(scrollWheel.value).toBe('pan')
    await flushSettingsProjection().catch(() => undefined)
    expect(save).not.toHaveBeenCalled()
  })

  it('U canopi-pqxl: a choice made while the first read is pending stays over the first-run default', async () => {
    let fail!: (error: Error) => void
    const load = vi.fn<() => Promise<Settings>>()
      .mockImplementationOnce(() => new Promise<Settings>((_resolve, reject) => { fail = reject }))
      .mockRejectedValue(new Error('locked'))
    installation = installSettingsProjection({ load, save: async () => undefined, firstRunSettings: trackpad })
    const ready = installation.ready.catch(() => undefined)

    mutateSettingsProjection((draft) => { draft.scrollWheel = 'pan' })
    mutateSettingsProjection((draft) => { draft.scrollWheel = 'zoom' })
    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    fail(new Error('locked'))
    await vi.runAllTimersAsync()
    await ready

    expect(storeStatus('settings')).toMatchObject({ kind: 'unavailable' })
    expect(theme.value).toBe('dark')
    expect(scrollWheel.value).toBe('zoom')
  })

  it('U canopi-pqxl: Try again reading a stored Mouse choice replaces the first-run default', async () => {
    const load = vi.fn<() => Promise<Settings>>().mockRejectedValue(new Error('locked'))
    await installFailing(load, async () => undefined)
    expect(scrollWheel.value).toBe('pan')

    load.mockResolvedValue(storedSettingsAsSettings({ scroll_wheel: 'zoom' }))
    await retrySettingsLoad()

    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(scrollWheel.value).toBe('zoom')
  })

  it('U canopi-pqxl: a platform with no first-run default keeps the host-independent defaults', async () => {
    await install(() => Promise.reject(new Error('locked')), async () => undefined)
    expect(scrollWheel.value).toBe('zoom')
  })
})

function storedSettingsAsSettings(overrides: Partial<Settings> = {}): Settings {
  const adapter = createBrowserSettingsPlatformAdapter({
    loadSettings: () => storedSettings(overrides),
    saveSettings: (settings) => ({ ok: true, value: settings }),
  })
  return adapter.load() as Settings
}
