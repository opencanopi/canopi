// The reader release on the Web Edition (Step 2.0.4; plan "Tests by behaviour"). After a rollback from 2.1:
// - R1 (canopi-f47t.52.270): a `.canopi` v10 Design opens in the read-only Session kind; its save status says a newer
//   Canopi saved it, with Update (2.1-Q317), Close is its only action (2.1-Q315), and it is never handed to the Draft
//   store (contracts §11: a v10 Design never reaches the 2.0 store or persistence paths).
// - R4 (canopi-f47t.52.239): a session over every frozen Web store form the rollback manifest lists writes no byte
//   (contracts §11 Rollback harness, 2.1-M484). Each Web row's `path` is a seed dump, `{ localStorage?: {key: value},
//   indexedDB?: [{ name, version, stores: [{ name, keyPath, records }] }] }`, written into the origin before the load.
//
// Written failing in commit 0 and marked expected-fail (`test.fail`): R1-6 removes the first marker, R4-2 (which
// writes spec/rollback/manifest.json and its Web seed dumps) the second.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const ROLLBACK = fileURLToPath(new URL('../../../../spec/rollback/', import.meta.url))
const DRAFT_DATABASE = 'canopi-drafts'

/** A Design as 2.1 writes it: `.canopi` v10, with the plant `scale` renamed `canopy_spread_m` (2.1-Q314). */
function v10Design(name: string): Buffer {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return Buffer.from(JSON.stringify({ ...design, version: 10, name, plants }, null, 2))
}

/** Every localStorage entry and every IndexedDB database's records: what "writes no byte" compares on Web. */
async function storageDump(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const local = Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])
    const names = 'databases' in indexedDB ? (await indexedDB.databases()).map((info) => info.name!).sort() : []
    const databases: Record<string, unknown> = {}
    for (const name of names) {
      databases[name] = await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const stores = [...db.objectStoreNames].sort()
          const out: Record<string, unknown> = { version: db.version }
          if (stores.length === 0) { db.close(); resolve(out); return }
          const tx = db.transaction(stores, 'readonly')
          for (const store of stores) {
            const all = tx.objectStore(store).getAll()
            all.onsuccess = () => { out[store] = all.result }
          }
          tx.oncomplete = () => { db.close(); resolve(out) }
          tx.onerror = () => reject(tx.error)
        }
      })
    }
    return { local, databases }
  })
}

test.fail('R1 canopi-f47t.52.270: reader release: a v10 Design opens read-only and says a newer Canopi saved it (Web)', async ({ page }) => {
  await page.goto('')
  const start = page.locator('[data-start-screen]')
  await expect(start).toBeVisible()
  const before = await storageDump(page)

  const open = start.getByRole('button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles({ name: 'Orchard 2.1.canopi', mimeType: 'application/json', buffer: v10Design('Orchard 2.1') })

  // Today the file is refused as made with a newer Canopi, and the start screen stays.
  const status = page.locator('[data-workspace-title-bar] [data-save-status]')
  await expect(status, 'the Design opens').toBeVisible()
  await expect(status).toContainText(/newer Canopi/)
  await expect(status.getByRole('button', { name: 'Update' }), 'the save status offers Update').toBeVisible()
  await expect(page.locator('[data-workspace-title-bar]')).toContainText('Orchard 2.1')

  expect(await storageDump(page), 'the v10 Design is never written as a Draft').toEqual(before)
})

test.fail('R4 canopi-f47t.52.239: reader release: a session over every frozen 2.1 store fixture writes no byte (Web)', async ({ page }) => {
  const manifestPath = `${ROLLBACK}manifest.json`
  // Today there is no manifest: R4-2 writes it.
  expect(existsSync(manifestPath), 'the rollback manifest exists').toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { forms: { store: string, edition: string, path: string }[] }
  const forms = manifest.forms.filter((form) => form.edition === 'web')
  for (const store of ['settings', 'web_drafts', 'web_species_lists']) {
    expect(forms.some((form) => form.store === store), `the manifest lists a Web ${store} form`).toBe(true)
  }

  await page.goto('')
  for (const form of forms) {
    const seed = JSON.parse(readFileSync(`${ROLLBACK}${form.path}`, 'utf8')) as unknown
    await page.evaluate(async (dump) => {
      const { localStorage: local = {}, indexedDB: databases = [] } = dump as {
        localStorage?: Record<string, string>,
        indexedDB?: { name: string, version: number, stores: { name: string, keyPath: string, records: unknown[] }[] }[],
      }
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value)
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
    }, seed)
  }
  const before = await storageDump(page)
  await page.reload()

  // One reader session: the start screen lists every store, each read-only, and the session ends.
  await expect(page.locator('[data-start-screen]')).toBeVisible()
  await expect(page.locator('[data-start-screen] li[data-read-only]').first(), 'the 2.1 Drafts are listed read-only').toBeVisible()
  await page.reload()
  await expect(page.locator('[data-start-screen]')).toBeVisible()

  const after = await storageDump(page)
  expect(after, 'the session writes no byte').toEqual(before)
  expect((after as { databases: Record<string, unknown> }).databases, 'the Draft store is still there').toHaveProperty(DRAFT_DATABASE)
})
