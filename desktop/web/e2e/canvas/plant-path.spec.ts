// Plant a row bends (canopi-f47t.54, stream P; plan section 4 "2.0 plant along a path", amendment A1, A2, A8, A17): after
// the pick, clicks add points and Enter, a double-click on the last point or the tool card's check button plants the row
// along a smooth curve through them, in one Undo step; a click on the first point closes a loop; "N plants" counts the
// picked plant; before planting a point drags, a dot drag or double-click inserts, Alt+click deletes and Alt while placing
// makes a sharp point; Esc, Backspace and Ctrl+Z step back one point; Delete removes the last-touched point, and a
// right-click or long press on a point opens its menu (the card offers no point buttons: decision 16), where Delete and
// Backspace delete that point and Ctrl+Z closes it (stream D). A drag from the plant still plants a straight row (guard). Both engines unless a
// test says otherwise; WebKit has taps, finger drags are Chromium-only (CDP). DOM and saved-Design assertions only, no
// baselines; the path engine's positions are compared bit for bit between Node and each browser, so these tests read
// exact positions.
//
// The base fixture at 1024x768 with grid snapping off, so a click places a point where it lands: its opening camera puts
// the rectangle zone's north-west corner at (322, 226) and draws 10.2 px per metre; the Apple inside that zone is the
// row's picked plant. Each test first moves the map 192 px down with the arrow keys (OPENING_PAN_PX). The DOM contract
// these tests read (stream P builds it): row points and midpoint dots are canvas handles `point:<owner>:<index>` and
// `dot:<owner>:<index>` (glyph `corner` on a sharp point); the tool card carries the check button
// `[data-plant-row-finish]`, the mode switch `[data-plant-row-mode="interval" | "count"]`, the count field
// `[data-plant-row-count-input]` and a loop's rounded spacing `[data-plant-row-loop-spacing]`.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { pressMod } from '../support/canvas'
import { Fingers, type Point } from '../support/fingers'
import { mapHost, openFixture } from '../support/layout'
import { pageBundle } from '../support/page-bundle'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

interface StoredPlant { readonly id: string, readonly canonical_name: string, readonly position: { readonly lon: number, readonly lat: number } }

const BASE_PLANT_IDS = new Set((JSON.parse(readFileSync(FIXTURE, 'utf8')) as { plants: StoredPlant[] }).plants.map((plant) => plant.id))
/**
 * The opening camera moved 3 arrow-key steps (3 x 64 px) so the map's content sits lower: the tool card, which grows once
 * a row has points (1024x768 lays out the named rail and the card beside it, about 250 px tall), then leaves the picked
 * Apple and the row's points clear, as a user pans to draw beside the card.
 */
const OPENING_PAN_PX = 3 * 64
function onScreen(x: number, y: number): Point {
  return { x, y: y + OPENING_PAN_PX }
}

/** The picked Apple, as stored and on screen. */
const APPLE_ID = '46595420-3ba9-4184-a4b0-b65fb40eff31'
const APPLE_GEO = { lon: 3.877071839, lat: 43.611230142 }
const APPLE: Point = onScreen(362.7, 266.3)
const PX_PER_M = 10.2
/** Empty ground for the row's points, about 9 to 11 m apart. */
const P1: Point = onScreen(437, 345)
const P2: Point = onScreen(516, 301)
const P3: Point = onScreen(579, 369)
/** Empty ground for a loop with the Apple: about 11 m from it and from each other. */
const Q1: Point = onScreen(477, 267)
const Q2: Point = onScreen(420, 365)
/** Empty ground for a point placed with Alt. */
const P4: Point = onScreen(643, 330)
/** Empty ground away from the row (above the row once the map moved down). */
const GROUND: Point = { x: 560, y: 590 }

test.use({ viewport: { width: 1024, height: 768 } })

async function openBase(page: Page): Promise<void> {
  await openFixture(page, FIXTURE, { settings: { snap_to_grid: false } })
  await mapHost(page).focus()
  for (let step = 0; step < OPENING_PAN_PX / 64; step += 1) await page.keyboard.press('ArrowUp')
}

function undo(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true })
}

