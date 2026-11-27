// Saved views keep their framed area in any window (canopi-f47t.17; plan "2.0 bug fixes", A14, U21, U23).
// A view records the ground the whole map shows when it is saved; going to it, or presenting a step
// that shows it, fits that ground into the whole map now (panels and story card included). The unit
// tests drive the fit through a fake map; this scenario drives it through the real MapLibre container
// in Chromium and WebKit, saving at 1400 x 900, going back at 1000 x 700, then growing the window back.
// The selected zone's handles are the DOM's measure of where the Design is drawn: the camera jumps
// under reduced motion (support/canvas.ts), and every read is polled until the handles settle.
// A presentation shows no handles, so its refit is compared with a fresh fit by pixels, within the run.
// No baselines: nothing here is compared with a recorded screenshot.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Empty map, away from every object and chrome of the fixture's opening camera. */
const NEUTRAL = { x: 800, y: 450 }
/** A point on the left edge of the fixture's rectangle zone (14 m x 8 m) at the opening camera. */
const RECT_ZONE_EDGE = { x: 367, y: 300 }
const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44.1 m'
/** How far left the map is panned before saving: the zone's left corners end up within 200 px of the map's left edge. */
const PAN_BEFORE_SAVE_PX = 240
/** The window the view is opened in afterwards: 400 px narrower and 200 px shorter than playwright.config.ts's (the width sets the fit). */
const SMALLER = { width: 1000, height: 700 }
/** playwright.config.ts's window, which each test grows back to. */
const LARGER = { width: 1400, height: 900 }
/**
 * Both engines lay boxes out in 1/64 px units, and the saved camera is rounded (centre to 1e-9°, zoom to 1e-5),
 * which moves a handle 600 px from the centre by under 0.01 px; 1/16 px is far below any framing mistake.
 */
const LAYOUT_TOLERANCE_PX = 1 / 16

interface Point { readonly x: number, readonly y: number }
interface Box extends Point { readonly width: number, readonly height: number }

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
  // The opening camera frames the Design.
  await expect(scaleChip(page)).toHaveText('1:240')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expectCanvasDrawn(page)
}

function scaleChip(page: Page) {
  return page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ })
}

/** The map host's box in page pixels: the whole map a view is fitted into. */
async function mapBox(page: Page): Promise<Box> {
  const box = await designMap(page).boundingBox()
  if (!box) throw new Error('the Design map has no box')
  return box
}

