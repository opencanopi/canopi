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
  existenceRead,
  heldUpgradeEnd,
  pendingRead,
  readerEvents,
  removeDatabases,
  startHeldUpgrade,
  versionChangeOutcome,
} from '../support/web-storage'

const PROBE_URL = `${APP_ORIGIN}/indexeddb-reader-probe.html`
const PROBE_PAGE = '<!doctype html><html><body>IndexedDB reader probe</body></html>'
/** 2.1's next Draft store version, as a later 2.1 would upgrade to it. */
const NEXT_VERSION = DRAFT_DATABASE_VERSION + 1
const ABSENT = { found: false, error: 'AbortError' } as const
const DRAFT_STORE = { found: true, version: DRAFT_DATABASE_VERSION, stores: ['drafts', 'meta'] } as const
const EMPTY_DRAFT_STORE = { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records: [], copiedIds: [] }

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
  expect(await page.evaluate(existenceRead, { name: DRAFT_DATABASE })).toEqual(ABSENT)
  expect(await page.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
  await page.reload()
  expect(await page.evaluate(existenceRead, { name: DRAFT_DATABASE }), 'a later open again starts from version 0').toEqual(ABSENT)
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
  expect(await page.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([1])
  expect(await page.evaluate(existenceRead, { name: DRAFT_DATABASE })).toEqual({ found: true, version: 1, stores: [] })
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
  expect(await reader.evaluate(existenceRead, { name: DRAFT_DATABASE, deferred: true })).toBe('started')
  expect(await reader.evaluate(pendingRead, 1000), 'the reader\'s open waits for the upgrade').toBe('pending')

  expect(await later.evaluate(heldUpgradeEnd, 'commit' as const)).toBe('committed')
  expect(await reader.evaluate(pendingRead, 5000), 'and then reads the committed store').toEqual(DRAFT_STORE)
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([DRAFT_DATABASE_VERSION])
})

// The race behind "abort leaves a database behind": 2.1's first upgrade aborts while the reader's open waits; the
// reader's open then starts from version 0, aborts too, and no database is left.
test('canopi-f47t.52.272: probe: when 2.1\'s first upgrade aborts under a waiting read, no database is left', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(startHeldUpgrade, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION })
  await reader.evaluate(existenceRead, { name: DRAFT_DATABASE, deferred: true })
  expect(await later.evaluate(heldUpgradeEnd, 'abort' as const)).toBe('AbortError')
  expect(await reader.evaluate(pendingRead, 5000)).toEqual(ABSENT)
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toEqual([])
})

// Measured: a later page's open at version 5 fires versionchange (4 to 5) on the reader's connection; closing there lets
// the upgrade run without a blocked event.
test('canopi-f47t.52.272: probe: a versionchange from another page reaches the reader connection, and closing there avoids blocked', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, EMPTY_DRAFT_STORE)
  expect(await reader.evaluate(existenceRead, { name: DRAFT_DATABASE, connection: 'close-on-versionchange' as const })).toEqual(DRAFT_STORE)

  expect(await later.evaluate(versionChangeOutcome, { name: DRAFT_DATABASE, to: NEXT_VERSION, waitMs: 5000 }))
    .toEqual({ blocked: false, outcome: 'upgraded' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: true }])
})

// The control: a reader that keeps its connection through versionchange blocks the upgrade, so the test above sees the
// close and not an engine that never blocks.
test('canopi-f47t.52.272: probe: a reader connection kept open through versionchange blocks 2.1\'s upgrade', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, EMPTY_DRAFT_STORE)
  await reader.evaluate(existenceRead, { name: DRAFT_DATABASE, connection: 'keep-open' as const })
  expect(await later.evaluate(versionChangeOutcome, { name: DRAFT_DATABASE, to: NEXT_VERSION, waitMs: 2000 }))
    .toEqual({ blocked: true, outcome: 'pending' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: false }])
})

// Measured: a later page's deleteDatabase fires versionchange with a null newVersion; closing there lets the delete run.
test('canopi-f47t.52.272: probe: a delete from another page reaches the reader connection with no new version, and closing there avoids blocked', async ({ page }) => {
  const reader = await openProbe(page)
  const later = await laterPage(page)
  await later.evaluate(createDraftStore, EMPTY_DRAFT_STORE)
  await reader.evaluate(existenceRead, { name: DRAFT_DATABASE, connection: 'close-on-versionchange' as const })
  expect(await later.evaluate(versionChangeOutcome, { name: DRAFT_DATABASE, to: 'delete' as const, waitMs: 5000 }))
    .toEqual({ blocked: false, outcome: 'deleted' })
  expect(await reader.evaluate(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: null, closed: true }])
  expect(await reader.evaluate(existenceRead, { name: DRAFT_DATABASE })).toEqual(ABSENT)
})

// Firefox without databases() (before 126), or any engine without it: the reader's feature test fails, and the
// open-and-abort fallback alone answers, creating nothing; a page with databases() confirms.
test('canopi-f47t.52.272: probe: with databases() removed, the open-and-abort fallback finds the store or creates none', async ({ page }) => {
  await page.addInitScript(removeDatabases)
  const reader = await openProbe(page)
  expect(await reader.evaluate(() => 'databases' in indexedDB), 'databases() is gone').toBe(false)
  expect(await reader.evaluate(databaseVersions, { name: DRAFT_DATABASE })).toBeNull()
  expect(await reader.evaluate(existenceRead, { name: DRAFT_DATABASE })).toEqual(ABSENT)

  const later = await laterPage(page)
  expect(await later.evaluate(databaseVersions, { name: DRAFT_DATABASE }), 'the fallback created no database').toEqual([])
  await later.evaluate(createDraftStore, EMPTY_DRAFT_STORE)
  expect(await reader.evaluate(existenceRead, { name: DRAFT_DATABASE })).toEqual(DRAFT_STORE)
})

