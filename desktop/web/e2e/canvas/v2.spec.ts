// The 2.0 Web scenario (plan section 4, release close step 2), on the base fixture with real input in Chromium and
// WebKit. First phase 0's live-check steps 2-6 and 0E's viewport resize, compared with the phase-0 Web reference
// baselines (re-recorded in the pinned image whenever a change moves what they show) or within the run; then the
// seam subset of the Web steps phases F, 1 and 2 listed, DOM assertions only. Each step opens the fixture afresh, so a
// failure names the one step that broke; DOM reads say what broke, screenshots say what it looks like.
// Screenshots are taken on settled states only, never mid-drag (drafts are compared by eye)
// and never while a timer is still due to change the page (an open nudge series). Before each
// one the canvas has drawn the change the DOM checks saw (expectCanvasDrawn).
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { bearing, designMap, expectCanvasDrawn, pressMod } from '../support/canvas'
import { nextFrames, openFixture } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

// The baselines show the title bar's save status; Drafts kept, as persistence is not this spec's subject (canopi-eon8.15.1).
test.use({ draftsKept: true })
/** Empty map, away from every object and chrome of the fixture's opening camera. */
const NEUTRAL = { x: 800, y: 450 }
/** A point on the left edge of the fixture's rectangle zone (14 m x 8 m) at the opening camera. */
const RECT_ZONE_EDGE = { x: 367, y: 300 }
const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44 m'
/** The Apple (Malus domestica) inside the rectangle zone, at the opening camera. */
const APPLE = { x: 430, y: 273 }

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
  ])
  await chooser.setFiles(FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  // The opening camera frames the Design.
  await expect(scaleChip(page)).toHaveText('1:240')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expectCanvasDrawn(page)
}

/** A rail button by its name; until a tool has been used the rail may add its shortcut ("Select (V)"). */
function tool(page: Page, name: string) {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.+\\))?$`) })
}

function scaleChip(page: Page) {
  return page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ })
}

function selection(page: Page) {
  return page.getByRole('group', { name: 'Selection' })
}

/**
 * Centres of the selected zone's control points, in page pixels. The overlay rebuilds its
 * handles on every refresh (a nudge series committing is one), so they are read in one pass
 * in the page: a handle read on its own could be one a refresh has just replaced.
 */
async function zoneCorners(page: Page): Promise<Array<{ x: number, y: number }>> {
  const corners = await page.getByRole('button', { name: /^Zone control point \d+$/ }).evaluateAll((handles) => handles.map((handle) => {
    const box = handle.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }))
  if (corners.length === 0) throw new Error('no zone is selected: no "Zone control point" is shown')
  return corners
}

async function firstCorner(page: Page): Promise<{ x: number, y: number }> {
  const [corner] = await zoneCorners(page)
  if (!corner) throw new Error('no zone control point')
  return corner
}

/**
 * Both engines lay boxes out in 1/64 px units, so a handle centre read from the DOM is off by
 * up to a few 1/64 px; 1/16 px stays far below the smallest step measured here (10 cm is
 * 1.57 px at the opening scale).
 */
const LAYOUT_TOLERANCE_PX = 1 / 16

function expectPx(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual.toFixed(3)} px, expected ${expected.toFixed(3)} px`).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
}

/**
 * A screenshot once two consecutive captures are identical, for comparing two states of one
 * run with each other (toHaveScreenshot compares with the baseline instead).
 */
async function settledScreenshot(page: Page): Promise<Buffer> {
  let previous = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(100)
    const next = await page.screenshot({ animations: 'disabled', caret: 'hide' })
    if (next.equals(previous)) return next
    previous = next
  }
  throw new Error('the page never settled: consecutive screenshots kept changing for 3 s')
}

test('step 2: the wheel zooms, and zooming back restores the opening pixels', async ({ page }) => {
  await openBaseFixture(page)
  await expect(page).toHaveScreenshot('phase0-02a-opening.png')
  const opening = await settledScreenshot(page)

  await page.mouse.wheel(0, -300)
  await expect(scaleChip(page), 'wheel up changes the scale').not.toHaveText('1:240')
  const zoomed = Number((await scaleChip(page).textContent())?.replace(/^1:/, '').replace(/[^\d]/g, ''))
  expect(zoomed, 'wheel up zooms in (a smaller scale denominator)').toBeLessThan(240)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-02b-zoomed.png')

  await page.mouse.wheel(0, 300)
  await expect(scaleChip(page), 'the opposite wheel returns to the opening scale').toHaveText('1:240')
  const back = await settledScreenshot(page)
  if (!back.equals(opening)) {
    await test.info().attach('opening', { body: opening, contentType: 'image/png' })
    await test.info().attach('back', { body: back, contentType: 'image/png' })
  }
  expect(back.equals(opening), 'zooming back gives the opening pixels').toBe(true)
})

