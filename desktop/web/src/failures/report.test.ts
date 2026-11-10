// @vitest-environment jsdom
// The one sink (contracts §2, §13; design check F15, 1b probe): one ring entry per settlement however many times it is
// reported, window hooks that survive a second bootstrap (HMR) with one entry per error, and a sink that never throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationId, RedactedText } from '../generated/contracts'
import { invokeCommand } from '../ipc/transport'
import { IpcFailure } from './ipc-failure'
import { dismissNotice } from './notices'
import { failureLogger, failureNoticesForTests, installFailureHooks, reportFailure, resetFailureNoticesForTests } from './report'
import { resetFrontendDiagnosticsForTests, ringEntries } from './ring'

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } }

function raiseUnhandledRejection(reason: unknown): void {
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))
}

describe('failure sink: one entry per settlement', () => {
  let dispose: () => void = () => undefined

  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  afterEach(() => {
    dispose()
    delete (window as TauriWindow).__TAURI_INTERNALS__
  })

  it('a String rejection keeps its message byte for byte and leaves one entry across transport, reportFailure and unhandledrejection', async () => {
    // A native busy string as today's commands reject (2.1-M41's busy regex reads it), naming a home path.
    const native = 'Busy: the library lane is full while reading /home/ana/Secret Garden/plan.canopi: try again'
    ;(window as TauriWindow).__TAURI_INTERNALS__ = { invoke: vi.fn(() => Promise.reject(native)) }
    dispose = installFailureHooks({ storage: 'disk' }, window)

    // Through the real transport and Tauri core, only the webview's internals stubbed.
    const settled = await invokeCommand('lidar_list_library').catch((error: unknown) => error)

    expect(settled).toBeInstanceOf(IpcFailure)
    expect((settled as IpcFailure).message).toBe(native)
    reportFailure(settled, { shown: 'notice' })
    raiseUnhandledRejection(settled)

    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'native', source: 'ipc.lidar_list_library', code: { kind: 'internal' }, surfaced: true })
    expect(JSON.stringify(entries)).not.toContain('/home/ana')
    expect(failureNoticesForTests().notices).toHaveLength(1)
  })

  it('[canopi-f47t.52.36] a session logger handed a settlement the transport recorded adds no second entry', async () => {
    // A settings save failing during dispose: the transport records it, then the lifecycle logs the rethrown error.
    ;(window as TauriWindow).__TAURI_INTERNALS__ = { invoke: vi.fn(() => Promise.reject('disk full')) }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dispose = installFailureHooks({ storage: 'disk' }, window)

    const settled = await invokeCommand('set_settings').catch((error: unknown) => error)
    failureLogger('document-session')('Failed to dispose Design Session lifecycle:', settled)

    expect(ringEntries()).toEqual([expect.objectContaining({ origin: 'native', source: 'ipc.set_settings' })])
    // The logger still writes its console line in the owner's shape.
    expect(consoleError).toHaveBeenCalledWith('Failed to dispose Design Session lifecycle:', settled)
    consoleError.mockRestore()
  })

  it('a session logger handed a plain error records it once under its source', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    failureLogger('document-session')('Failed to initialize scene canvas runtime:', new Error('canvas lost'))
    expect(ringEntries()).toEqual([expect.objectContaining({ origin: 'frontend', source: 'document-session' })])
    expect(ringEntries()[0]).toHaveProperty('text', expect.stringContaining('Failed to initialize scene canvas runtime: Error: canvas lost'))
    consoleError.mockRestore()
  })

  it('a copy of a settlement counts as a new report', () => {
    const failure = new IpcFailure({ code: { kind: 'unavailable' }, user_may_retry: true, op: 'library.list', operation: null, detail: null }, 'closed')
    reportFailure(failure, { shown: 'none' })
    reportFailure(new IpcFailure(failure.failure, failure.message), { shown: 'none' })
    // Counted on the entry it repeats, so a repeat never pushes older failures out (canopi-vsey, 2.1-Q294).
    expect(ringEntries()).toEqual([expect.objectContaining({ source: 'library.list', count: 2 })])
  })

  it('[canopi-f47t.52.36] a repeat under another operation counts on its entry, which names the newest occurrence\'s operation', () => {
    // Each re-ask runs under a new OperationId, so the operation stays out of the repeat key; the entry's operation
    // follows its timestamp to the newest occurrence, the one the native log tail most likely still holds.
    const failure = (operation: string) => new IpcFailure(
      { code: { kind: 'unavailable' }, user_may_retry: true, op: 'library.list', operation: operation as OperationId, detail: null },
      'closed',
    )
    reportFailure(failure('op-1'), { shown: 'none' })
    reportFailure(failure('op-2'), { shown: 'none' })

    expect(ringEntries()).toEqual([expect.objectContaining({ source: 'library.list', count: 2, operation: 'op-2' })])
  })
})

