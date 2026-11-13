// The rollback harness's Web reader (Step 2.0.4 R4, canopi-f47t.52.239; contracts §11 Rollback harness, 2.1-M484; plan
// "reader release: a session over every frozen 2.1 store fixture writes no byte"). main's lane runs it against the
// reader's Web bundle (CANOPI_ROLLBACK_WEB_DIST, playwright.config.ts beside it) over the fixture directory the writer
// job uploaded (CANOPI_ROLLBACK_FIXTURES): every Web form its manifest lists is seeded into a fresh profile on a blank
// page of the app's origin, one reader session loads the app, and the profile then holds the same bytes.
//
// What it asserts holds for any reader release, so a later tag's bundle meets it too, and it reads the tag's page by a
// few stable hooks only: the start screen (`data-start-screen`), a read-only Draft row (`li[data-read-only]`) and the
// notice row's key (`data-notice-key`), whose last button dismisses it. Settings and species lists each raise their
// newer-read-only notice, and the Draft store stays ready with its rows read-only (contracts §11, 2.1-M486). No
// IndexedDB database is created or opened at a new version, and no localStorage key changes but the first-paint theme
// cache, a copy of the theme shown that each launch rewrites.
//
// Each Web form is a dump the writer copies as R3 froze it (spec/web/frozen/): a record `{key, record}` seeded as
// JSON under its key, or the Draft store `{database, version, stores: {name: records}}`. Without
// CANOPI_ROLLBACK_FIXTURES the spec reads the in-repo frozen forms, the writer naming each Web form after its file.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURES = process.env.CANOPI_ROLLBACK_FIXTURES
const MANIFEST = FIXTURES ? `${FIXTURES}/manifest.json` : `${REPOSITORY}spec/rollback/manifest.json`
/** A blank page of the app's origin: seeding and reading back there runs none of the app. */
const BLANK = '/__rollback-blank'
/** Rewritten at each launch to the theme shown: a cache of the settings record, which is the store compared. */
const FIRST_PAINT_THEME = 'canopi:first-paint-theme'
/** The key path of each object store of the 2.1 Draft store (contracts §11 "Web Drafts move to IndexedDB"). */
const KEY_PATHS: Readonly<Record<string, string>> = { drafts: 'id', meta: 'key' }
/** The Web stores that raise their own newer-read-only notice (contracts §11; web_drafts stays ready, 2.1-M486). */
const NOTICED = ['settings', 'web_species_lists']

interface Form { readonly store: string, readonly edition: string, readonly path: string }
interface RecordDump { readonly key: string, readonly record: unknown }
interface DatabaseDump { readonly database: string, readonly version: number, readonly stores: Readonly<Record<string, readonly unknown[]>> }
interface Seed {
  readonly localStorage: Readonly<Record<string, string>>
  readonly databases: readonly { name: string, version: number, stores: { name: string, keyPath: string, records: readonly unknown[] }[] }[]
}

function webForms(): Form[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { forms: Form[] }
  return manifest.forms.filter((form) => form.edition === 'web')
}

function formFile(form: Form): string {
  return FIXTURES ? `${FIXTURES}/${form.path}` : `${REPOSITORY}spec/web/frozen/${basename(form.path)}`
}

/** What the forms seed: each record under its key as JSON, each database with its stores' records. */
function seedOf(forms: readonly Form[]): Seed {
  const localStorage: Record<string, string> = {}
  const databases: Seed['databases'][number][] = []
  for (const form of forms) {
    const dump = JSON.parse(readFileSync(formFile(form), 'utf8')) as RecordDump | DatabaseDump
    if ('key' in dump) {
      localStorage[dump.key] = JSON.stringify(dump.record)
      continue
    }
    databases.push({ name: dump.database, version: dump.version, stores: Object.entries(dump.stores).map(([name, records]) => {
      const keyPath = KEY_PATHS[name]
      if (!keyPath) throw new Error(`the ${form.store} form's store ${name} has no key path here`)
      return { name, keyPath, records }
    }) })
  }
  return { localStorage, databases }
}

async function seed(page: Page, value: Seed): Promise<void> {
  await page.evaluate(async ({ localStorage: local, databases }) => {
    for (const [key, text] of Object.entries(local)) localStorage.setItem(key, text)
    for (const database of databases) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(database.name, database.version)
        request.onupgradeneeded = () => {
          for (const store of database.stores) request.result.createObjectStore(store.name, { keyPath: store.keyPath })
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction(database.stores.map((store) => store.name), 'readwrite')
          for (const store of database.stores) for (const record of store.records) tx.objectStore(store.name).put(record)
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
    }
  }, value)
}