function card(page: Page): Locator {
  return page.locator('[data-tool-card]')
}

function selectionChip(page: Page): Locator {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function intervalField(page: Page): Locator {
  return page.locator('[data-plant-spacing-interval-input]')
}

function tool(page: Page, name: string): Locator {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.\\))?$`) })
}

/** Arms Plant a row from the keyboard (W). */
async function armRow(page: Page): Promise<void> {
  await mapHost(page).focus()
  await page.keyboard.press('w')
  await expect(card(page)).toHaveAttribute('data-tool-card', 'plant-spacing')
}

/** Arms Plant a row, picks the Apple and keeps an interval: Enter in the field keeps it and gives the map focus back. */
async function pickApple(page: Page, interval = '2'): Promise<void> {
  await armRow(page)
  await page.mouse.click(APPLE.x, APPLE.y)
  await expect(intervalField(page), 'the pick focuses the spacing field').toBeFocused()
  await intervalField(page).fill(interval)
  await page.keyboard.press('Enter')
  await expect(mapHost(page), 'Enter in the field gives the map focus back').toBeFocused()
}

async function click(page: Page, at: Point, modifiers: readonly ('Alt' | 'Shift')[] = []): Promise<void> {
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(at.x, at.y)
  for (const key of modifiers) await page.keyboard.up(key)
}

async function drag(page: Page, from: Point, to: Point, steps = 10): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps)
  }
  await page.mouse.up()
}

interface Handle { readonly id: string, readonly glyph: string, readonly index: number, readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** The shown row point or dot handles, by index. */
async function handles(page: Page, role: 'point' | 'dot'): Promise<Handle[]> {
  const all = await page.locator(`[data-canvas-handle^="${role}:"]`).evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return {
      id: element.getAttribute('data-canvas-handle') ?? '',
      glyph: element.getAttribute('data-canvas-handle-glyph') ?? '',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      width: box.width,
      height: box.height,
    }
  }))
  return all.map((handle) => ({ ...handle, index: Number(handle.id.split(':').at(-1)) })).sort((a, b) => a.index - b.index)
}

/** The draft's points: one more than the highest point index shown (the picked plant is point 0). */
async function pointCount(page: Page): Promise<number> {
  const points = await handles(page, 'point')
  return points.length === 0 ? 0 : points.at(-1)!.index + 1
}

async function pointAt(page: Page, index: number): Promise<Handle> {
  const point = (await handles(page, 'point')).find((handle) => handle.index === index)
  if (!point) throw new Error(`no point ${index} is shown`)
  return point
}

/** Undo is on, one Undo turns it off: the step made exactly one Design edit on a freshly opened Design. */
async function expectOneUndoStep(page: Page, what: string): Promise<void> {
  await expect(undo(page), `${what}: one Design edit`).toBeEnabled()
  await undo(page).click()
  await expect(undo(page), `${what}: one Undo restores the Design`).toBeDisabled()
}

/**
 * Nothing is planted yet: no row's plants are selected, as a finish selects them. Undo is no witness while a row is
 * drawn: Edit > Undo then takes the draft's last point back (A17). The test's one-Undo-step check after the finish
 * proves the draft made no Design edit before it.
 */
async function expectNothingPlanted(page: Page, what: string): Promise<void> {
  await expect(selectionChip(page).filter({ hasText: /plants · Apple/ }), what).toHaveCount(0)
}

/** The Design as File > Download a copy saves it. */
async function savedDesign(page: Page): Promise<{ plants: StoredPlant[] }> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Download a copy/ }).click(),
  ])
  return JSON.parse(await readFile(await download.path(), 'utf8')) as { plants: StoredPlant[] }
}

/** Metres east and north of the Apple: the plane is flat enough over 50 m for these checks. */
function metresFromApple(geo: { readonly lon: number, readonly lat: number }): Point {
  const lat = (APPLE_GEO.lat * Math.PI) / 180
  return { x: (geo.lon - APPLE_GEO.lon) * 111_320 * Math.cos(lat), y: (geo.lat - APPLE_GEO.lat) * 110_574 }
}

function screenToMetres(at: Point): Point {
  return { x: (at.x - APPLE.x) / PX_PER_M, y: -(at.y - APPLE.y) / PX_PER_M }
}

/** The row's plants in the saved Design: the Apple and the Apples the row added. */
async function savedRow(page: Page): Promise<Point[]> {
  const design = await savedDesign(page)
  return design.plants
    .filter((plant) => plant.id === APPLE_ID || (!BASE_PLANT_IDS.has(plant.id) && plant.canonical_name === 'Malus domestica'))
    .map((plant) => metresFromApple(plant.position))
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Distance from `p` to the line through `a` and `b`. */
function offLine(p: Point, a: Point, b: Point): number {
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / distance(a, b)
}

/** The plant count the selection chip leads with ("15 plants · Apple"). */
async function selectedPlants(page: Page): Promise<number> {
  const text = (await selectionChip(page).textContent()) ?? ''
  const match = /^(\d+)/.exec(text.trim())
  return match ? Number(match[1]) : 1
}

test('(canopi-f47t.54, P) clicks bend a row through four points and Enter plants it in one Undo step', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expectNothingPlanted(page, 'a click adds a point and plants nothing')
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)

  await page.keyboard.press('Enter')
  await expect(selectionChip(page), 'Enter plants the row and selects it').toHaveText(/^\d+ plants · Apple/)
  const row = await savedRow(page)
  expect(row.length, 'the row is planted').toBeGreaterThan(10)
  expect(await selectedPlants(page), 'the selection is the row').toBe(row.length)
  for (const [name, at] of [['the first point', P1], ['the second point', P2]] as const) {
    const point = screenToMetres(at)
    expect(Math.min(...row.map((plant) => distance(plant, point))), `the row passes through ${name}`).toBeLessThanOrEqual(1.2)
  }
  // Every 2 m from the picked plant: the last plant stands within one interval of the last point.
  expect(Math.min(...row.map((plant) => distance(plant, screenToMetres(P3)))), 'the row runs to the last point').toBeLessThanOrEqual(2.2)
  const end = screenToMetres(P3)
  expect(Math.max(...row.map((plant) => offLine(plant, { x: 0, y: 0 }, end))), 'the row bends away from the straight line').toBeGreaterThan(3)
  await expectOneUndoStep(page, 'the planted row')
})

test('(canopi-f47t.54, P) a double-click on the last point plants the row', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  await click(page, P1)
  await click(page, P2)
  await expectNothingPlanted(page, 'a click adds a point and plants nothing')
  const last = await pointAt(page, 2)
  await page.mouse.dblclick(last.x, last.y)
  await expect(selectionChip(page), 'the double-click plants the row').toHaveText(/^\d+ plants · Apple/)
  const row = await savedRow(page)
  const bend = screenToMetres(P1)
  expect(Math.min(...row.map((plant) => distance(plant, bend))), 'the row passes through the first point').toBeLessThanOrEqual(1.2)
  await expectOneUndoStep(page, 'the planted row')
})

test('(canopi-f47t.54, P) the check button plants the row', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  await click(page, P1)
  await click(page, P2)
  const finish = card(page).locator('[data-plant-row-finish]')
  await expect(finish, 'two points show the check button').toBeVisible()
  await expectNothingPlanted(page, 'nothing is planted before the finish')
  await finish.click()
  await expect(selectionChip(page), 'the check button plants the row').toHaveText(/^\d+ plants · Apple/)
  await expect(finish, 'the planted row leaves no check button').toHaveCount(0)
  await expectOneUndoStep(page, 'the planted row')
})

test('(canopi-f47t.54, P) a click on the first point closes a loop and every N m rounds to equal gaps shown in the card', async ({ page }) => {
  await openBase(page)
  await pickApple(page, '3')
  await click(page, Q1)
  await click(page, Q2)
  await click(page, APPLE)
  const shown = card(page).locator('[data-plant-row-loop-spacing]')
  await expect(shown, 'the closed loop shows its rounded spacing').toBeVisible()
  await expectNothingPlanted(page, 'closing the loop plants nothing')
  const spacing = Number.parseFloat(((await shown.textContent()) ?? '').replace(',', '.'))
  expect(spacing, 'every 3 m rounds to a nearby equal gap').toBeGreaterThan(2.5)
  expect(spacing).toBeLessThan(3.5)

  await page.keyboard.press('Enter')
  await expect(selectionChip(page), 'Enter plants the loop').toHaveText(/^\d+ plants · Apple/)
  const row = await savedRow(page)
  expect(row.length, 'a loop of some 35 m at about 3 m').toBeGreaterThanOrEqual(10)
  const gaps = row.map((plant) => Math.min(...row.filter((other) => other !== plant).map((other) => distance(plant, other))))
  for (const gap of gaps) expect(Math.abs(gap - Math.min(...gaps)), 'the loop\'s gaps are equal').toBeLessThanOrEqual(0.25)
  await expectOneUndoStep(page, 'the planted loop')
})

test('(canopi-f47t.54, P) N plants evenly plants N plants, the picked one included', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  await click(page, P1)
  const plants = card(page).locator('[data-plant-row-mode="count"]')
  await expect(plants, 'the card offers N plants').toBeVisible()
  await plants.click()
  const count = card(page).locator('[data-plant-row-count-input]')
  await count.fill('5')
  await count.press('Enter')
  await expect(mapHost(page), 'Enter in the count gives the map focus back').toBeFocused()
  await page.keyboard.press('Enter')
  await expect(selectionChip(page), 'five plants, the picked Apple among them').toHaveText(/^5 plants · Apple/)
  expect((await savedRow(page)).length, 'the row holds five plants').toBe(5)
  await expectOneUndoStep(page, 'the planted row')
})

test('(canopi-f47t.54, P) before planting: drag a point, drag a dot to insert, double-click a dot to insert in place, Alt+click deletes a point, Alt while placing makes it sharp', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)

  const second = await pointAt(page, 2)
  const moved = { x: second.x, y: second.y - 30 }
  await drag(page, second, moved)
  await expect.poll(async () => Math.round(distance(await pointAt(page, 2), moved)), 'the dragged point follows the pointer').toBeLessThanOrEqual(2)

  const [firstDot] = await handles(page, 'dot')
  if (!firstDot) throw new Error('the draft shows no midpoint dot')
  await drag(page, firstDot, { x: firstDot.x - 20, y: firstDot.y + 20 })
  await expect.poll(() => pointCount(page), 'a dot drag inserts a point').toBe(5)
  const inserted = await pointAt(page, 1)
  expect(distance(inserted, { x: firstDot.x - 20, y: firstDot.y + 20 }), 'the inserted point is where the drag ended').toBeLessThanOrEqual(2)

  const dot = (await handles(page, 'dot')).at(-1)!
  await page.mouse.dblclick(dot.x, dot.y)
  await expect.poll(() => pointCount(page), 'a double-click on a dot inserts a point in place').toBe(6)

  const third = await pointAt(page, 3)
  await click(page, third, ['Alt'])
  await expect.poll(() => pointCount(page), 'Alt+click deletes the point').toBe(5)

  await click(page, P4, ['Alt'])
  await expect.poll(() => pointCount(page), 'Alt while placing still adds a point').toBe(6)
  expect((await pointAt(page, 5)).glyph, 'a point placed with Alt is sharp').toBe('corner')
  expect((await pointAt(page, 4)).glyph, 'a point placed without Alt is smooth').toBe('vertex')
  await expectNothingPlanted(page, 'editing the draft plants nothing')
})

test('(canopi-f47t.54, P) Esc, Backspace and Ctrl+Z remove the last point and Ctrl+Shift+Z restores it; only Esc drops the picked plant, then returns to Select', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)

  await page.keyboard.press('Escape')
  await expect.poll(() => pointCount(page), 'Esc removes the last point').toBe(3)
  await page.keyboard.press('Backspace')
  await expect.poll(() => pointCount(page), 'Backspace removes the last point').toBe(2)
  await pressMod(page, 'z')
  await expect.poll(() => pointCount(page), 'Ctrl+Z removes the last point').toBeLessThanOrEqual(1)
  // Only the picked plant left: Ctrl+Z and Backspace do nothing, never the Design's undo or Delete selected.
  await pressMod(page, 'z')
  await page.keyboard.press('Backspace')
  await expect(intervalField(page), 'the picked plant stays').toBeVisible()
  for (let step = 0; step < 3; step += 1) await pressMod(page, 'Shift+z')
  await expect.poll(() => pointCount(page), 'Ctrl+Shift+Z restores every removed point').toBe(4)

  for (let step = 0; step < 3; step += 1) await page.keyboard.press('Escape')
  await expect.poll(() => pointCount(page), 'Esc steps back to the picked plant').toBeLessThanOrEqual(1)
  await expect(intervalField(page), 'the picked plant stays after the points').toBeVisible()
  await page.keyboard.press('Escape')
  await expect(intervalField(page), 'the next Esc drops the picked plant').toHaveCount(0)
  await expect(card(page)).toHaveAttribute('data-tool-card', 'plant-spacing')
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select'), 'the last Esc returns to Select').toHaveAttribute('aria-pressed', 'true')
  await expect(undo(page), 'stepping back edits nothing').toBeDisabled()
})

// Decision 16 (2026-10-11): points are edited where they are (their menu, Alt+click, Delete), never from the card.
test('(canopi-f47t.54, P) a click on a point then Delete removes that point; the card offers no point buttons', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)

  const second = await pointAt(page, 2)
  await page.mouse.click(second.x, second.y)
  const foot = card(page).locator('[data-path]')
  await expect(foot.getByRole('button'), 'the foot\'s one button plants the row').toHaveCount(1)
  await expect(foot.locator('[data-plant-row-finish]')).toBeVisible()
  await page.keyboard.press('Delete')
  await expect.poll(() => pointCount(page), 'Delete removes the clicked point').toBe(3)
  const kept = await pointAt(page, 2)
  expect(Math.hypot(kept.x - P3.x, kept.y - P3.y), 'the last point is kept, the clicked one gone').toBeLessThan(2)
  await expectNothingPlanted(page, 'Delete plants nothing')
})

function menuEntries(page: Page): Locator {
  return page.getByRole('menu').getByRole('menuitem')
}

/** The open canvas menu holds `names`, in order; Esc then closes it. */
async function expectMenu(page: Page, names: readonly RegExp[], how: string): Promise<void> {
  await expect(menuEntries(page), how).toHaveCount(names.length)
  for (const [index, name] of names.entries()) await expect(menuEntries(page).nth(index), how).toHaveAccessibleName(name)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

// Moved from plant-path-select.spec.ts when Select stopped editing rows (answer 27): the point menu while drawing.
test('(canopi-f47t.54, P) right-click and long press on a point while drawing open Finish shape, Delete point and Sharp or Smooth corner, and plant nothing (long press Chromium)', async ({ page, browserName }) => {
  await openBase(page)
  await pickApple(page)
  await click(page, P1)
  await click(page, P2, ['Alt'])
  await expect.poll(() => pointCount(page), 'the picked plant and two points').toBe(3)

  const smooth = await pointAt(page, 1)
  await page.mouse.click(smooth.x, smooth.y, { button: 'right' })
  await expectMenu(page, [/^Finish shape/, /^Delete point/, /^Sharp corner/], 'a right-click on a smooth point')
  const sharp = await pointAt(page, 2)
  await page.mouse.click(sharp.x, sharp.y, { button: 'right' })
  await expectMenu(page, [/^Finish shape/, /^Delete point/, /^Smooth corner/], 'a right-click on a sharp point')
  if (browserName === 'chromium') {
    const fingers = await Fingers.of(page)
    await fingers.tap(smooth, { holdMs: 600 })
    await expectMenu(page, [/^Finish shape/, /^Delete point/, /^Sharp corner/], 'a long press on a point')
  }

  await expect.poll(() => pointCount(page), 'the row is still drawn').toBe(3)
  await expectNothingPlanted(page, 'opening the menus plants nothing')
})

// In a point's menu, Delete and Backspace are its Delete point: never the last point or the last-touched one.
test('(canopi-f47t.54, D) Delete and Backspace in a point\'s menu while drawing delete that point and close the menu', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)

  for (const [key, left, next] of [['Delete', 3, P2], ['Backspace', 2, P3]] as const) {
    const point = await pointAt(page, 1)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(menuEntries(page), 'the point menu').toHaveCount(3)
    await page.keyboard.press(key)
    await expect(page.getByRole('menu'), `${key} closes the menu`).toHaveCount(0)
    await expect.poll(() => pointCount(page), `${key} removes one point`).toBe(left)
    expect(distance(await pointAt(page, 1), next), `${key} removes the menu's point, not the last one`).toBeLessThan(2)
  }
  await expectNothingPlanted(page, 'the keys plant nothing')
})