test('step 3: Space and a 200 px left drag pan the map 200 px; objects stay on their ground', async ({ page }) => {
  await openBaseFixture(page)
  // The zone's corner handle is the DOM's measure of where the zone is drawn.
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  const before = await firstCorner(page)
  await page.keyboard.press('Escape')
  await expect(selection(page), 'Esc in Select clears the selection').toHaveCount(0)

  await page.keyboard.down('Space')
  await page.mouse.move(500, 620)
  await page.mouse.down()
  await page.mouse.move(700, 620, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expect(scaleChip(page), 'a pan keeps the scale').toHaveText('1:240')
  await expect(tool(page, 'Undo'), 'panning never edits the Design').toBeDisabled()
  await expect(selection(page), 'Space-drag pans; it does not marquee-select').toHaveCount(0)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-03-space-pan.png')

  await page.mouse.click(RECT_ZONE_EDGE.x + 200, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status'), 'the zone edge is now 200 px right').toHaveText(RECT_ZONE_CHIP)
  const after = await firstCorner(page)
  expectPx(after.x - before.x, 200, 'the zone moved with the map, 200 px right')
  expectPx(after.y - before.y, 0, 'a horizontal drag does not move the map vertically')
})

test('step 4: a right-click on a plant opens the canvas menu with today\'s entries on release; Esc closes it', async ({ page }) => {
  await openBaseFixture(page)
  await page.mouse.move(APPLE.x, APPLE.y)
  await page.mouse.down({ button: 'right' })
  await expectCanvasDrawn(page)
  await expect(page.getByRole('menu'), 'the right press alone opens no menu (it may still become a pan)').toHaveCount(0)
  await page.mouse.up({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Apple' })
  await expect(menu, 'the still right-click opens the menu on release').toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Cut/, /^Copy/, /^Paste/, /^Duplicate/,
    /^Select all of this species/, /^Plant color/, /^Plant symbol/, /^Show name/, /^Species details/,
    /^Add to calendar…/, /^Set unit cost…/,
    /^Arrange/, /^Rotate…/,
    /^Lock/, /^Unlock/,
    /^Delete/,
  ])
  await expect(selection(page).getByRole('status'), 'the right-click selects the plant').toHaveText('Apple')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-04a-context-menu.png')

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu'), 'Esc closes the canvas menu').toHaveCount(0)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-04b-menu-closed.png')
})

test('step 5: P places a plant, Ctrl+Z removes it; R draws a rectangle; Esc, Esc returns to Select and clears', async ({ page }) => {
  await openBaseFixture(page)
  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await page.keyboard.press('p')
  await expect(tool(page, 'Place plants')).toHaveAttribute('aria-pressed', 'true')
  // The Design's own species: the Web plant catalog is not part of the job's build.
  await page.getByRole('region', { name: 'In this Design' }).getByRole('button', { name: 'Apple Malus domestica' }).click()
  await expect(page.getByRole('region', { name: 'Place plants' }).getByRole('status')).toContainText('Apple')

  await page.mouse.click(680, 420)
  await expect(tool(page, 'Undo'), 'placing a plant is one Design edit').toBeEnabled()
  await expect(selection(page).getByRole('status'), 'the placed plant is selected').toHaveText('Apple')
  await expect(designMap(page), 'placing a species picked in a panel leaves the map the focus (phase F)').toBeFocused()
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-05a-plant-placed.png')

  await pressMod(page, 'z')
  await expect(tool(page, 'Undo'), 'Ctrl+Z undid the only edit').toBeDisabled()
  await expect(tool(page, 'Redo')).toBeEnabled()
  await expect(selection(page), 'the removed plant is no longer selected').toHaveCount(0)
  await expect(tool(page, 'Place plants'), 'undo keeps the tool').toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-05b-plant-undone.png')

  await page.keyboard.press('r')
  await expect(tool(page, 'Rectangle zone')).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(360, 440)
  await page.mouse.down()
  await page.mouse.move(620, 640, { steps: 10 })
  await page.mouse.up()
  await expect(selection(page).getByRole('status'), 'the drawn rectangle is selected').toHaveText('Rectangle zone · 192 m² · 56 m')
  await expect(tool(page, 'Rectangle zone'), 'the tool stays armed after a rectangle').toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-05c-rect-drawn.png')

  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select'), 'the first Esc returns to Select').toHaveAttribute('aria-pressed', 'true')
  await expect(selection(page).getByRole('status'), 'the first Esc keeps the selection').toHaveText('Rectangle zone · 192 m² · 56 m')
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-05d-esc-select.png')

  await page.keyboard.press('Escape')
  await expect(selection(page), 'the second Esc clears the selection').toHaveCount(0)
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-05e-esc-cleared.png')
})

test('step 6: ArrowRight nudges a selected zone 10 cm east, Ctrl+ArrowRight (Cmd on a Mac) 1 m; each pause commits one Design edit', async ({ page }) => {
  await openBaseFixture(page)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  const start = await zoneCorners(page)
  const [c1, c2, , c4] = start
  if (!c1 || !c2 || !c4) throw new Error('the rectangle zone shows fewer than four control points')
  // Pixels per metre from the zone itself: its handles span 14 m x 8 m (112 m², the chip).
  const pxPerMetre = Math.sqrt(Math.abs((c2.x - c1.x) * (c4.y - c1.y)) / 112)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-06a-zone-selected.png')

  // Arrow keys open a nudge series: the zone moves at once, Undo stays off while the series is
  // open, and the series commits as one Design edit once the keys pause. Each step waits for
  // that commit (a condition, not the pause's length) before measuring and taking a screenshot,
  // so the next key starts a series of its own.
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await firstCorner(page)).x - c1.x, 'ArrowRight moves the zone').toBeGreaterThan(LAYOUT_TOLERANCE_PX)
  await expect(tool(page, 'Undo'), 'the ArrowRight series commits as one Design edit after its pause').toBeEnabled()
  const nudged = await firstCorner(page)
  // Today's world axes: the camera is north-up, so east is +x on screen and y does not change.
  expectPx(nudged.x - c1.x, 0.1 * pxPerMetre, 'ArrowRight moves the zone 10 cm east')
  expectPx(nudged.y - c1.y, 0, 'ArrowRight does not move the zone north or south')
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-06b-nudge-10cm.png')

  await pressMod(page, 'ArrowRight')
  await expect.poll(async () => (await firstCorner(page)).x - nudged.x, 'Ctrl+ArrowRight (Cmd on a Mac) moves the zone').toBeGreaterThan(LAYOUT_TOLERANCE_PX)
  await expect(tool(page, 'Undo'), 'the Ctrl+ArrowRight (Cmd on a Mac) series commits as one Design edit after its pause').toBeEnabled()
  const large = await firstCorner(page)
  expectPx(large.x - nudged.x, pxPerMetre, 'Ctrl+ArrowRight (Cmd on a Mac) moves the zone 1 m east')
  expectPx(large.y - nudged.y, 0, 'Ctrl+ArrowRight (Cmd on a Mac) does not move the zone north or south')
  await expect(selection(page).getByRole('status'), 'nudging keeps the zone selected').toHaveText(RECT_ZONE_CHIP)
  await expectCanvasDrawn(page)
  await expect(page).toHaveScreenshot('phase0-06c-nudge-1m.png')

  await pressMod(page, 'z')
  await expect.poll(async () => (await firstCorner(page)).x - large.x, 'Ctrl+Z moves the zone back').toBeLessThan(-LAYOUT_TOLERANCE_PX)
  const undone = await firstCorner(page)
  expectPx(undone.x - nudged.x, 0, 'Ctrl+Z undoes the 1 m series alone: the zone is back 10 cm east of its start')
  expectPx(undone.y - nudged.y, 0, 'Ctrl+Z does not move the zone north or south')
  await expect(tool(page, 'Undo'), 'the 10 cm series is still an edit to undo').toBeEnabled()
  await expect(tool(page, 'Redo'), 'the 1 m series can be redone').toBeEnabled()
})

