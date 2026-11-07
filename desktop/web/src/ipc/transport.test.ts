// @vitest-environment jsdom
// The one IPC transport (contracts §2, design check F15) through the real sink, ring and redactor, with only Tauri's
// invoke stubbed: a rejected command is one ring entry however often it is reported, a String command's error reaches
// the ring as a redacted `internal` keeping its `.message` (2.1-M409), a silent row is never recorded, and only a typed
// `cancelled` code is a cancel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Failure, RedactedText } from '../generated/contracts'
import { IpcFailure, isCancelledFailure } from '../failures/ipc-failure'
import { failureNoticesForTests, installFailureHooks, reportFailure, resetFailureNoticesForTests } from '../failures/report'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../failures/ring'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }))

const { invokeCommand } = await import('./transport')

async function rejected(command: string): Promise<IpcFailure> {
  const settled = await invokeCommand(command).then(
    () => { throw new Error(`${command} resolved`) },
    (error: unknown) => error,
  )
  expect(settled).toBeInstanceOf(IpcFailure)
  return settled as IpcFailure
}

function raiseUnhandledRejection(reason: unknown): void {
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))
}

const UNAVAILABLE: Failure = {
  code: { kind: 'unavailable' },
  user_may_retry: true,
  op: 'library.list',
  operation: null,
  detail: 'the library lane is closed' as RedactedText,
}

describe('IPC transport', () => {
  let dispose: () => void = () => undefined

  beforeEach(() => {
    invoke.mockReset()
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
    dispose = installFailureHooks({ storage: 'disk' }, window)
  })

  afterEach(() => {
    dispose()
  })

  it('a command that answers resolves with its reply and records nothing', async () => {
    invoke.mockResolvedValueOnce({ rows: 3 })
    await expect(invokeCommand('get_saved_object_stamps', { limit: 3 })).resolves.toEqual({ rows: 3 })
    expect(invoke).toHaveBeenCalledWith('get_saved_object_stamps', { limit: 3 })
    expect(ringEntries()).toEqual([])
  })

  it('[1b-c2 canopi-f47t.52.36] native_untyped: a String command error naming a UNC and a home path reaches the ring redacted', async () => {
    const native = 'Failed to read \\\\nas\\gardens\\plan.canopi and /home/ana/Secret Garden/plan.canopi: permission denied'
    invoke.mockRejectedValueOnce(native)

    const settled = await rejected('load_design')

    // 2.1-M41's matchers read the text byte for byte.
    expect(settled.message).toBe(native)
    expect(settled.failure).toMatchObject({ code: { kind: 'internal' }, user_may_retry: false, op: 'ipc.load_design', operation: null })
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'native', source: 'ipc.load_design', code: { kind: 'internal' }, surfaced: false })
    const stored = JSON.stringify(entries)
    expect(stored).not.toMatch(/nas|gardens|\/home\/ana|Secret Garden/)
    expect(stored).toContain('permission denied')
  })

  it('an Error a command rejects with keeps its message as the settlement text', async () => {
    invoke.mockRejectedValueOnce(new Error('Native raster operations are busy; try again'))
    const settled = await rejected('lidar_display_descriptor')
    expect(settled.message).toBe('Native raster operations are busy; try again')
    expect(ringEntries()).toHaveLength(1)
  })

  it('a catalogue Failure keeps its code, op and native detail, recorded once', async () => {
    invoke.mockRejectedValueOnce(UNAVAILABLE)
    const settled = await rejected('lidar_list_library')
    expect(settled.failure).toBe(UNAVAILABLE)
    expect(ringEntries()).toEqual([
      expect.objectContaining({ origin: 'native', source: 'library.list', code: { kind: 'unavailable' }, detail: UNAVAILABLE.detail }),
    ])
  })

  it('a typed refusal not yet on the catalogue reaches its caller unchanged, for its surface to word', async () => {
    const refusal = { kind: 'newer_version', message: 'written by Canopi 9.0' }
    invoke.mockRejectedValueOnce(refusal)
    await expect(invokeCommand('load_design', { path: 'plan.canopi' })).rejects.toBe(refusal)
    expect(ringEntries()).toEqual([])
  })

  it('a silent row (a cancel, the refused second dialog) settles typed and is never recorded (2.1-M437)', async () => {
    invoke.mockRejectedValueOnce({ ...UNAVAILABLE, code: { kind: 'cancelled' }, op: 'updater.download', detail: null })
    invoke.mockRejectedValueOnce({ ...UNAVAILABLE, code: { kind: 'dialog_already_open' }, op: 'dialog.pick_open', detail: null })
    const cancelled = await rejected('update_download')
    const alreadyOpen = await rejected('pick_open')
    expect(isCancelledFailure(cancelled)).toBe(true)
    expect(alreadyOpen.failure.code).toEqual({ kind: 'dialog_already_open' })
    expect(ringEntries()).toEqual([])
  })

  it('[canopi-f47t.52.36] a String command refusing a second dialog settles as the silent dialog_already_open, never recorded', async () => {
    // pick_geojson_file still rejects with the refusal's kind as a plain string (desktop/src/commands/export.rs).
    invoke.mockRejectedValueOnce('dialog_already_open')
    const settled = await rejected('pick_geojson_file')
    expect(settled.failure.code).toEqual({ kind: 'dialog_already_open' })
    expect(settled.message).toBe('dialog_already_open')
    expect(ringEntries()).toEqual([])
  })

  it('same settlement reported twice: one entry, marked surfaced', async () => {
    invoke.mockRejectedValueOnce('Plant database unavailable: bundled plant database is missing')
    const settled = await rejected('search_species')
    reportFailure(settled, { shown: 'inline' })
    reportFailure(settled, { shown: 'notice' })
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.surfaced).toBe(true)
    expect(failureNoticesForTests().notices).toHaveLength(1)
  })

  it('a copied failure is a new report with its own entry (the ring matches by identity)', async () => {
    invoke.mockRejectedValueOnce(UNAVAILABLE)
    const settled = await rejected('lidar_list_library')
    reportFailure(new IpcFailure(settled.failure, settled.message), { shown: 'none' })
    expect(ringEntries()).toHaveLength(2)
  })

  it('a never-awaited rejection: the unhandledrejection hook adds no second entry', async () => {
    invoke.mockRejectedValueOnce('stale lock under /home/ana/.local/share/canopi')
    const settled = await rejected('get_settings')
    raiseUnhandledRejection(settled)
    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ source: 'ipc.get_settings' })
  })

  it('[1b-c2 canopi-f47t.52.172] canopi-f47t.52.172: an error whose text contains cancelled shows its message', async () => {
    // A real failure whose English happens to say "cancelled" is a failure to show, not a user cancel.
    invoke.mockRejectedValueOnce('The export was cancelled by the operating system: disk full')
    const settled = await rejected('export_file')
    expect(isCancelledFailure(settled)).toBe(false)
    expect(isCancelledFailure(new Error('Dialog cancelled'))).toBe(false)
    reportFailure(settled, { shown: 'notice' })
    expect(failureNoticesForTests().notices).toMatchObject([{ source: 'ipc.export_file', message: 'failure.internal' }])
  })
})
