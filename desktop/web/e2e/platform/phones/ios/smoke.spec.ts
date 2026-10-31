// The iOS smoke (wdio.ios.conf.ts): the Web Edition opens on its start screen in Safari at the simulator's own size,
// and a new Design opens in the layout the device calls for: the phone layout on an iPhone, the tablet (wide) layout
// on an iPad (src/app/shell/phone-layout.ts), with no page wider than the screen. A page error fails it as APP, except
// the simulator's own GPU process crash, proven by its log and handled by the app (simulator-verdict.ts): that passes
// as ENV, and the job prints the warning (web-edition-browsers.yml).
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { $, browser, expect } from '@wdio/globals'
import { CONTEXT_LOSS_ERROR, logStart, pageFailureVerdict, type DesignShell } from './simulator-verdict'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/web.html'
const tablet = (process.env.CANOPI_IOS_DEVICE ?? '').startsWith('iPad')
/** The run's temp dir, which the CI job uploads: the simulator log the verdict read, and the ENV verdict it printed. */
const ARTIFACTS = resolve(process.env.RUNNER_TEMP ?? tmpdir())

/** What the page recorded since `installProbe`: the input events that reached it and the errors it raised. */
interface PageProbe {
  readonly events: string[]
  readonly errors: string[]
}

/**
 * Records, in the page, every click, pointerup and touchend (capture phase, with the button it landed on) and every
 * page error, unhandled rejection and console.error, so a failure says whether New Design's tap reached the page and
 * whether the page then failed (F5 probe 5: neither was visible from the driver).
 */
async function installProbe(): Promise<void> {
  await browser.execute(() => {
    const probe = { events: [] as string[], errors: [] as string[] }
    ;(window as unknown as { __canopiE2e: typeof probe }).__canopiE2e = probe
    for (const type of ['click', 'pointerup', 'touchend']) {
      document.addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target.closest('button') : null
        probe.events.push(`${type} on ${target ? `button "${target.textContent?.trim() ?? ''}"` : 'no button'}`)
      }, { capture: true })
    }
    window.addEventListener('error', (event) => probe.errors.push(`page error: ${event.message}`))
    window.addEventListener('unhandledrejection', (event) => {
      const reason: unknown = event.reason
      probe.errors.push(`unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`)
    })
    const consoleError = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      probe.errors.push(`console.error: ${args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' ')}`)
      consoleError(...args)
    }
  })
}

async function readProbe(): Promise<PageProbe> {
  return browser.execute(() => {
    const probe = (window as unknown as { __canopiE2e?: { events: string[], errors: string[] } }).__canopiE2e
    return { events: [...(probe?.events ?? [])], errors: [...(probe?.errors ?? [])] }
  })
}

/** The clicks on New Design that reached the page since `installProbe`. */
async function newDesignClicks(): Promise<string[]> {
  return (await readProbe()).events.filter((event) => event.startsWith('click on button "New Design'))
}

/** Whether a click on New Design has reached the page since `installProbe`. */
async function newDesignClicked(): Promise<boolean> {
  return (await newDesignClicks()).length > 0
}

/**
 * What the page shows when the start screen does not leave: whether the click opened a Design that has not been
 * drawn yet (the start screen stays until the first scene is presented, design-reveal.ts), whether the map is ready,
 * what the persistence line says, and which of the two causes it is: the tap never reached New Design (a harness or
 * driver fault) or the page failed after it (an app fault).
 */
async function revealState(): Promise<string> {
  const page = await browser.execute(() => {
    const workspace = document.querySelector('[data-testid="web-canvas-workspace"]')
    const map = workspace?.querySelector('[data-map-active]')
    return [
      `workspace ${workspace ? 'present' : 'absent'}`,
      `data-design-hidden ${workspace?.querySelector('[data-design-hidden]') ? 'present (a Design is open, not drawn yet)' : 'absent (no Design opened)'}`,
      `data-map-active ${map?.getAttribute('data-map-active') ?? 'absent'}`,
      `persistence line ${JSON.stringify(document.querySelector('[data-notice]')?.textContent?.trim() ?? 'absent')}`,
    ].join(', ')
  })
  const { events, errors } = await readProbe()
  const clicked = events.some((event) => event.startsWith('click on button "New Design'))
  const verdict = !clicked
    ? 'HARNESS: no click reached New Design (tap lost between the driver and the page)'
    : errors.length > 0
      ? 'APP: New Design was clicked and the page raised an error (file an app bead with it)'
      : 'UNKNOWN: New Design was clicked and the page raised no error'
  return `${verdict}; ${page}; events [${events.join('; ')}]; errors [${errors.join('; ')}]`
}

