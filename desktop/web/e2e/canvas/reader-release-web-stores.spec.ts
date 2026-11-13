// The reader release's Web stores (Step 2.0.4 R3, canopi-f47t.52.272; contracts §11 "Web Drafts move to IndexedDB",
// 2.1-Q321, 2.1-Q322, 2.1-Q323, 2.1-M486). After a rollback from 2.1, the Web Edition lists the Drafts 2.1 keeps in
// the IndexedDB database `canopi-drafts` (version 4; stores `drafts`, key `id`, and `meta`, key `key`, holding the move
// record) read-only beside the editable ones, hides every old-key Draft the 2.1 move copied, restores nothing at launch
// while 2.1 Drafts exist, creates no database on an origin without one, and never blocks 2.1's upgrade.
//
// Written failing in commit 0 and marked expected-fail (`test.fail`): R3's chunk that builds each path removes its
// marker. The records are seeded in the contract's shape before the load; R3-4 may swap in its frozen fixture.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import { DRAFT_DATABASE, DRAFT_DATABASE_VERSION, createDraftStore, draftStoreDump, type DraftRecord } from '../support/web-storage'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const V3_DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'

function baseDesign(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
}

/** A Design as 2.1 writes it: `.canopi` v10, with the plant `scale` renamed `canopy_spread_m` (2.1-Q314). */
function v10Content(name: string): string {
  const design = baseDesign()
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return JSON.stringify({ ...design, version: 10, name, plants })
}

function draftRecord(id: string, name: string, day: number): DraftRecord {
  return {
    id,
    canopi_version: '2.1.0',
    version: 3,
    name,
    updated_at: new Date(Date.UTC(2026, 11, day)).toISOString(),
    content: v10Content(name),
  }
}

/** The 2.0 Drafts record under the old key: what a 2.0 tab wrote, and what the 2.1 move copied. */
function v3DraftsRecord(drafts: readonly { id: string, name: string, day: number }[]): string {
  const design = baseDesign()
  return JSON.stringify({
    version: 3,
    drafts: drafts.map(({ id, name, day }) => ({ id, name, updatedAt: new Date(Date.UTC(2026, 9, day)).toISOString() })),
    draftFiles: Object.fromEntries(drafts.map(({ id, name }) => [id, { ...design, name }])),
  })
}

/** Writes the 2.1 Draft store as 2.1 leaves it: its Draft records and the move record naming the copied ids. */
async function seedDraftStore(page: Page, records: readonly DraftRecord[], copiedIds: readonly string[]): Promise<void> {
  await page.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records, copiedIds })
}

/** Every record of the Draft store and every localStorage entry: what "writes nothing" compares. */
async function storageDump(page: Page): Promise<unknown> {
  const local = await page.evaluate(() => Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]))
  return { local, stores: await page.evaluate(draftStoreDump, DRAFT_DATABASE) }
}

function startScreen(page: Page) {
  return page.locator('[data-start-screen]')
}

function draftRow(page: Page, name: string) {
  return startScreen(page).locator('li').filter({ hasText: name })
}

test.fail('R3 canopi-f47t.52.272: reader release: Web lists IndexedDB Drafts read-only and hides old-key Drafts the 2.1 move copied', async ({ page }) => {
  await page.goto('')
  await seedDraftStore(page, [draftRecord('orchard', 'Orchard in 2.1', 3)], ['orchard'])
  // The old key still holds the Draft the move copied, under the same id, and a Draft a 2.0 tab made after the move.
  await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [
    V3_DRAFTS_KEY,
    v3DraftsRecord([{ id: 'orchard', name: 'Orchard as 2.0 left it', day: 1 }, { id: 'hedge', name: 'Hedge', day: 2 }]),
  ])
  const before = await storageDump(page)
  await page.reload()

  // Today launch restores the old key's latest Draft, and the 2.1 Draft is never listed.
  await expect(startScreen(page), 'launch restores nothing while 2.1 Drafts exist').toBeVisible()
  const newer = draftRow(page, 'Orchard in 2.1')
  await expect(newer, 'the 2.1 Draft is listed').toHaveCount(1)
  await expect(newer).toHaveAttribute('data-read-only', '')
  await expect(newer).toContainText('Read-only: saved by a newer Canopi')
  await expect(draftRow(page, 'Hedge'), 'an editable 2.0 Draft is listed beside it').toHaveCount(1)
  await expect(draftRow(page, 'Hedge')).not.toHaveAttribute('data-read-only', '')
  await expect(draftRow(page, 'Orchard as 2.0 left it'), 'the old-key Draft the move copied is hidden').toHaveCount(0)

  await newer.getByRole('button', { name: 'Actions for Orchard in 2.1' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download a copy' }), 'a read-only Draft offers Download a copy').toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete draft…' }), 'and no Delete').toHaveCount(0)
  await page.keyboard.press('Escape')

  expect(await storageDump(page), 'listing writes no record and no key').toEqual(before)
})

