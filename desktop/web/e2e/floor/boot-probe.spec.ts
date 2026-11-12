// The engine-floor probe (canopi-4kfl, Step 2.0.4 U-2; canopi-pqxl for the user agent). A Mac user on an old Safari saw
// an empty window. Step 2.0.4 bets on three things, and this spec checks each one in the engine it runs in:
// - the empty window comes from the engine floor (the bundle does not parse or run), not from a missing WebGL: each
//   edition's built page boots once with WebGL and once with WebGL taken away, and the two must render alike; a window
//   left empty must carry the engine error that emptied it;
// - a module SyntaxError and a module that answers 404 reach a classic `error` capture listener before `load`, which is
//   what the start-up guard (U-4) listens for;
// - what Playwright WebKit on a Linux host reports as its user agent, which decides whether the macOS Trackpad default
//   (2.1-Q309, U-1) flips an e2e run's scroll setting: it does, and the pin at the end says why e2e seeds it.
//
// The same file runs under today's runner and under the old runners whose WebKit predates the floor: the repository's
// Playwright config matches it for local runs, and .github/workflows/engine-floor-probe.yml copies it, with the one app
// module it imports, into a scratch package that installs the runner matching each image and runs it without that
// config. No regular CI lane runs e2e/floor, so nothing here runs on a runner bump. So it uses only the API Playwright
// 1.20 already had, serves its own pages with node:http, and writes every in-page script as ES5. Each boot writes one
// `FLOOR-ROW {json}` line, which the workflow gathers into its summary: the floor and its cause are read from there.
//
// Local run (desktop/web, after `npm run build` and `npm run build:web`):
//   npx playwright test e2e/floor --project=webkit
// CANOPI_FLOOR_DIST and CANOPI_FLOOR_DIST_WEB name the built editions (default: dist and dist-web in the working
// directory); a boot whose edition is not built is skipped, saying so. In a browser the Desktop edition (dist) stops at
// the missing native shell (__TAURI_INTERNALS__) even on a current engine, so its row tells only whether the bundle
// parsed; the Web Edition (dist-web) row tells whether the app rendered.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { detectPlatform } from '../../src/canvas/runtime/input/platform'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

/** One page origin on a free port, closed by the caller. */
async function serve(handler: Handler): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.pbf': 'application/x-protobuf',
}

