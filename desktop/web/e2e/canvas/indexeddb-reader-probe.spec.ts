// The reader release's IndexedDB probe (Step 2.0.4 R3-1, canopi-f47t.52.272; design check §5b R3, A18, A19): the Web
// stores stream's riskiest assumption, probed first in every engine. The reader release reads the 2.1 Draft store
// (`canopi-drafts`, contracts §11 "Web Drafts move to IndexedDB") without ever creating it, and never blocks 2.1's
// upgrade (2.1-Q40, 2.1-M486). It drives no app: a blank page on the preview origin asks each engine directly, through
// the page functions of support/web-storage.ts, which R3-2's reader and R4's rollback harness follow.
// - Chromium, Playwright WebKit and Firefox: the projects of playwright.config.ts, a reader page and a 2.1 page in one
//   context (one origin, two tabs).
// - WebKitGTK (Desktop's Linux floor) and Edge (WebView2's engine): the WebDriver test, run beside the chromium project
//   by web-edition-browsers.yml's format-core-engines job (its CANOPI_FORMAT_PROBE_WEBDRIVER and
//   CANOPI_FORMAT_PROBE_CAPABILITIES); one page holds both connections there, which is the same versionchange path.
// Measured 2026-11-13 in mcr.microsoft.com/playwright:v1.64.1-noble, Chromium, WebKit and Firefox alike: see each
// test's comment. WebKitGTK and Edge: first answered by the CI job.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import { APP_ORIGIN } from '../support/storage-persistence'
import {
  DRAFT_DATABASE,
  DRAFT_DATABASE_VERSION,
  createDraftStore,
  databaseVersions,
  deleteOutcome,
  heldUpgradeEnd,
  openAndAbortAtZero,
  openReaderConnection,
  readerEvents,
  removeDatabases,
  startHeldUpgrade,
  startPendingRead,
  pendingRead,
  upgradeOutcome,
} from '../support/web-storage'

const PROBE_URL = `${APP_ORIGIN}/indexeddb-reader-probe.html`
const PROBE_PAGE = '<!doctype html><html><body>IndexedDB reader probe</body></html>'
/** 2.1's next Draft store version, as a later 2.1 would upgrade to it. */
const NEXT_VERSION = DRAFT_DATABASE_VERSION + 1

async function openProbe(page: Page): Promise<Page> {
  await page.route(PROBE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PROBE_PAGE }))
  await page.goto(PROBE_URL)
  return page
}

/** A second tab on the same origin: the 2.1 page beside the reader. */
async function laterPage(page: Page): Promise<Page> {
  return await openProbe(await page.context().newPage())
}

// Measured: every engine refuses the upgrade from version 0 with an AbortError and keeps no database; databases() lists
// none, and a second open again starts from version 0.
test('canopi-f47t.52.272: probe: an open aborted at oldVersion 0 leaves no database', async ({ page }) => {
  await openProbe(page)
  expect(await page.evaluate(openAndAbortAtZero, DRAFT_DATABASE)).toEqual({ found: false, error: 'AbortError' })
  expect(await page.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
  await page.reload()
  expect(await page.evaluate(openAndAbortAtZero, DRAFT_DATABASE), 'a later open again starts from version 0').toEqual({ found: false, error: 'AbortError' })
  expect(await page.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
})

// The failure state's detector: an open that is not aborted leaves version 1 behind, and both reads see it, so the
// checks above would fail on an engine that kept the aborted database.
test('canopi-f47t.52.272: probe: a database left behind by an open that was not aborted is seen by both reads', async ({ page }) => {
  await openProbe(page)
  await page.evaluate(async (name) => await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  }), DRAFT_DATABASE)
  const versions = await page.evaluate(databaseVersions, { name: DRAFT_DATABASE })
  expect(versions).toEqual([1])
  expect(await page.evaluate(openAndAbortAtZero, DRAFT_DATABASE)).toEqual({ found: true, version: 1, stores: [] })
})

