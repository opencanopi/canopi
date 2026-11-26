/**
 * Real-browser Draft-store suite for 2b-6 (`canopi-f47t.52.50`; contracts §4, §11; 2.1-Q40, M21, M527):
 * exercises real IndexedDB (`canopi-drafts` v4) in Chromium, WebKit, and Firefox:
 * 1. A Draft > 8 MiB saves in IndexedDB and survives a full reload.
 * 2. Migrating 2.0 localStorage Drafts (including a refused Draft) copies all Drafts into IndexedDB
 *    while leaving `canopi:web-app-data:v3:drafts` byte-identical.
 * 3. Two-tab Q40 `versionchange`: upgrading `canopi-drafts` from a second tab closes the first tab's
 *    connection without blocking and triggers the Reload notice.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../support/offline'
import { DRAFT_DATABASE, DRAFT_DATABASE_VERSION, draftStoreDump, versionChangeOutcome } from '../support/web-storage'

const LEGACY_DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'
const V9_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url)), 'utf8'),
) as Record<string, unknown>

test.describe('Web Drafts IndexedDB (canopi-f47t.52.50)', () => {
  test('canopi-f47t.52.50: a Draft above 8 MiB saves in IndexedDB and survives reload', async ({ page }) => {
    await page.goto('')
    await expect(page.locator('[data-start-screen]')).toBeVisible()

    // Seed a > 8 MiB v10 Draft directly into canopi-drafts v4 and reload to prove real IDB persistence.
    const bigLength = await page.evaluate(async ({ dbName, dbVersion }) => {
      const padding = 'x'.repeat(8_500_000)
      const content = JSON.stringify({
        version: 10,
        name: 'Big Orchard 8MiB',
        description: padding,
        plants: [],
        zones: [],
        annotations: [],
        layers: [],
        created_at: '2026-12-01T00:00:00.000Z',
        updated_at: '2026-12-01T00:00:00.000Z',
      })
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('drafts')) req.result.createObjectStore('drafts', { keyPath: 'id' })
          if (!req.result.objectStoreNames.contains('meta')) req.result.createObjectStore('meta', { keyPath: 'key' })
        }
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('drafts', 'readwrite')
          tx.objectStore('drafts').put({
            id: 'draft-big-8mib',
            canopi_version: '2.1.0',
            version: 1,
            name: 'Big Orchard 8MiB',
            updated_at: '2026-12-01T00:00:00.000Z',
            content,
          })
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
      return content.length
    }, { dbName: DRAFT_DATABASE, dbVersion: DRAFT_DATABASE_VERSION })

    expect(bigLength).toBeGreaterThan(8 * 1024 * 1024)
    await page.reload()
    await expect(page.locator('[data-workspace-title-bar]')).toBeVisible()

    const dump = await page.evaluate(draftStoreDump, DRAFT_DATABASE)
    expect(dump).not.toBeNull()
    expect(dump?.version).toBe(DRAFT_DATABASE_VERSION)
    const drafts = (dump?.drafts ?? []) as Array<{ id: string; content: string }>
    const stored = drafts.find((d) => d.id === 'draft-big-8mib')
    expect(stored?.content.length).toBeGreaterThan(8 * 1024 * 1024)
  })

  test('canopi-f47t.52.50: 2.0 localStorage migration copies valid and refused Drafts to IndexedDB and leaves 2.0 key byte-identical', async ({ page }) => {
    const legacyRaw = JSON.stringify({
      version: 3,
      drafts: [
        { id: 'draft-legacy-ok', name: 'Legacy Meadow', updatedAt: '2026-10-01T00:00:00.000Z' },
        { id: 'draft-legacy-refused', name: 'Future Draft', updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      draftFiles: {
        'draft-legacy-ok': {
          ...V9_FIXTURE,
          name: 'Legacy Meadow',
        },
        'draft-legacy-refused': { version: 99, name: 'Future Draft' },
      },
    })
    await page.addInitScript(({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value)
    }, { key: LEGACY_DRAFTS_KEY, value: legacyRaw })

    await page.goto('')
    await expect.poll(async () => {
      const dump = await page.evaluate(draftStoreDump, DRAFT_DATABASE)
      const meta = (dump?.meta ?? []) as Array<{ key: string; state: string; copiedIds: string[] }>
      return meta.find((m) => m.key === 'move')?.state ?? null
    }).toBe('live')

    const afterLegacy = await page.evaluate((key) => localStorage.getItem(key), LEGACY_DRAFTS_KEY)
    expect(afterLegacy, '2.1-M21: 2.0 localStorage key stays untouched').toBe(legacyRaw)

    const dump = await page.evaluate(draftStoreDump, DRAFT_DATABASE)
    const drafts = (dump?.drafts ?? []) as Array<{ id: string; content: string }>
    expect(drafts.map((d) => d.id).sort()).toEqual(['draft-legacy-ok', 'draft-legacy-refused'])
    const okRow = drafts.find((d) => d.id === 'draft-legacy-ok')!
    expect((JSON.parse(okRow.content) as { version: number }).version).toBe(10)
  })

  test('canopi-f47t.52.50: Q40 two-tab versionchange closes the open tab connection without blocking and shows Reload', async ({ context, page }) => {
    await page.goto('')
    await expect(page.locator('[data-start-screen]')).toBeVisible()

    const tab2 = await context.newPage()
    await tab2.goto('')
    const upgrade = await tab2.evaluate(versionChangeOutcome, {
      name: DRAFT_DATABASE,
      to: DRAFT_DATABASE_VERSION + 1,
      waitMs: 4000,
    })
    expect(upgrade.outcome).toBe('upgraded')
    expect(upgrade.blocked).toBe(false)
    await expect(page.getByRole('button', { name: /reload/i })).toBeVisible()
    await tab2.close()
  })
})