/** Text Safari shows in place of a page whose web content process died (its crash page and its title). */
const CRASH_TEXTS = ['Webpage Crashed', 'A problem repeatedly occurred', 'This webpage was reloaded because a problem occurred']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Why the page stopped answering, read without JavaScript: a dead page hangs every script until the driver's atom wait
 * (wdio.ios.conf.ts webviewAtomWaitTimeout) gives up (F5 probe 7: Safari's web content process crashed after New Design,
 * and the old waits turned it into a five-minute hang). The webviews' titles come from the driver, and Safari's own
 * screen from WebDriverAgent's accessibility tree in the NATIVE_APP context.
 */
async function crashState(): Promise<string> {
  let contexts: string[]
  try {
    const found = await browser.getContexts({ returnDetailedContexts: true })
    contexts = found.map((context) => (typeof context === 'string' ? context : `${context.id} ${JSON.stringify(context.title ?? '')}`))
  } catch (error) {
    contexts = [`unreadable: ${messageOf(error)}`]
  }
  let screen = ''
  try {
    await browser.switchContext('NATIVE_APP')
    screen = await browser.getPageSource()
  } catch (error) {
    contexts.push(`NATIVE_APP unreadable: ${messageOf(error)}`)
  }
  const crashed = CRASH_TEXTS.some((text) => screen.includes(text) || contexts.some((context) => context.includes(text)))
  const verdict = crashed
    ? 'CRASH: Safari\'s web content process crashed after New Design (see the simulator crash logs in the job artifact)'
    : 'NO ANSWER: the page stopped answering scripts after New Design and Safari shows no crash page'
  return `${verdict}; contexts [${contexts.join('; ')}]`
}

/** A wait's failure explained: the page's own state when it still answers, else what Safari shows without JavaScript. */
async function failureState(error: unknown): Promise<string> {
  return messageOf(error).startsWith('waitUntil condition timed out') ? revealState() : crashState()
}

/** One poll after the tap in one script (an element display check costs the driver two): the start screen and errors. */
async function afterTap(): Promise<{ startScreenShown: boolean, errors: string[] }> {
  return browser.execute(() => {
    const startScreen = document.querySelector('[data-start-screen]')
    const shown = startScreen !== null && startScreen.getClientRects().length > 0 && getComputedStyle(startScreen).visibility !== 'hidden'
    const probe = (window as unknown as { __canopiE2e?: { errors: string[] } }).__canopiE2e
    return { startScreenShown: shown, errors: [...(probe?.errors ?? [])] }
  })
}

/**
 * Waits for the start screen to leave after New Design, every 2 s for 90 s. A page error fails at once (APP, with the
 * errors), except the workspace map's context loss alone, which the verdict judges (contextLossVerdict), and a poll
 * the page does not answer fails at once with what Safari shows (crashState): neither waits out the budget. The start
 * screen leaves once the new Design's first scene is drawn, which in the simulator's software WebGL with a basemap over
 * the network takes longer than the 20 s default (F5 probe 3): the same budget as the first load.
 */
async function waitForDesign(tappedAt: Date): Promise<void> {
  const deadline = Date.now() + 90_000
  for (;;) {
    let state: Awaited<ReturnType<typeof afterTap>>
    try {
      state = await afterTap()
    } catch (error) {
      throw new Error(`a page script got no answer after New Design: ${await crashState()}`, { cause: error })
    }
    if (state.errors.some((error) => error !== CONTEXT_LOSS_ERROR)) {
      throw new Error(`APP: New Design was clicked and the page raised errors (file an app bead with them): [${state.errors.join('; ')}]`)
    }
    if (state.errors.length > 0) {
      await contextLossVerdict(tappedAt)
      return
    }
    if (!state.startScreenShown) return
    if (Date.now() >= deadline) throw new Error(`the start screen was still displayed 90 s after New Design: ${await revealState()}`)
    await browser.pause(2_000)
  }
}

/** The Design shell as the page shows it, in one script; the layout is the one this device calls for. */
async function designShell(): Promise<DesignShell> {
  return browser.execute((onTablet: boolean) => {
    const startScreen = document.querySelector('[data-start-screen]')
    const startShown = startScreen !== null && startScreen.getClientRects().length > 0 && getComputedStyle(startScreen).visibility !== 'hidden'
    const shell = document.querySelector('[data-testid="browser-app-shell"]')
    const phoneLayout = shell?.getAttribute('data-phone-layout') ?? null
    return {
      startScreenGone: !startShown,
      workspace: document.querySelector('[data-testid="web-canvas-workspace"]') !== null,
      // A new Design opens on the site prompt, which hides the rail until the site is found or skipped.
      toolStrip: document.querySelector('[data-rail-tool]') !== null || document.querySelector('[data-site-locate]') !== null,
      layout: shell !== null && (onTablet ? phoneLayout === null : phoneLayout === 'portrait'),
      // Present, not visible: on a phone the "Where is your site?" prompt and the keyboard cover it (probe 8).
      mapNoticeRetry: document.querySelector('[data-map-notice][data-tone="error"] button') !== null,
    }
  }, tablet)
}

