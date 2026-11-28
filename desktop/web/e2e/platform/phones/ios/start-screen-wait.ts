// The iOS smoke's wait for the start screen (canopi-f47t.52.261, run 41753452998): on a hosted runner the iPad mini
// simulator took 80 s to load the app, and the first element lookup sent into the loading page found Safari's debugger
// busy: the driver gave up on it after webviewAtomWaitTimeout (wdio.ios.conf.ts) with its "JavaScript execution is
// blocked" error, though the load then finished on the start screen with no dialog; wdio's waitForDisplayed then sent no
// new lookup (canopi-5kel). So a busy debugger is asked again, by a fresh probe, until the deadline. Framework-free, so it is unit tested (start-screen-wait.test.ts, beside it).

/** The driver's error for a page whose debugger answered nothing within webviewAtomWaitTimeout. */
const BUSY_DEBUGGER = 'The remote Safari debugger did not respond to the requested command'

/** Whether `error` is the driver's busy-debugger error: the page may answer the same request later. */
export function isBusyDebugger(error: Error): boolean {
  return error.message.includes(BUSY_DEBUGGER)
}
/**
 * Single-shot poll loop for the start screen (canopi-5kel): unlike wdio's `waitForDisplayed`, which stops sending
 * lookups after a 30 s Safari debugger timeout, this issues a fresh single-shot probe after every busy-debugger error
 * until `deadline` ms elapses. Preserves the exact planted-page message ("the start screen was not displayed") when the
 * page answers `false` until the deadline.
 */
export async function pollStartScreen(
  probe: () => Promise<boolean>,
  page: string,
  deadline: number,
  options: { interval?: number, clock?: () => number, sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const interval = options.interval ?? 1_000
  const clock = options.clock ?? (() => performance.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const start = clock()
  const seconds = Math.round(deadline / 1000)
  for (;;) {
    // The last probe's outcome names the failure: a page busy at the deadline is busy, whatever it answered before.
    let busy: Error | undefined
    try {
      if (await probe()) return
    } catch (error) {
      if (!(error instanceof Error) || !isBusyDebugger(error)) throw error
      busy = error
    }
    const left = deadline - (clock() - start)
    if (left <= 0) {
      if (busy) throw new Error(`Safari answered no element lookup for ${seconds} s after opening ${page}: the page stayed busy`, { cause: busy })
      throw new Error(`the start screen was not displayed ${seconds} s after opening ${page}`)
    }
    // A pause after every probe, a busy one too: a busy error that returns at once never spins the loop.
    await sleep(Math.min(interval, left))
  }
}
