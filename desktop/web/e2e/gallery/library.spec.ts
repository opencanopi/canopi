// The Data library sheet (canopi-f47t.42, plan section 4, gallery g6; pattern site-data.md "Dialogs and library").
// A large sheet of fixed height over the dimmed workspace: the item list and the selected item's details scroll on
// their own, the footer stays inside the sheet, and below 760 px one pane shows at a time with Back. ↑/↓ select, Show in
// Site data closes the sheet on the item, Esc returns focus to the opener, Analyze opened over the sheet returns to it
// with its search and selection, and with no Design open the empty library's Import… says why it is off. Run in
// Chromium, WebKit and Firefox (projects gallery-chromium, gallery-webkit and gallery-firefox); DOM assertions only, no baselines.
import type { Locator, Page } from '@playwright/test'
import { expect, openGallery, test } from '../support/gallery'
import { tooltipOf } from '../support/tooltip'

/** playwright.config.ts's window; the sheet is min(1200 px, 100vw − 48) × min(860 px, 100vh − 48). */
const WIDE = { width: 1400, height: 900 }
/** A window whose sheet is narrower than 760 px. */
const NARROW = { width: 740, height: 820 }

function sheet(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Data library' })
}

function itemList(page: Page): Locator {
  return sheet(page).getByRole('listbox')
}

/** The selected item's details: the one region of the sheet, named by the item. */
function detailsPane(page: Page): Locator {
  return sheet(page).getByRole('region')
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error('no box')
  return value
}

async function scrollTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.scrollTop)
}

/** Whether a pane rests at its end, to the pixel. */
async function atEnd(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)
}

