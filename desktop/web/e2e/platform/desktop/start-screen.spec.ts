// The suite's first spec: the e2e build opens on the start screen, served from its bundled frontend (is_dev() false,
// design-check A28), not a dev server. The lane reruns it with CANOPI_E2E_PLANTED_PAGE=about:blank and fails unless
// that run fails.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { appFolders, currentProfile, plantBrokenPageWhenAsked } from '../support/app'

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
    await expect(browser).toHaveUrl(/^(tauri:\/\/localhost|http:\/\/tauri\.localhost)(\/|$)/)
  })

  it('canopi-72fm: shows no start-up guard after a normal boot, and the start screen takes clicks', async () => {
    // The guard shows at the load event unless the app acknowledged its boot; a top-level await on the entry's static
    // graph once mounted the app after load, so the guard covered a working app in every Desktop webview. A script
    // that reads `complete` runs in a later task than the one that set it and fired load, so load has been handled.
    await browser.waitUntil(() => browser.execute(() => document.readyState === 'complete'), { timeout: 30_000 })

    await expect($('[data-boot-guard]')).not.toBeExisting()
    expect(await browser.execute(() => (window as { __CANOPI_BOOT_ACKNOWLEDGED__?: true }).__CANOPI_BOOT_ACKNOWLEDGED__)).toBe(true)
    // A click is refused when another element would receive it, as the guard's full-window message would.
    await $('[data-start-screen] h1').click()
    await expect($('[data-start-screen]')).toBeDisplayed()
  })

  it('keeps its folders in the session profile (canopi-f47t.52.228.14)', () => {
    // The app creates its log folder at startup; on Windows it once landed in the runner's real known folders.
    const logs = join(appFolders(currentProfile()), 'logs')
    expect(existsSync(logs)).toBe(true)
  })
})
