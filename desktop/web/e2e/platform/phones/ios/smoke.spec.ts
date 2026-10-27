// The iOS smoke (wdio.ios.conf.ts): the Web Edition opens on its start screen in Safari at the simulator's own size,
// and a new Design opens in the layout the device calls for: the phone layout on an iPhone, the tablet (wide) layout
// on an iPad (src/app/shell/phone-layout.ts), with no page wider than the screen.
import { $, browser, expect } from '@wdio/globals'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/app/web.html'
const tablet = (process.env.CANOPI_IOS_DEVICE ?? '').startsWith('iPad')

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

async function overflow(): Promise<number> {
  return browser.execute(() => document.documentElement.scrollWidth - window.innerWidth)
}

describe(`the Web Edition in Safari on an ${tablet ? 'iPad' : 'iPhone'}`, () => {
  it('opens on the start screen and starts a Design in its layout', async () => {
    const page = process.env.CANOPI_E2E_PLANTED_PAGE ?? APP_URL
    await browser.url(page)
    const startScreen = $('[data-start-screen]')
    // The lane's planted-page step requires this message: it is printed only once a session exists and the page loaded.
    try {
      await startScreen.waitForDisplayed({ timeout: 90_000 })
    } catch (error) {
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
    await browser.action('pointer', { parameters: { pointerType: 'touch' } }).move({ origin: primary }).down().up().perform()
    try {
      await browser.waitUntil(newDesignClicked, { timeout: 10_000, interval: 250 })
    } catch (error) {
      throw new Error(`no click reached New Design 10 s after the tap: ${await revealState()}`, { cause: error })
    }
    // The start screen leaves once the new Design's first scene is drawn, which in the simulator's software WebGL with
    // a basemap over the network takes longer than the 20 s default (F5 probe 3): the same budget as the first load.
    try {
      await startScreen.waitForDisplayed({ reverse: true, timeout: 90_000 })
    } catch (error) {
      throw new Error(`the start screen was still displayed 90 s after New Design: ${await revealState()}`, { cause: error })
    }
    const shell = $('[data-testid="browser-app-shell"]')
    await expect(shell).toBeDisplayed()
    if (tablet) await expect(shell).not.toHaveAttribute('data-phone-layout')
    else await expect(shell).toHaveAttribute('data-phone-layout', 'portrait')
    expect(await overflow()).toBeLessThanOrEqual(0)
    // One tap is one New Design: a doubled click would test the replacement path, not a user's single tap.
    expect((await newDesignClicks()).length).toBe(1)
  })
})
