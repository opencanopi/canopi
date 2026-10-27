// Web Edition browser checks (canopi-9x95, canvas v2 plan section 3.2), and the UI gallery's
// (canopi-f47t.42, plan section 4 "Surfaces and checks").
// The built Web Edition (`npm run build:web`, `dist-web/`) is served by `vite preview`
// and driven in Chromium (stands in for WebView2), WebKit (stands in for WKWebView) and Firefox, each the whole
// canvas suite (2.1-M214).
// The UI gallery (`ui-gallery/`, its dev server on 1422) mounts the Desktop panels and the
// shared workspace over memory fixtures; `e2e/gallery` drives it in the three engines too
// (projects gallery-chromium, gallery-webkit and gallery-firefox), with DOM and pixel assertions only.
// Headless Firefox creates no WebGL context in the pinned image (every driver option is refused), so the map
// never draws there; headed Firefox under Xvfb gets Mesa's software WebGL 2 (measured 2026-10-27). The Firefox
// projects therefore run headed and need a display wider and taller than the largest viewport a spec sets (820x1180):
// `xvfb-run -a -s '-screen 0 1920x1200x24' npx playwright test --project=firefox`.
// Baselines are made only in the pinned image mcr.microsoft.com/playwright:v1.64.1-noble,
// the CI job's container; screenshots from the host's own browsers are never committed.
// After recording, run the suite in that image on fewer cores than the hosted runner's four
// (`docker run --cpus=2 … npx playwright test e2e/canvas --repeat-each=3`, under that xvfb-run for Firefox): a screenshot of a
// state that a timer is still due to change passes on a fast workstation and fails there.
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

const PORT = 4174
const GALLERY_PORT = 1422
const isCI = Boolean(process.env.CI)
/**
 * Never a browser engine project's: the Desktop real-app suite and the iOS smoke (WebdriverIO, under platform/) and the
 * Android smoke (Playwright `_android` on an emulator, `npm run test:android`).
 */
const NOT_ENGINE_SPECS = ['platform/**', 'phones/**']
/**
 * Firefox as the specs need it: headed (see the header), and geolocation blocked unless a spec grants it, as Chromium and
 * WebKit answer an ungranted request; Playwright's Firefox otherwise answers it with a position (measured 2026-10-27).
 */
const FIREFOX = { browserName: 'firefox', headless: false, launchOptions: { firefoxUserPrefs: { 'permissions.default.geo': 2 } } } as const

type WebServer = Extract<NonNullable<PlaywrightTestConfig['webServer']>, readonly unknown[]>[number] & { url: string }

const WEB_EDITION_SERVER: WebServer = {
  // Web mode supplies the /app/ base and dist-web; build first with `npm run build:web`.
  command: `npx vite preview --mode web --port ${PORT} --strictPort`,
  url: `http://localhost:${PORT}/app/web.html`,
  reuseExistingServer: !isCI,
  timeout: 60_000,
}

const GALLERY_SERVER: WebServer = {
  // The UI gallery's dev server (ui-gallery/vite.config.ts, strict port). From a cold dependency cache
  // (node_modules/.vite-ui-gallery removed) Vite optimised every dependency before the first page
  // answered and reloaded no page: 24 passed with --repeat-each=3 in both engines in the pinned image
  // (2026-10-08), so ui-gallery/vite.config.ts needs no optimizeDeps.include.
  command: 'npx vite --config ui-gallery/vite.config.ts',
  url: `http://127.0.0.1:${GALLERY_PORT}/`,
  reuseExistingServer: !isCI,
  timeout: 120_000,
}

/**
 * The servers the chosen projects use. Playwright starts every listed server whatever `--project` picks, so
 * the gallery lane would need the built Web Edition and the canvas lane would optimise the gallery's
 * dependencies. With no `--project`, both start.
 */
export function webServersFor(argv: readonly string[]): WebServer[] {
  const projects = argv.flatMap((arg, index) => {
    if (arg.startsWith('--project=')) return [arg.slice('--project='.length)]
    return arg === '--project' && argv[index + 1] ? [argv[index + 1]!] : []
  })
  const gallery = projects.some((project) => project.startsWith('gallery-'))
  const webEdition = projects.some((project) => !project.startsWith('gallery-'))
  if (projects.length === 0 || (gallery && webEdition)) return [WEB_EDITION_SERVER, GALLERY_SERVER]
  return gallery ? [GALLERY_SERVER] : [WEB_EDITION_SERVER]
}

export default defineConfig({
  testDir: 'e2e',
  // A flaky screenshot is a bug to fix (settle first), never something to retry past.
  retries: 0,
  forbidOnly: isCI,
  // The same on a workstation as on the hosted runner (four cores). No spec shares state between its tests
  // (each has its own page; no beforeAll or serial mode), so CI shards split tests, not files (2026-10-16).
  fullyParallel: true,
  workers: 2,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Measured in the pinned image with tracing on (retain-on-failure records every run): at four
  // cores (the hosted runner's size) the base scenario takes up to 40 s, above Playwright's
  // default 30 s, and at two cores up to 125 s. A screenshot after a Design change waits for
  // the canvas (e2e/support/canvas.ts) and matches its baseline on its first capture, but at two
  // cores (the validation run above) that one capture takes up to 6.6 s, opening the fixture up
  // to 11.6 s and the PDF preview up to 10.1 s, beyond the default 5 s; at 20 s the slowest
  // uses under 60 % of its budget. These limits only bound how long a check waits; a longer
  // wait never lets a wrong page pass.
  timeout: 180_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      // Playwright's default comparison, not loosened: no pixel budget (maxDiffPixels 0) and
      // the default per-pixel colour threshold; the pinned image makes the pixels reproducible.
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}/app/web.html`,
    // The size the phase-0 native references use.
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    // Pinned so number and date formatting never follows the host or the image.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // No device descriptors: they would change the user agent (Desktop Safari claims macOS,
  // which switches the app to Command shortcuts); every engine keeps the host platform.
  projects: [
    { name: 'chromium', testIgnore: ['gallery/**', ...NOT_ENGINE_SPECS], use: { browserName: 'chromium' } },
    { name: 'webkit', testIgnore: ['gallery/**', ...NOT_ENGINE_SPECS], use: { browserName: 'webkit' } },
    { name: 'firefox', testIgnore: ['gallery/**', ...NOT_ENGINE_SPECS], use: FIREFOX },
    { name: 'gallery-chromium', testMatch: 'gallery/**/*.spec.ts', testIgnore: NOT_ENGINE_SPECS, use: { browserName: 'chromium', baseURL: `http://127.0.0.1:${GALLERY_PORT}/` } },
    { name: 'gallery-webkit', testMatch: 'gallery/**/*.spec.ts', testIgnore: NOT_ENGINE_SPECS, use: { browserName: 'webkit', baseURL: `http://127.0.0.1:${GALLERY_PORT}/` } },
    { name: 'gallery-firefox', testMatch: 'gallery/**/*.spec.ts', testIgnore: NOT_ENGINE_SPECS, use: { ...FIREFOX, baseURL: `http://127.0.0.1:${GALLERY_PORT}/` } },
  ],
  webServer: webServersFor(process.argv),
})