test.describe('the Data library sheet', () => {
  test('forty items: the list and the details scroll on their own, and the footer stays in the sheet', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await openGallery(page, { surface: 'library', state: 'long' })
    const dialog = sheet(page)
    await expect(itemList(page).getByRole('option')).toHaveCount(40)
    const sheetBox = await box(dialog)
    expect(sheetBox.width).toBeCloseTo(1200, 0)
    expect(sheetBox.height).toBeCloseTo(Math.min(860, WIDE.height - 48), 0)

    const list = itemList(page)
    const details = detailsPane(page)
    await expect(details).toBeVisible()
    const listMetrics = await list.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }))
    expect(listMetrics.scroll, 'forty rows overflow the list pane').toBeGreaterThan(listMetrics.client)

    const footer = dialog.locator('footer')
    const footerBefore = await box(footer)
    expect(footerBefore.y + footerBefore.height, 'the footer ends inside the sheet').toBeLessThanOrEqual(sheetBox.y + sheetBox.height + 0.5)
    expect(footerBefore.y).toBeGreaterThan(sheetBox.y)

    const listBox = await box(list)
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2)
    // Wheeled in steps until the list rests at its end: Firefox caps the scroll one wheel event applies, so a single
    // 2400 px event stops short of the end there, and WebKit applies a wheel's scroll over several frames, so a list read
    // as soon as it moves can still be moving (CI read 1759 px, then 1761); each step is read after a pause.
    await expect(async () => {
      await page.mouse.wheel(0, 800)
      expect(await atEnd(list), 'the list scrolls to its end').toBe(true)
    }).toPass({ intervals: [250] })
    expect(await scrollTop(details), 'the details pane did not move').toBe(0)
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0), 'the page did not move').toBe(0)
    expect(await box(footer), 'the footer did not move').toEqual(footerBefore)
    expect(await box(dialog), 'the sheet did not grow').toEqual(sheetBox)
    // The last row can be reached.
    await expect(list.getByRole('option').last()).toBeInViewport()

    // The details pane scrolls without moving the list.
    const listScrolled = await scrollTop(list)
    const detailsBox = await box(details)
    const detailMetrics = await details.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }))
    if (detailMetrics.scroll > detailMetrics.client) {
      await page.mouse.move(detailsBox.x + detailsBox.width / 2, detailsBox.y + detailsBox.height / 2)
      await page.mouse.wheel(0, 1200)
      await expect.poll(() => scrollTop(details), { message: 'the details scroll' }).toBeGreaterThan(0)
      expect(await scrollTop(list), 'the list did not move').toBe(listScrolled)
    }
    expect(await details.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
  })

  test('opened on an item far down the list, the sheet scrolls its selected row into view', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await openGallery(page, { surface: 'library', state: 'long', open: 'lidar-tile-37' })
    const selected = itemList(page).getByRole('option', { selected: true })
    await expect(selected).toContainText('IGN LiDAR HD MNT tile 0470_6836')
    await expect(detailsPane(page)).toHaveAccessibleName('IGN LiDAR HD MNT tile 0470_6836')
    await expect(selected).toBeInViewport()
  })

  test('below 760 px one pane shows at a time, with Back', async ({ page }) => {
    await page.setViewportSize(NARROW)
    await openGallery(page, { surface: 'library', state: 'long' })
    const list = itemList(page)
    await expect(list).toBeVisible()
    await expect(detailsPane(page)).toBeHidden()
    const sheetBox = await box(sheet(page))
    expect(sheetBox.width).toBeLessThan(760)
    const footer = sheet(page).locator('footer')
    expect((await box(footer)).y + (await box(footer)).height).toBeLessThanOrEqual(sheetBox.y + sheetBox.height + 0.5)

    await list.getByRole('option', { name: /^IGN LiDAR HD MNT tile 0470_6805/ }).click()
    await expect(list).toBeHidden()
    const details = sheet(page).getByRole('region', { name: 'IGN LiDAR HD MNT tile 0470_6805' })
    await expect(details).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Back' }).click()
    await expect(details).toBeHidden()
    await expect(list).toBeVisible()
  })

  test('below 760 px focus follows the pane, Esc still closes the sheet, and a search matching nothing shows the list', async ({ page }) => {
    await page.setViewportSize(NARROW)
    await openGallery(page, { surface: 'library', state: 'long' })
    const list = itemList(page)
    const row = list.getByRole('option', { name: /^IGN LiDAR HD MNT tile 0470_6805/ })
    await row.click()
    const back = sheet(page).getByRole('button', { name: 'Back' })
    await expect(back).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(back).toBeFocused()
    await sheet(page).getByRole('searchbox').fill('zzz')
    await expect(list).toBeVisible()
    await expect(sheet(page).getByText('No data matches this search.')).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Clear search and filters' }).click()
    await row.click()
    await sheet(page).getByRole('button', { name: 'Rename…' }).click()
    await page.keyboard.press('Escape')
    await expect(sheet(page).getByRole('button', { name: 'Rename…' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toBeHidden()
  })

  test('↑ and ↓ select rows, and Show in Site data closes the sheet on the item', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await openGallery(page, { surface: 'library', state: 'long' })
    const list = itemList(page)
    const first = list.getByRole('option').first()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await first.focus()
    await page.keyboard.press('ArrowDown')
    const second = list.getByRole('option').nth(1)
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(second).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    // The first row is this Design's ground elevation.
    const name = (await first.locator('strong').textContent()) ?? ''
    await sheet(page).getByRole('button', { name: 'Show in Site data' }).click()
    await expect(sheet(page)).toBeHidden()
    const siteData = page.getByRole('complementary', { name: 'Site data' })
    await expect(siteData).toBeVisible()
    // Its row is open in Site data.
    await expect(siteData.locator('button[aria-expanded="true"]', { has: page.getByText(name, { exact: true }) })).toBeVisible()
  })

  test('Esc closes the sheet and returns focus to the Site data Library button', async ({ page }) => {
    await openGallery(page, { surface: 'site-data' })
    const opener = page.getByRole('complementary', { name: 'Site data' }).getByRole('button', { name: 'Data library', exact: true })
    await opener.click()
    await expect(sheet(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('Run again with changes opens Analyze over the sheet, which returns with its search and selection', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await openGallery(page, { surface: 'library' })
    await sheet(page).getByRole('searchbox', { name: 'Search data' }).fill('gradient')
    await itemList(page).getByRole('option', { name: /^Orchard gradient/ }).click()
    await sheet(page).getByRole('button', { name: 'Run again with changes…' }).click()
    const analyze = page.getByRole('dialog', { name: 'Analyze' })
    await expect(analyze).toBeVisible()
    await expect(analyze.locator(':focus'), 'focus moved into Analyze').toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(analyze).toBeHidden()
    await expect(sheet(page).getByRole('searchbox', { name: 'Search data' })).toHaveValue('gradient')
    await expect(itemList(page).getByRole('option', { name: /^Orchard gradient/ })).toHaveAttribute('aria-selected', 'true')
    await expect(sheet(page).getByRole('button', { name: 'Run again with changes…' })).toBeFocused()
  })

  test('with no Design open, the empty library\'s Import… is off and says why', async ({ page }) => {
    await openGallery(page, { surface: 'library', state: 'no-design' })
    const importButton = sheet(page).getByRole('button', { name: /^Import…/ })
    await expect(importButton).toBeDisabled()
    // The reason is the button's description and its tooltip, drawn in the window-level tooltip layer (93eb97a64).
    await expect(importButton).toHaveAccessibleDescription('Open a Design to import data')
    await importButton.hover({ force: true })
    await expect(await tooltipOf(importButton)).toHaveText('Open a Design to import data')
  })

  for (const locale of ['de', 'ru']) {
    test(`Analyze at 320 px (${locale}): the close button never overlaps the title (canopi-f47t.48)`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 })
      await openGallery(page, { surface: 'analyze', locale })
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const title = await box(dialog.getByRole('heading', { level: 2 }))
      const close = await box(dialog.locator('header button'))
      const apart = close.x >= title.x + title.width || close.y >= title.y + title.height || close.y + close.height <= title.y
      expect(apart, `title ${JSON.stringify(title)} and close ${JSON.stringify(close)} do not overlap`).toBe(true)
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    })
  }
})