/** The centre of the map host, in page pixels: a resize keeps the camera's centre there (0E, D8). */
async function mapCentre(page: Page): Promise<{ x: number, y: number, width: number, height: number }> {
  const box = await designMap(page).boundingBox()
  if (!box) throw new Error('the Design map has no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height }
}

test('canvas v2 0E: a viewport resize keeps the map and the Design on their ground; resizing back restores the pixels', async ({ page }) => {
  await openBaseFixture(page)
  // The selected zone's handles are the DOM's measure of where the Design is drawn.
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expectCanvasDrawn(page)
  const before = await settledScreenshot(page)
  const centre = await mapCentre(page)
  const offsets = (await zoneCorners(page)).map(({ x, y }) => ({ x: x - centre.x, y: y - centre.y }))

  await page.setViewportSize({ width: 1300, height: 840 })
  await expect.poll(async () => (await mapCentre(page)).width, 'the map host shrinks with the window').toBeLessThan(centre.width)
  const resized = await mapCentre(page)
  // The camera keeps its centre and scale (D8), so each handle keeps its offset from the map's centre.
  await expect.poll(async () => {
    const corners = await zoneCorners(page)
    return Math.max(...corners.map(({ x, y }, index) => Math.max(
      Math.abs(x - resized.x - offsets[index]!.x),
      Math.abs(y - resized.y - offsets[index]!.y),
    )))
  }, 'the zone keeps its place relative to the map centre').toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX)
  await expect(scaleChip(page), 'a resize keeps the scale').toHaveText('1:240')
  await expect(tool(page, 'Undo'), 'a resize never edits the Design').toBeDisabled()

  await page.setViewportSize({ width: 1400, height: 900 })
  await expect.poll(async () => (await mapCentre(page)).width, 'the map host returns to its size').toBe(centre.width)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await expectCanvasDrawn(page)
  const back = await settledScreenshot(page)
  if (!back.equals(before)) {
    await test.info().attach('before', { body: before, contentType: 'image/png' })
    await test.info().attach('back', { body: back, contentType: 'image/png' })
  }
  expect(back.equals(before), 'resizing back gives the pixels before the resize: the map and the Design kept their ground').toBe(true)
})


