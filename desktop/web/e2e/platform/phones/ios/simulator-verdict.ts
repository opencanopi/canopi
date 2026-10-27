// The iOS smoke's verdict on a page that raised errors after New Design (F5 probe 8, run 40600121577): on hosted macOS
// runners the simulator's Metal host (SimMetalHost) drops its XPC connection and WebKit's GPU process exits, which
// loses every WebGL context; the workspace map then reports its context loss and shows the map notice with Retry, as
// it does for a user whose GPU resets. Real iPhones and iPads have no SimMetalHost. So that one error is ENV only when
// the simulator's own log proves the crash and the app handled it the way a user sees it; anything else is APP.
// Framework-free, so it is unit tested (src/__tests__/ios-smoke-verdict.test.ts).

/** The only page error the ENV verdict accepts: workspace-activation.ts logging contextLossError's message. */
export const CONTEXT_LOSS_ERROR =
  'console.error: Shared workspace map failed: Error: MapLibre WebGL context was lost while preparing the shared workspace.'

/** Simulator log lines that prove the GPU process crashed: the Metal host connection lost, or WebKit seeing the exit. */
const GPU_CRASH_LINES: readonly RegExp[] = [
  /Connection to SimMetalHost\b.*\bwas lost/,
  /gpuProcessExited: reason=Crash/,
]

/** What the page shows once the Design opened, each read from the DOM. */
export interface DesignShell {
  /** The start screen has left. */
  readonly startScreenGone: boolean
  /** The canvas workspace is mounted. */
  readonly workspace: boolean
  /** The tool strip shows its tools. */
  readonly toolStrip: boolean
  /** The shell's layout attribute is the one the device calls for (phone portrait, or none on a tablet). */
  readonly layout: boolean
  /** The map notice is shown in its error tone with Retry: the path a user takes after a context loss. */
  readonly mapNoticeRetry: boolean
}

export interface Verdict {
  readonly kind: 'ENV' | 'APP'
  readonly reason: string
}

const SHELL_PARTS: ReadonlyArray<readonly [keyof DesignShell, string]> = [
  ['startScreenGone', 'the start screen did not leave'],
  ['workspace', 'no canvas workspace'],
  ['toolStrip', 'no tool strip'],
  ['layout', 'the wrong layout attribute'],
  ['mapNoticeRetry', 'no map notice with Retry'],
]

/**
 * ENV only when all hold: the simulator log shows the GPU process crash, the page's every error is the context loss,
 * and the Design shell and the map notice with Retry are shown. Otherwise APP, with what failed.
 */
export function pageFailureVerdict(errors: readonly string[], simulatorLog: string, shell: DesignShell): Verdict {
  const listed = `[${errors.join('; ')}]`
  if (errors.length === 0) return { kind: 'APP', reason: 'no page error to explain' }
  const others = errors.filter((error) => error !== CONTEXT_LOSS_ERROR)
  if (others.length > 0) return { kind: 'APP', reason: `the page raised errors other than the context loss: ${listed}` }
  const crash = simulatorLog.split('\n').find((line) => GPU_CRASH_LINES.some((pattern) => pattern.test(line)))
  if (crash === undefined) {
    return { kind: 'APP', reason: `the WebGL context was lost and the simulator log shows no GPU process crash: ${listed}` }
  }
  const missing = SHELL_PARTS.filter(([part]) => !shell[part]).map(([, what]) => what)
  if (missing.length > 0) {
    return { kind: 'APP', reason: `the WebGL context was lost and the app did not handle it: ${missing.join(', ')}; ${listed}` }
  }
  return { kind: 'ENV', reason: `the simulator's GPU process crashed (SimMetalHost lost) and the app showed the map notice with Retry; log: ${crash.trim()}` }
}
