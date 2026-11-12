// The format worker's probe (Step 2.0.4 R1-1, canopi-f47t.52.270; design check §5b R1): its riskiest assumption, probed
// first. The built Web Edition's module worker (src/platform/design-core.worker.ts) loads canopi-format-wasm, which
// links canopi-types and the canopi-redact leaf, and runs it in every engine Canopi supports. It drives no app: a blank
// page on the preview origin starts the worker from dist-web, as R1-6's adapter will, and asks the module's probe call.
// - Chromium (stands in for WebView2), Playwright WebKit and Firefox: the projects of playwright.config.ts.
// - WebKitGTK and WebView2 themselves: the WebDriver test, run by web-edition-browsers.yml's format-core-engines job
//   against WebKitWebDriver (MiniBrowser on Ubuntu 22.04's WebKitGTK, Desktop's Linux floor) and msedgedriver, with
//   CANOPI_FORMAT_PROBE_WEBDRIVER (the driver's URL) and CANOPI_FORMAT_PROBE_CAPABILITIES (its capabilities, JSON).
// - The engine floor: U's old WebKit images boot dist-web, which carries the worker (canopi-4kfl).
// The preview server labels the .wasm `application/wasm`, so the worker compiles it as it streams; a host that labels it
// otherwise gets the arrayBuffer fallback, and a load that fails answers `unavailable` and is retried by the next call.
// Measured 2026-11-12 (wasm-bindgen 0.2.130, Rust 1.97.1 release, no wasm-opt): the .wasm is 61,791 bytes, and the
// worker's chunk with the glue bundled in 3,655 (7,201 unminified); it instantiated with the default target features
// (reference types among them) in the pinned image's Chromium, WebKit and Firefox and in MiniBrowser on Ubuntu 22.04's
// WebKitGTK 2.50.4 through WebKitWebDriver, so no `-C target-cpu=mvp`.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import { APP_ORIGIN } from '../support/storage-persistence'

const ASSETS = fileURLToPath(new URL('../../dist-web/assets/', import.meta.url))
const PROBE_URL = `${APP_ORIGIN}/format-core-probe.html`
const PROBE_PAGE = '<!doctype html><html><body>format core probe</body></html>'
/** A path the shared corpus redacts to `<path>`: the probe text, which must never come back. */
const PROBE_TEXT = '/home/ana/plan.canopi'
const EXPECTED_VALUE = { current_version: 9, redacted: '<path>' }

/** The one built file of dist-web/assets whose name matches, as the URL the preview server serves it at. */
function builtAsset(pattern: RegExp): string {
  const matches = readdirSync(ASSETS).filter((name) => pattern.test(name))
  if (matches.length !== 1) throw new Error(`dist-web/assets holds ${matches.length} files matching ${pattern}; run npm run build:web`)
  return `${APP_ORIGIN}/assets/${matches[0]}`
}

const WORKER_URL = () => builtAsset(/^design-core\.worker-[\w-]{16}\.js$/)
const WASM_URL = () => builtAsset(/^canopi_format_wasm_bg-[\w-]{16}\.wasm$/)

interface ProbeRun {
  readonly workerUrl: string
  readonly texts: readonly string[]
  readonly between?: string
}

interface ProbeReply {
  readonly ok: boolean
  readonly value?: string
  readonly compiledBy?: string
  readonly error?: string
  readonly detail?: string
}

/**
 * Starts the worker at `workerUrl`, sends one probe call per entry of `texts` in order, each after the last answered
 * and the page function named `between` (if any) settled, and returns the answers; any worker error rejects.
 * Self-contained: the WebDriver test sends its source.
 */
async function runProbe({ workerUrl, texts, between }: ProbeRun): Promise<unknown[]> {
  const worker = new Worker(workerUrl, { type: 'module' })
  const replies: unknown[] = []
  try {
    for (const [index, text] of texts.entries()) {
      if (index > 0 && between) await (window as unknown as Record<string, () => Promise<void>>)[between]!()
      replies.push(await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(`worker error: ${event.message || 'no message'}`))
        worker.postMessage({ id: index + 1, call: 'probe', text })
      }))
    }
  } finally {
    worker.terminate()
  }
  return replies
}

async function openProbePage(page: Page): Promise<void> {
  await page.route(PROBE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PROBE_PAGE }))
  await page.goto(PROBE_URL)
}