describe('failure sink: window hooks', () => {
  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  it('hooks installed twice (HMR) leave one entry per error', async () => {
    const first = installFailureHooks({ storage: 'disk' }, window)
    installFailureHooks({ storage: 'disk' }, window)
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('drawing failed') }))
    expect(ringEntries()).toHaveLength(1)

    // A hot reload evaluates a second copy of the sink, whose install must remove the first copy's listeners.
    vi.resetModules()
    const reloaded = await import('./report')
    const reloadedRing = await import('./ring')
    const dispose = reloaded.installFailureHooks({ storage: 'disk' }, window)
    resetFrontendDiagnosticsForTests()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('drawing failed again') }))
    expect(ringEntries()).toHaveLength(0)
    expect(reloadedRing.ringEntries()).toHaveLength(1)
    dispose()
    first()
  })

  it('an unhandled rejection reaches the ring redacted, with no notice', () => {
    const dispose = installFailureHooks({ storage: 'disk' }, window)
    raiseUnhandledRejection(new Error('fetch https://tile.example.com/1/2/3.png?key=AIzaSECRET failed'))
    dispose()
    const [entry] = ringEntries()
    expect(entry).toMatchObject({ origin: 'frontend', source: 'window.unhandledrejection', code: { kind: 'internal' } })
    expect(JSON.stringify(ringEntries())).not.toContain('AIzaSECRET')
    expect(failureNoticesForTests().notices).toEqual([])
  })

  it('after dispose a report keeps its entry and queues no notice', () => {
    installFailureHooks({ storage: 'disk' }, window)()
    reportFailure(new Error('late failure'), { shown: 'notice' })
    expect(ringEntries()).toHaveLength(1)
    expect(failureNoticesForTests().notices).toEqual([])
    // A message-only event: with no listener left, an event carrying an Error would be the test runner's own failure.
    window.dispatchEvent(new ErrorEvent('error', { message: 'after dispose' }))
    expect(ringEntries()).toHaveLength(1)
  })
})

