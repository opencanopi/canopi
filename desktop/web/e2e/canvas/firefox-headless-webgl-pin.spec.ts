// W18's pin (policy/upstream.json; canopi-f47t.52.228.43, 2.1-M426): headless Firefox in the pinned Playwright image
// creates no WebGL context, which is why the Firefox projects run headed under Xvfb (playwright.config.ts). It runs in
// the firefox-headless project alone and needs no server. It holds in the pinned image only
// (mcr.microsoft.com/playwright, which sets PLAYWRIGHT_BROWSERS_PATH=/ms-playwright): a workstation's Firefox may reach
// its own GPU. When a Playwright bump's headless Firefox creates a context there, this fails: run the Firefox projects
// headless, drop the Xvfb wrapper and close W18.
import { expect, test } from '@playwright/test'

test('pin: headless Firefox in the pinned image creates no WebGL context', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_BROWSERS_PATH !== '/ms-playwright', 'W18 describes the pinned image\'s headless Firefox')
  await page.setContent('<canvas id="webgl2"></canvas><canvas id="webgl"></canvas>')
  const contexts = await page.evaluate(() => ({
    webgl2: (document.getElementById('webgl2') as HTMLCanvasElement).getContext('webgl2') !== null,
    webgl: (document.getElementById('webgl') as HTMLCanvasElement).getContext('webgl') !== null,
  }))
  expect(contexts).toEqual({ webgl2: false, webgl: false })
})
