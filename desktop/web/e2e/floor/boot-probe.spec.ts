// The engine-floor probe (canopi-4kfl, Step 2.0.4 U-2; canopi-pqxl for the user agent). A Mac user on an old Safari saw
// an empty window. Step 2.0.4 bets on three things, and this spec checks each one in the engine it runs in:
// - the empty window comes from the engine floor (the bundle does not parse or run), not from a missing WebGL: each
//   edition's built page boots once with WebGL and once with WebGL taken away, and the two must render alike; a window
//   left empty must carry the engine error that emptied it;
// - a module SyntaxError and a module that answers 404 reach a classic `error` capture listener before `load`, which is
//   what the start-up guard (U-4) listens for; the Web Edition's start-up guard shows exactly when its window is empty;
// - what Playwright WebKit on a Linux host reports as its user agent, which decides whether the macOS Trackpad default
//   (2.1-Q309, U-1) flips an e2e run's scroll setting: it does, and the pin at the end says why e2e seeds it.
// Since U-2 set the floor (Safari 16.4, desktop/web/engine-floor.ts; U-3) it also holds that floor in the engines on
// both sides of it: a class static block, the floor's cause, parses in a WebKit at or above the floor and is refused
// below it, and the Web Edition's format worker (design-core.worker, canopi-format-wasm) starts straight from
// dist-web/assets on a blank page and answers its read call at and above the floor, as e2e/canvas/format-core-probe.spec.ts
// starts it, while a worker that answers 404 or does not compile turns that probe red (the R1-1 hand-off: the module
// must instantiate on the floor engine).
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { detectPlatform } from '../../src/canvas/runtime/input/platform'
import { compareVersions, ENGINE_FLOOR } from '../../engine-floor'

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
  /** The start-up guard (src/boot-guard/guard.ts) shows "Canopi couldn't start". */
  guard: boolean
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
        webglAvailable: !!gl, guard: !!document.querySelector('[data-boot-guard]'), events: window.__floor ? window.__floor.events : [] };
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

/** Whether this run's engine is a WebKit below the floor's Safari, where Canopi supports nothing (2.1-Q306). */
const belowFloor = (browser: Browser, browserName: string) => browserName === 'webkit' && compareVersions(browser.version(), ENGINE_FLOOR.safari) < 0

const BLANK_PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body>engine floor probe</body></html>'
/** A worker module no engine compiles, and the floor's cause (a class static block) as a module of its own. */
const BROKEN_WORKER = 'export const = ;\n'
const STATIC_BLOCK = 'export class Held { static { this.ready = true } }\n'

/** A built edition (or none) behind a blank page, a broken worker and a static-block module, all on one origin. */
function probeSite(root: string | undefined): Handler {
  const built = root ? staticRoot(root) : undefined
  const bodies: Readonly<Record<string, readonly [string, string]>> = {
    '/__blank.html': [TYPES['.html']!, BLANK_PAGE],
    '/__broken-worker.js': [TYPES['.js']!, BROKEN_WORKER],
    '/__static-block.js': [TYPES['.js']!, STATIC_BLOCK],
  }
  return (request, response) => {
    const body = bodies[(request.url ?? '/').split('?')[0] ?? '/']
    if (body) {
      response.writeHead(200, { 'content-type': body[0] })
      response.end(body[1])
      return
    }
    if (built) return built(request, response)
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not Found')
  }
}

/** The format worker's built file in dist-web/assets, or undefined when the Web Edition is not built. */
function formatWorker(root: string): string | undefined {
  const assets = join(root, 'assets')
  if (!existsSync(assets)) return undefined
  return readdirSync(assets).find((name) => /^design-core\.worker-[\w-]{16}\.js$/.test(name))
}

/** The frozen v10 fixture and the read view canopi-format gives for it, as format-core-probe.spec.ts sends them: the
 * worker's one call is `read` (R1-6). CANOPI_FLOOR_FORMAT_SPEC names their directory (default: the repository's, from
 * desktop/web); a working-directory path, since the old runners compile this file without import.meta. */
const FORMAT_SPEC = process.env['CANOPI_FLOOR_FORMAT_SPEC'] ?? '../../canopi-format/spec/v10'
const PROBE_TEXT = readFileSync(join(FORMAT_SPEC, 'read-fixture.canopi'), 'utf8')
const EXPECTED_VALUE = { read: JSON.parse(readFileSync(join(FORMAT_SPEC, 'read-expected.json'), 'utf8')) as unknown }

