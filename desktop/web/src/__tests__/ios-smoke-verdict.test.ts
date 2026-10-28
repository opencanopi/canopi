// The iOS smoke passes with an ENV warning only when the simulator's GPU process provably crashed and the app handled
// it as a user would see it (F5 probe 8, run 40600121577): every other page error stays APP, and a missing map notice
// or a log without the crash fails the smoke.
import { describe, expect, it } from 'vitest'
import { pageFailureVerdict, type DesignShell } from '../../e2e/platform/phones/ios/simulator-verdict'

const CONTEXT_LOSS = 'console.error: Shared workspace map failed: Error: MapLibre WebGL context was lost while preparing the shared workspace.'

/** Probe 8's simulator log around the crash (iPad mini), trimmed to the lines that tell the story. */
const PROBE_8_LOG = [
  '2026-10-27 23:24:40.401 E  com.apple.WebKit.GPU[20085:ffca] IOSurfaceQueryTransactionList got non-success return from kernel',
  '2026-10-27 23:24:45.687 E  com.apple.WebKit.GPU[20085:ffca] (MTLSimDriver) Connection to SimMetalHost (version=L10/R10, profile=6) XPC service (PID=15497) was lost: XPC_ERROR_CONNECTION_INTERRUPTED',
  '2026-10-27 23:24:45.795 E  MobileSafari[20075:f122] [com.apple.WebKit:Process] 0x1141381e0 - GPUProcessProxy::gpuProcessExited: reason=Crash',
].join('\n')

const SHELL: DesignShell = { startScreenGone: true, workspace: true, toolStrip: true, layout: true, mapNoticeRetry: true }

describe('pageFailureVerdict', () => {
  it('is ENV when the log shows the GPU crash, the only error is the context loss and the shell shows the notice', () => {
    const verdict = pageFailureVerdict([CONTEXT_LOSS], PROBE_8_LOG, SHELL)
    expect(verdict.kind).toBe('ENV')
    expect(verdict.reason).toContain('SimMetalHost')
  })

  it('takes either crash line alone as the proof', () => {
    const [, metal, exited] = PROBE_8_LOG.split('\n')
    expect(pageFailureVerdict([CONTEXT_LOSS], metal ?? '', SHELL).kind).toBe('ENV')
    expect(pageFailureVerdict([CONTEXT_LOSS], exited ?? '', SHELL).kind).toBe('ENV')
  })

  it('is APP when the page raised any other error besides the context loss', () => {
    const verdict = pageFailureVerdict([CONTEXT_LOSS, 'console.error: failure handling failed: TypeError: this.style.removeLayer'], PROBE_8_LOG, SHELL)
    expect(verdict.kind).toBe('APP')
    expect(verdict.reason).toContain('failure handling failed')
  })

  it('is APP for an unhandled rejection or a page error alone, crash or not', () => {
    expect(pageFailureVerdict(['unhandled rejection: TypeError: x is undefined'], PROBE_8_LOG, SHELL).kind).toBe('APP')
    expect(pageFailureVerdict(['page error: Script error.'], PROBE_8_LOG, SHELL).kind).toBe('APP')
  })

  it('is APP when the simulator log lacks the GPU crash, even with the notice shown', () => {
    const verdict = pageFailureVerdict([CONTEXT_LOSS], PROBE_8_LOG.split('\n')[0] ?? '', SHELL)
    expect(verdict.kind).toBe('APP')
    expect(verdict.reason).toContain('simulator log')
    expect(pageFailureVerdict([CONTEXT_LOSS], '', SHELL).kind).toBe('APP')
  })

  it('is APP when the map notice with Retry is missing', () => {
    const verdict = pageFailureVerdict([CONTEXT_LOSS], PROBE_8_LOG, { ...SHELL, mapNoticeRetry: false })
    expect(verdict.kind).toBe('APP')
    expect(verdict.reason).toContain('map notice')
  })

  it('is APP when any part of the Design shell is missing', () => {
    for (const part of ['startScreenGone', 'workspace', 'toolStrip', 'layout'] as const) {
      const verdict = pageFailureVerdict([CONTEXT_LOSS], PROBE_8_LOG, { ...SHELL, [part]: false })
      expect(verdict.kind, part).toBe('APP')
    }
  })

  it('is APP when there is no error to explain', () => {
    expect(pageFailureVerdict([], PROBE_8_LOG, SHELL).kind).toBe('APP')
  })
})