// The point menu names its point by index; once the draft's points change, it closes.
test('(canopi-f47t.54, D) Ctrl+Z with a point\'s menu open while drawing takes the last point back and closes the menu', async ({ page }) => {
  await openBase(page)
  await pickApple(page)
  for (const at of [P1, P2, P3]) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and three points').toBe(4)
  const second = await pointAt(page, 2)
  await page.mouse.click(second.x, second.y, { button: 'right' })
  await expect(menuEntries(page), 'the point menu').toHaveCount(3)
  await pressMod(page, 'z')
  await expect(page.getByRole('menu'), 'Ctrl+Z closes the point menu').toHaveCount(0)
  await expect.poll(() => pointCount(page), 'Ctrl+Z takes the last point back').toBe(3)
  await expect(mapHost(page), 'focus goes back to the map').toBeFocused()
  await expectNothingPlanted(page, 'nothing is planted')
})

test('(canopi-f47t.54, P) a drag from the plant still plants a straight row in one Undo step (guard)', async ({ page }) => {
  await openBase(page)
  await armRow(page)
  await drag(page, APPLE, P1)
  await expect(selectionChip(page), 'the release plants the row and selects it').toHaveText(/^\d+ plants · Apple/)
  const row = await savedRow(page)
  expect(row.length, 'every 50 cm along some 10.6 m').toBeGreaterThan(15)
  expect(await selectedPlants(page)).toBe(row.length)
  const source = row.find((plant) => distance(plant, { x: 0, y: 0 }) < 0.01)!
  const end = row.reduce((far, plant) => (distance(plant, source) > distance(far, source) ? plant : far), source)
  expect(distance(end, screenToMetres(P1)), 'the row ends near the release').toBeLessThanOrEqual(0.6)
  for (const plant of row) expect(offLine(plant, source, end), 'the row is straight').toBeLessThanOrEqual(0.02)
  await expectOneUndoStep(page, 'the planted row')
})