function centreOf(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Centres of the selected zone's control points, in page pixels, read in one pass in the page: the overlay
 * rebuilds its handles on every refresh, and a handle read on its own could be one a refresh has just replaced.
 */
async function zoneCorners(page: Page): Promise<Point[]> {
  return page.getByRole('button', { name: /^Zone control point \d+$/ }).evaluateAll((handles) => handles.map((handle) => {
    const box = handle.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }))
}

/** The largest distance, on either axis, between the zone's corners now and `expected`; Infinity when a corner is missing. */
async function cornerError(page: Page, expected: readonly Point[]): Promise<number> {
  const corners = await zoneCorners(page)
  if (corners.length !== expected.length) return Number.POSITIVE_INFINITY
  return Math.max(...corners.map(({ x, y }, index) => Math.max(Math.abs(x - expected[index]!.x), Math.abs(y - expected[index]!.y))))
}

/** A middle-button drag that pans the map by `dx` px, away from the chrome. */
async function panBy(page: Page, dx: number): Promise<void> {
  const from = { x: 700, y: 560 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(from.x + dx, from.y, { steps: 10 })
  await page.mouse.up({ button: 'middle' })
}

async function openViewMenuItem(page: Page, name: string): Promise<void> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitem', { name }).click()
}

async function saveCurrentView(page: Page): Promise<string> {
  await openViewMenuItem(page, 'Save current view…')
  const dialog = page.getByRole('dialog', { name: 'Save current view' })
  await expect(dialog).toBeVisible()
  const name = await dialog.getByRole('textbox').first().inputValue()
  expect(name, 'the new view gets a default name').not.toBe('')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(dialog).toBeHidden()
  return name
}

async function goToView(page: Page, name: string): Promise<void> {
  await openViewMenuItem(page, 'Manage views…')
  const dialog = page.getByRole('dialog', { name: 'Manage views' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: `Go to ${name}` }).click()
  await expect(dialog).toBeHidden()
}

test('a saved view gives back its camera in the window it was saved in, and keeps its framed corners in a smaller one', async ({ page }) => {
  await openBaseFixture(page)
  // Going to a view jumps under reduced motion, so the handles settle where the camera lands.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(page.getByRole('group', { name: 'Selection' }).getByRole('status')).toHaveText(RECT_ZONE_CHIP)

  const savedMap = await mapBox(page)
  const opening = await zoneCorners(page)
  await panBy(page, -PAN_BEFORE_SAVE_PX)
  await expect.poll(() => cornerError(page, opening.map(({ x, y }) => ({ x: x - PAN_BEFORE_SAVE_PX, y }))), 'the pan moved the zone left')
    .toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
  const saved = await zoneCorners(page)
  const savedScale = await scaleChip(page).textContent()
  // A camera-zoom fit keeps the centre and scale, so a smaller window crops (width - 1000) / 2 px off each side:
  // the scenario only tells the two apart while a corner sits inside that band.
  const cropBand = (savedMap.width - SMALLER.width) / 2
  expect(Math.min(...saved.map(({ x }) => x - savedMap.x)), 'a framed corner sits where a camera-zoom fit would crop it').toBeLessThan(cropBand)
  expect(Math.min(...saved.map(({ x }) => x - savedMap.x)), 'every framed corner is on the map').toBeGreaterThan(0)

  const name = await saveCurrentView(page)

  await test.step('in the same window the view gives back its exact camera', async () => {
    await panBy(page, 200)
    await expect.poll(() => cornerError(page, saved), 'the pan moved the zone away').toBeGreaterThan(100)
    await goToView(page, name)
    await expect.poll(() => cornerError(page, saved), 'every corner is back where it was saved').toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
    await expect(scaleChip(page)).toHaveText(savedScale ?? '')
  })

  await test.step('in a smaller window the view zooms out until every framed corner is on the map', async () => {
    await page.setViewportSize(SMALLER)
    await expect.poll(async () => (await mapBox(page)).width, 'the map host shrinks with the window').toBeLessThan(savedMap.width)
    const smallerMap = await mapBox(page)
    await panBy(page, 150)
    await goToView(page, name)
    // The fit scales the saved ground into the whole map by the tighter of the two ratios, about the map's centre.
    const fit = Math.min(smallerMap.width / savedMap.width, smallerMap.height / savedMap.height)
    const savedCentre = centreOf(savedMap)
    const smallerCentre = centreOf(smallerMap)
    const fitted = saved.map(({ x, y }) => ({
      x: smallerCentre.x + (x - savedCentre.x) * fit,
      y: smallerCentre.y + (y - savedCentre.y) * fit,
    }))
    await expect.poll(() => cornerError(page, fitted), 'each corner lands where the saved ground fitted into the whole map puts it')
      .toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
    const corners = await zoneCorners(page)
    for (const [index, { x, y }] of corners.entries()) {
      expect(x, `corner ${index + 1} is right of the map's left edge`).toBeGreaterThan(smallerMap.x)
      expect(x, `corner ${index + 1} is left of the map's right edge`).toBeLessThan(smallerMap.x + smallerMap.width)
      expect(y, `corner ${index + 1} is below the map's top edge`).toBeGreaterThan(smallerMap.y)
      expect(y, `corner ${index + 1} is above the map's bottom edge`).toBeLessThan(smallerMap.y + smallerMap.height)
    }
  })

  await test.step('grown back to the window it was saved in, the view gives back its exact camera again', async () => {
    await page.setViewportSize(LARGER)
    await expect.poll(async () => (await mapBox(page)).width, 'the map host grows with the window').toBe(savedMap.width)
    await expectCanvasDrawn(page)
    await panBy(page, 150)
    await goToView(page, name)
    await expect.poll(() => cornerError(page, saved), 'every corner is back where it was saved').toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
    await expect(scaleChip(page)).toHaveText(savedScale ?? '')
  })
})

/**
 * The map beside the story card, in the smaller window: the card's translucent surface blends the map under it, so its
 * pixels can differ by one colour step between two captures of the same camera; the map itself cannot.
 */
const BESIDE_STORY_CARD = { x: 470, y: 0, width: 530, height: 640 }

/**
 * A screenshot of the map beside the story card once it has not changed for 600 ms, for comparing two states of one run
 * with each other. The window outlasts the camera's settle delay (SETTLE_MS, 150 ms) and the jump a settled resize asks
 * for, so a capture taken between a resize and the refit it causes is never the one returned.
 */
async function quietScreenshot(page: Page): Promise<Buffer> {
  const quietCaptures = 6
  const capture = () => page.screenshot({ animations: 'disabled', caret: 'hide', clip: BESIDE_STORY_CARD })
  let previous = await capture()
  let unchanged = 0
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(100)
    const next = await capture()
    unchanged = next.equals(previous) ? unchanged + 1 : 0
    if (unchanged >= quietCaptures) return next
    previous = next
  }
  throw new Error('the page never settled: it kept changing for 6 s')
}

