// @vitest-environment jsdom
// The one sink (contracts §2, §13; design check F15, 1b probe): one ring entry per settlement however many times it is
// reported, window hooks that survive a second bootstrap (HMR) with one entry per error, and a sink that never throws.
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedactedText } from '../generated/contracts'
import { IpcFailure } from './ipc-failure'
import { redact } from './redact'
import { failureNoticesForTests, installFailureHooks, reportFailure, resetFailureNoticesForTests } from './report'
import { resetFrontendDiagnosticsForTests, ringEntries } from './ring'

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } }

// What ipc/transport.ts (1b-c2) does with a rejection that is not a Failure (2.1-M409): record it as `internal` with
// the command's op, its text redacted, and throw the settlement whose `.message` keeps the native text.
async function invokeLikeTheTransport(command: string, op: string): Promise<unknown> {
  try {
    return await invoke(command)
  } catch (rejection) {
    const text = String(rejection)
    const failure = new IpcFailure(
      { code: { kind: 'internal' }, user_may_retry: false, op, operation: null, detail: redact(text) as RedactedText },
      text,
    )
    reportFailure(failure, { shown: 'none' })
    throw failure
  }
}

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
    dispose = installFailureHooks(window)

    const settled = await invokeLikeTheTransport('lidar_list_library', 'library.list').catch((error: unknown) => error)

    expect(settled).toBeInstanceOf(IpcFailure)
    expect((settled as IpcFailure).message).toBe(native)
    reportFailure(settled, { shown: 'notice' })
    raiseUnhandledRejection(settled)

    const entries = ringEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'native', source: 'library.list', code: { kind: 'internal' }, surfaced: true })
    expect(JSON.stringify(entries)).not.toContain('/home/ana')
    expect(failureNoticesForTests().notices).toHaveLength(1)
  })

  it('a copy of a settlement counts as a new report', () => {
    const failure = new IpcFailure({ code: { kind: 'unavailable' }, user_may_retry: true, op: 'library.list', operation: null, detail: null }, 'closed')
    reportFailure(failure, { shown: 'none' })
    reportFailure(new IpcFailure(failure.failure, failure.message), { shown: 'none' })
    expect(ringEntries()).toHaveLength(2)
  })
})

describe('failure sink: window hooks', () => {
  beforeEach(() => {
    resetFrontendDiagnosticsForTests()
    resetFailureNoticesForTests()
  })

  it('hooks installed twice (HMR) leave one entry per error', async () => {
    const first = installFailureHooks(window)
    installFailureHooks(window)
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('drawing failed') }))
    expect(ringEntries()).toHaveLength(1)

    // A hot reload evaluates a second copy of the sink, whose install must remove the first copy's listeners.
    vi.resetModules()
    const reloaded = await import('./report')
    const reloadedRing = await import('./ring')
    const dispose = reloaded.installFailureHooks(window)
    resetFrontendDiagnosticsForTests()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('drawing failed again') }))
    expect(ringEntries()).toHaveLength(0)
    expect(reloadedRing.ringEntries()).toHaveLength(1)
    dispose()
    first()
  })

  it('an unhandled rejection reaches the ring redacted, with no notice', () => {
    const dispose = installFailureHooks(window)
    raiseUnhandledRejection(new Error('fetch https://tile.example.com/1/2/3.png?key=AIzaSECRET failed'))
    dispose()
    const [entry] = ringEntries()
    expect(entry).toMatchObject({ origin: 'frontend', source: 'window.unhandledrejection', code: { kind: 'internal' } })
    expect(JSON.stringify(ringEntries())).not.toContain('AIzaSECRET')
    expect(failureNoticesForTests().notices).toEqual([])
  })

  it('after dispose a report keeps its entry and queues no notice', () => {
    installFailureHooks(window)()
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