/** The path engine (src/canvas/plant-path/spacing.ts) bundled as one script: `window.__plantPath` in a page. */
function engineScript(): Promise<string> {
  return pageBundle("export * from './spacing'", fileURLToPath(new URL('../../src/canvas/plant-path/', import.meta.url)), '__plantPath')
}

/** One curved open row, one loop with a sharp point and one loop counted out, as JSON of their counts, spacings and positions. */
function plantCurvedRows(engine: { plantAlongPath: (path: unknown, spacing: unknown) => { count: number, effectiveSpacingM: number, lengthM: number, positions(limit?: number): unknown[] } }): string {
  const at = (x: number, y: number, sharp = false) => ({ position: { x, y }, sharp })
  const rows = [
    engine.plantAlongPath({ points: [at(0, 0), at(7.3, 4.1), at(15.2, -2.7), at(23.9, 3.3)], closed: false }, { kind: 'interval', metres: 0.7 }),
    engine.plantAlongPath({ points: [at(0, 0), at(11.1, 0.4), at(9.7, 10.2, true), at(-1.3, 8.8)], closed: true }, { kind: 'interval', metres: 1.3 }),
    engine.plantAlongPath({ points: [at(3, 1), at(-4.4, 6.5), at(-9.2, -3.1)], closed: true }, { kind: 'count', count: 17 }),
  ]
  return JSON.stringify(rows.map((row) => ({ count: row.count, spacing: row.effectiveSpacingM, length: row.lengthM, positions: row.positions() })))
}

