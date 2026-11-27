// Esc while a menu bar menu is open (live-bugs step, item 5, from the native live check). A click opens a menu without
// moving focus into it, and Safari and WKWebView do not even focus the menu button: focus stays on the map. An Esc
// there must close the menu and only the menu (the Esc chain's popover layer), so a polygon being drawn survives; and
// closing the menu gives focus back to where it was before it opened, so Enter then finishes the polygon instead of
// opening the menu again. Both engines; DOM assertions only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

interface Point { readonly x: number, readonly y: number }

/** Corners of a new polygon on empty ground at the opening camera at 1024x768 (as edit-hold-menu.spec.ts). */
const POLYGON = [{ x: 860, y: 560 }, { x: 940, y: 560 }, { x: 940, y: 620 }] as const satisfies readonly Point[]
/** Past the recogniser's 500 ms multi-click window, so each corner is a first click. */
const PAST_MULTI_CLICK_MS = 600

test.use({ viewport: { width: 1024, height: 768 } })

test('an Esc from the map closes a menu opened by click and keeps the draft, which Enter then finishes', async ({ page }) => {
  await openBaseFixture(page)
  await drawThreeCorners(page)

  await openEditByClick(page)
  // Where Safari and WKWebView leave focus after the click.
  await designMap(page).focus()
  await page.keyboard.press('Escape')

  await expectMenuClosedAndDraftLive(page)
  await expect(designMap(page), 'the map keeps focus').toBeFocused()
  await page.keyboard.press('Enter')
  await expectPolygonFinished(page)
})

test('an Esc right after the click closes the menu, keeps the draft and hands focus back to the map, so Enter finishes it', async ({ page }) => {
  await openBaseFixture(page)
  await drawThreeCorners(page)

  await openEditByClick(page)
  await page.keyboard.press('Escape')

  await expectMenuClosedAndDraftLive(page)
  await expect(designMap(page), 'focus is back where it was before the menu opened').toBeFocused()
  await page.keyboard.press('Enter')
  await expect(editMenu(page), 'Enter did not open the menu again').toBeHidden()
  await expectPolygonFinished(page)
})

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
}

async function drawThreeCorners(page: Page): Promise<void> {
  await page.keyboard.press('z')
  await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')
  for (const corner of POLYGON) {
    await page.mouse.click(corner.x, corner.y)
    await page.waitForTimeout(PAST_MULTI_CLICK_MS)
  }
  await expect(toolCard(page), 'the draft is live').toContainText('Esc or Backspace removes the last corner')
  await expect(designMap(page)).toBeFocused()
}

async function openEditByClick(page: Page): Promise<void> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Edit' }).click()
  await expect(editMenu(page)).toBeVisible()
}

async function expectMenuClosedAndDraftLive(page: Page): Promise<void> {
  await expect(editMenu(page), 'Esc closed the menu').toBeHidden()
  await expect(tool(page, 'Polygon zone'), 'Esc closed the menu, not the tool').toHaveAttribute('aria-pressed', 'true')
  await expect(toolCard(page), 'Esc closed the menu, not the draft').toContainText('Esc or Backspace removes the last corner')
}

async function expectPolygonFinished(page: Page): Promise<void> {
  await expect(selectionChip(page), 'Enter finished the shape').toHaveText(/^Polygon zone/)
  // Esc leaves the tool, and Select shows the new zone's corner handles.
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-canvas-handle^="vertex:"]'), 'with the three corners placed before the menu').toHaveCount(3)
}

function tool(page: Page, name: string) {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.\\))?$`) })
}

function selectionChip(page: Page) {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function toolCard(page: Page) {
  return page.getByRole('region', { name: 'Polygon zone' }).getByRole('status')
}

function editMenu(page: Page) {
  return page.getByRole('menu', { name: 'Edit' })
}