// Measured: databases() never creates the database; while 2.1's first upgrade is held open, the reader's databases()
// answers at once without it (all three engines, 3 runs each) and its open-and-abort waits; both see version 4 once the
// upgrade commits.
test('canopi-f47t.52.272: probe: databases() creates no database and sees a 2.1 database only once its upgrade commits', async ({ page }) => {
  const reader = await openProbe(page)
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE }), 'a second call still finds none').toEqual([])
  const later = await laterPage(page)
  await later.evaluate(startHeldUpgrade, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION })

  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE, waitMs: 1500 }), 'no 2.1 database is seen before its upgrade commits')
    .toEqual([])
  await reader.evaluate(startPendingRead, DRAFT_DATABASE)
  expect(await reader.evaluate(pendingRead, 1000), 'the reader\'s open waits for the upgrade').toBe('pending')

  expect(await later.evaluate(heldUpgradeEnd, 'commit' as const)).toBe('committed')
  expect(await reader.evaluate(pendingRead, 5000), 'and then reads the committed store')
    .toEqual({ found: true, version: DRAFT_DATABASE_VERSION, stores: ['drafts', 'meta'] })
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([DRAFT_DATABASE_VERSION])
})

// The race behind "abort leaves a database behind": 2.1's first upgrade aborts while the reader's open waits; the
// reader's open then starts from version 0, aborts too, and no database is left.
test('canopi-f47t.52.272: probe: when 2.1\'s first upgrade aborts under a waiting read, no database is left', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(startHeldUpgrade, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION })
  await reader.evaluate(startPendingRead, DRAFT_DATABASE)
  expect(await later.evaluate(heldUpgradeEnd, 'abort' as const)).toBe('AbortError')
  expect(await reader.evaluate(pendingRead, 5000)).toEqual({ found: false, error: 'AbortError' })
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
})

// Measured: a later page's open at version 5 fires versionchange (4 to 5) on the reader's connection; closing there lets
// the upgrade run without a blocked event.
test('canopi-f47t.52.272: probe: a versionchange from another page reaches the reader connection, and closing there avoids blocked', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records: [], copiedIds: [] })
  expect(await reader.evaluate(openReaderConnection, { name: DRAFT_DATABASE, closeOnVersionChange: true }))
    .toEqual({ found: true, version: DRAFT_DATABASE_VERSION, stores: ['drafts', 'meta'] })

  expect(await later.evaluate(upgradeOutcome, { name: DRAFT_DATABASE, version: NEXT_VERSION, waitMs: 5000 }))
    .toEqual({ blocked: false, outcome: 'upgraded' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: true }])
})

// The control: a reader that keeps its connection through versionchange blocks the upgrade, so the test above sees the
// close and not an engine that never blocks.
test('canopi-f47t.52.272: probe: a reader connection kept open through versionchange blocks 2.1\'s upgrade', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records: [], copiedIds: [] })
  await reader.evaluate(openReaderConnection, { name: DRAFT_DATABASE, closeOnVersionChange: false })
  expect(await later.evaluate(upgradeOutcome, { name: DRAFT_DATABASE, version: NEXT_VERSION, waitMs: 2000 }))
    .toEqual({ blocked: true, outcome: 'pending' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: false }])
})

// Measured: a later page's deleteDatabase fires versionchange with a null newVersion; closing there lets the delete run.
test('canopi-f47t.52.272: probe: a delete from another page reaches the reader connection with no new version, and closing there avoids blocked', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records: [], copiedIds: [] })
  await reader.evaluate(openReaderConnection, { name: DRAFT_DATABASE, closeOnVersionChange: true })
  expect(await later.evaluate(deleteOutcome, { name: DRAFT_DATABASE, waitMs: 5000 })).toEqual({ blocked: false, outcome: 'deleted' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: null, closed: true }])
  expect(await reader.evaluate(openAndAbortAtZero, DRAFT_DATABASE)).toEqual({ found: false, error: 'AbortError' })
})

// Firefox without databases() (before 126), or any engine without it: the reader's feature test fails, and the
// open-and-abort fallback alone answers, creating nothing; a page with databases() confirms.
test('canopi-f47t.52.272: probe: with databases() removed, the open-and-abort fallback finds the store or creates none', async ({ page }) => {
  await page.addInitScript(removeDatabases)
  const reader = await openProbe(page)
  expect(await reader.evaluate(() => 'databases' in indexedDB), 'databases() is gone').toBe(false)
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toBeNull()
  expect(await reader.evaluate(openAndAbortAtZero, DRAFT_DATABASE)).toEqual({ found: false, error: 'AbortError' })

  const later = await laterPage(page)
  expect(await later.evaluate(databaseVersions, { name: DRAFT_DATABASE }), 'the fallback created no database').toEqual([])
  await later.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records: [], copiedIds: [] })
  expect(await reader.evaluate(openAndAbortAtZero, DRAFT_DATABASE))
    .toEqual({ found: true, version: DRAFT_DATABASE_VERSION, stores: ['drafts', 'meta'] })
})

