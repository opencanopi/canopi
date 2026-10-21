// The release smoke of a deployed Web Edition (e2e-release/playwright.config.ts): one user walk
// from a new Design through place search, the plant catalog, a drawn zone, a download and a reload.
import { readFile } from 'node:fs/promises'
import { expect, test, type Response } from '@playwright/test'
import { collectPageProblems } from './page-problems'

test('a deployed Web Edition creates, edits, downloads and keeps a Design', async ({ page }) => {
  const problems = collectPageProblems(page)

  await page.goto('/', { waitUntil: 'networkidle' })

  await test.step('New Design asks where the site is', async () => {
    await page.getByRole('button', { name: 'New Design', exact: true }).first().click()
    await expect(page.getByPlaceholder('Place or coordinates')).toBeVisible()
  })

  await test.step('place search moves the view', async () => {
    await page.getByPlaceholder('Place or coordinates').fill('Lyon')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: /Lyon/ }).or(page.getByRole('option', { name: /Lyon/ })).first().click()
    await expect(page.getByRole('button', { name: /Map scale/ })).not.toHaveAccessibleName(/17,000,000/)
  })

  await test.step('the plant catalog answers a search and a filter, reading Parquet only by range', async () => {
    const parquet: Response[] = []
    const record = (response: Response) => {
      if (new URL(response.url()).pathname.endsWith('.parquet')) parquet.push(response)
    }
    page.on('response', record)
    await page.getByRole('button', { name: 'Plant catalog', exact: true }).click()
    await page.getByLabel('Search the plant catalog').fill('apple')
    // A cold DuckDB-WASM load is slow (15-20 s measured); wait for it rather than fail early.
    await expect(page.getByText('Malus domestica').first()).toBeVisible({ timeout: 180_000 })
    await page.getByRole('button', { name: 'Trees', exact: true }).click()
    await expect(page.getByText('Malus domestica').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible()
    await page.keyboard.press('Escape')
    page.off('response', record)
    // DuckDB-WASM reads the catalog by HTTP range, never a whole shard (duckdb-wasm-catalog.ts `CATALOG_FILESYSTEM`).
    expect(parquet.length, 'catalog Parquet responses during the search').toBeGreaterThan(0)
    const whole = []
    for (const response of parquet) {
      const range = (await response.request().allHeaders())['range']
      if (response.status() !== 206 || !range) {
        whole.push(`${response.request().method()} ${response.status()} range=${range ?? 'none'} ${new URL(response.url()).pathname}`)
      }
    }
    expect(whole, 'Parquet responses that were not ranged 206s').toEqual([])
  })

  await test.step('a drawn rectangle is an undoable edit', async () => {
    await page.keyboard.press('r')
    const box = await page.locator('canvas').first().boundingBox()
    if (!box) throw new Error('the map canvas has no box')
    await page.mouse.move(box.x + 450, box.y + 450)
    await page.mouse.down()
    await page.mouse.move(box.x + 600, box.y + 560, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
  })

  await test.step('Download a copy saves a .canopi without a key or a location reading', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download a copy' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.canopi$/)
    const text = await readFile(await download.path(), 'utf8')
    expect(() => JSON.parse(text)).not.toThrow()
    expect(text).not.toMatch(/AIza/)
    expect(text).not.toMatch(/accuracy|myLocation/i)
  })

  await test.step('a reload keeps the Design', async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('button', { name: 'Settings…' }).first()).toBeVisible()
    await expect(page.getByText('No Designs in this browser yet')).toHaveCount(0)
  })

  await test.step('a deep route loads the app shell', async () => {
    const response = await page.goto('/some/deep/route', { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('button', { name: 'Settings…' }).first()).toBeVisible()
  })

  expect(problems).toEqual([])
})
