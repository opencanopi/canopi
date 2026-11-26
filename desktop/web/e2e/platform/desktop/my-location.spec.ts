// 2.1-Q146: Desktop "Show my location" on Linux and Windows. Tauri's Builder::on_permission_request
// grants PermissionKind::Geolocation to the app origin only, so pressing Show my location on Linux
// or Windows gets a reading or the unavailable state, never a permission refusal ('blocked').
import { $, browser, expect } from '@wdio/globals'

const isMac = process.platform === 'darwin'

describe('Desktop Show my location (2.1-Q146)', () => {
  it('gets a reading or unavailable on Linux and Windows, never a permission refusal', async () => {
    if (isMac) return
    const startScreen = $('[data-start-screen]')
    await startScreen.waitForDisplayed({ timeout: 90_000 })
    const newDesignBtn = startScreen.$('button=New Design')
    if (await newDesignBtn.isExisting()) {
      await newDesignBtn.click()
    }
    const locationBtn = $('[data-my-location]')
    await locationBtn.waitForDisplayed({ timeout: 30_000 })
    await locationBtn.click()
    // Wait for a geolocation outcome: a real fix, the unavailable state (codes 2/3),
    // or a refusal (code 1 -> mode returns to 'off' or 'blocked'). Never pass before an answer arrives.
    await browser.waitUntil(async () => {
      const mode = await locationBtn.getAttribute('data-my-location')
      const unavailable = await locationBtn.getAttribute('data-my-location-unavailable')
      const hasFix = await locationBtn.getAttribute('data-my-location-fix')
      return mode === 'off' || mode === 'blocked' || unavailable === 'true' || hasFix === 'true'
    }, { timeout: 35_000, timeoutMsg: 'Show my location did not receive a reading, unavailable state, or refusal' })
    const mode = await locationBtn.getAttribute('data-my-location')
    const unavailable = await locationBtn.getAttribute('data-my-location-unavailable')
    const hasFix = await locationBtn.getAttribute('data-my-location-fix')
    expect(mode).toBe('following')
    expect(unavailable === 'true' || hasFix === 'true').toBe(true)
  })
})