// The 2.0 seam scenarios (plan section 4, release close step 2): the Web steps phases F, 1 and 2 listed that only a
// real engine shows (keys and focus through the key router, real pointer buttons and wheels through the recogniser,
// the camera's turn), on the base fixture. DOM assertions only, no baselines; each step left out is named, with the
// unit test that covers it, in the release-close receipt. Phase 3's touch steps are touch.spec.ts's, the phone chrome
// phone-chrome.spec.ts's.

/** Opens the base fixture with Web Edition settings (snapping off where a corner must land where the pointer is). */
async function openV2(page: Page, settings: Readonly<Record<string, unknown>> = {}): Promise<void> {
  await openFixture(page, FIXTURE, { settings })
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(scaleChip(page)).toHaveText('1:240')
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
}

async function isMac(page: Page): Promise<boolean> {
  return await page.evaluate(() => /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent))
}

/** The bearing once the next frames have drawn: a turn by key, compass or gesture jumps (U34), so no wait is needed. */
async function bearingNow(page: Page): Promise<number> {
  await nextFrames(page)
  return await bearing(page)
}

function compassText(page: Page) {
  return page.getByRole('group', { name: 'Zoom' }).getByText(/^(North is up|View turned .*)$/)
}

async function pressTimes(page: Page, key: string, times: number): Promise<void> {
  for (let press = 0; press < times; press += 1) await page.keyboard.press(key)
}

/** Pixels per metre at the opening camera, from the rectangle zone's handles (14 m x 8 m, north up). */
async function openingPxPerMetre(page: Page): Promise<number> {
  const [c1, c2, , c4] = await zoneCorners(page)
  if (!c1 || !c2 || !c4) throw new Error('the rectangle zone shows fewer than four control points')
  return Math.sqrt(Math.abs((c2.x - c1.x) * (c4.y - c1.y)) / 112)
}

/** The corner of `corners` nearest `to`, and its distance. */
function nearest(corners: Array<{ x: number, y: number }>, to: { x: number, y: number }): number {
  return Math.min(...corners.map(({ x, y }) => Math.hypot(x - to.x, y - to.y)))
}

/** Counts contextmenu events at the window and how many arrived default-prevented (the native menu shut). */
async function watchContextMenus(page: Page): Promise<() => Promise<{ seen: number, prevented: number }>> {
  await page.evaluate(() => {
    const record = { seen: 0, prevented: 0 }
    ;(window as unknown as { contextMenus: typeof record }).contextMenus = record
    window.addEventListener('contextmenu', (event) => {
      record.seen += 1
      if (event.defaultPrevented) record.prevented += 1
    })
  })
  return async () => await page.evaluate(() => (window as unknown as { contextMenus: { seen: number, prevented: number } }).contextMenus)
}

async function rightDrag(page: Page, from: { x: number, y: number }, dx: number, dy = 0): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 })
  await page.mouse.up({ button: 'right' })
}

async function shiftDrag(page: Page, button: 'right' | 'middle', from: { x: number, y: number }, dx: number, held: string[] = []): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.keyboard.down('Shift')
  for (const key of held) await page.keyboard.down(key)
  await page.mouse.down({ button })
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 })
  await page.mouse.move(from.x + dx, from.y, { steps: 5 })
  await page.mouse.up({ button })
  for (const key of [...held].reverse()) await page.keyboard.up(key)
  await page.keyboard.up('Shift')
}

function menuBar(page: Page, name: string) {
  return page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name, exact: true })
}

test('F: Esc after a click on a rail tool, with no click on the map, returns to Select', async ({ page }) => {
  await openV2(page)
  await tool(page, 'Polygon zone').click()
  await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select'), 'Esc from the rail button returns to Select').toHaveAttribute('aria-pressed', 'true')
})