/** The fixture's Design as stored: every plant, zone corner and label anchor, in metres east and north of the Apple. */
function designPoints(): Point[] {
  type Geo = { readonly lon: number, readonly lat: number }
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    plants: { position: Geo }[], zones: { points: Geo[] }[], annotations: { position: Geo }[]
  }
  return [
    ...design.plants.map((plant) => plant.position),
    ...design.zones.flatMap((zone) => zone.points),
    ...design.annotations.map((annotation) => annotation.position),
  ].map(metresFromApple)
}

// Answer 15 (2026-10-11): where the grown card covers the picked plant or the points, the user pans, as with zone
// corners; the card registers with the visible-map-area seam, so Fit to Design frames the Design clear of it. At the
// opening framing (not moved) the grown card covers the picked Apple.
test('(canopi-f47t.54, P) with the grown card shown, Fit to Design frames the Design clear of the card', async ({ page }) => {
  await openFixture(page, FIXTURE, { settings: { snap_to_grid: false } })
  const opening = (at: Point): Point => ({ x: at.x, y: at.y - OPENING_PAN_PX })
  const apple = opening(APPLE)
  // Two points on empty ground right of the card, at the opening framing.
  const placed = [opening(P3), opening(P4)] as const
  await armRow(page)
  await page.mouse.click(apple.x, apple.y)
  await expect(intervalField(page), 'the pick focuses the spacing field').toBeFocused()
  await page.keyboard.press('Enter')
  for (const at of placed) await click(page, at)
  await expect.poll(() => pointCount(page), 'the picked plant and two points').toBe(3)
  const covered = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-tool-card]') !== null, apple)
  expect(covered, 'at the opening framing the grown card covers the picked Apple').toBe(true)

  await page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Fit to Design' }).click()
  // The camera after the fit, from the two points' handles: screen = first + k (metres - first's metres), in complex
  // numbers (east, south), so a turn or a new scale reads the same.
  const metres = placed.map((at) => ({ x: (at.x - apple.x) / PX_PER_M, y: -(at.y - apple.y) / PX_PER_M }))
  // The camera has come to rest: the points read the same twice in a row.
  let last = ''
  await expect.poll(async () => {
    const now = JSON.stringify([await pointAt(page, 1), await pointAt(page, 2)])
    const still = now === last
    last = now
    return still
  }, { message: 'the fit comes to rest', intervals: [100] }).toBe(true)
  const [first, second] = JSON.parse(last) as [Handle, Handle]
  const dm = { re: metres[1]!.x - metres[0]!.x, im: -(metres[1]!.y - metres[0]!.y) }
  const ds = { re: second.x - first.x, im: second.y - first.y }
  const norm = dm.re * dm.re + dm.im * dm.im
  const k = { re: (ds.re * dm.re + ds.im * dm.im) / norm, im: (ds.im * dm.re - ds.re * dm.im) / norm }
  const toScreen = (m: Point): Point => {
    const d = { re: m.x - metres[0]!.x, im: -(m.y - metres[0]!.y) }
    return { x: first.x + k.re * d.re - k.im * d.im, y: first.y + k.re * d.im + k.im * d.re }
  }
  const box = await card(page).boundingBox()
  if (!box) throw new Error('the card is not shown')
  for (const point of designPoints().map(toScreen)) {
    const inside = point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height
    expect(inside, `the Design at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) is clear of the card ${JSON.stringify(box)}`).toBe(false)
  }
})