function expectProbeAnswer(reply: ProbeReply, compiledBy: 'streaming' | 'arrayBuffer'): void {
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, compiledBy })
  expect(JSON.parse(reply.value ?? 'null')).toEqual(EXPECTED_VALUE)
}

test('canopi-f47t.52.270: the format worker instantiates canopi-format-wasm and runs the redact leaf in it', async ({ page, browserName }) => {
  const wasm = await page.request.get(WASM_URL())
  // The content-type check: the preview server, like Cloudflare Pages, labels the module so it compiles as it streams.
  expect(wasm.headers()['content-type']).toBe('application/wasm')
  await openProbePage(page)
  const [reply] = await page.evaluate(runProbe, { workerUrl: WORKER_URL(), texts: [PROBE_TEXT] }) as ProbeReply[]
  test.info().annotations.push({ type: `format worker, ${browserName}`, description: JSON.stringify(reply) })
  expectProbeAnswer(reply!, 'streaming')
})

test('canopi-f47t.52.270: a .wasm served without application/wasm loads through the arrayBuffer fallback', async ({ page, context }) => {
  const wasmUrl = WASM_URL()
  await context.route(wasmUrl, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'application/octet-stream' } })
  })
  await openProbePage(page)
  const [reply] = await page.evaluate(runProbe, { workerUrl: WORKER_URL(), texts: [PROBE_TEXT] }) as ProbeReply[]
  expectProbeAnswer(reply!, 'arrayBuffer')
})

test.describe('a format module that fails to load', () => {
  test.use({ expectedConsoleErrors: ['Failed to load resource: the server responded with a status of 404'] })

  test('canopi-f47t.52.270: a format module that fails to load answers unavailable, and the next call loads it', async ({ page, context }) => {
    const wasmUrl = WASM_URL()
    let missing = true
    await context.route(wasmUrl, (route) => (missing ? route.fulfill({ status: 404, body: 'Not Found' }) : route.fallback()))
    await openProbePage(page)
    await page.exposeFunction('restoreFormatModule', () => { missing = false })
    const replies = await page.evaluate(runProbe, { workerUrl: WORKER_URL(), texts: [PROBE_TEXT, PROBE_TEXT], between: 'restoreFormatModule' }) as ProbeReply[]
    expect(replies[0]).toMatchObject({ ok: false, error: 'unavailable' })
    expectProbeAnswer(replies[1]!, 'streaming')
  })
})

/** One WebDriver classic call; its `value`, or a thrown error naming the driver's. */
async function webDriver(base: string, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const answer = await response.json() as { value: unknown }
  if (!response.ok) throw new Error(`WebDriver ${method} ${path} answered ${response.status}: ${JSON.stringify(answer.value)}`)
  return answer.value
}

test('canopi-f47t.52.270: the format worker instantiates in a WebDriver engine (WebKitGTK, WebView2)', async ({ browserName }) => {
  const driver = process.env.CANOPI_FORMAT_PROBE_WEBDRIVER
  test.skip(!driver || browserName !== 'chromium', 'web-edition-browsers.yml format-core-engines runs it once per driver, beside the chromium project')
  const capabilities = JSON.parse(process.env.CANOPI_FORMAT_PROBE_CAPABILITIES ?? '{}') as Record<string, unknown>
  const session = await webDriver(driver!, 'POST', '/session', { capabilities: { alwaysMatch: capabilities } }) as { sessionId: string }
  try {
    const workerUrl = WORKER_URL()
    // Any document on the preview origin may start the worker; its own script is a small one.
    await webDriver(driver!, 'POST', `/session/${session.sessionId}/url`, { url: workerUrl })
    const script = `const done = arguments[arguments.length - 1];
      (${runProbe.toString()})({ workerUrl: arguments[0], texts: [arguments[1]] }).then(done, (error) => done([{ ok: false, error: 'thrown', detail: String(error) }]));`
    const [reply] = await webDriver(driver!, 'POST', `/session/${session.sessionId}/execute/async`, { script, args: [workerUrl, PROBE_TEXT] }) as ProbeReply[]
    test.info().annotations.push({ type: 'format worker, WebDriver engine', description: JSON.stringify(reply) })
    expectProbeAnswer(reply!, 'streaming')
  } finally {
    await webDriver(driver!, 'DELETE', `/session/${session.sessionId}`)
  }
})