test('F, phase 2: F6 reaches the map host itself, and Shift+2, +, − and Home act on the map', async ({ page }) => {
  await openV2(page)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let presses = 0; presses < 8 && !await designMap(page).evaluate((host) => document.activeElement === host); presses += 1) {
    await page.keyboard.press('F6')
  }
  await expect(designMap(page), 'F6 reaches the map host, not a handle inside it').toBeFocused()

  // Shift+Digit2 types '@' on a US layout; the router's digit row names it Shift+2 (probe P-F2).
  await page.keyboard.press('Shift+Digit2')
  await expect(scaleChip(page), 'Shift+2 zooms to the selected zone').not.toHaveText('1:240')
  await page.keyboard.press('Home')
  await expect(scaleChip(page), 'Home fits the Design').toHaveText('1:240')
  await page.keyboard.press('+')
  await expect(scaleChip(page), '+ zooms in').not.toHaveText('1:240')
  const zoomedIn = Number((await scaleChip(page).textContent())?.replace(/[^\d]/g, '').slice(1))
  expect(zoomedIn, '+ zooms in (a smaller scale denominator)').toBeLessThan(240)
  await page.keyboard.press('-')
  await expect(scaleChip(page), '− zooms back out').toHaveText('1:240')
  await expect(tool(page, 'Undo'), 'no key here edits the Design').toBeDisabled()
})

test('F: Select all then Delete asks nothing and keeps the focus on the map; Ctrl+Z (Cmd on a Mac) brings everything back', async ({ page }) => {
  await openV2(page)
  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await expect(designMap(page)).toBeFocused()
  await pressMod(page, 'a')
  await expect(selection(page), 'Select all selects').toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(selection(page), 'Delete removes the selection').toHaveCount(0)
  await expect(page.getByRole('dialog'), 'Delete asks nothing').toHaveCount(0)
  await expect(page.getByRole('alertdialog'), 'Delete asks nothing').toHaveCount(0)
  await expect(designMap(page), 'the focus stays on the map; no card takes it').toBeFocused()
  await pressMod(page, 'z')
  await expect(tool(page, 'Undo'), 'Select all and Delete were one edit').toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(selection(page)).toHaveCount(0)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status'), 'the zone is back').toHaveText(RECT_ZONE_CHIP)
  await page.mouse.click(APPLE.x, APPLE.y)
  await expect(selection(page).getByRole('status'), 'the plants are back').toHaveText('Apple')
})

test('phase 1: Shift+→ turns the view 15° at a time with no animation, and a click on the compass returns north', async ({ page }) => {
  await openV2(page)
  await expect(compassText(page)).toHaveText('North is up')
  for (const expected of [15, 30, 45]) {
    await page.keyboard.press('Shift+ArrowRight')
    expect(await bearingNow(page), `Shift+→ turns to ${expected}° at once`).toBe(expected)
  }
  await expect(compassText(page)).toHaveText('View turned 45° from north')
  await page.locator('[data-compass]').click()
  expect(await bearingNow(page), 'a click on the compass returns north at once').toBe(0)
  await expect(compassText(page)).toHaveText('North is up')
  await expect(tool(page, 'Undo'), 'turning never edits the Design').toBeDisabled()
})

test('phase 1: N resets north; with single-key shortcuts off N does nothing and Shift+N still resets', async ({ page }) => {
  await openV2(page)
  await page.keyboard.press('Shift+ArrowRight')
  expect(await bearingNow(page)).toBe(15)
  await page.keyboard.press('n')
  expect(await bearingNow(page), 'N resets north').toBe(0)

  await page.getByRole('button', { name: 'Settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Keyboard' }).click()
  const singleKeys = settings.getByRole('switch', { name: 'Single-key shortcuts' })
  await expect(singleKeys).toBeChecked()
  await singleKeys.click()
  await expect(singleKeys).not.toBeChecked()
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toHaveCount(0)

  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await page.keyboard.press('Shift+ArrowRight')
  expect(await bearingNow(page)).toBe(15)
  await page.keyboard.press('n')
  expect(await bearingNow(page), 'with single-key shortcuts off, N does nothing').toBe(15)
  await page.keyboard.press('Shift+N')
  expect(await bearingNow(page), 'Shift+N always resets north').toBe(0)
})

test('phase 1: at 30° ArrowUp moves a selected zone 10 cm up the screen and Ctrl+ArrowUp (Cmd on a Mac) 1 m', async ({ page }) => {
  await openV2(page)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  const pxPerMetre = await openingPxPerMetre(page)
  await pressTimes(page, 'Shift+ArrowRight', 2)
  expect(await bearingNow(page)).toBe(30)
  await expect(selection(page).getByRole('status'), 'turning keeps the selection').toHaveText(RECT_ZONE_CHIP)
  const start = await firstCorner(page)

  await page.keyboard.press('ArrowUp')
  await expect(tool(page, 'Undo'), 'the ArrowUp series commits as one Design edit after its pause').toBeEnabled()
  const nudged = await firstCorner(page)
  expectPx(nudged.x - start.x, 0, 'ArrowUp moves the zone along the screen, not sideways')
  expectPx(nudged.y - start.y, -0.1 * pxPerMetre, 'ArrowUp moves the zone 10 cm up the screen')

  await pressMod(page, 'ArrowUp')
  await expect.poll(async () => nudged.y - (await firstCorner(page)).y, 'Ctrl+ArrowUp moves the zone').toBeGreaterThan(LAYOUT_TOLERANCE_PX)
  const large = await firstCorner(page)
  expectPx(large.x - nudged.x, 0, 'Ctrl+ArrowUp moves the zone along the screen, not sideways')
  expectPx(large.y - nudged.y, -pxPerMetre, 'Ctrl+ArrowUp moves the zone 1 m up the screen')
})