test('(canopi-f47t.54, P) the path engine plants a curved row to the same bits in this browser as in Node', async ({ page }) => {
  const script = await engineScript()
  const inNode = plantCurvedRows(new Function(`${script}; return __plantPath`)())
  await page.goto('about:blank')
  await page.addScriptTag({ content: script })
  const inPage = await page.evaluate(`(${plantCurvedRows.toString()})(window.__plantPath)`)
  expect(inPage, 'the same JSON, bit for bit').toBe(inNode)
})

/**
 * The double-click on the ground (A1): its first press places a point, whose handle the second press then lands on, as
 * a handle press with a click count of 2 on the last point, which plants the row through that point. Nothing hears the
 * native dblclick: no text is selected, and the one Undo step is the row.
 */
test('(canopi-f47t.54, P) a double-click on the ground plants the row through the point its first press placed', async ({ page }) => {
  // Records each pointerdown's handle before the canvas hears it; changes nothing.
  await page.addInitScript(() => {
    const downs: Array<string | null> = []
    Object.assign(window, { __rowDowns: downs })
    window.addEventListener('pointerdown', (event) => {
      downs.push(event.target instanceof Element ? event.target.closest('[data-canvas-handle]')?.getAttribute('data-canvas-handle') ?? null : null)
    }, { capture: true })
  })
  const downs = () => page.evaluate(() => (window as unknown as { __rowDowns: Array<string | null> }).__rowDowns.slice())
  await openBase(page)
  await pickApple(page)
  await click(page, P1)
  await page.waitForTimeout(600)
  const before = (await downs()).length
  await page.mouse.dblclick(P2.x, P2.y)
  await expect(selectionChip(page), 'the double-click plants the row').toHaveText(/^\d+ plants · Apple/)
  expect((await downs()).slice(before), 'the second press lands on the point the first one placed').toEqual([null, 'point:draft:2'])
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''), 'the dblclick selects no text').toBe('')
  const row = await savedRow(page)
  expect(Math.min(...row.map((plant) => distance(plant, screenToMetres(P2)))), 'the row runs to the double-clicked point').toBeLessThanOrEqual(2.2)
  await expectOneUndoStep(page, 'the planted row')
})