/** Every localStorage entry but the first-paint theme, and every IndexedDB database with its version and records. */
async function profile(page: Page): Promise<unknown> {
  return await page.evaluate(async (skipped) => {
    const local = Object.keys(localStorage).filter((key) => key !== skipped).sort().map((key) => [key, localStorage.getItem(key)])
    const infos = await indexedDB.databases()
    const databases: unknown[] = []
    for (const { name } of [...infos].sort((a, b) => ((a.name ?? '') < (b.name ?? '') ? -1 : 1))) {
      databases.push(await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open(name!)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const stores = [...db.objectStoreNames].sort()
          const out: Record<string, unknown> = { name, version: db.version }
          if (stores.length === 0) { db.close(); resolve(out); return }
          const tx = db.transaction(stores, 'readonly')
          for (const store of stores) {
            const all = tx.objectStore(store).getAll()
            all.onsuccess = () => { out[store] = all.result }
          }
          tx.oncomplete = () => { db.close(); resolve(out) }
          tx.onerror = () => reject(tx.error)
        }
      }))
    }
    return { local, databases }
  }, FIRST_PAINT_THEME)
}

/** The notice keys the start shows, read from the first row and dismissing it until none is left (at most `limit`). */
async function noticeKeys(page: Page, limit = 10): Promise<string[]> {
  const keys: string[] = []
  const row = page.locator('[data-notice-row]').first()
  for (let shown = 0; shown < limit; shown += 1) {
    const key = await row.getAttribute('data-notice-key', { timeout: 3_000 }).catch(() => null)
    if (key === null) break
    keys.push(key)
    await row.getByRole('button').last().click()
    // The next notice takes the row, or none is left.
    await expect.poll(async () => await row.getAttribute('data-notice-key', { timeout: 500 }).catch(() => null)).not.toBe(key)
  }
  return keys
}

test.beforeEach(async ({ page }) => {
  // The blank page, and nothing off the origin: the fixtures are the only data the session sees.
  await page.route(`**${BLANK}`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }))
  await page.route((url) => !['localhost', '127.0.0.1'].includes(url.hostname), (route) => route.abort())
})

test('R4 canopi-f47t.52.239: reader release: a session over every frozen 2.1 Web store fixture writes no byte, each read newer-read-only with its notice', async ({ page }) => {
  const forms = webForms()
  for (const store of ['settings', 'web_drafts', 'web_species_lists']) {
    expect(forms.some((form) => form.store === store), `the manifest lists a Web ${store} form`).toBe(true)
  }
  const value = seedOf(forms)
  await page.goto(BLANK)
  await seed(page, value)
  const before = await profile(page)
  expect((before as { databases: { name: string }[] }).databases.map((db) => db.name).sort(), 'seeded databases')
    .toEqual(value.databases.map((db) => db.name).sort())

  // One reader session: the start lists the 2.1 Drafts read-only, and each store a newer Canopi saved says so.
  await page.goto('')
  await expect(page.locator('[data-start-screen]'), 'the reader starts').toBeVisible()
  await expect(page.locator('[data-start-screen] li[data-read-only]').first(), 'the 2.1 Drafts are listed read-only').toBeVisible()
  const keys = await noticeKeys(page)
  for (const store of NOTICED) {
    expect(keys, `${store} raises its newer-read-only notice`).toContain(`health:${store}:status:${JSON.stringify({ kind: 'newer_read_only' })}`)
  }
  await page.reload()
  await expect(page.locator('[data-start-screen]')).toBeVisible()

  // The profile as seeded: no record changed, no key written, no database created or opened at a new version.
  await page.goto(BLANK)
  expect(await profile(page), 'the session writes no byte').toEqual(before)
})

test('R4 canopi-f47t.52.239: the profile comparison sees a Web database created and the Draft store opened at a newer version', async ({ page }) => {
  const value = seedOf(webForms())
  await page.goto(BLANK)
  await seed(page, value)
  const before = await profile(page)
  const drafts = value.databases[0]!
  // A reader that creates a database of its own, or upgrades the Draft store, writes: neither may pass as no byte.
  await page.evaluate(async (name) => await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('planted')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  }), 'canopi-rollback-planted')
  const created = await profile(page)
  expect(created, 'a created database').not.toEqual(before)
  await page.evaluate(async ({ name, version }) => await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, version + 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  }), { name: drafts.name, version: drafts.version })
  expect(await profile(page), 'a versioned open').not.toEqual(created)
})