test('phase 1: at 30° a rectangle drawn with R is level to the screen', async ({ page }) => {
  await openV2(page, { snap_to_grid: false })
  await pressTimes(page, 'Shift+ArrowRight', 2)
  expect(await bearingNow(page)).toBe(30)
  await page.keyboard.press('r')
  const from = { x: 700, y: 420 }
  const to = { x: 900, y: 560 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
  await expect(selection(page).getByRole('status')).toHaveText(/^Rectangle zone · /)
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  const corners = await zoneCorners(page)
  for (const expected of [from, to, { x: from.x, y: to.y }, { x: to.x, y: from.y }]) {
    expect(nearest(corners, expected), `a corner at (${expected.x}, ${expected.y}): the rectangle is level to the screen`).toBeLessThanOrEqual(1)
  }
})

test('phase 1: a saved view and a story step taken at 30° bring the view back to 30° after Reset north', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openV2(page)
  await pressTimes(page, 'Shift+ArrowRight', 2)
  expect(await bearingNow(page)).toBe(30)

  await menuBar(page, 'View').click()
  await page.getByRole('menuitem', { name: 'Save current view…' }).click()
  const save = page.getByRole('dialog', { name: 'Save current view' })
  const name = await save.getByRole('textbox', { name: 'Name' }).inputValue()
  await save.getByRole('button', { name: 'Save view' }).click()
  await expect(save).toHaveCount(0)

  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
  await page.getByRole('button', { name: 'Add the current view as a step' }).click()
  await expect(page.getByRole('list', { name: 'Steps of Tour' }).getByRole('button', { name: /^Step 2: / })).toBeVisible()

  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await page.keyboard.press('n')
  expect(await bearingNow(page)).toBe(0)
  await menuBar(page, 'View').click()
  await page.getByRole('menuitem', { name: 'Saved views' }).click()
  await page.getByRole('menu', { name: 'Saved views' }).getByRole('menuitem', { name, exact: true }).click()
  await expect.poll(async () => await bearing(page), 'going to the saved view turns the view back to 30°').toBe(30)

  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  await page.keyboard.press('n')
  expect(await bearingNow(page)).toBe(0)
  // A story step keeps its view as a saved view of its own ("Tour · step 2"), which the presenter goes to.
  await menuBar(page, 'View').click()
  await page.getByRole('menuitem', { name: 'Saved views' }).click()
  await page.getByRole('menu', { name: 'Saved views' }).getByRole('menuitem', { name: 'Tour · step 2', exact: true }).click()
  await expect.poll(async () => await bearing(page), 'going to the story step\'s view turns the view back to 30°').toBe(30)
})