test.describe('touch', () => {
  test.use({ hasTouch: true })

  test('(canopi-f47t.54, P) touch: tapped points get 44 px handles and the check button plants (WebKit touchscreen.tap, Chromium)', async ({ page }) => {
    await openBase(page)
    await page.touchscreen.tap(GROUND.x, GROUND.y)
    await armRow(page)
    await page.touchscreen.tap(APPLE.x, APPLE.y)
    await expect(intervalField(page), 'the pick focuses the spacing field').toBeFocused()
    await intervalField(page).fill('2')
    await page.keyboard.press('Enter')
    for (const at of [P1, P2]) {
      // Apart in time, so the taps are not a double tap.
      await page.waitForTimeout(600)
      await page.touchscreen.tap(at.x, at.y)
    }
    await expect.poll(() => pointCount(page), 'the tapped points are shown').toBe(3)
    for (const point of await handles(page, 'point')) {
      expect([Math.round(point.width), Math.round(point.height)], `${point.id} is a 44 px target after a tap`).toEqual([44, 44])
    }
    const finish = card(page).locator('[data-plant-row-finish]')
    const box = await finish.boundingBox()
    expect(box && Math.min(box.width, box.height), 'the check button is a 44 px target').toBeGreaterThanOrEqual(44)
    await finish.tap()
    await expect(selectionChip(page), 'the check button plants the row').toHaveText(/^\d+ plants · Apple/)
    await expect(undo(page), 'one Design edit').toBeEnabled()
    await undo(page).tap()
    await expect(undo(page), 'one Undo restores the Design').toBeDisabled()
  })

  test.describe('fingers', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'finger drags go through CDP touch input, Chromium-only')

    test('(canopi-f47t.54, P) touch: a finger drags a point before planting (Chromium)', async ({ page }) => {
      await openBase(page)
      const fingers = await Fingers.of(page)
      await fingers.tap(GROUND)
      await armRow(page)
      await fingers.tap(APPLE)
      await expect(intervalField(page), 'the pick focuses the spacing field').toBeFocused()
      await intervalField(page).fill('2')
      await page.keyboard.press('Enter')
      for (const at of [P1, P2]) {
        await page.waitForTimeout(600)
        await fingers.tap(at)
      }
      await expect.poll(() => pointCount(page), 'the tapped points are shown').toBe(3)
      const first = await pointAt(page, 1)
      await fingers.drag(first, { x: first.x + 40, y: first.y + 20 })
      await expect.poll(async () => {
        const moved = await pointAt(page, 1)
        return Math.round(distance(moved, { x: first.x + 40, y: first.y + 20 }))
      }, 'the point follows the finger').toBeLessThanOrEqual(2)
      await expectNothingPlanted(page, 'moving a point plants nothing')
    })
  })
})
