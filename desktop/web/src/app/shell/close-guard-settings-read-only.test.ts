// @vitest-environment jsdom
// Desktop settings on a newer-read-only user DB (2.1-Q320, design check R3 'Setting changed: applied per Q6, never
// written'): through the real Desktop settings adapter, IPC transport, settings projection and close guard, with only
// Tauri's invoke and the Design session stubbed. A refused save keeps the change for the session, records and logs
// nothing, and Quit, Reload or an update asks nothing about the settings; any other save failure still asks.
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../generated/settings'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  requestSaveProblemDecision: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class {} }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../document-session/transition', () => ({
  designContinuousSave: { flush: vi.fn(async () => true), conflict: signal(null) },
}))
vi.mock('../document-session/store', () => ({ currentDesign: { peek: () => null } }))
vi.mock('../document-session/save-problem', () => ({ requestSaveProblemDecision: mocks.requestSaveProblemDecision }))

const { flushBeforeExit } = await import('./close-guard')
const { installSettingsProjection, mutateSettingsProjection, resetSettingsProjectionForTests } = await import('../settings/projection')
const { createDesktopSettingsPlatformAdapter } = await import('../../editions/desktop/settings')
const { getSettingsRecord, patchSettingsRecord } = await import('../../ipc/settings')
const { resetFrontendDiagnosticsForTests, ringEntries } = await import('../../failures/ring')
const { snapToGridEnabled } = await import('../settings/state')

let dispose: () => void = () => undefined

async function installDesktopSettings(saveRejection: unknown): Promise<void> {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'get_settings_record') {
      return Promise.resolve({
        record: { version: 2, ...DEFAULT_SETTINGS, snap_to_grid: false },
        reset_fields: [],
        newer_read_only: false,
      })
    }
    if (command === 'patch_settings_record') return Promise.reject(saveRejection)
    return Promise.reject(new Error(`unexpected command ${command}`))
  })
  const installation = installSettingsProjection(
    createDesktopSettingsPlatformAdapter({ getSettingsRecord, patchSettingsRecord }),
  )
  dispose = installation.dispose
  await installation.ready
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.requestSaveProblemDecision.mockReset().mockResolvedValue('cancel')
  resetSettingsProjectionForTests()
  resetFrontendDiagnosticsForTests()
  snapToGridEnabled.value = false
})

afterEach(() => {
  dispose()
  dispose = () => undefined
  resetSettingsProjectionForTests()
  vi.restoreAllMocks()
})

describe('Desktop settings refused as read-only', () => {
  it('canopi-f47t.52.271: a settings change on a newer-read-only user DB applies for the session; closing asks nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await installDesktopSettings({
      code: { kind: 'store_read_only', store: 'settings' },
      user_may_retry: false,
      op: 'settings.patch_record',
      operation: null,
      detail: 'the settings refuse writes for this session',
    })

    mutateSettingsProjection((draft) => { draft.snapToGrid = true })
    const answers = [await flushBeforeExit('update'), await flushBeforeExit('reload'), await flushBeforeExit('update')]
    mutateSettingsProjection((draft) => { draft.theme = 'dark' })
    answers.push(await flushBeforeExit('update'))

    expect(answers).toEqual(['proceed', 'proceed', 'proceed', 'proceed'])
    expect(snapToGridEnabled.value).toBe(true)
    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled()
    expect(ringEntries()).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
    // The first refusal says the store refuses writes; later changes are never sent.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'patch_settings_record')).toHaveLength(1)
  })

  it('canopi-f47t.52.271: any other settings save failure still asks Retry, Close anyway or Cancel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await installDesktopSettings('Failed to save settings: disk I/O error')

    mutateSettingsProjection((draft) => { draft.snapToGrid = true })

    expect(await flushBeforeExit('update')).toBe('cancel')
    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledWith({ kind: 'settings-failed', designSaved: false })
  })
})