test('phase 1: a still Shift+middle click turns nothing; a Shift+middle drag turns the view about the press; within 7° of north it snaps', async ({ page }) => {
  await openV2(page)
  const menus = await watchContextMenus(page)
  await shiftDrag(page, 'middle', APPLE, 0)
  expect(await bearingNow(page), 'a still Shift+middle click turns nothing').toBe(0)

  await shiftDrag(page, 'middle', APPLE, 20)
  const turned = await bearingNow(page)
  // 0.8° per pixel (MapLibre's rate); a 20 px drag is about 16°, depending on the pointer's last step.
  expect(Math.abs(turned), 'a 20 px drag turns the view').toBeGreaterThan(10)
  expect(Math.abs(turned)).toBeLessThan(20)
  await expect(compassText(page), 'the compass reports the new angle').toHaveText(`View turned ${Math.round(((turned % 360) + 360) % 360)}° from north`)
  await page.mouse.click(APPLE.x, APPLE.y)
  await expect(selection(page).getByRole('status'), 'the plant under the press stayed there').toHaveText('Apple')
  await page.keyboard.press('Escape')

  await page.keyboard.press('n')
  await shiftDrag(page, 'middle', NEUTRAL, 50)
  const forty = await bearingNow(page)
  expect(Math.abs(forty), 'a 50 px drag turns the view about 40°').toBeGreaterThan(30)
  await shiftDrag(page, 'middle', NEUTRAL, -44)
  expect(await bearingNow(page), 'released within 7° of north, the view snaps to north').toBe(0)
  const seen = await menus()
  expect(seen.prevented, 'no native menu').toBe(seen.seen)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('phase 2: Shift+right-drag turns the view and opens no menu; Ctrl (Cmd on a Mac) steps it 15°, and a Mac\'s Control does not', async ({ page }) => {
  await openV2(page)
  const mac = await isMac(page)
  const menus = await watchContextMenus(page)
  await shiftDrag(page, 'right', NEUTRAL, 50)
  const free = await bearingNow(page)
  expect(Math.abs(free), 'Shift+right-drag turns the view').toBeGreaterThan(30)
  expect(Math.abs(free) % 15, 'without the step modifier the turn is free').not.toBeCloseTo(0, 3)
  await page.keyboard.press('n')

  await shiftDrag(page, 'right', NEUTRAL, 50, [mac ? 'Meta' : 'Control'])
  const stepped = await bearingNow(page)
  expect(Math.abs(stepped), 'the stepped drag turns the view').toBeGreaterThan(1)
  expect(Math.abs(stepped) % 15, 'the step modifier steps the turn to 15°').toBeCloseTo(0, 6)
  await page.keyboard.press('n')

  if (mac) {
    // A Mac Control-click is a right-click, yet a right-drag holding Control is still a turn, never a menu (probe P-F1).
    await shiftDrag(page, 'right', NEUTRAL, 50, ['Control'])
    const control = await bearingNow(page)
    expect(Math.abs(control), 'Control on a Mac keeps the turn').toBeGreaterThan(30)
    expect(Math.abs(control) % 15, 'Control does not step on a Mac').not.toBeCloseTo(0, 3)
  }
  await expect(page.getByRole('menu'), 'no canvas menu opens').toHaveCount(0)
  const seen = await menus()
  expect(seen.prevented, 'every contextmenu event reached the window default-prevented').toBe(seen.seen)
  await expect(tool(page, 'Undo'), 'turning never edits the Design').toBeDisabled()
})

test('phase 2: in every tool a right-drag pans and opens no menu', async ({ page }) => {
  await openV2(page)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  const before = await firstCorner(page)
  const tools = ['Select', 'Place plants', 'Plant a row', 'Place a stamp', 'Polygon zone', 'Rectangle zone', 'Ellipse zone', 'Line zone', 'Text note', 'Measure']
  const step = 30
  for (const name of tools) {
    await tool(page, name).click()
    await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'true')
    await rightDrag(page, { x: 1000, y: 700 }, step)
    await expect(page.getByRole('menu'), `${name}: a right-drag opens no menu`).toHaveCount(0)
    await expect(tool(page, name), `${name}: the tool stays armed`).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(tool(page, 'Undo'), 'panning never edits the Design').toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.click(RECT_ZONE_EDGE.x + step * tools.length, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  const after = await firstCorner(page)
  expectPx(after.x - before.x, step * tools.length, `each of the ${tools.length} tools panned the map ${step} px`)
  expectPx(after.y - before.y, 0, 'a horizontal right-drag does not move the map vertically')
})

test('phase 2: a polygon draft survives a right-drag, Delete deletes nothing mid-draft, and a double-click finishes it', async ({ page }) => {
  await openV2(page, { snap_to_grid: false })
  await tool(page, 'Polygon zone').click()
  await page.mouse.click(700, 420)
  await page.mouse.click(860, 420)
  await rightDrag(page, { x: 1000, y: 700 }, 40)
  await expect(page.getByRole('menu'), 'the right-drag opens no menu').toHaveCount(0)
  await page.keyboard.press('Delete')
  // The two corners moved 40 px right with the map; the third goes below them.
  await page.mouse.dblclick(820, 560)
  await expect(selection(page).getByRole('status'), 'the double-click finishes the polygon').toHaveText(/^Polygon zone/)
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  const corners = await zoneCorners(page)
  expect(corners, 'the polygon has the three corners placed, none taken by Delete').toHaveLength(3)
  for (const expected of [{ x: 740, y: 420 }, { x: 900, y: 420 }, { x: 820, y: 560 }]) {
    expect(nearest(corners, expected), `a corner at (${expected.x}, ${expected.y}), where the map carried it`).toBeLessThanOrEqual(1)
  }
  await tool(page, 'Undo').click()
  await expect(tool(page, 'Undo'), 'the polygon was the only Design edit: Delete mid-draft deleted nothing').toBeDisabled()
  await page.mouse.click(RECT_ZONE_EDGE.x + 40, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status'), 'the rectangle zone is still there').toHaveText(RECT_ZONE_CHIP)
})

test('phase 2: a wheel during a Rectangle drag keeps the drag: the fixed corner stays on the ground, the free corner under the cursor', async ({ page }) => {
  await openV2(page, { snap_to_grid: false })
  await page.keyboard.press('r')
  await expect(tool(page, 'Rectangle zone')).toHaveAttribute('aria-pressed', 'true')
  const fixed = { x: 700, y: 420 }
  const mid = { x: 800, y: 500 }
  const free = { x: 860, y: 560 }
  await page.mouse.move(fixed.x, fixed.y)
  await page.mouse.down()
  await page.mouse.move(mid.x, mid.y, { steps: 8 })
  await page.mouse.wheel(0, -300)
  await expect(scaleChip(page), 'the wheel zooms during the drag').not.toHaveText('1:240')
  await page.mouse.move(free.x, free.y, { steps: 8 })
  await page.mouse.up()
  await expect(selection(page).getByRole('status'), 'the drag drew one rectangle').toHaveText(/^Rectangle zone · /)
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select'), 'Esc returns to Select, keeping the new zone selected with its handles').toHaveAttribute('aria-pressed', 'true')
  expect(nearest(await zoneCorners(page), free), 'a corner is under the cursor at the release').toBeLessThanOrEqual(1)

  // Zooming back about the same point restores the opening camera: the fixed corner is back where the press was.
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.wheel(0, 300)
  await expect(scaleChip(page), 'the opposite wheel returns to the opening scale').toHaveText('1:240')
  await expect.poll(async () => nearest(await zoneCorners(page), fixed), 'the fixed corner stayed on the ground under the press').toBeLessThanOrEqual(1)
})

test('phase 2: in overview a left drag pans and selects nothing, and a still right-click opens no menu', async ({ page }) => {
  await openV2(page)
  const hint = page.getByText('Zoom in to edit. Plants are hidden at this scale.')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.click(NEUTRAL.x, NEUTRAL.y)
  // Each − is a small step (about 1:240 to 1:260); overview starts near 1:38 000.
  for (let presses = 0; presses < 120 && await hint.count() === 0; presses += 1) {
    const scale = await scaleChip(page).textContent()
    await page.keyboard.press('-')
    await expect(scaleChip(page), '− zooms out').not.toHaveText(scale ?? '')
  }
  await expect(hint, 'zoomed out to overview').toBeVisible()
  const pin = page.getByRole('button', { name: /^Go to Design: / })
  const before = await pin.boundingBox()
  if (!before) throw new Error('the Design pin is not shown in overview')
  // The drag starts on empty map below the pin (a drag from the pin itself: overview-tools.spec.ts).
  const grab = { x: before.x + before.width / 2, y: before.y + before.height + 120 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x - 60, grab.y + 40, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await pin.boundingBox())?.x ?? Number.NaN, 'the left drag panned the map').toBeCloseTo(before.x - 60, 0)
  expect((await pin.boundingBox())!.y - before.y, 'the left drag panned the map down').toBeCloseTo(40, 0)
  await expect(selection(page), 'nothing is selectable in overview').toHaveCount(0)
  await page.mouse.click(grab.x, grab.y, { button: 'right' })
  await expect(page.getByRole('menu'), 'a still right-click in overview opens no menu').toHaveCount(0)
})

test('phase 2: Settings › Canvas offers Mouse and Trackpad, and with Trackpad the wheel pans', async ({ page }) => {
  await openV2(page)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection(page).getByRole('status')).toHaveText(RECT_ZONE_CHIP)
  await page.getByRole('button', { name: 'Settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Canvas' }).click()
  const device = settings.getByRole('radiogroup', { name: 'Pointing device' })
  await expect(device.getByRole('radio', { name: 'Mouse: the wheel zooms' })).toBeChecked()
  await device.getByRole('radio', { name: 'Trackpad: two fingers pan' }).click()
  await expect(device.getByRole('radio', { name: 'Trackpad: two fingers pan' })).toBeChecked()
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toHaveCount(0)

  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  const before = await firstCorner(page)
  await page.mouse.wheel(0, 100)
  await expect.poll(async () => before.y - (await firstCorner(page)).y, 'the wheel pans the map up').toBeCloseTo(100, 0)
  await expect(scaleChip(page), 'the wheel no longer zooms').toHaveText('1:240')
})

test.describe('phase 1 on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the compass is in the zoom column, and View holds Reset north and both turns', async ({ page }) => {
    await openFixture(page, FIXTURE)
    const column = page.locator('[data-zoom-group]')
    await expect(column.locator('[data-compass]'), 'the compass is a button of the zoom column').toBeVisible()
    await menuBar(page, 'Menu').click()
    await page.getByRole('menuitem', { name: 'View' }).click()
    const view = page.getByRole('menu', { name: 'View' })
    for (const name of ['Reset north', 'Turn view left 15°', 'Turn view right 15°']) {
      await expect(view.getByRole('menuitem', { name }), `View holds ${name}`).toBeVisible()
    }
  })
})
