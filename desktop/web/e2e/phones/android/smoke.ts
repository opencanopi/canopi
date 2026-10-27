// The Android smoke (ADR 0029 Platform matrix, 2.1-Q84): Chrome on an Android emulator reads the built Web Edition
// (`npm run build:web`, `vite preview` on 4174, `adb reverse tcp:4174 tcp:4174`). `npm run test:android` inside
// reactivecircus/android-emulator-runner (web-edition-browsers.yml, job android). With CANOPI_E2E_PLANTED_PAGE it opens
// that page instead, so the lane's inverted step fails unless the smoke fails (plan:157). Any failure exits non-zero;
// no emulator is a failure, never a skip (plan:181).
//
// Playwright `_android` first: the start screen at the emulator's own size (the phone layout) and at 820x1180 (the
// tablet layout, ADR 0029:26), each starting a Design. The probe of 2026-10-26 saw `launchBrowser()` hang on a
// google_apis_playstore API 34 image, likely because a non-rooted Chrome reads its command-line file only as the debug
// app, which `prepareChrome` sets. When `_android` cannot reach Chrome the smoke falls back to adb: Chrome opens
// about:blank (the reference) and then the page, and the page's screenshot must differ from the reference's in the crop
// below Chrome's toolbar; that fallback checks the phone size only, and says so in a warning line.
import { _android, chromium, type AndroidDevice, type Page } from '@playwright/test'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/app/web.html'
const TARGET = process.env.CANOPI_E2E_PLANTED_PAGE ?? APP_URL
const CHROME = 'com.android.chrome'
/** Long enough for Chrome's first launch on a software-rendered emulator; the probe's hang never ended. */
const LAUNCH_TIMEOUT_MS = 180_000
/** The fallback's settle time after Chrome is asked to open a page. */
const FALLBACK_SETTLE_MS = 30_000
/** The fallback's crop, as fractions of the screen's height: below the status bar and toolbar, above the navigation. */
const CROP = { top: 0.2, bottom: 0.9 }
/** A page that differs from the blank reference in fewer of the crop's pixels than this is blank. */
const MIN_CHANGED_FRACTION = 0.02

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Chrome's first run skipped: its command-line file holds the flags, read because Chrome is the debug app. */
async function prepareChrome(device: AndroidDevice): Promise<void> {
  await device.shell(`am set-debug-app --persistent ${CHROME}`)
  await device.shell(`echo '_ --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line`)
  await device.shell(`am force-stop ${CHROME}`)
}

async function expectNoOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 0) throw new Error(`${where}: the page is ${overflow} px wider than the screen`)
}

/** The start screen, then a new Design in the given layout. */
async function smoke(page: Page, layout: 'phone' | 'tablet'): Promise<void> {
  await page.goto(TARGET, { timeout: 120_000 })
  const startScreen = page.locator('[data-start-screen]')
  await startScreen.waitFor({ timeout: 90_000 })
  const title = await startScreen.locator('h1').textContent()
  if (title !== 'Canopi') throw new Error(`${layout}: the start screen's heading reads ${title}`)
  await expectNoOverflow(page, `${layout} start screen`)
  await startScreen.getByRole('button', { name: 'New Design', exact: true }).first().click()
  await startScreen.waitFor({ state: 'hidden' })
  const shell = page.getByTestId('browser-app-shell')
  await shell.waitFor()
  const phoneLayout = await shell.getAttribute('data-phone-layout')
  const expected = layout === 'phone' ? 'portrait' : null
  if (phoneLayout !== expected) throw new Error(`${layout}: the workspace's phone layout is ${phoneLayout}, not ${expected}`)
  await expectNoOverflow(page, `${layout} workspace`)
}

async function viaPlaywright(device: AndroidDevice): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LAUNCH_TIMEOUT_MS) })
  const context = await Promise.race([device.launchBrowser().catch((error: Error) => {
    console.log(`::warning::Playwright _android could not launch Chrome: ${error.message.split('\n')[0]}`)
    return null
  }), timeout])
  clearTimeout(timer)
  if (!context) {
    console.log(`::warning::Playwright _android did not reach Chrome within ${LAUNCH_TIMEOUT_MS / 1000} s; the smoke falls back to adb screenshots`)
    return false
  }
  try {
    const page = await context.newPage()
    await smoke(page, 'phone')
    await page.setViewportSize({ width: 820, height: 1180 })
    await smoke(page, 'tablet')
    console.log('android smoke: the start screen and a new Design at the phone and tablet layouts, through Playwright _android')
    return true
  } finally {
    await context.close().catch(() => undefined)
  }
}

async function screenshotOf(device: AndroidDevice, url: string): Promise<Buffer> {
  await device.shell(`am start -a android.intent.action.VIEW -d '${url}' ${CHROME}`)
  await sleep(FALLBACK_SETTLE_MS)
  return device.screenshot()
}

/** The fraction of the crop's pixels that differ between two same-size PNG screenshots, decoded in Chromium. */
async function changedFraction(reference: Buffer, shot: Buffer): Promise<number> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    return await page.evaluate(async ({ a, b, crop }) => {
      const pixels = async (base64: string) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = new OffscreenCanvas(image.width, image.height)
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height)
      }
      const [x, y] = await Promise.all([pixels(a), pixels(b)])
      if (x.width !== y.width || x.height !== y.height) return 1
      let changed = 0
      let total = 0
      for (let row = Math.floor(x.height * crop.top); row < Math.floor(x.height * crop.bottom); row++) {
        for (let column = 0; column < x.width; column++) {
          const i = (row * x.width + column) * 4
          const delta = Math.abs(x.data[i]! - y.data[i]!) + Math.abs(x.data[i + 1]! - y.data[i + 1]!) + Math.abs(x.data[i + 2]! - y.data[i + 2]!)
          total++
          if (delta > 48) changed++
        }
      }
      return changed / total
    }, { a: reference.toString('base64'), b: shot.toString('base64'), crop: CROP })
  } finally {
    await browser.close()
  }
}

async function viaScreenshots(device: AndroidDevice): Promise<void> {
  await device.shell(`am force-stop ${CHROME}`)
  const reference = await screenshotOf(device, 'about:blank')
  const shot = await screenshotOf(device, TARGET)
  const fraction = await changedFraction(reference, shot)
  if (fraction < MIN_CHANGED_FRACTION) {
    throw new Error(`the page's screenshot differs from blank in ${(fraction * 100).toFixed(2)} % of the crop, under ${MIN_CHANGED_FRACTION * 100} %: Chrome shows no page`)
  }
  console.log(`::warning::android smoke by screenshot only (phone size; no tablet layout, no new Design): the page differs from blank in ${(fraction * 100).toFixed(1)} % of the crop`)
}

const devices = await _android.devices()
const device = devices[0]
if (!device) throw new Error('no Android device: the emulator did not boot, and the smoke fails rather than skip')
try {
  await prepareChrome(device)
  if (!await viaPlaywright(device)) await viaScreenshots(device)
} finally {
  await device.close()
}
// A launchBrowser() that never settled would keep the process alive past a passing smoke.
process.exit(0)
