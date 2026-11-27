// The input seam's real-browser touch test (canvas v2 phase 3, A17; plan section 4, phase 3, "Web check"). jsdom with
// fake timers cannot show a long press timed against real event timeStamps (A1) or a menu that the lift closes (A4), so
// this drives real touch input: in Chromium, CDP Input.dispatchTouchEvent with hasTouch, at 1024x768 and 390x844; in
// WebKit, which has no multi-touch driver, page.touchscreen.tap placing one plant. DOM assertions only, no baselines.
// Not covered here: the World map pinch (Q7), since the Web Edition ships no Design templates and so shows no World map
// panel (world-map-surface.test.tsx covers its handler); the phone chrome (phone-chrome.spec.ts, and v2.spec.ts for the
// compass and the View menu's rotation rows on a phone).
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { bearing, designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { Fingers, type Point } from '../support/fingers'
import { expect, test } from '../support/offline'
import { tooltipOf } from '../support/tooltip'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

/** Places of the base fixture at its opening camera, per viewport. */
interface Layout {
  readonly viewport: { readonly width: number, readonly height: number }
  /** Empty ground, clear of every object and every piece of chrome. */
  readonly ground: Point
  /** The Apple inside the rectangle zone. */
  readonly apple: Point
}

/** Corners of a new polygon at 1024x768, on empty ground clear of the selection chip the finished zone brings up. */
const POLYGON = [{ x: 860, y: 560 }, { x: 940, y: 560 }, { x: 940, y: 620 }] as const
/** A point on the rectangle zone's left edge at 1024x768. */
const RECT_EDGE = { x: 311, y: 285 }

const TABLET: Layout = {
  viewport: { width: 1024, height: 768 },
  ground: { x: 560, y: 590 },
  apple: { x: 353, y: 265 },
}

const PHONE: Layout = {
  viewport: { width: 390, height: 844 },
  // Above the panel sheet, whose context bar holds the map notice and, with an Apple selected, the selection chip.
  ground: { x: 195, y: 530 },
  // Offline, the map notice is the sheet's first row, which the opening camera frames above.
  apple: { x: 114, y: 330 },
}

const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44.1 m'

async function openBaseFixture(page: Page, layout: Layout): Promise<void> {
  await page.setViewportSize(layout.viewport)
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
}

/** A rail tool by its name; the phone rail adds the shortcut to the name ("Select (V)"). */
function tool(page: Page, name: string) {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.\\))?$`) })
}

function undo(page: Page) {
  return page.getByRole('button', { name: 'Undo', exact: true })
}

function selectionChip(page: Page) {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function scaleChip(page: Page) {
  return page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ })
}

/** An angle in (-180°, 180°]. */
function signedDeg(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/** Centres and sizes of the shown handles matching `selector`, read in one pass (the layer rebuilds them). */
async function handles(page: Page, selector = '[data-canvas-handle]'): Promise<Array<{ id: string, x: number, y: number, width: number, height: number }>> {
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return {
      id: element.getAttribute('data-canvas-handle') ?? '',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      width: box.width,
      height: box.height,
    }
  }))
}

function zoneCorners(page: Page) {
  return handles(page, '[data-canvas-handle]:not([data-canvas-handle-glyph="rotate"])')
}

/** Arms Place plants with the Design's Apple (the Web plant catalog is not part of the job's build). */
async function armApple(page: Page): Promise<void> {
  await tool(page, 'Place plants').tap()
  await expect(tool(page, 'Place plants')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('region', { name: 'In this Design' }).getByRole('button', { name: 'Apple Malus domestica' }).tap()
  await expect(page.getByRole('region', { name: 'Place plants' }).getByRole('status')).toContainText('Apple')
}

/** Undoes the one edit the step made: Undo is on before and off after, so the step made exactly one. */
async function expectOneEditThenUndo(page: Page, what: string): Promise<void> {
  await expect(undo(page), `${what}: one Design edit`).toBeEnabled()
  await undo(page).tap()
  await expect(undo(page), `${what}: no edit before it`).toBeDisabled()
}

/**
 * What a placing tool's gesture selected, by the selection chip. On a phone the armed tool's card holds the context bar,
 * so Esc first returns to Select, which keeps the selection and shows its chip there.
 */
async function expectPlacedSelection(page: Page, layout: Layout, text: string | RegExp, what: string): Promise<void> {
  if (layout === PHONE) {
    await page.keyboard.press('Escape')
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(selectionChip(page), what).toHaveText(text)
}

/** The new zone's corners, shown once Esc returns to Select with the zone still selected. */
async function expectPolygonCorners(page: Page, count: number): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(selectionChip(page), 'Esc keeps the new zone selected').toHaveText(/^Polygon zone/)
  await expect.poll(async () => (await zoneCorners(page)).filter((handle) => handle.id.startsWith('vertex:')).length, 'its corners').toBe(count)
}

test.describe('Chromium touch', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'multi-touch through CDP is Chromium-only')
  test.use({ hasTouch: true })

  for (const layout of [TABLET, PHONE]) {
    const size = `${layout.viewport.width}x${layout.viewport.height}`

    test(`A1, A4: a 600 ms hold on a plant opens its menu, open after the lift; a 100 ms tap opens none (${size})`, async ({ page }) => {
      await openBaseFixture(page, layout)
      const fingers = await Fingers.of(page)

      await fingers.start(0, layout.apple)
      await page.waitForTimeout(600)
      const menu = page.getByRole('menu', { name: 'Apple' })
      await expect(menu, 'the hold opens the canvas menu before the lift').toBeVisible()
      await fingers.end(0)
      await page.waitForTimeout(300)
      await expect(menu, 'the lift keeps the menu open').toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /^Delete/ }), 'the menu targets the plant').toBeEnabled()
      await expect(undo(page), 'the lift runs no entry').toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)

      await fingers.tap(layout.ground)
      // Empty ground, not chrome: the tap clears the selection the hold made, so the next tap's selection is its own.
      await expect(page.locator('[data-selection-chip]'), 'the ground tap clears the selection').toHaveCount(0)
      await fingers.tap(layout.apple, { holdMs: 100 })
      await page.waitForTimeout(700)
      await expect(page.getByRole('menu'), 'a 100 ms tap opens no menu').toHaveCount(0)
      await expect(selectionChip(page), 'the tap selects the plant at its lift').toHaveText('Apple')
    })

    test(`held press: a still, a 6 px rolling and a 12 px sliding tap each place one plant (${size})`, async ({ page }) => {
      await openBaseFixture(page, layout)
      await armApple(page)
      const fingers = await Fingers.of(page)
      const { ground } = layout

      await fingers.tap(ground)
      await expectPlacedSelection(page, layout, 'Apple', 'a still tap places one plant')
      await expectOneEditThenUndo(page, 'a still tap')
      if (layout === PHONE) await armApple(page)

      await fingers.tap(ground, { path: [{ x: ground.x + 3, y: ground.y + 2 }, { x: ground.x + 6, y: ground.y }] })
      await expectPlacedSelection(page, layout, 'Apple', 'a 6 px rolling tap places one plant')
      await expectOneEditThenUndo(page, 'a rolling tap')
      if (layout === PHONE) await armApple(page)

      await fingers.tap(ground, { path: [4, 8, 12].map((dx) => ({ x: ground.x + dx, y: ground.y })) })
      await expectPlacedSelection(page, layout, 'Apple', 'a 12 px slide places one plant')
      await expectOneEditThenUndo(page, 'a sliding tap')
    })

    test(`A13: a pinch with Place plants armed adds nothing, raises no pointercancel and keeps the page unzoomed (${size})`, async ({ page }) => {
      await openBaseFixture(page, layout)
      await armApple(page)
      await page.evaluate(() => {
        const win = window as unknown as { __touchCancels: number }
        win.__touchCancels = 0
        window.addEventListener('pointercancel', () => { win.__touchCancels += 1 }, true)
      })
      const scaleBefore = layout === TABLET ? await scaleChip(page).textContent() : null
      const fingers = await Fingers.of(page)

      await fingers.pair(layout.ground, 40, { endRadius: 90 })
      await page.waitForTimeout(300)

      await expect(undo(page), 'a pinch places no plant').toBeDisabled()
      if (scaleBefore !== null) await expect(scaleChip(page), 'the spread zooms in').not.toHaveText(scaleBefore)
      expect(await page.evaluate(() => window.visualViewport?.scale), 'the page does not zoom').toBe(1)
      expect(await page.evaluate(() => window.scrollY), 'the page does not scroll').toBe(0)
      expect(await page.evaluate(() => (window as unknown as { __touchCancels: number }).__touchCancels), 'no pointercancel').toBe(0)
    })

    test(`a one-finger Rectangle drag draws one rectangle and the page stays put (${size})`, async ({ page }) => {
      await openBaseFixture(page, layout)
      const fingers = await Fingers.of(page)
      await fingers.tap(layout.ground)
      // R arms the Rectangle zone, which the phone rail keeps under More tools.
      await page.keyboard.press('r')

      const { ground } = layout
      await fingers.drag({ x: ground.x - 60, y: ground.y - 40 }, { x: ground.x + 60, y: ground.y + 40 })

      await expectPlacedSelection(page, layout, /^Rectangle zone/, 'the drag drew a rectangle')
      await expectOneEditThenUndo(page, 'the rectangle')
      expect(await page.evaluate(() => window.scrollY), 'the page does not scroll').toBe(0)
    })
  }

  test('a pinch with Select from empty ground keeps the selection', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.apple)
    await expect(selectionChip(page)).toHaveText('Apple')

    await fingers.pair(TABLET.ground, 40, { endRadius: 90 })

    await expect(selectionChip(page), 'the pinch keeps the selection').toHaveText('Apple')
    await expect(undo(page)).toBeDisabled()
  })

  test('A12: a twist with 15 px of arc turns nothing', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const scale = await scaleChip(page).textContent()
    const fingers = await Fingers.of(page)

    // Fingers 120 px apart: 15 px along their circle is 15 / (π · 120) of a turn, 14.3°.
    await fingers.pair(TABLET.ground, 60, { turnDeg: 14 })

    await expect(page.locator('[data-compass]').first(), 'the view is still north-up').not.toHaveAttribute('data-turned', 'true')
    await expect(scaleChip(page)).toHaveText(scale ?? '')
  })

  test('A5: a 40° twist with 100 px of drift keeps the ground under the moving centroid', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(RECT_EDGE)
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)
    const [corner] = await zoneCorners(page)
    if (!corner) throw new Error('the selected rectangle zone shows no corner')

    const drift = { x: 60, y: 80 }
    await fingers.pair(corner, 70, { turnDeg: 40, drift, steps: 20 })
    await expectCanvasDrawn(page)

    // MapLibre's rule (A12): the turn starts once the fingers' arc passes 25 px over their 140 px circle, 20.5°, and counts
    // from the last move below it, so 20 of the fingers' 40° in 2° steps turn the view.
    const thresholdDeg = (25 / (Math.PI * 140)) * 360
    const expected = 40 - Math.floor(thresholdDeg / 2) * 2
    const turned = Math.abs(signedDeg(await bearing(page)))
    expect(Math.abs(turned - expected), `the view turned ${turned.toFixed(2)}°, expected ${expected}°`).toBeLessThanOrEqual(0.5)
    const target = { x: corner.x + drift.x, y: corner.y + drift.y }
    const moved = (await zoneCorners(page)).find((handle) => handle.id === corner.id)
    if (!moved) throw new Error(`the corner ${corner.id} is no longer shown`)
    expect(Math.hypot(moved.x - target.x, moved.y - target.y), 'the corner stays under the centroid').toBeLessThanOrEqual(2)
    await expect(selectionChip(page), 'the twist keeps the selection').toHaveText(RECT_ZONE_CHIP)
    await expect(undo(page), 'turning the view edits nothing').toBeDisabled()
  })

  test('A14: a two-finger pan that ends over a plant shows no plant tooltip', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    // The first finger starts on the Apple; the map moves with the fingers, so it ends on the Apple too.
    await fingers.pair({ x: TABLET.apple.x + 50, y: TABLET.apple.y }, 50, { drift: { x: 40, y: 30 } })
    await page.waitForTimeout(500)
    await expect(page.locator('[data-hover-tooltip]'), 'no hover point after a pair pan').toBeHidden()
  })

  test('Q1–Q4, A9: a finger\'s tap gives 44 px handles; a handle tap with 6 px jitter moves nothing; a mouse move makes them 20 px', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(RECT_EDGE)
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)

    const before = await zoneCorners(page)
    expect(before.length, 'the rectangle zone shows its corners').toBeGreaterThanOrEqual(4)
    for (const handle of before) {
      expect([Math.round(handle.width), Math.round(handle.height)], `${handle.id} is a 44 px target after a touch`).toEqual([44, 44])
    }

    const [corner] = before
    if (!corner) throw new Error('no corner')
    await fingers.tap(corner, { path: [{ x: corner.x + 3, y: corner.y + 3 }, { x: corner.x + 6, y: corner.y }] })
    await page.waitForTimeout(300)
    await expect(undo(page), 'a handle tap records nothing').toBeDisabled()
    const after = await zoneCorners(page)
    for (const handle of before) {
      const now = after.find((entry) => entry.id === handle.id)
      expect(now && Math.hypot(now.x - handle.x, now.y - handle.y), `${handle.id} stays in place`).toBeLessThanOrEqual(0.1)
    }

    const [rotate] = await handles(page, '[data-canvas-handle-glyph="rotate"]')
    if (!rotate) throw new Error('the selected rectangle zone shows no rotate handle')
    await fingers.tap(rotate, { path: [{ x: rotate.x + 3, y: rotate.y - 3 }, { x: rotate.x + 6, y: rotate.y }] })
    await page.waitForTimeout(300)
    await expect(undo(page), 'a rotate-handle tap turns nothing').toBeDisabled()
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)

    await page.mouse.move(TABLET.ground.x, TABLET.ground.y)
    await page.mouse.move(TABLET.ground.x + 5, TABLET.ground.y)
    await expect.poll(async () => (await zoneCorners(page)).map((handle) => Math.round(handle.width)), 'a mouse move makes the handles 20 px again')
      .toEqual(before.map(() => 20))
  })

  test('Q5: two corner taps, then a double tap 20 px apart, finish a 3-corner zone', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.ground)
    await page.keyboard.press('z')
    await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')

    const [first, second, third] = POLYGON
    await fingers.tap(first)
    await page.waitForTimeout(600)
    await fingers.tap(second)
    await page.waitForTimeout(600)
    // The double tap: its first tap adds the third corner, its second, 20 px away, finishes the shape.
    await fingers.tap(third)
    await fingers.tap({ x: third.x, y: third.y + 20 })

    await expect(selectionChip(page), 'the double tap finished the shape').toHaveText(/^Polygon zone/)
    await expectPolygonCorners(page, 3)
    await expectOneEditThenUndo(page, 'the polygon')
  })

  test('Q5: a tap 18 px from the first corner closes the polygon', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.ground)
    await page.keyboard.press('z')
    await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')

    for (const corner of POLYGON) {
      await fingers.tap(corner)
      await page.waitForTimeout(600)
    }
    const [first] = POLYGON
    await fingers.tap({ x: first.x + 18, y: first.y })

    await expect(selectionChip(page), 'the tap near the first corner closed the shape').toHaveText(/^Polygon zone/)
    await expectPolygonCorners(page, 3)
    await expectOneEditThenUndo(page, 'the polygon')
  })

  test('A15: a Text tap focuses the note field at 16 px', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.ground)
    await page.keyboard.press('t')
    await expect(tool(page, 'Text note')).toHaveAttribute('aria-pressed', 'true')

    await fingers.tap(TABLET.ground)

    const field = page.locator('textarea[data-canvas-text-entry]')
    await expect(field, 'the tap opens the note field focused').toBeFocused()
    expect(await field.evaluate((element) => getComputedStyle(element).fontSize), 'iOS does not zoom a 16 px field').toBe('16px')
  })

  test('a double tap that finishes a polygon where the selection chip appears opens no Rename zone dialog', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.ground)
    await page.keyboard.press('z')
    await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')

    // The finishing tap lands at the bottom centre, where the finished zone's chip shows Rename.
    await fingers.tap({ x: 520, y: 560 })
    await page.waitForTimeout(600)
    await fingers.tap({ x: 720, y: 560 })
    await page.waitForTimeout(600)
    await fingers.tap({ x: 620, y: 632 })
    await fingers.tap({ x: 620, y: 642 })

    await expect(selectionChip(page), 'the double tap finished the shape').toHaveText(/^Polygon zone/)
    const rename = page.getByRole('group', { name: 'Selection' }).getByRole('button', { name: 'Rename…' })
    const box = await rename.boundingBox()
    if (!box) throw new Error('the finished zone\'s chip shows no Rename')
    expect(box.x <= 620 && 620 <= box.x + box.width && box.y <= 642 && 642 <= box.y + box.height, 'Rename is under the finger').toBe(true)
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog', { name: 'Rename zone' }), 'the lift opens no dialog').toHaveCount(0)
  })

  test('Q1: Select keeps a finger\'s 44 px handles after a finger switches tools and back', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(RECT_EDGE)
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)

    await tool(page, 'Measure').tap()
    await expect(tool(page, 'Measure')).toHaveAttribute('aria-pressed', 'true')
    await tool(page, 'Select').tap()
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')

    await expect.poll(async () => (await zoneCorners(page)).map((handle) => Math.round(handle.width)), 'the new Select sizes them for the finger')
      .toEqual([44, 44, 44, 44])
  })

  test('A13: the page never overscrolls', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const behaviour = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return [style.overscrollBehaviorX, style.overscrollBehaviorY]
    })
    expect(behaviour).toEqual(['none', 'none'])
  })

  test('a long press opens a canvas menu whose rows are finger-sized', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const fingers = await Fingers.of(page)
    await fingers.tap(TABLET.apple, { holdMs: 600 })
    const menu = page.getByRole('menu', { name: 'Apple' })
    await expect(menu).toBeVisible()

    const touchSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-size-touch')))
    expect(touchSize).toBeGreaterThan(0)
    const heights = await menu.getByRole('menuitem').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height, 'each row is a touch target').toBeGreaterThanOrEqual(touchSize)
  })

  test('a tapped button keeps its tooltip hidden', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    const button = page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: 'Fit to Design' })
    const tooltip = await tooltipOf(button)
    await button.tap()
    // Past the tooltip's 400 ms delay and its fade.
    await page.waitForTimeout(1000)
    await expect(tooltip, 'the tap leaves no tooltip').toHaveCount(0)
  })
})

test.describe('WebKit touch', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'page.touchscreen in WebKit')
  test.use({ hasTouch: true })

  test('a touchscreen tap with Place plants armed places one plant', async ({ page }) => {
    await openBaseFixture(page, TABLET)
    await armApple(page)

    await page.touchscreen.tap(TABLET.ground.x, TABLET.ground.y)

    await expect(selectionChip(page), 'the tap places one plant').toHaveText('Apple')
    await expectOneEditThenUndo(page, 'the tap')
  })
})
