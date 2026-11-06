// The Android smoke's device and Chrome tab (canopi-f47t.52.228.47). Scratch CI run 40893658953 failed at smoke.ts:72
// with `browserContext.newPage: Cannot read properties of undefined (reading '_page')`. Playwright's newPage on Chrome
// for Android (playwright-core 1.64.1, CRBrowserContext.doCreateNewPage) sends Target.createTarget and reads the new
// tab at once from the tabs whose Target.attachedToTarget it has handled. That lookup is the only `._page` read of the
// path, so Chrome for Android, which creates the tab through its tab model, answered before that tab's attach event
// arrived (the probe's pw:protocol logs, phone-smoke.yml android_repeats, show the order). The smoke therefore never
// creates a tab: it drives the about:blank tab launchBrowser's `am start` opened, which Playwright has attached when
// launchBrowser returns or attaches just after. Framework-free, so it is unit tested
// (src/__tests__/android-chrome-tab.test.ts).

/** How long `_android.devices()` may stay empty: an emulator that adb still reports offline after its boot. */
export const DEVICE_WAIT_MS = 120_000
/** Between two device lists. */
const DEVICE_POLL_MS = 2_000

/** The first device `list` names, asked every 2 s for `timeout` ms; a list that stays empty fails naming the bound. */
export async function waitForDevice<D>(
  list: () => Promise<readonly D[]>, timeout: number,
  clock: () => number = () => performance.now(), sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
): Promise<D> {
  const start = clock()
  for (;;) {
    const [device] = await list()
    if (device !== undefined) return device
    if (clock() - start >= timeout) {
      throw new Error(`no Android device answered within DEVICE_WAIT_MS (${timeout / 1000} s): the emulator did not boot, and the smoke fails rather than skip`)
    }
    await sleep(DEVICE_POLL_MS)
  }
}

/** A Chrome tab as the smoke needs it (Playwright's Page). */
export interface LaunchedTab {
  url(): string
  bringToFront(): Promise<void>
}

/** The context launchBrowser returned, as far as the smoke reads it (Playwright's BrowserContext). */
export interface LaunchedContext<T extends LaunchedTab> {
  pages(): T[]
  waitForEvent(event: 'page', options: { timeout: number }): Promise<T>
}

/**
 * The about:blank tab launchBrowser opened (a tab Chrome restored from an earlier pass may sit beside it, in the
 * background), or the first tab to attach within `timeout` ms; brought to the front, since Chrome throttles a
 * background tab's frames and the start screen leaves only once the first scene is drawn.
 */
export async function launchedTab<T extends LaunchedTab>(context: LaunchedContext<T>, timeout: number): Promise<T> {
  const open = context.pages()
  let tab = open.find((candidate) => candidate.url() === 'about:blank') ?? open.at(-1)
  if (!tab) {
    try {
      tab = await context.waitForEvent('page', { timeout })
    } catch (error) {
      throw new Error(`Chrome showed no tab ${timeout / 1000} s after launch`, { cause: error })
    }
  }
  await tab.bringToFront()
  return tab
}