interface WorkerRun { reply?: { ok?: boolean, value?: string, compiledBy?: string, error?: string, detail?: string }, error?: string, timedOut?: boolean }

/** Starts the module worker at `url`, sends it one read call and settles with its reply, its error or a timeout (ES5). */
function runWorker(page: Page, url: string): Promise<WorkerRun> {
  return page.evaluate(`new Promise(function (resolve) {
    var worker;
    try { worker = new Worker(${JSON.stringify(url)}, { type: 'module' }); } catch (error) { resolve({ error: 'not started: ' + error }); return; }
    var timer = setTimeout(function () { worker.terminate(); resolve({ timedOut: true }); }, 30000);
    worker.onmessage = function (event) { clearTimeout(timer); worker.terminate(); resolve({ reply: event.data }); };
    worker.onerror = function (event) { clearTimeout(timer); worker.terminate(); resolve({ error: 'worker error: ' + (event.message || 'no message') }); };
    worker.postMessage({ id: 1, call: 'read', text: ${JSON.stringify(PROBE_TEXT)} });
  })`) as Promise<WorkerRun>
}

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
          // The start-up guard (U-4) replaces the empty window below the floor, and never shows over a rendered one.
          expect(run.guard, `the start-up guard shows exactly when the window is empty (WebGL ${run.webglAsked ? 'on' : 'off'})`).toBe(!run.rendered)
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

  test('U canopi-4kfl: a class static block parses in a WebKit at or above the floor and is refused below it', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'the floor is a Safari version: the WebKit rows hold it')
    const site = await serve(probeSite(undefined))
    try {
      await page.goto(`${site.origin}/__blank.html`)
      const outcome = await page.evaluate(`import('/__static-block.js').then(function () { return 'parsed' }, function (error) { return String(error && error.name) + ': ' + String(error && error.message) })`) as string
      console.log(`FLOOR-STATIC-BLOCK ${JSON.stringify({ browserVersion: browser.version(), floor: ENGINE_FLOOR.safari, outcome })}`)
      if (belowFloor(browser, browserName)) expect(outcome, `WebKit ${browser.version()} is below the floor and must refuse a static block`).toMatch(/SyntaxError/)
      else expect(outcome, `WebKit ${browser.version()} is at or above the floor and must parse a static block`).toBe('parsed')
    } finally {
      await site.close()
    }
  })

  test('U canopi-4kfl: the format worker starts from dist-web/assets on a blank page and answers its probe at and above the floor', async ({ page, browser, browserName }) => {
    test.setTimeout(120_000)
    const root = EDITIONS[0].root
    const worker = formatWorker(root)
    test.skip(!worker, `dist-web is not built at ${resolve(root)} with its format worker (npm run build:web)`)
    test.skip(belowFloor(browser, browserName), `WebKit ${browser.version()} is below the floor (Safari ${ENGINE_FLOOR.safari}): nothing is supported there`)
    const site = await serve(probeSite(root))
    try {
      await page.goto(`${site.origin}/__blank.html`)
      const run = await runWorker(page, `${site.origin}/assets/${worker}`)
      console.log(`FLOOR-FORMAT-WORKER ${JSON.stringify({ browserName, browserVersion: browser.version(), run })}`)
      expect(run.reply, JSON.stringify(run)).toMatchObject({ ok: true })
      expect(JSON.parse(run.reply?.value ?? 'null'), JSON.stringify(run)).toEqual(EXPECTED_VALUE)
    } finally {
      await site.close()
    }
  })

  // The inverted step: the probe above must be able to go red, or its green proves nothing.
  test('U canopi-4kfl: the format worker probe goes red for a worker that answers 404 and for one the engine cannot compile', async ({ page }) => {
    const site = await serve(probeSite(undefined))
    try {
      await page.goto(`${site.origin}/__blank.html`)
      const missing = await runWorker(page, `${site.origin}/assets/design-core.worker-missing.js`)
      const broken = await runWorker(page, `${site.origin}/__broken-worker.js`)
      console.log(`FLOOR-FORMAT-WORKER-RED ${JSON.stringify({ missing, broken })}`)
      for (const run of [missing, broken]) {
        expect(run.reply, JSON.stringify(run)).toBeUndefined()
        expect(run.error, JSON.stringify(run)).toMatch(/^worker error/)
      }
    } finally {
      await site.close()
    }
  })
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
