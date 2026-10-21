// The Web real-environment check of Step 2.0.2's frontend fixes, through what the user sees in both engines:
// canopi-knon (a selected plant's name label follows the Plants layer's visibility and opacity), canopi-eon8.14.2 (on
// the Web, Save as stamp is greyed in Edit and absent from the canvas menu: the Web Edition saves no stamps, 2.1-Q150)
// and canopi-eon8.14.3 (a group holding a locked member is selectable and its drag is refused with the toast, 2.1-Q161
// and Q177; Unlock clears the group's and its members' locks in one undo step, Q178).
//
// The base fixture at 1024x768 with the basemap hidden (plain paper behind the canvas) and grid snapping off. Labels are
// drawn by the canvas, so the label checks read the page's pixels below the Apple; the lock checks read the saved Design
// (File > Download a copy). DOM assertions and pixel differences only, no baselines.
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expectCanvasDrawn, pressMod } from '../support/canvas'
import type { Point } from '../support/fingers'
import { openFixture } from '../support/layout'
import { pixelsAround, type Pixels } from '../support/pixels'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** The fixture's first Apple (inside the rectangle zone), at the opening camera on a 1024x768 screen. */
const APPLE: Point = { x: 363, y: 266 }
/** The middle of the selected Apple's name label, drawn under its symbol and clear of its selection ring. */
const APPLE_LABEL: Point = { x: 363, y: 292 }
/** Half the side of the square read around the label: its middle letters, not the ring above or the zone line below. */
const LABEL_HALF = 8
/** Empty ground, clear of every object. */
const GROUND: Point = { x: 560, y: 620 }
/** An Apple inside the polygon zone, in the second group of the lock check. */
const OTHER_GROUP_APPLE: Point = { x: 771, y: 266 }

test.use({ viewport: { width: 1024, height: 768 } })

interface SavedPlant { readonly id: string, locked: boolean, readonly position: { readonly lon: number, readonly lat: number } }
interface SavedDesign {
  readonly plants: SavedPlant[]
  groups: Array<{ id: string, locked: boolean, name: string | null, members: Array<{ kind: 'plant', id: string }> }>
}

function selectionChip(page: Page): Locator {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function undo(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true })
}

async function openEditMenu(page: Page): Promise<Locator> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Edit' }).click()
  const menu = page.getByRole('menu', { name: 'Edit' })
  await expect(menu).toBeVisible()
  return menu
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

async function mouseDrag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

async function download(page: Page): Promise<SavedDesign> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Download a copy/ }).click(),
  ])
  return JSON.parse(await readFile(await file.path(), 'utf8')) as SavedDesign
}

/** How much darker the label square is than `paper` (the same square with no label): the sum of each pixel's drop. */
async function labelInk(page: Page, paper: Pixels): Promise<number> {
  const now = await pixelsAround(page, APPLE_LABEL, LABEL_HALF)
  let sum = 0
  for (let i = 0; i < now.data.length; i += 4) {
    const luma = (data: Uint8Array) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    sum += Math.max(0, luma(paper.data) - luma(now.data))
  }
  return sum
}