/** A built edition at the origin's root, as the editions' base "/" expects; anything missing answers 404. */
function staticRoot(root: string): Handler {
  const base = resolve(root)
  return (request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
    const file = normalize(join(base, path))
    if (!(file === base || file.startsWith(base + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not Found')
      return
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  }
}

/**
 * The guard's listening position: a classic script before every module, capturing `error` (non-bubbling element errors
 * included) and noting whether `load` had fired. The page also asks for a chunk that answers 404 two ways: a
 * modulepreload (Safari reads it only from 17.0) and a module that imports it.
 */
const LISTENER_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script>
window.__floor = { events: [], loaded: false };
addEventListener('error', function (event) {
  var target = event.target, element = !!(target && target.nodeType === 1);
  window.__floor.events.push({
    kind: element ? 'element' : 'error',
    tag: element ? target.tagName.toLowerCase() : '',
    url: element ? String(target.src || target.href || '') : String(event.filename || ''),
    message: String(event.message || (event.error && event.error.message) || ''),
    name: String((event.error && event.error.name) || ''),
    beforeLoad: !window.__floor.loaded
  });
}, true);
addEventListener('load', function () { window.__floor.loaded = true; });
</script>
<link rel="modulepreload" href="/missing-chunk.js">
<script type="module" src="/broken-entry.js"></script>
<script type="module" src="/imports-missing.js"></script>
</head><body></body></html>`

function listenerSite(): Handler {
  const bodies: Readonly<Record<string, string>> = {
    '/': LISTENER_PAGE,
    // Syntax no engine reads, as an old engine meets a newer build's syntax.
    '/broken-entry.js': 'export const = ;\n',
    '/imports-missing.js': "import '/missing-chunk.js'\n",
  }
  return (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const body = bodies[path]
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not Found')
      return
    }
    response.writeHead(200, { 'content-type': path === '/' ? TYPES['.html']! : TYPES['.js']! })
    response.end(body)
  }
}

interface FloorEvent { kind: string, tag: string, url: string, message: string, name: string, beforeLoad: boolean }

const isSyntaxError = (event: FloorEvent) => event.name === 'SyntaxError' || /SyntaxError/.test(event.message)

/** The listener as an init script for the built pages, which have none of their own yet, plus unhandled rejections. */
const CAPTURE = `(function () {
  var floor = window.__floor = { events: [], loaded: false };
  addEventListener('error', function (event) {
    var target = event.target, element = !!(target && target.nodeType === 1);
    floor.events.push({
      kind: element ? 'element' : 'error',
      tag: element ? target.tagName.toLowerCase() : '',
      url: element ? String(target.src || target.href || '') : String(event.filename || ''),
      message: String(event.message || (event.error && event.error.message) || ''),
      name: String((event.error && event.error.name) || ''),
      beforeLoad: !floor.loaded
    });
  }, true);
  addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    floor.events.push({ kind: 'rejection', tag: '', url: '', message: String((reason && reason.message) || reason),
      name: String((reason && reason.name) || ''), beforeLoad: !floor.loaded });
  });
  addEventListener('load', function () { floor.loaded = true; });
})();`

/** A GPU without WebGL, as a blocklisted 2015 Intel GPU answers: every WebGL context request returns null. */
const NO_WEBGL = `(function () {
  function refuse(proto) {
    if (!proto || !proto.getContext) return;
    var original = proto.getContext;
    proto.getContext = function (type) {
      if (/webgl/i.test(String(type))) return null;
      return original.apply(this, arguments);
    };
  }
  refuse(window.HTMLCanvasElement && HTMLCanvasElement.prototype);
  refuse(window.OffscreenCanvas && OffscreenCanvas.prototype);
})();`

interface BootRun {
  webglAsked: boolean
  webglAvailable: boolean
  rendered: boolean
  appChildren: number
  appText: number
  events: FloorEvent[]
  pageErrors: string[]
  console: string[]
}

/** How long a built page gets to put anything in #app before the window counts as empty. */
const SETTLE_MS = 15_000

async function boot(browser: Browser, url: string, webgl: boolean): Promise<BootRun> {
  const context = await browser.newContext()
  const page: Page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
  const consoleLines: string[] = []
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') consoleLines.push(`${message.type()}: ${message.text()}`) })
  try {
    await page.addInitScript(CAPTURE)
    if (!webgl) await page.addInitScript(NO_WEBGL)
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction("(function () { var app = document.getElementById('app'); return !!app && app.childElementCount > 0 })()",
      undefined, { timeout: SETTLE_MS }).catch(() => undefined)
    const state = await page.evaluate(`(function () {
      var app = document.getElementById('app'), canvas = document.createElement('canvas'), gl = null;
      try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); } catch (error) { gl = null; }
      return { appChildren: app ? app.childElementCount : -1, appText: app ? (app.textContent || '').trim().length : -1,
        webglAvailable: !!gl, events: window.__floor ? window.__floor.events : [] };
    })()`) as Omit<BootRun, 'webglAsked' | 'rendered' | 'pageErrors' | 'console'>
    return { ...state, webglAsked: webgl, rendered: state.appChildren > 0, pageErrors, console: consoleLines }
  } finally {
    await context.close()
  }
}

/**
 * The built editions. Only the Web Edition renders in a browser: the Desktop edition stops at the missing native shell
 * even on a current engine (with no error at all in WebKit 16.4), so its empty window proves nothing and its row tells
 * only whether its bundle parsed.
 */
const EDITIONS = [
  { edition: 'dist-web', page: '/web.html', root: process.env['CANOPI_FLOOR_DIST_WEB'] ?? 'dist-web', rendersInBrowser: true },
  { edition: 'dist', page: '/index.html', root: process.env['CANOPI_FLOOR_DIST'] ?? 'dist', rendersInBrowser: false },
] as const

test.describe('engine floor (canopi-4kfl)', () => {
  test('U canopi-4kfl: a module SyntaxError and a 404 module reach a classic capture listener before load', async ({ page }) => {
    const site = await serve(listenerSite())
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'load' })
      const events = await page.evaluate('window.__floor.events') as FloorEvent[]
      const userAgent = await page.evaluate('navigator.userAgent') as string
      console.log(`FLOOR-LISTENER ${JSON.stringify({ userAgent, events })}`)
      const syntax = events.filter(isSyntaxError)
      const missing = events.filter((event) => event.kind === 'element' && /missing-chunk|imports-missing/.test(event.url))
      expect(syntax.length, `a SyntaxError event reached the listener: ${JSON.stringify(events)}`).toBeGreaterThan(0)
      expect(syntax.every((event) => event.beforeLoad), 'the SyntaxError arrived before load').toBe(true)
      expect(missing.length, `an error event for the 404 chunk reached the listener: ${JSON.stringify(events)}`).toBeGreaterThan(0)
      expect(missing.every((event) => event.beforeLoad), 'the 404 chunk\'s error arrived before load').toBe(true)
    } finally {
      await site.close()
    }
  })

  for (const { edition, page: path, root, rendersInBrowser } of EDITIONS) {
    const title = rendersInBrowser
      ? `U canopi-4kfl: ${edition} renders alike with and without WebGL, and an empty window carries its engine error`
      : `U canopi-4kfl: ${edition} parses alike with and without WebGL`
    test(title, async ({ browser, browserName }, testInfo) => {
      test.setTimeout(180_000)
      test.skip(!existsSync(join(root, path)), `${edition} is not built at ${resolve(root)} (npm run build${edition === 'dist-web' ? ':web' : ''})`)
      const site = await serve(staticRoot(root))
      try {
        const withWebgl = await boot(browser, `${site.origin}${path}`, true)
        const withoutWebgl = await boot(browser, `${site.origin}${path}`, false)
        const engineErrors = (run: BootRun) => run.events.filter((event) => event.kind !== 'element' || /\.js(\?|$)/.test(event.url))
        const row = {
          edition, browserName, browserVersion: browser.version(),
          userAgent: await userAgentOf(browser),
          withWebgl, withoutWebgl,
          syntaxError: [...withWebgl.events, ...withoutWebgl.events].some(isSyntaxError),
        }
        console.log(`FLOOR-ROW ${JSON.stringify(row)}`)
        const rowFile = testInfo.outputPath('floor-row.json')
        mkdirSync(dirname(rowFile), { recursive: true })
        writeFileSync(rowFile, JSON.stringify(row, null, 2))
        expect(withoutWebgl.events.some(isSyntaxError), 'taking WebGL away changes whether the bundle parses').toBe(withWebgl.events.some(isSyntaxError))
        expect(withoutWebgl.rendered, 'taking WebGL away changes whether the window renders: the empty window would be WebGL\'s')
          .toBe(withWebgl.rendered)
        for (const run of rendersInBrowser ? [withWebgl, withoutWebgl] : []) {
          if (!run.rendered) {
            expect(engineErrors(run).length + run.pageErrors.length,
              `the empty window (WebGL ${run.webglAsked ? 'on' : 'off'}) carries the engine error that emptied it`).toBeGreaterThan(0)
          }
        }
      } finally {
        await site.close()
      }
    })
  }
})

async function userAgentOf(browser: Browser): Promise<string> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    return await page.evaluate('navigator.userAgent') as string
  } finally {
    await context.close()
  }
}

// Measured 2026-11-12 in the 1.64.1 image (WebKit 27.2) and the 1.20.0 image (WebKit 15.4): Playwright WebKit on Linux
// sends Safari's Mac user agent (Macintosh; Intel Mac OS X 10_15_7) while navigator.platform says Linux, so
// detectPlatform reads it as a Mac and a new Web profile would start on Trackpad (2.1-Q309). Every e2e wheel step
// therefore seeds the pointing device (support/canvas.ts). This pin runs only when the probe is dispatched or run by
// hand, not on a runner bump; the seed works whichever answer a bump brings, so a changed answer only means the seed
// may no longer be needed.
test.describe('the e2e user agent (canopi-pqxl)', () => {
  test('U canopi-pqxl: on a Linux host Playwright WebKit reads as a Mac, Chromium and Firefox as Linux (e2e default flip)', async ({ page, browserName }) => {
    test.skip(process.platform !== 'linux', 'the pin is about the Linux hosts CI and the pinned images run on')
    const nav = await page.evaluate('({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })') as
      { userAgent: string, platform: string, maxTouchPoints: number }
    console.log(`FLOOR-UA ${JSON.stringify({ browserName, ...nav })}`)
    expect(detectPlatform(nav, {}).os, `${browserName} reads as ${nav.userAgent} on ${nav.platform}`).toBe(browserName === 'webkit' ? 'mac' : 'linux')
  })
})