describe('failure sink: failure states', () => {
  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  it('error storm: the ring stays at 50, one notice for the first occurrence, the rest counted (2.1-Q294)', () => {
    for (let index = 0; index < 500; index += 1) {
      reportFailure(new Error(`tile ${index} failed`), { shown: 'notice', source: 'canvas.draw' })
    }
    const entries = ringEntries()
    expect(entries).toHaveLength(50)
    expect(entries.at(-1)).toMatchObject({ origin: 'frontend', text: expect.stringContaining('tile 499 failed') })
    const { notices, repeats } = failureNoticesForTests()
    expect(notices).toHaveLength(1)
    expect([...repeats.values()]).toEqual([500])
    // Another failure is its own notice.
    reportFailure(new Error('save failed'), { shown: 'notice', source: 'design.save' })
    expect(failureNoticesForTests().notices).toHaveLength(2)
  })

  it('[canopi-f47t.52.36] the same failure after its notice was dismissed queues no new notice and keeps counting, since it never recovered (2.1-Q294)', () => {
    reportFailure(new Error('save failed'), { shown: 'notice', source: 'design.save' })
    reportFailure(new Error('save failed again'), { shown: 'notice', source: 'design.save' })
    const [first] = failureNoticesForTests().notices
    dismissNotice(first!.id)
    reportFailure(new Error('save failed later'), { shown: 'notice', source: 'design.save' })
    const { notices, repeats } = failureNoticesForTests()
    expect(notices).toHaveLength(0)
    expect([...repeats.values()]).toEqual([3])
    // The user was told of this failure by its first notice.
    expect(ringEntries().at(-1)).toMatchObject({ surfaced: true })
  })

  it('multi-MB stack: the entry is capped and no secret survives at the cut', () => {
    const error = new Error('drawing failed')
    // The secret straddles the entry's 8 KiB cut, then megabytes follow.
    const frames = 'at frame (app.js:1:1)\n'.repeat(400).slice(0, 8 * 1024 - 12)
    error.stack = `${frames} {"key": "AIzaSECRET"} at /home/ana/SECRETDIR/x.js${'\n at frame'.repeat(300_000)}`
    reportFailure(error, { shown: 'none' })
    const [entry] = ringEntries()
    expect(entry?.origin === 'frontend' && entry.text.length).toBeLessThanOrEqual(8 * 1024 + 1)
    expect(JSON.stringify(entry)).not.toMatch(/SECRETDIR|AIzaSECRET/)
  })

  it('[canopi-f47t.52.36] a frames-only stack (WebKitGTK, Safari, Firefox) still records the name and message', () => {
    const error = new TypeError('the plan has no site')
    error.stack = 'drawSite@tauri://localhost/assets/index.js:12:34\nrender@tauri://localhost/assets/index.js:56:78'
    reportFailure(error, { shown: 'none' })
    const [entry] = ringEntries()
    expect(entry?.origin === 'frontend' && entry.text).toBe(`TypeError: the plan has no site\n${error.stack}`)
  })

  it('[canopi-f47t.52.36] a V8 stack that already starts with the name and message is kept as is', () => {
    const error = new Error('drawing failed')
    error.stack = 'Error: drawing failed\n    at draw (app.js:1:1)'
    reportFailure(error, { shown: 'none' })
    expect(ringEntries().map((entry) => entry.origin === 'frontend' && entry.text)).toEqual([error.stack])
  })

  it('the sink never throws: a failing stack getter or toString still leaves an entry', () => {
    const hostile = new Error('hostile')
    Object.defineProperty(hostile, 'stack', { get: () => { throw new Error('stack getter') } })
    const unprintable = { toString: () => { throw new Error('toString') } }
    expect(() => reportFailure(hostile, { shown: 'notice' })).not.toThrow()
    expect(() => reportFailure(unprintable, { shown: 'none' })).not.toThrow()
    expect(ringEntries().map((entry) => entry.origin === 'frontend' && entry.text)).toContain('Unprintable failure')
  })

  it('native RedactedText is never re-redacted', () => {
    // Text the TS redactor would change: native detail arrives redacted by canopi-redact and is kept byte for byte.
    const detail = 'stale lock under /opt/canopi/library: <home-dir>/x' as RedactedText
    reportFailure({ code: { kind: 'io', io: 'other' }, user_may_retry: true, op: 'library.list', operation: null, detail }, { shown: 'none' })
    expect(ringEntries()[0]).toMatchObject({ origin: 'native', detail })
  })
})

describe('failure sink: silent codes', () => {
  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  it('tile source failing before 2d: one redacted ring entry per occurrence, no notice and no locale key (2.1-Q300)', () => {
    for (let index = 0; index < 3; index += 1) {
      reportFailure(new Error(`AJAXError: Forbidden (403): https://tile.example.com/3/4/${index}?key=AIzaSECRET`), {
        shown: 'notice', code: { kind: 'tile_source_failed', layer: 'satellite' }, source: 'map',
      })
    }
    expect(ringEntries()).toHaveLength(3)
    // Recorded, never told: no entry counts as surfaced.
    expect(ringEntries().map((entry) => entry.surfaced)).toEqual([false, false, false])
    expect(JSON.stringify(ringEntries())).not.toContain('AIzaSECRET')
    expect(failureNoticesForTests().notices).toEqual([])
  })

  it('a told failure carries the message its edition reads', () => {
    const dispose = installFailureHooks({ storage: 'device' }, window)
    reportFailure({ code: { kind: 'io', io: 'no_space' }, user_may_retry: true, op: 'drafts.write', operation: null, detail: null }, { shown: 'notice' })
    dispose()
    expect(failureNoticesForTests().notices).toMatchObject([{ source: 'drafts.write', message: 'failure.storageFull' }])
  })
})
