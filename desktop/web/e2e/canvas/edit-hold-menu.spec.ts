// The menu bar greys what the canvas menu greys (canopi-f47t.52.2, S3b; plan section 4 "2.0 live bugs, guards and
// location"). While a polygon is being drawn, the selection's Cut and Delete are held (U39): the keys and the canvas
// menu refuse them, and Edit in the menu bar shows them disabled too, even after Edit › Select all reselects during the
// draft (the live bug: Edit › Delete deleted while the draft stayed live). Opening and closing Edit is also the focus
// probe in both engines: the draft survives the menu and finishes with its corners. DOM assertions only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

interface Point { readonly x: number, readonly y: number }

/** Corners of a new polygon on empty ground at the opening camera at 1024x768, clear of the chip the finished zone brings up (as input-probe.spec.ts). */
const POLYGON = [{ x: 860, y: 560 }, { x: 940, y: 560 }, { x: 940, y: 620 }] as const satisfies readonly Point[]
/** Past the recogniser's 500 ms multi-click window, so each corner is a first click. */
const PAST_MULTI_CLICK_MS = 600

async function openBaseFixture(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
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

async function openEdit(page: Page): Promise<void> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Edit' }).click()
  await expect(editMenu(page)).toBeVisible()
}

test('Edit greys Cut and Delete while a polygon is drawn, after a reselection too, and closing it keeps the draft', async ({ page }) => {
  await openBaseFixture(page)
  const [first, second, third] = POLYGON

  await test.step('place two polygon corners', async () => {
    await page.keyboard.press('z')
    await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.click(first.x, first.y)
    await page.waitForTimeout(PAST_MULTI_CLICK_MS)
    await page.mouse.click(second.x, second.y)
    await page.waitForTimeout(PAST_MULTI_CLICK_MS)
    await expect(toolCard(page), 'the draft is live: Esc steps it back').toContainText('Esc or Backspace removes the last corner')
    // One hint says what steps the draft back, once (it used to name Backspace and then Esc for the same step).
    expect((await toolCard(page).textContent())?.match(/removes the last/g), 'the step-back hint shows once').toHaveLength(1)
  })

  await test.step('Edit › Select all reselects during the draft', async () => {
    await openEdit(page)
    await editMenu(page).getByRole('menuitem', { name: 'Select all', exact: true }).click()
    await expect(editMenu(page)).toBeHidden()
    await expect(toolCard(page), 'the reselection keeps the draft').toContainText('Esc or Backspace removes the last corner')
  })

  await test.step('Edit shows Cut and Delete disabled while the draft holds them', async () => {
    await openEdit(page)
    await expect(editMenu(page).getByRole('menuitem', { name: 'Cut', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await expect(editMenu(page).getByRole('menuitem', { name: 'Delete', exact: true })).toHaveAttribute('aria-disabled', 'true')
  })

  await test.step('closing the menu keeps the draft, which finishes with its three corners', async () => {
    await page.keyboard.press('Escape')
    await expect(editMenu(page)).toBeHidden()
    await expect(tool(page, 'Polygon zone'), 'Esc closed the menu, not the tool').toHaveAttribute('aria-pressed', 'true')
    await expect(toolCard(page), 'Esc closed the menu, not the draft').toContainText('Esc or Backspace removes the last corner')
    await page.mouse.dblclick(third.x, third.y)
    await expect(selectionChip(page), 'the double-click finished the shape').toHaveText(/^Polygon zone/)
    await page.keyboard.press('Escape')
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-canvas-handle^="vertex:"]'), 'the corners placed before the menu are kept').toHaveCount(3)
  })
})
