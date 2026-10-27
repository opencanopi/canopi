// The iOS smoke (wdio.ios.conf.ts): the Web Edition opens on its start screen in Safari at the simulator's own size,
// and a new Design opens in the layout the device calls for: the phone layout on an iPhone, the tablet (wide) layout
// on an iPad (src/app/shell/phone-layout.ts), with no page wider than the screen.
import { $, browser, expect } from '@wdio/globals'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/app/web.html'
const tablet = (process.env.CANOPI_IOS_DEVICE ?? '').startsWith('iPad')

/**
 * What the page shows when the start screen does not leave: whether the click opened a Design that has not been
 * drawn yet (the start screen stays until the first scene is presented, design-reveal.ts) and whether the map is ready.
 */
async function revealState(): Promise<string> {
  return browser.execute(() => {
    const workspace = document.querySelector('[data-testid="web-canvas-workspace"]')
    const map = workspace?.querySelector('[data-map-active]')
    return [
      `workspace ${workspace ? 'present' : 'absent'}`,
      `data-design-hidden ${workspace?.querySelector('[data-design-hidden]') ? 'present (a Design is open, not drawn yet)' : 'absent (no Design opened)'}`,
      `data-map-active ${map?.getAttribute('data-map-active') ?? 'absent'}`,
    ].join(', ')
  })
}

async function overflow(): Promise<number> {
  return browser.execute(() => document.documentElement.scrollWidth - window.innerWidth)
}

describe(`the Web Edition in Safari on an ${tablet ? 'iPad' : 'iPhone'}`, () => {
  it('opens on the start screen and starts a Design in its layout', async () => {
    await browser.url(process.env.CANOPI_E2E_PLANTED_PAGE ?? APP_URL)
    const startScreen = $('[data-start-screen]')
    await startScreen.waitForDisplayed({ timeout: 90_000 })
    await expect(startScreen.$('h1')).toHaveText('Canopi')
    expect(await overflow()).toBeLessThanOrEqual(0)

    // A first run also shows the empty Drafts list's New Design action; the primary one comes first in the screen.
    const [primary] = await startScreen.$$('button=New Design')
    if (!primary) throw new Error('the start screen shows no New Design button')
    await primary.click()
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
  })
})