/**
 * The simulator's GPU and Safari log from the tap on (an earlier crash proves nothing about this one), read here
 * because the verdict depends on it (a step that greps it could pass on its own), and kept in the artifacts. A read
 * that fails gives no log, so the verdict is APP.
 */
async function simulatorLog(since: Date): Promise<{ log: string, problem: string }> {
  const udid = process.env.CANOPI_IOS_UDID
  if (!udid) return { log: '', problem: 'CANOPI_IOS_UDID is not set' }
  try {
    const { stdout } = await promisify(execFile)('xcrun', [
      'simctl', 'spawn', udid, 'log', 'show', '--start', logStart(since), '--style', 'compact',
      '--predicate', 'process CONTAINS "GPU" OR process CONTAINS "MobileSafari"',
    ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 })
    writeFileSync(join(ARTIFACTS, 'simulator-gpu.log'), stdout)
    return { log: stdout, problem: '' }
  } catch (error) {
    return { log: '', problem: `the simulator log could not be read: ${messageOf(error)}` }
  }
}

/**
 * The page's only errors are the workspace map's context loss: waits up to 30 s for the Design shell and the map
 * notice with Retry, reads the page's errors again and the simulator log, and passes as ENV only on the verdict's
 * proof (simulator-verdict.ts); otherwise it fails as APP. An ENV verdict is written to the artifacts, where the job
 * turns it into a warning.
 */
async function contextLossVerdict(tappedAt: Date): Promise<void> {
  const settle = Date.now() + 30_000
  let shell = await designShell()
  while (!Object.values(shell).every(Boolean) && Date.now() < settle) {
    await browser.pause(2_000)
    shell = await designShell()
  }
  const { errors } = await readProbe()
  const { log, problem } = await simulatorLog(tappedAt)
  const verdict = pageFailureVerdict(errors, log, shell)
  if (verdict.kind === 'APP') {
    throw new Error(`APP: New Design was clicked and ${verdict.reason} (file an app bead with it)${problem ? `; ${problem}` : ''}`)
  }
  const line = `${process.env.CANOPI_IOS_DEVICE ?? 'iOS'}: ENV: ${verdict.reason}`
  writeFileSync(join(ARTIFACTS, 'ios-env-verdict.txt'), `${line}\n`)
  console.warn(line)
}

async function overflow(): Promise<number> {
  return browser.execute(() => document.documentElement.scrollWidth - window.innerWidth)
}

describe(`the Web Edition in Safari on an ${tablet ? 'iPad' : 'iPhone'}`, () => {
  it('opens on the start screen and starts a Design in its layout', async () => {
    const page = process.env.CANOPI_E2E_PLANTED_PAGE ?? APP_URL
    await browser.url(page)
    const startScreen = $('[data-start-screen]')
    // The lane's planted-page step requires this message, so it is printed only for wdio's own wait timeout (the page
    // loaded and never showed the start screen). Any other error, such as a session that died during the wait
    // (WebDriverAgent crash, invalid session id, ECONNRESET), is rethrown unchanged and fails that step.
    try {
      await startScreen.waitForDisplayed({ timeout: 90_000 })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('still not displayed after')) throw error
      throw new Error(`the start screen was not displayed 90 s after opening ${page}`, { cause: error })
    }
    await expect(startScreen.$('h1')).toHaveText('Canopi')
    expect(await overflow()).toBeLessThanOrEqual(0)

    // A first run also shows the empty Drafts list's New Design action; the primary one comes first in the screen.
    const [primary] = await startScreen.$$('button=New Design')
    if (!primary) throw new Error('the start screen shows no New Design button')
    await installProbe()
    // One tap, by W3C touch as a finger does: real touch delivery, which is what this smoke proves on iOS (a script
    // click would skip it): the XCUITest driver resolves the button to screen coordinates and WebDriverAgent taps there.
    // Element Click is not used: safaridriver's synthesized tap did not reach the button in probe 5, and a second tap
    // after a late one would open a second Design over the first.
    const tappedAt = new Date()
    await browser.action('pointer', { parameters: { pointerType: 'touch' } }).move({ origin: primary }).down().up().perform()
    try {
      await browser.waitUntil(newDesignClicked, { timeout: 10_000, interval: 250 })
    } catch (error) {
      throw new Error(`no click reached New Design 10 s after the tap: ${await failureState(error)}`, { cause: error })
    }
    await waitForDesign(tappedAt)
    const shell = $('[data-testid="browser-app-shell"]')
    await expect(shell).toBeDisplayed()
    if (tablet) await expect(shell).not.toHaveAttribute('data-phone-layout')
    else await expect(shell).toHaveAttribute('data-phone-layout', 'portrait')
    expect(await overflow()).toBeLessThanOrEqual(0)
    // One tap is one New Design: a doubled click would test the replacement path, not a user's single tap.
    expect((await newDesignClicks()).length).toBe(1)
  })
})
