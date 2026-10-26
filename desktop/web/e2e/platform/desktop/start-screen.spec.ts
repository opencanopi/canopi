// The suite's first spec: the e2e build opens on the start screen, served from its bundled frontend (is_dev() false,
// design-check A28), not a dev server. The lane reruns it with CANOPI_E2E_PLANTED_PAGE=about:blank and fails unless
// that run fails.
import { $, browser, expect } from '@wdio/globals'
import { plantBrokenPageWhenAsked } from '../support/app'

describe('the Desktop app at launch', () => {
  it('opens on the start screen from its bundled frontend', async () => {
    const startScreen = $('[data-start-screen]')
    await startScreen.waitForDisplayed({ timeout: 90_000 })
    await plantBrokenPageWhenAsked()

    await expect(startScreen).toBeDisplayed()
    await expect(startScreen.$('h1')).toHaveText('Canopi')
    await expect(browser).toHaveTitle('Canopi')
    // A built frontend loads from Tauri's own origin (tauri://localhost on Linux, http://tauri.localhost on Windows);
    // a dev build would load the dev server at http://localhost:1420.
    await expect(browser).toHaveUrl(/^(tauri:\/\/localhost|http:\/\/tauri\.localhost)\//)
  })
})
