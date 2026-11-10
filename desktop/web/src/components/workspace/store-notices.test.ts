// A root's store notices (store-notices.ts) through the real settings projection, health model, health notices and
// notice queue; a fake stands only at the settings adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSettingsProjection, resetSettingsProjectionForTests, type SettingsProjectionInstallation } from '../../app/settings/projection'
import { resetStoreHealthForTests, storeStatus, writeStoreHealth } from '../../failures/health'
import { notices, resetNoticesForTests } from '../../failures/notices'
import { resetFrontendDiagnosticsForTests } from '../../failures/ring'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { Settings } from '../../types/settings'
import { installStoreNotices } from './store-notices'

let installation: SettingsProjectionInstallation | null = null
let disposeNotices: (() => void) | null = null

/** Installs the projection over `load` and lets its bounded retry run out. */
async function installSettings(load: () => Promise<Settings>): Promise<void> {
  installation = installSettingsProjection({ load, save: async () => undefined })
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
})

afterEach(() => {
  disposeNotices?.()
  disposeNotices = null
  installation?.dispose()
  installation = null
  resetSettingsProjectionForTests()
  vi.useRealTimers()
})

describe('store notices', () => {
  it('canopi-f47t.52.36: Try again that fails again shows it is trying, then says settings still could not be read', async () => {
    disposeNotices = installStoreNotices({ report: null, updatesInAbout: false, dismissOnHost: null })
    const load = vi.fn<() => Promise<Settings>>().mockRejectedValue(new Error('locked'))
    await installSettings(load)
    const statusNotice = notices.value[0]!
    expect(statusNotice.message).toBe('health.settingsUnavailable')

    let fail!: (error: Error) => void
    load.mockImplementation(() => new Promise<Settings>((_resolve, reject) => { fail = reject }))
    statusNotice.action!.run()
    await vi.runAllTimersAsync()
    expect(statusNotice.action!.busy?.now()).toBe(true)
    fail(new Error('still locked'))
    await vi.runAllTimersAsync()

    expect(statusNotice.action!.busy?.now()).toBe(false)
    expect(notices.value.map((notice) => notice.message)).toEqual(['health.settingsStillUnavailable', 'health.settingsUnavailable'])
    expect(notices.value[0]?.kind).toBe('outcome')
    expect(storeStatus('settings')).toEqual({ kind: 'unavailable', code: { kind: 'internal' } })

    // A Try again that reads the record withdraws both.
    load.mockResolvedValue({ ...DEFAULT_SETTINGS })
    statusNotice.action!.run()
    await vi.runAllTimersAsync()
    expect(storeStatus('settings')).toEqual({ kind: 'ready' })
    expect(notices.value).toEqual([])
  })

  it('canopi-f47t.52.36: a store notice\'s Report a problem passes the store\'s origin to the root\'s report', () => {
    const report = vi.fn()
    disposeNotices = installStoreNotices({ report, updatesInAbout: false, dismissOnHost: null })
    writeStoreHealth('web_drafts', { status: { kind: 'unavailable', code: { kind: 'internal' } }, notice: null })
    notices.value[0]!.action!.run()
    expect(report).toHaveBeenCalledWith({ source: 'health.web_drafts', code: { kind: 'internal' }, operation: null, detail: 'web_drafts: unavailable' })
  })
})
