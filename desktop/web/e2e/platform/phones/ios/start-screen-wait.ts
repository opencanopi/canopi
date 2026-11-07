// The iOS smoke's wait for the start screen (canopi-f47t.52.261, run 41753452998): on a hosted runner the iPad mini
// simulator took 80 s to load the app, and the first element lookup sent into the loading page found Safari's debugger
// busy: the driver gave up on it after webviewAtomWaitTimeout (wdio.ios.conf.ts) with its "JavaScript execution is
// blocked" error, though the load then finished on the start screen with no dialog. So a busy debugger is asked again
// until the deadline. Framework-free, so it is unit tested (start-screen-wait.test.ts, beside it).

/** The driver's error for a page whose debugger answered nothing within webviewAtomWaitTimeout. */
const BUSY_DEBUGGER = 'The remote Safari debugger did not respond to the requested command'

/** Whether `error` is the driver's busy-debugger error: the page may answer the same request later. */
export function isBusyDebugger(error: Error): boolean {
  return error.message.includes(BUSY_DEBUGGER)
}
/** wdio's own message when the element exists nowhere or stays hidden for the whole wait. */
const NOT_DISPLAYED = 'still not displayed after'

/**
 * Waits up to `deadline` ms for the start screen through `wait` (waitForDisplayed with a timeout). The lane's
 * planted-page step requires "the start screen was not displayed" for an absent start screen, so a page that stayed
 * busy fails with its own message and any other error (a session that died) is rethrown unchanged.
 */
export async function waitForStartScreen(
  wait: (timeout: number) => Promise<unknown>, page: string, deadline: number, clock: () => number = () => performance.now(),
): Promise<void> {
  const start = clock()
  for (;;) {
    const left = deadline - (clock() - start)
    try {
      await wait(left)
      return
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const seconds = Math.round(deadline / 1000)
      if (error.message.includes(NOT_DISPLAYED)) {
        throw new Error(`the start screen was not displayed ${seconds} s after opening ${page}`, { cause: error })
      }
      if (!isBusyDebugger(error)) throw error
      if (deadline - (clock() - start) <= 0) {
        throw new Error(`Safari answered no element lookup for ${seconds} s after opening ${page}: the page stayed busy`, { cause: error })
      }
    }
  }
}