test.describe('Step 2.0.2 on the Web Edition', () => {
  test('canopi-knon: hiding Plants hides the selected plant\'s name label too; showing it brings it back; its opacity fades the label', async ({ page }) => {
    await openFixture(page, FIXTURE, { basemapHidden: true, settings: { snap_to_grid: false } })
    // Nothing selected, the opening zoom draws no plant names: the square under the Apple is paper.
    const paper = await pixelsAround(page, APPLE_LABEL, LABEL_HALF)

    await page.mouse.click(APPLE.x, APPLE.y)
    await expect(selectionChip(page)).toHaveText('Apple')
    await expectCanvasDrawn(page)
    const shown = await labelInk(page, paper)
    expect(shown, 'the selected Apple shows its name label').toBeGreaterThan(1500)

    await page.getByRole('button', { name: /^Layers\b/ }).first().click()
    const panel = page.getByRole('complementary', { name: 'Layers' })
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Hide Plants' }).click()
    await expect(panel.getByRole('button', { name: 'Show Plants' })).toHaveAttribute('aria-pressed', 'false')
    await expectCanvasDrawn(page)
    expect(await labelInk(page, paper), 'with Plants hidden, the selected Apple\'s label is gone with its symbol').toBeLessThan(shown * 0.02)

    await panel.getByRole('button', { name: 'Show Plants' }).click()
    await expect(panel.getByRole('button', { name: 'Hide Plants' })).toHaveAttribute('aria-pressed', 'true')
    await expectCanvasDrawn(page)
    await expect.poll(() => labelInk(page, paper), 'showing Plants again brings the label back')
      .toBeGreaterThan(shown * 0.9)

    await panel.getByRole('button', { name: /^Plants/ }).click()
    const slider = panel.getByRole('slider', { name: 'Opacity: Plants' })
    await expect(slider).toBeVisible()
    await slider.fill('20')
    await expect(slider).toHaveAttribute('aria-valuetext', '20%')
    await expectCanvasDrawn(page)
    await expect(selectionChip(page), 'the Apple stays selected').toHaveText('Apple')
    await expect.poll(async () => {
      const faded = await labelInk(page, paper) / shown
      return faded > 0.05 && faded < 0.45
    }, 'at 20 % Plants opacity the label fades with the layer, neither gone nor at full ink').toBe(true)
  })

  test('canopi-eon8.14.2: on the Web, Edit > Save as stamp is greyed with a selection and the canvas menu does not offer it', async ({ page }) => {
    await openFixture(page, FIXTURE, { basemapHidden: true, settings: { snap_to_grid: false } })
    await page.mouse.click(APPLE.x, APPLE.y)
    await expect(selectionChip(page)).toHaveText('Apple')

    const edit = await openEditMenu(page)
    const saveAsStamp = edit.getByRole('menuitem', { name: 'Save as stamp' })
    const copy = edit.getByRole('menuitem', { name: 'Copy', exact: true })
    await expect(copy, 'the selection enables Copy').toBeEnabled()
    await expect(saveAsStamp, 'Save as stamp is listed').toBeVisible()
    await expect(saveAsStamp, 'Save as stamp is disabled on the Web').toBeDisabled()
    const colour = (item: Locator) => item.evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.color} ${style.opacity}`
    })
    expect(await colour(saveAsStamp), 'Save as stamp is greyed, unlike Copy').not.toBe(await colour(copy))
    await saveAsStamp.click({ force: true })
    await expect(page.getByRole('dialog'), 'a click on the greyed item opens nothing').toHaveCount(0)
    await closeMenus(page)

    await page.mouse.click(APPLE.x, APPLE.y, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Apple' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Copy/ }), 'the canvas menu is the selection\'s').toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /stamp/i }), 'the canvas menu offers no Save as stamp').toHaveCount(0)
    await closeMenus(page)
    await expect(undo(page), 'nothing was edited').toBeDisabled()
  })

  test('canopi-eon8.14.3: a group holding a locked member is selected, its drag refused with the toast; Unlock clears every lock in one undo step', async ({ page }) => {
    const base = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SavedDesign
    const [apple, , lowApple] = base.plants
    const otherApple = base.plants[1]!
    const hazel = base.plants[5]!
    // Group A: the Apple and a locked Apple, the group itself unlocked (the bug's case). Group B: locked itself and
    // holding a locked Apple, so Unlock has a group lock and member locks to clear.
    const design = structuredClone(base)
    design.plants[2]!.locked = true
    design.plants[1]!.locked = true
    design.groups = [
      { id: 'group-a', locked: false, name: null, members: [{ kind: 'plant', id: apple!.id }, { kind: 'plant', id: lowApple!.id }] },
      { id: 'group-b', locked: true, name: null, members: [{ kind: 'plant', id: otherApple.id }, { kind: 'plant', id: hazel.id }] },
    ]
    const fixture = test.info().outputPath('locked-member-group.canopi')
    writeFileSync(fixture, JSON.stringify(design))
    await openFixture(page, fixture, { basemapHidden: true, settings: { snap_to_grid: false } })

    await page.mouse.click(APPLE.x, APPLE.y)
    await expect(selectionChip(page), 'a click on the group selects it').toHaveText(/^2 plants · Apple/)
    let menu = await openEditMenu(page)
    await expect(menu.getByRole('menuitem', { name: 'Unlock', exact: true }), 'the group shows as locked: Unlock is offered').toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'Lock', exact: true }), 'and Lock is not').toBeDisabled()
    await closeMenus(page)

    await mouseDrag(page, APPLE, { x: APPLE.x + 60, y: APPLE.y + 40 })
    const toast = page.locator('[data-locked-move-toast]')
    await expect(toast, 'the refused drag says why').toBeVisible()
    await expect(toast).toContainText('Locked: unlock to move')
    await expect(undo(page), 'the drag moved nothing').toBeDisabled()
    await expect(selectionChip(page), 'the group stays selected').toHaveText(/^2 plants · Apple/)
    const unmoved = await download(page)
    expect(unmoved.plants.find((plant) => plant.id === apple!.id)!.position, 'the Apple did not move').toEqual(apple!.position)

    await page.keyboard.down('Shift')
    await page.mouse.click(OTHER_GROUP_APPLE.x, OTHER_GROUP_APPLE.y)
    await page.keyboard.up('Shift')
    await expect(selectionChip(page), 'Shift-click adds the locked group B').toHaveText(/^4 plants/)
    menu = await openEditMenu(page)
    await menu.getByRole('menuitem', { name: 'Unlock', exact: true }).click()
    await expect(undo(page), 'Unlock is one edit').toBeEnabled()

    const locks = (saved: SavedDesign) => ({
      groups: saved.groups.map((group) => [group.id, group.locked]),
      plants: [apple!, lowApple!, otherApple, hazel].map((plant) => saved.plants.find((each) => each.id === plant.id)!.locked),
    })
    expect(locks(await download(page)), 'Unlock clears both groups\' locks and every member\'s').toEqual({
      groups: [['group-a', false], ['group-b', false]],
      plants: [false, false, false, false],
    })

    await undo(page).click()
    await expect(undo(page), 'one Undo takes the whole Unlock back').toBeDisabled()
    expect(locks(await download(page)), 'one Undo restores every lock').toEqual({
      groups: [['group-a', false], ['group-b', true]],
      plants: [false, true, true, false],
    })

    await pressMod(page, 'Shift+z')
    await expect(undo(page), 'Redo unlocks again').toBeEnabled()
    await page.mouse.click(GROUND.x, GROUND.y)
    await expect(page.locator('[data-selection-chip]')).toHaveCount(0)
    await page.mouse.click(APPLE.x, APPLE.y)
    await expect(selectionChip(page)).toHaveText(/^2 plants · Apple/)
    await mouseDrag(page, APPLE, { x: APPLE.x + 60, y: APPLE.y + 40 })
    await expectCanvasDrawn(page)
    const moved = await download(page)
    const at = (saved: SavedDesign, id: string) => saved.plants.find((plant) => plant.id === id)!.position
    expect(at(moved, apple!.id), 'after Unlock the drag moves the Apple').not.toEqual(apple!.position)
    expect(at(moved, lowApple!.id), 'and its group\'s other Apple with it').not.toEqual(lowApple!.position)
    await page.mouse.click(GROUND.x, GROUND.y)
    await page.mouse.click(APPLE.x + 60, APPLE.y + 40)
    await expect(selectionChip(page), 'the group is where it was dropped').toHaveText(/^2 plants · Apple/)
  })
})