/** Presents the fixture's story "Tour" and moves to its second step, the view added by the test. */
async function presentSecondStep(page: Page) {
  await page.getByRole('button', { name: 'Present' }).click()
  const presentation = page.getByRole('dialog', { name: 'Presenting Tour' })
  await expect(presentation).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(presentation.getByRole('status').filter({ hasText: /^Step \d/ })).toHaveText('Step 2 of 2: Step 2')
  // The same pointer place in every capture: inside the smaller window, away from the story card, the chrome and the notice.
  await page.mouse.move(SMALLER.width - 8, SMALLER.height / 2)
  return presentation
}

test('a presented step keeps its frame when the window gets smaller', async ({ page }) => {
  await openBaseFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const largerMap = await mapBox(page)
  // The same framing as the test above: a corner a camera-zoom fit would crop in the smaller window.
  await panBy(page, -PAN_BEFORE_SAVE_PX)
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
  await page.getByRole('button', { name: 'Add the current view as a step' }).click()
  await expect(page.getByRole('list', { name: 'Steps of Tour' }).getByRole('button', { name: /^Step 2: / })).toBeVisible()

  // Presented in the window it was saved in, then the window gets smaller: the step refits with a jump.
  let presentation = await presentSecondStep(page)
  await page.setViewportSize(SMALLER)
  await expect.poll(async () => (await mapBox(page)).width, 'the map host shrinks with the window').toBeLessThan(largerMap.width)
  const refitted = await quietScreenshot(page)
  await presentation.getByRole('button', { name: 'Leave presentation' }).click()
  await expect(presentation).toBeHidden()

  // Presented afresh in the smaller window: going to the step's view fits its saved ground (the test above).
  presentation = await presentSecondStep(page)
  const opened = await quietScreenshot(page)
  if (!refitted.equals(opened)) {
    await test.info().attach('refitted', { body: refitted, contentType: 'image/png' })
    await test.info().attach('opened in the smaller window', { body: opened, contentType: 'image/png' })
  }
  expect(refitted.equals(opened), 'the refitted step shows what the step opened in the smaller window shows').toBe(true)

  // Grown back and made smaller again while presenting: the map keeps drawing and the step refits the same way.
  await page.setViewportSize(LARGER)
  await expect.poll(async () => (await mapBox(page)).width, 'the map host grows with the window').toBe(largerMap.width)
  await expectCanvasDrawn(page)
  await page.setViewportSize(SMALLER)
  await expect.poll(async () => (await mapBox(page)).width, 'the map host shrinks with the window').toBeLessThan(largerMap.width)
  const refittedAgain = await quietScreenshot(page)
  if (!refittedAgain.equals(opened)) {
    await test.info().attach('refitted after growing back', { body: refittedAgain, contentType: 'image/png' })
  }
  expect(refittedAgain.equals(opened), 'after growing back and shrinking again, the step shows the same frame').toBe(true)
})