const ASSETS = fileURLToPath(new URL('../../dist-web/assets/', import.meta.url))

/** A small built file on the preview origin, as a document for the WebDriver page (any same-origin document will do). */
function builtWorkerUrl(): string {
  const matches = readdirSync(ASSETS).filter((name) => /^design-core\.worker-[\w-]{16}\.js$/.test(name))
  if (matches.length !== 1) throw new Error(`dist-web/assets holds ${matches.length} format workers; run npm run build:web`)
  return `${APP_ORIGIN}/assets/${matches[0]}`
}

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

test('canopi-f47t.52.272: probe: the IndexedDB reader behaviours hold in a WebDriver engine (WebKitGTK, WebView2)', async ({ browserName }) => {
  const driver = process.env.CANOPI_FORMAT_PROBE_WEBDRIVER
  test.skip(!driver || browserName !== 'chromium', 'web-edition-browsers.yml format-core-engines runs it once per driver, beside the chromium project')
  const capabilities = JSON.parse(process.env.CANOPI_FORMAT_PROBE_CAPABILITIES ?? '{}') as Record<string, unknown>
  const session = await webDriver(driver!, 'POST', '/session', { capabilities: { alwaysMatch: capabilities } }) as { sessionId: string }
  /** Runs one page function of support/web-storage.ts in the driver's page with `arg`, and returns its answer. */
  const run = async (fn: (arg: never) => unknown, arg?: unknown): Promise<unknown> => {
    const script = `const done = arguments[arguments.length - 1];
      Promise.resolve().then(() => (${fn.toString()})(arguments[0])).then((value) => done({ value: value === undefined ? null : value }), (error) => done({ thrown: String(error) }));`
    const answer = await webDriver(driver!, 'POST', `/session/${session.sessionId}/execute/async`, { script, args: [arg ?? null] }) as { value?: unknown, thrown?: string }
    if (answer.thrown !== undefined) throw new Error(`${fn.name} threw in the WebDriver engine: ${answer.thrown}`)
    return answer.value
  }
  try {
    await webDriver(driver!, 'POST', `/session/${session.sessionId}/url`, { url: builtWorkerUrl() })
    const name = `${DRAFT_DATABASE}-webdriver-probe`
    // A previous run's database, if the driver's profile kept one.
    await run(deleteOutcome, { name, waitMs: 5000 })
    expect(await run(openAndAbortAtZero, name), 'an aborted open').toEqual({ found: false, error: 'AbortError' })
    const hasDatabases = await run(databaseVersions, { name }) !== null
    if (hasDatabases) expect(await run(databaseVersions, { name }), 'databases() creates none').toEqual([])

    await run(startHeldUpgrade, { name, version: DRAFT_DATABASE_VERSION })
    if (hasDatabases) expect(await run(databaseVersions, { name, waitMs: 1500 }), 'databases() during the held upgrade').toEqual([])
    await run(startPendingRead, name)
    expect(await run(heldUpgradeEnd, 'commit')).toBe('committed')
    expect(await run(pendingRead, 5000)).toEqual({ found: true, version: DRAFT_DATABASE_VERSION, stores: ['drafts', 'meta'] })

    await run(openReaderConnection, { name, closeOnVersionChange: true })
    expect(await run(upgradeOutcome, { name, version: NEXT_VERSION, waitMs: 5000 }), 'versionchange then close').toEqual({ blocked: false, outcome: 'upgraded' })
    expect(await run(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: true }])

    await run(openReaderConnection, { name, closeOnVersionChange: true })
    expect(await run(deleteOutcome, { name, waitMs: 5000 }), 'a delete with the reader open').toEqual({ blocked: false, outcome: 'deleted' })
    expect(await run(readerEvents)).toEqual([{ oldVersion: NEXT_VERSION, newVersion: null, closed: true }])

    await run(removeDatabases)
    expect(await run(databaseVersions, { name }), 'databases() removed').toBeNull()
    expect(await run(openAndAbortAtZero, name), 'the fallback').toEqual({ found: false, error: 'AbortError' })
  } finally {
    await webDriver(driver!, 'DELETE', `/session/${session.sessionId}`)
  }
})