/** A same-origin document for the WebDriver page: the built format worker's script (any document on the origin will do). */
function sameOriginDocument(): string {
  const assets = fileURLToPath(new URL('../../dist-web/assets/', import.meta.url))
  const [worker, ...more] = readdirSync(assets).filter((name) => /^design-core\.worker-[\w-]{16}\.js$/.test(name))
  if (!worker || more.length > 0) throw new Error('dist-web/assets needs exactly one format worker; run npm run build:web')
  return `${APP_ORIGIN}/assets/${worker}`
}

interface DriverPage {
  /** Runs a page function of support/web-storage.ts in the driver's page and returns its answer. */
  run(fn: (arg: never) => unknown, arg?: unknown): Promise<unknown>
  quit(): Promise<void>
}

/** A WebDriver classic session at `base` on a same-origin document. */
async function driverPage(base: string, capabilities: Record<string, unknown>): Promise<DriverPage> {
  const send = async (path: string, init: { method: string, body?: unknown }): Promise<unknown> => {
    const reply = await fetch(`${base}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json' },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    })
    const { value } = await reply.json() as { value: unknown }
    if (reply.status >= 400) throw new Error(`${init.method} ${path}: ${reply.status} ${JSON.stringify(value)}`)
    return value
  }
  const { sessionId } = await send('/session', { method: 'POST', body: { capabilities: { alwaysMatch: capabilities } } }) as { sessionId: string }
  await send(`/session/${sessionId}/url`, { method: 'POST', body: { url: sameOriginDocument() } })
  return {
    async run(fn, arg) {
      const script = `const done = arguments[arguments.length - 1];
        Promise.resolve().then(() => (${fn.toString()})(arguments[0])).then((value) => done({ value: value === undefined ? null : value }), (error) => done({ thrown: String(error) }));`
      const answer = await send(`/session/${sessionId}/execute/async`, { method: 'POST', body: { script, args: [arg ?? null] } }) as { value?: unknown, thrown?: string }
      if (answer.thrown !== undefined) throw new Error(`${fn.name} threw in the WebDriver engine: ${answer.thrown}`)
      return answer.value
    },
    async quit() { await send(`/session/${sessionId}`, { method: 'DELETE' }) },
  }
}

test('canopi-f47t.52.272: probe: the IndexedDB reader behaviours hold in a WebDriver engine (WebKitGTK, WebView2)', async ({ browserName }) => {
  const driver = process.env.CANOPI_FORMAT_PROBE_WEBDRIVER
  test.skip(!driver || browserName !== 'chromium', 'web-edition-browsers.yml format-core-engines runs it once per driver, beside the chromium project')
  const engine = await driverPage(driver!, JSON.parse(process.env.CANOPI_FORMAT_PROBE_CAPABILITIES ?? '{}') as Record<string, unknown>)
  try {
    const name = `${DRAFT_DATABASE}-webdriver-probe`
    // A previous run's database, if the driver's profile kept one.
    await engine.run(versionChangeOutcome, { name, to: 'delete', waitMs: 5000 })
    expect(await engine.run(existenceRead, { name }), 'an aborted open').toEqual(ABSENT)
    const hasDatabases = await engine.run(databaseVersions, { name }) !== null
    if (hasDatabases) expect(await engine.run(databaseVersions, { name }), 'databases() creates none').toEqual([])

    await engine.run(startHeldUpgrade, { name, version: DRAFT_DATABASE_VERSION })
    if (hasDatabases) expect(await engine.run(databaseVersions, { name, waitMs: 1500 }), 'databases() during the held upgrade').toEqual([])
    await engine.run(existenceRead, { name, deferred: true })
    expect(await engine.run(heldUpgradeEnd, 'commit')).toBe('committed')
    expect(await engine.run(pendingRead, 5000)).toEqual(DRAFT_STORE)

    await engine.run(existenceRead, { name, connection: 'close-on-versionchange' })
    expect(await engine.run(versionChangeOutcome, { name, to: NEXT_VERSION, waitMs: 5000 }), 'versionchange then close')
      .toEqual({ blocked: false, outcome: 'upgraded' })
    expect(await engine.run(readerEvents)).toEqual([{ oldVersion: DRAFT_DATABASE_VERSION, newVersion: NEXT_VERSION, closed: true }])

    await engine.run(existenceRead, { name, connection: 'close-on-versionchange' })
    expect(await engine.run(versionChangeOutcome, { name, to: 'delete', waitMs: 5000 }), 'a delete with the reader open')
      .toEqual({ blocked: false, outcome: 'deleted' })
    expect(await engine.run(readerEvents)).toEqual([{ oldVersion: NEXT_VERSION, newVersion: null, closed: true }])

    await engine.run(removeDatabases)
    expect(await engine.run(databaseVersions, { name }), 'databases() removed').toBeNull()
    expect(await engine.run(existenceRead, { name }), 'the fallback').toEqual(ABSENT)
  } finally {
    await engine.quit()
  }
})
