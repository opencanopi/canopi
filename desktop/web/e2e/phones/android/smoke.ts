// The Android smoke (ADR 0029 Platform matrix, 2.1-Q84): Chrome on an Android emulator reads the built Web Edition
// (`npm run build:web`, `vite preview` on 4174, `adb reverse tcp:4174 tcp:4174`). `npm run test:android` inside
// reactivecircus/android-emulator-runner (web-edition-browsers.yml, job android). With CANOPI_E2E_PLANTED_PAGE it opens
// that page instead, so the lane's inverted step fails unless the smoke fails (plan:157). Any failure exits non-zero;
// no emulator, or a Chrome Playwright cannot reach, is a failure, never a skip or a weaker check (plan:181).
//
// Playwright `_android` reaches Chrome on the google_apis_playstore API 34 image once `prepareChrome` makes Chrome the
// debug app, so it reads its command-line file (probe run 40479601028). The smoke runs the start screen and a new
// Design at the emulator's own screen (the phone layout), then on a tablet screen (the tablet layout, ADR 0029:26):
// `wm size` and `wm density` give the device 820x1180 CSS pixels, because viewport emulation on an `_android` context
// leaves `window.innerWidth`, which the layout reads, at the phone's width. The screen is reset afterwards.
import { _android, type AndroidDevice, type Page } from '@playwright/test'

const APP_URL = process.env.CANOPI_E2E_APP_URL ?? 'http://localhost:4174/app/web.html'
const TARGET = process.env.CANOPI_E2E_PLANTED_PAGE ?? APP_URL
const CHROME = 'com.android.chrome'
/** Long enough for Chrome's first launch on a software-rendered emulator. */
const LAUNCH_TIMEOUT_MS = 180_000
/** A tablet screen: 1640x2360 device pixels at density 320 (a device pixel ratio of 2) is 820x1180 CSS pixels. */
const TABLET_SCREEN = { size: '1640x2360', density: 320 }

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
  if (phoneLayout !== expected) {
    const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
    throw new Error(`${layout}: the workspace's phone layout is ${phoneLayout}, not ${expected}, in a ${size} CSS px window`)
  }
  await expectNoOverflow(page, `${layout} workspace`)
}

/** Chrome through Playwright, or a thrown error when it does not answer in time: the smoke has no fallback. */
async function launchChrome(device: AndroidDevice) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Playwright _android did not reach Chrome within ${LAUNCH_TIMEOUT_MS / 1000} s`)), LAUNCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([device.launchBrowser(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** One smoke pass in a fresh Chrome context. */
async function pass(device: AndroidDevice, layout: 'phone' | 'tablet'): Promise<void> {
  const context = await launchChrome(device)
  try {
    await smoke(await context.newPage(), layout)
  } finally {
    await context.close().catch(() => undefined)
  }
}

const devices = await _android.devices()
const device = devices[0]
if (!device) throw new Error('no Android device: the emulator did not boot, and the smoke fails rather than skip')
try {
  await prepareChrome(device)
  await pass(device, 'phone')
  await device.shell(`wm size ${TABLET_SCREEN.size}`)
  await device.shell(`wm density ${TABLET_SCREEN.density}`)
  try {
    await device.shell(`am force-stop ${CHROME}`)
    await pass(device, 'tablet')
  } finally {
    await device.shell('wm size reset')
    await device.shell('wm density reset')
  }
  console.log('android smoke: the start screen and a new Design at the phone and tablet layouts, through Playwright _android')
} finally {
  await device.close()
}
// A launchBrowser() that never settled would keep the process alive past the smoke.
process.exit(0)
