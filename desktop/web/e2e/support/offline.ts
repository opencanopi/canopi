// The network rule of the Web Edition browser checks (canvas v2 plan section 3.2, "Network").
// Every committed scenario runs offline except for the preview server, so baselines never
// change with OpenFreeMap's tiles or the network's speed. Every spec imports `test` and
// `expect` from this file, never from '@playwright/test'.
import { test as base, expect, type ConsoleMessage } from '@playwright/test'
import { APP_ORIGIN, draftsKeptStub } from './storage-persistence'

/**
 * The Web plant catalog (catalog-input/, git-ignored) is generated from canopi-core.db by
 * `npm run generate:web-catalog`, so the job's `npm run build:web` has none. A checkout that has
 * generated it builds it into dist-web under assets/catalog/<content id>/, and the Place plants
 * card would then start DuckDB-WASM, whose worker comes from a CDN this file aborts. Every
 * checkout answers as the job does: the catalog is missing, whatever its id.
 */
const WEB_CATALOG = `${APP_ORIGIN}/app/assets/catalog/`

/** Firefox's whole console line for a cross-origin request that never got an answer; group 1 is the request's URL. */
const FIREFOX_ABORTED_CORS =
  /^\[JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at (\S+?)\. \(Reason: CORS request did not succeed\)\. Status code: \(null\)\."\]$/

/**
 * Console errors a scenario allows. Anything else logged as an error, and every uncaught
 * page error, fails the test.
 */
function isAllowedConsoleError(
  message: ConsoleMessage,
  aborted: ReadonlySet<string>,
  expected: readonly string[],
  expectedLines: readonly string[],
): boolean {
  const text = message.text()
  const source = message.location().url
  // A failure the scenario causes on purpose (`test.use({ expectedConsoleErrors })`).
  if (expected.some((prefix) => text.startsWith(prefix))) return true
  // The same, whole lines only, for a scenario where a prefix could let more through (`expectedConsoleLines`).
  if (expectedLines.includes(text)) return true
  // The Web Edition's default basemap is remote (OpenFreeMap). Its style request is aborted
  // below, so the basemap never installs and the map keeps its backdrop colour; the app logs
  // this (app/canvas-map-surface/workspace-map-controls.ts) and shows "Basemap couldn't load"
  // with Retry in the map's status chip, which every offline baseline records (U22).
  if (text.startsWith('Map basemap style failed to load:')) return true
  // The browser's own log line for a request this file aborted (Chromium:
  // "Failed to load resource: net::ERR_INTERNET_DISCONNECTED"); its location is the aborted
  // URL, so the line is caused only by the offline rule.
  if (text.startsWith('Failed to load resource:') && aborted.has(source)) return true
  // Firefox's line for a cross-origin request this file aborted has an empty location, so the URL is read from the
  // text, and only an aborted one passes.
  const blocked = FIREFOX_ABORTED_CORS.exec(text)
  if (blocked && aborted.has(blocked[1]!)) return true
  // The Web plant catalog's manifest, answered 404 below (WEB_CATALOG). The Place plants card
  // asks for it; "In this Design" still lists the Design's species without it.
  if (
    text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
    && source.startsWith(WEB_CATALOG) && source.endsWith('/manifest.json')
  ) return true
  return false
}

// Named `networkRule`: `offline` is Playwright's own context option.
export const test = base.extend<{
  networkRule: void,
  expectedConsoleErrors: readonly string[],
  expectedConsoleLines: readonly string[],
  forbiddenText: readonly string[],
  draftsKept: boolean,
  persistenceRule: void,
}>({
  /** Starts of the console errors a spec causes on purpose; a spec sets them with test.use. */
  expectedConsoleErrors: [[], { option: true }],
  /** Whole console error lines a spec causes on purpose, for a scenario with a secret in play. */
  expectedConsoleLines: [[], { option: true }],
  /**
   * Text no console message (of any type, allowed or not) and no uncaught page error may hold: a spec's test Google
   * key. A message's location URL is the browser's (a failed request's own URL) and is not checked.
   */
  forbiddenText: [[], { option: true }],
  /**
   * Whether the browser keeps Drafts from launch (support/storage-persistence.ts `draftsKeptStub`), for a scenario whose
   * baselines show the title bar and whose subject is not persistence. Off, each engine answers as a fresh profile does
   * (Chromium and WebKit refuse), and the save status warns once Drafts exist.
   */
  draftsKept: [false, { option: true }],
  persistenceRule: [async ({ context, draftsKept }, use) => {
    if (draftsKept) await context.addInitScript(draftsKeptStub)
    await use()
  }, { auto: true }],
  networkRule: [async ({ context, expectedConsoleErrors, expectedConsoleLines, forbiddenText }, use) => {
    const aborted = new Set<string>()
    await context.route('**/*', (route) => {
      const url = route.request().url()
      if (url.startsWith(WEB_CATALOG)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
      if (new URL(url).origin === APP_ORIGIN) return route.continue()
      aborted.add(url)
      return route.abort('internetdisconnected')
    })
    const unexpected: string[] = []
    // Reported by index, so a failure never prints the secret it found.
    const forbiddenIn = (text: string) => forbiddenText.findIndex((secret) => text.includes(secret))
    context.on('console', (message) => {
      const secret = forbiddenIn(message.text())
      if (secret >= 0) unexpected.push(`console ${message.type()} holds forbidden text #${secret}`)
      if (message.type() !== 'error' || isAllowedConsoleError(message, aborted, expectedConsoleErrors, expectedConsoleLines)) return
      if (secret < 0) unexpected.push(`console error: ${message.text()} (${message.location().url})`)
    })
    context.on('weberror', (error) => {
      const text = error.error().stack ?? error.error().message
      const secret = forbiddenIn(text)
      unexpected.push(secret >= 0 ? `uncaught error holds forbidden text #${secret}` : `uncaught: ${text}`)
    })
    await use()
    expect(unexpected, 'console errors and uncaught page errors').toEqual([])
  }, { auto: true }],
})

export { expect }
