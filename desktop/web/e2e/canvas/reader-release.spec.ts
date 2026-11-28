// The reader release on the Web Edition (Step 2.0.4; plan "Tests by behaviour"). After a rollback from 2.1:
// - R1 (canopi-f47t.52.270): a `.canopi` v10 Design opens in the read-only Session kind; its save status says
//   "Read-only" and its popover that a newer Canopi saved it, with Update (2.1-Q317, Q336), Close is its only action
//   (2.1-Q315), and it is never handed to the Draft
//   store (contracts §11: a v10 Design never reaches the 2.0 store or persistence paths).
// A session over every frozen Web store form writes no byte (R4, canopi-f47t.52.239) is the rollback harness's own test,
// e2e-rollback/reader.spec.ts, which the rollback lane runs against the reader release's bundle.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

/** A Design from a future Canopi release (v11): refused unchanged on Canopi 2.1 (2.1-Q347). */
function v11Design(name: string): Buffer {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return Buffer.from(JSON.stringify({ ...design, version: 11, name, plants }, null, 2))
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

test('R1 canopi-f47t.52.270: 2.1-Q347: a newer-version (v11) Design is refused unchanged and writes no byte (Web)', async ({ page }) => {
  await page.goto('')
  const start = page.locator('[data-start-screen]')
  await expect(start).toBeVisible()
  const before = await storageDump(page)

  const open = start.getByRole('button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles({ name: 'Orchard 2.2.canopi', mimeType: 'application/json', buffer: v11Design('Orchard 2.2') })

  await expect(page.getByText(/newer version/i), 'a newer-version Design is refused with a visible notice (2.1-Q347)').toBeVisible()
  await expect(start, 'nothing opened').toBeVisible()
  expect(await storageDump(page), 'a refused v11 Design writes no byte to browser storage').toEqual(before)
})