for (const variant of ['databases()', 'databases() stubbed away'] as const) {
  test.fail(`R3 canopi-f47t.52.272: reader release: listing Drafts on an origin with no Draft store creates no IndexedDB database (${variant})`, async ({ page }) => {
    // Every IndexedDB open and databases() call the page makes, recorded before any script of the page runs; the
    // second variant removes databases() as engines without it do, so the reader's open-and-abort fallback runs.
    await page.addInitScript((stub) => {
      const factory = indexedDB as IDBFactory & { databases?: IDBFactory['databases'] }
      const calls: string[] = []
      ;(window as unknown as { __idbCalls: string[] }).__idbCalls = calls
      const databases = factory.databases?.bind(factory)
      ;(window as unknown as { __databases?: IDBFactory['databases'] }).__databases = databases
      const open = factory.open.bind(factory)
      factory.open = (name: string, version?: number) => {
        calls.push(`open ${name}`)
        return version === undefined ? open(name) : open(name, version)
      }
      if (stub) {
        Object.defineProperty(factory, 'databases', { value: undefined, configurable: true })
      } else if (databases) {
        factory.databases = () => {
          calls.push('databases')
          return databases()
        }
      }
    }, variant === 'databases() stubbed away')
    await page.goto('')
    await expect(startScreen(page)).toBeVisible()

    // Today nothing reads the Draft store, so the reader's check never runs.
    const calls = await page.evaluate(() => (window as unknown as { __idbCalls: string[] }).__idbCalls)
    expect(calls.some((call) => call === 'databases' || call === `open ${DRAFT_DATABASE}`), 'the start screen looked for the Draft store').toBe(true)
    const names = await page.evaluate(async () => {
      const databases = (window as unknown as { __databases?: IDBFactory['databases'] }).__databases
      return databases ? (await databases()).map((info) => info.name) : null
    })
    // An engine without databases() at all (none the lanes run today) leaves the check to the call record above.
    if (names !== null) expect(names, 'no database was created').not.toContain(DRAFT_DATABASE)
  })
}

test.fail('R3 canopi-f47t.52.272: reader release: an open reader-release tab closes on versionchange and 2.1’s upgrade is not blocked', async ({ page, context }) => {
  // Every connection the page opens to the Draft store, whether it closed, and whether a versionchange reached it.
  await page.addInitScript(() => {
    interface Seen { closed: boolean, versionchange: boolean }
    const seen: Seen[] = []
    ;(window as unknown as { __draftConnections: Seen[] }).__draftConnections = seen
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = (name: string, version?: number) => {
      const request = version === undefined ? open(name) : open(name, version)
      if (name === 'canopi-drafts') {
        request.addEventListener('success', () => {
          const db = request.result
          const entry: Seen = { closed: false, versionchange: false }
          seen.push(entry)
          db.addEventListener('versionchange', () => { entry.versionchange = true })
          const close = db.close.bind(db)
          db.close = () => { entry.closed = true; close() }
        })
      }
      return request
    }
  })
  await page.goto('')
  await seedDraftStore(page, [draftRecord('orchard', 'Orchard in 2.1', 3)], [])
  await page.reload()
  // Today the 2.1 Draft is never listed: nothing reads the store.
  await expect(draftRow(page, 'Orchard in 2.1'), 'the reader tab lists the 2.1 Draft').toHaveCount(1)

  // A 2.1 tab upgrades the store while the reader tab is open.
  const later = await context.newPage()
  await later.goto('')
  const outcome = await later.evaluate(async (name) => await new Promise<string>((resolve) => {
    const request = indexedDB.open(name, 5)
    request.onblocked = () => resolve('blocked')
    request.onerror = () => resolve(`error ${request.error?.name}`)
    request.onsuccess = () => { request.result.close(); resolve('upgraded') }
  }), DRAFT_DATABASE)
  expect(outcome, '2.1’s upgrade is not blocked').toBe('upgraded')

  const connections = await page.evaluate(() =>
    (window as unknown as { __draftConnections: { closed: boolean, versionchange: boolean }[] }).__draftConnections)
  expect(connections.length, 'the reader opened the store').toBeGreaterThan(0)
  expect(connections.every((connection) => connection.closed), 'every reader connection is closed').toBe(true)
  if (connections.some((connection) => connection.versionchange)) {
    await expect(page.getByText('New version'), 'a versionchange shows the Reload notice (2.1-Q40)').toBeVisible()
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  }
})
