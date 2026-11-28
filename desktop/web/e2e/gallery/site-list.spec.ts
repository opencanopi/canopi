// The Site data list in real engines (canopi-f47t.42, plan section 4 "Surfaces and checks", g1, g2 and g7): the 440 px
// panel with one-line rows whose long names truncate in de, ru and ja, the filter above eight items, collapse, the strip
// while the Layers eye hides all site data, drag and Alt ↓ among siblings only, and the missing and pending rows. The
// gallery's memory backend holds the Design, so a drop is a real Design edit read back from the list. DOM assertions only.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expect, openGallery, test } from '../support/gallery'

/** The Site data writer, imported in the page from the module the gallery itself loaded (Vite's /@fs/ path). */
const ACTIONS = `/@fs${fileURLToPath(new URL('../../src/app/data-library/actions.ts', import.meta.url))}`

/** The Site data panel, in any locale: the side panel that lists site data lines. */
function siteData(page: Page): Locator {
  return page.locator('aside').filter({ has: page.locator('[data-site-line]') })
}

/** Each listed line, front first: its depth and row id, or `[line]` for an analysis or pending line. */
async function lines(panel: Locator): Promise<string[]> {
  return panel.locator('[data-site-line]').evaluateAll((elements) => elements.map((element) => {
    const data = (element as HTMLElement).dataset
    return `${'  '.repeat(Number(data.depth))}${data.siteRow ?? `[${data.siteLine}]`}`
  }))
}

function row(panel: Locator, id: string): Locator {
  return panel.locator(`[data-site-row="${id}"]`)
}

async function dragGrip(page: Page, grip: Locator, to: Locator): Promise<void> {
  const from = await grip.boundingBox()
  const target = await to.boundingBox()
  if (!from || !target) throw new Error('no box')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  const y = target.y + target.height * 0.25
  await page.mouse.move(from.x + from.width / 2, (from.y + y) / 2, { steps: 6 })
  await page.mouse.move(from.x + from.width / 2, y, { steps: 6 })
  await page.mouse.up()
}

test.describe('the Site data list', () => {
  for (const locale of ['en', 'de', 'ru', 'ja']) {
    test(`is 440 px wide with one-line rows whose long names truncate (${locale})`, async ({ page }) => {
      await openGallery(page, { surface: 'site-data', state: 'lidar-long', locale })
      const panel = siteData(page)
      const box = await panel.boundingBox()
      expect(Math.round(box!.width + 2)).toBe(440)
      const rows = await panel.locator('[data-site-row]').evaluateAll((elements) => elements.map((element) => {
        const name = element.querySelector<HTMLElement>('[data-control="name"]')!
        const line = name.parentElement!
        return {
          id: (element as HTMLElement).dataset.siteRow,
          lineHeight: line.getBoundingClientRect().height,
          overflow: element.scrollWidth - element.clientWidth,
          nameHeight: name.getBoundingClientRect().height,
        }
      }))
      expect(rows.length).toBe(12)
      for (const entry of rows) {
        expect(entry.lineHeight, `${entry.id} is one 32 px line`).toBe(32)
        expect(entry.overflow, `${entry.id} does not overflow the panel`).toBe(0)
        expect(entry.nameHeight, `${entry.id}'s name is one line`).toBeLessThanOrEqual(32)
      }
    })
  }

  test('shows the filter only above eight items; a match keeps its source, and the grips go while filtering', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    await expect(siteData(page).locator('[data-site-line]').first()).toBeVisible()
    await expect(siteData(page).getByRole('searchbox')).toHaveCount(0)

    await openGallery(page, { surface: 'site-data', state: 'lidar-long' })
    const panel = siteData(page)
    const filter = panel.getByRole('searchbox', { name: 'Filter site data' })
    await filter.fill('orchard')
    await expect.poll(() => lines(panel)).toEqual(['lidar-block-2', 'lidar-ground', '  lidar-slope-percent'])
    await expect(panel.getByRole('button', { name: /^Reorder / })).toHaveCount(0)
    await filter.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(panel.locator('[data-site-row]')).toHaveCount(12)
  })

  test('collapses a source\'s results in the panel only', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const panel = siteData(page)
    await panel.getByRole('button', { name: 'Collapse IGN ground elevation' }).click()
    await expect.poll(() => lines(panel)).toEqual(['lidar-ground'])
    await panel.getByRole('button', { name: 'Expand IGN ground elevation' }).click()
    await expect.poll(() => lines(panel)).toEqual(['lidar-ground', '  lidar-slope-percent', '  lidar-slope'])
  })

  test('says when the Layers eye hides all site data, and Show brings it back', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const panel = siteData(page)
    await page.evaluate(async (url) => {
      const actions = await import(url) as { setSiteDataShown(shown: boolean): void }
      actions.setSiteDataShown(false)
    }, ACTIONS)
    await expect(panel.getByText('Site data is hidden from the map')).toBeVisible()
    await expect(row(panel, 'lidar-ground')).toHaveAttribute('data-hidden', 'true')
    await panel.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(panel.getByText('Site data is hidden from the map')).toHaveCount(0)
    await expect(row(panel, 'lidar-ground')).toHaveAttribute('data-hidden', 'false')
  })
})

