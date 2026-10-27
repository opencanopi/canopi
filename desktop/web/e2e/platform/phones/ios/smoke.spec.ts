// The iOS smoke (wdio.ios.conf.ts): the Web Edition opens on its start screen in Safari at the simulator's own size,
// and a new Design opens in the layout the device calls for: the phone layout on an iPhone, the tablet (wide) layout
// on an iPad (src/app/shell/phone-layout.ts), with no page wider than the screen.
import { $, browser, expect } from '@wdio/globals'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/app/web.html'
const tablet = (process.env.CANOPI_IOS_DEVICE ?? '').startsWith('iPad')

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

    await startScreen.$('button=New Design').click()
    await startScreen.waitForDisplayed({ reverse: true })
    const shell = $('[data-testid="browser-app-shell"]')
    await expect(shell).toBeDisplayed()
    if (tablet) await expect(shell).not.toHaveAttribute('data-phone-layout')
    else await expect(shell).toHaveAttribute('data-phone-layout', 'portrait')
    expect(await overflow()).toBeLessThanOrEqual(0)
  })
})