test.describe('reordering Site data', () => {
  test('drags a source among sources and a result among its siblings only', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-long' })
    const panel = siteData(page)
    const before = await lines(panel)
    // The ground elevation dragged to the top lands first, its results with it.
    await dragGrip(page, row(panel, 'lidar-ground').getByRole('button', { name: 'Reorder IGN ground elevation' }), row(panel, 'lidar-block-9'))
    await expect.poll(() => lines(panel)).toEqual([
      'lidar-ground', '  lidar-slope-percent', '  lidar-slope',
      ...before.filter((line) => !line.includes('lidar-ground') && !line.includes('lidar-slope')),
    ])
    // A result dragged above every source stays under its own, first among its siblings.
    await dragGrip(page, row(panel, 'lidar-slope').getByRole('button', { name: /^Reorder / }), row(panel, 'lidar-ground'))
    await expect.poll(async () => (await lines(panel)).slice(0, 3)).toEqual(['lidar-ground', '  lidar-slope', '  lidar-slope-percent'])
  })

  test('Alt ↓ moves a row one place and keeps focus on its grip', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-long' })
    const panel = siteData(page)
    const grip = row(panel, 'lidar-block-9').getByRole('button', { name: /^Reorder / })
    await grip.focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(async () => (await lines(panel)).slice(0, 2)).toEqual(['lidar-block-8', 'lidar-block-9'])
    await expect(row(panel, 'lidar-block-9').getByRole('button', { name: /^Reorder / })).toBeFocused()
  })
})

test.describe('missing and pending Site data', () => {
  test('a missing item shows its stored name and Missing, and opened, the reason and Remove from Design only', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-missing' })
    const panel = siteData(page)
    const missing = row(panel, 'lidar-gone-2021')
    await expect(missing.locator('[data-trailing]')).toHaveText('Missing')
    await missing.getByRole('button', { name: 'IGN LiDAR HD MNT 2021', exact: true }).click()
    await expect(missing.getByText('Not in this computer’s Data library')).toBeVisible()
    await expect(missing.getByRole('button', { name: 'Remove IGN LiDAR HD MNT 2021 from this Design' })).toBeVisible()
    await expect(missing.getByRole('radiogroup')).toHaveCount(0)
    await expect(missing.getByRole('button', { name: 'Details' })).toHaveCount(0)
  })

  test('an import pends at the top with its progress, a calculation under its source, each with Cancel', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-progress' })
    const panel = siteData(page)
    await expect.poll(() => lines(panel)).toEqual([
      '[pending:import:lidar-canopy]', 'lidar-ground', '  [pending:lidar-slope-running-def]', '  lidar-slope-percent', '  lidar-slope',
    ])
    const importing = panel.locator('[data-site-line="pending:import:lidar-canopy"]')
    await expect(importing).toContainText(/Importing · \d+%/)
    await expect(importing.getByRole('progressbar')).toBeVisible()
    await expect(importing.getByRole('button', { name: 'Cancel import' })).toBeVisible()
    await expect(panel.locator('[data-site-line="pending:lidar-slope-running-def"]').getByRole('button', { name: 'Cancel calculation' })).toBeVisible()
  })

  test('Cancel import deletes the half-imported item: nothing left in Site data or the Data library', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-progress' })
    const panel = siteData(page)
    await panel.locator('[data-site-line="pending:import:lidar-canopy"]').getByRole('button', { name: 'Cancel import' }).click()
    await expect.poll(() => lines(panel)).toEqual([
      'lidar-ground', '  [pending:lidar-slope-running-def]', '  lidar-slope-percent', '  lidar-slope',
    ])
    await expect(panel.getByText('Canopy height 2024')).toHaveCount(0)

    await openGallery(page, { surface: 'library', state: 'lidar-progress' })
    const library = page.getByRole('dialog', { name: 'Data library' })
    await library.getByRole('option', { name: /Canopy height 2024/ }).click()
    await library.getByRole('button', { name: 'Cancel import' }).click()
    await expect(library.getByRole('option', { name: /Canopy height 2024/ })).toHaveCount(0)
  })

  test('Cancel on a Retry puts the item back to failed, with Retry and Dismiss (U51)', async ({ page }) => {
    await openGallery(page, { surface: 'library', state: 'lidar-progress' })
    const library = page.getByRole('dialog', { name: 'Data library' })
    await library.getByRole('option', { name: /Survey tile 0712/ }).click()
    await library.getByRole('button', { name: 'Retry', exact: true }).click()
    await library.getByRole('button', { name: 'Cancel import' }).click()
    await expect(library.getByRole('option', { name: /Survey tile 0712/ })).toHaveCount(1)
    // A failed job's reason goes to the log, not the page (user, 2026-10-15): the item shows its status only.
    await expect(library.getByRole('status').filter({ hasText: 'Import failed' })).toBeVisible()
    await expect(library.getByText('The file is not a readable raster.')).toHaveCount(0)
    await expect(library.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await expect(library.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  })

  test('says when work started here could not join the Design', async ({ page }) => {
    await openGallery(page, { surface: 'site-data', state: 'lidar-failure' })
    await expect(siteData(page).getByRole('button', { name: 'Show in the Data library' })).toBeVisible()
  })
})
