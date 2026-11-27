// (canopi-qd2k) Zones are picked by their outline only, through the real canvas: the user's decision of 2026-10-14,
// which reversed canopi-f47t.2's fill click (A25) and canopi-f47t.40's "right-click inside a selected zone opens its
// menu", and restored canopi-c7k8. Rewriting a case here needs the user's word, cited in the commit. The pick rule's
// contract is canvas/runtime/tools/hit-testing.pick.test.ts (6 px for a mouse, 16 px for a finger, at two zooms and two
// bearings); this spec drives what the user does: a click or tap inside a zone picks what lies beneath or clears, near
// the outline it selects the zone, a plant on the line wins over the zone, a drag from inside draws a band that selects
// only the plants it holds, a band across a line or around the zone selects it, the menu targets what the click would
// select, and a mouse near the outline highlights the line.
//
// The base fixture at 1024x768, both engines with a mouse. Touch: Chromium through CDP (Fingers) for taps, drags, bands
// and long presses; WebKit taps only, through page.touchscreen.tap, since Playwright's WebKit drives no touch drag or
// long press (touch.spec.ts). That WebKit gap (a finger's band and long press) is covered in jsdom by
// canvas-interaction-e2e.touch.test.ts and hit-testing.pick.test.ts. One size: the pick tolerance is in screen pixels
// whatever the viewport, and the phone chrome has its own specs. DOM assertions and pixel differences only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expectCanvasDrawn } from '../support/canvas'
import { Fingers, type Point } from '../support/fingers'
import { openFixture } from '../support/layout'
import { pixelsAround, type Pixels } from '../support/pixels'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** A point on the rectangle zone's left edge, the Apple inside the rectangle, and empty ground, at 1024x768. */
const RECT_EDGE: Point = { x: 321, y: 286 }
const APPLE: Point = { x: 363, y: 266 }
const GROUND: Point = { x: 560, y: 590 }
const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44 m'
const EMPTY_MAP_MENU = 'Canvas edit commands'

test.use({ viewport: { width: 1024, height: 768 } })

/** The rectangle zone's screen box, read from its corner handles once a click on its edge selects it. */
interface Rect { readonly x0: number, readonly x1: number, readonly y0: number, readonly y1: number }

/** Places in and around the rectangle zone, from its box. */
function places(rect: Rect) {
  const midY = (rect.y0 + rect.y1) / 2
  return {
    /** `px` inside the left edge (outside when negative), level with the Apple. */
    left: (px: number): Point => ({ x: rect.x0 + px, y: midY }),
    /** `px` inside the right edge, far from the Apple, whose symbol takes a tap 24 px inside the left edge. */
    right: (px: number): Point => ({ x: rect.x1 - px, y: midY }),
    /** Inside, far from the outline and from the Apple. */
    inside: { x: rect.x0 + (rect.x1 - rect.x0) * 0.75, y: midY } as Point,
    /** A band inside the rectangle, around the Apple, pressed beyond a finger's 16 px from the outline. */
    bandAroundApple: [{ x: rect.x0 + 22, y: rect.y0 + 22 }, { x: rect.x0 + 75, y: rect.y1 - 22 }] as const,
    /** A band pressed 30 px outside the left edge, released 20 px inside it, short of the Apple. */
    bandAcrossEdge: [{ x: rect.x0 - 30, y: midY - 12 }, { x: rect.x0 + 20, y: midY + 12 }] as const,
    /** A band around the whole rectangle. */
    bandAround: [{ x: rect.x0 - 16, y: rect.y0 - 16 }, { x: rect.x1 + 16, y: rect.y1 + 16 }] as const,
  }
}

function selectionChip(page: Page): Locator {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function undo(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true })
}

async function expectNothingSelected(page: Page, what: string): Promise<void> {
  await expect(page.locator('[data-selection-chip]'), what).toHaveCount(0)
}

async function openBase(page: Page): Promise<Rect> {
  await openFixture(page, FIXTURE, { settings: { snap_to_grid: false } })
  await page.mouse.click(RECT_EDGE.x, RECT_EDGE.y)
  await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)
  const corners = await page.locator('[data-canvas-handle]:not([data-canvas-handle-glyph="rotate"])').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }))
  expect(corners, 'the rectangle zone shows its four corners').toHaveLength(4)
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  await page.mouse.click(GROUND.x, GROUND.y)
  await expectNothingSelected(page, 'the ground click clears the selection')
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

async function mouseDrag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

async function expectMenu(page: Page, name: string | RegExp, what: string): Promise<void> {
  await expect(page.getByRole('menu', { name }), what).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/** Drags the Apple with the mouse onto the rectangle's left edge, level with where it was, and clears the selection:
 *  the plant on the line. Returns where it now lies. */
async function appleOnTheLine(page: Page, rect: Rect): Promise<Point> {
  const onLine: Point = { x: rect.x0, y: APPLE.y }
  await mouseDrag(page, APPLE, onLine)
  await expect(selectionChip(page), 'the drag moves the Apple').toHaveText('Apple')
  await page.mouse.click(GROUND.x, GROUND.y)
  await expectNothingSelected(page, 'the ground click clears')
  return onLine
}

function samePixels(a: Pixels, b: Pixels): boolean {
  return a.data.length === b.data.length && a.data.every((value, index) => value === b.data[index])
}

test.describe('(canopi-qd2k) a mouse picks zones by their outline', () => {
  test('a click inside picks what lies beneath or clears; near the outline it selects the zone', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)

    await page.mouse.click(APPLE.x, APPLE.y)
    await expect(selectionChip(page), 'a click on the Apple inside the zone selects the Apple alone').toHaveText('Apple')
    await page.mouse.click(at.inside.x, at.inside.y)
    await expectNothingSelected(page, 'a click inside, on empty ground, clears the selection')

    for (const px of [4, -4]) {
      await page.mouse.click(at.left(px).x, at.left(px).y)
      await expect(selectionChip(page), `${px} px from the outline selects the zone`).toHaveText(RECT_ZONE_CHIP)
      await page.mouse.click(GROUND.x, GROUND.y)
      await expectNothingSelected(page, 'the ground click clears')
    }

    await page.mouse.click(at.left(-4).x, at.left(-4).y)
    await page.mouse.click(at.left(10).x, at.left(10).y)
    await expectNothingSelected(page, '10 px inside, past a mouse\'s 6 px, clears the selected zone')
    await expect(undo(page), 'a click edits nothing').toBeDisabled()
  })

  test('a plant on the line wins: a click or right-click on it picks the plant, not the zone', async ({ page }) => {
    const rect = await openBase(page)
    const onLine = await appleOnTheLine(page, rect)

    await page.mouse.click(onLine.x, onLine.y)
    await expect(selectionChip(page), 'a click on the Apple on the line selects the Apple').toHaveText('Apple')
    await page.mouse.click(GROUND.x, GROUND.y)
    await page.mouse.click(onLine.x, onLine.y, { button: 'right' })
    await expectMenu(page, 'Apple', 'a right-click on the Apple on the line opens its menu')
  })

  test('a drag from inside draws a band of the plants only; a band across a line or around the zone selects it', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)

    await mouseDrag(page, ...at.bandAroundApple)
    await expect(selectionChip(page), 'the band inside selects only the Apple').toHaveText('Apple')
    await expect(undo(page), 'the drag moved no zone').toBeDisabled()

    await mouseDrag(page, ...at.bandAcrossEdge)
    await expect(selectionChip(page), 'a band across the left edge selects the zone').toHaveText(RECT_ZONE_CHIP)

    await mouseDrag(page, ...at.bandAround)
    await expect(selectionChip(page), 'a band around the zone selects it with the Apple').toHaveText('2 selected · 1 plant · 1 zone')
    await expect(undo(page)).toBeDisabled()
  })

  test('the menu targets what the click would select: inside the empty map\'s, on the Apple the Apple\'s, near the outline the zone\'s', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)

    await page.mouse.click(at.inside.x, at.inside.y, { button: 'right' })
    await expectMenu(page, EMPTY_MAP_MENU, 'a right-click inside opens the empty map\'s menu')
    await page.mouse.click(APPLE.x, APPLE.y, { button: 'right' })
    await expectMenu(page, 'Apple', 'a right-click on the Apple opens its menu')
    await page.mouse.click(at.left(4).x, at.left(4).y, { button: 'right' })
    await expectMenu(page, /^Rectangle zone/, 'a right-click near the outline opens the zone\'s menu')

    // The zone selected: a right-click inside still opens the empty map's menu and keeps the selection.
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)
    await page.mouse.click(at.inside.x, at.inside.y, { button: 'right' })
    await expectMenu(page, EMPTY_MAP_MENU, 'a right-click inside the selected zone opens the empty map\'s menu')
    await expect(selectionChip(page), 'the menu keeps the selection').toHaveText(RECT_ZONE_CHIP)
  })

  test('hovering near the outline highlights the line; hovering inside does not', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)
    // A stretch of the left edge above the pointer.
    const line: Point = { x: rect.x0, y: at.left(0).y - 22 }

    await page.mouse.move(GROUND.x, GROUND.y)
    await expectCanvasDrawn(page)
    const plain = await pixelsAround(page, line, 8)
    await page.mouse.move(at.left(-4).x, at.left(-4).y)
    await expect.poll(async () => samePixels(await pixelsAround(page, line, 8), plain), 'the hover highlights the outline').toBe(false)
    await page.mouse.move(at.left(30).x, at.left(30).y)
    await expect.poll(async () => samePixels(await pixelsAround(page, line, 8), plain), 'inside, the outline is plain again').toBe(true)
  })
})

test.describe('(canopi-qd2k) a finger picks zones by their outline (Chromium)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'one-finger drags and long presses through CDP are Chromium-only')
  test.use({ hasTouch: true })

  test('a tap within 16 px selects the zone; inside it picks what lies beneath or clears; a drag inside bands the plants only', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)
    const fingers = await Fingers.of(page)

    await fingers.tap(at.left(12))
    await expect(selectionChip(page), 'a tap 12 px inside the outline selects the zone').toHaveText(RECT_ZONE_CHIP)
    await fingers.tap(at.inside)
    await expectNothingSelected(page, 'a tap inside clears')
    await fingers.tap(APPLE)
    await expect(selectionChip(page), 'a tap on the Apple inside selects it').toHaveText('Apple')
    await fingers.tap(at.right(24))
    await expectNothingSelected(page, 'a tap 24 px inside, past a finger\'s 16 px, clears')

    await fingers.drag(...at.bandAroundApple)
    await expect(selectionChip(page), 'a finger\'s drag inside draws a band that selects only the Apple').toHaveText('Apple')
    await expect(undo(page), 'the drag moved no zone').toBeDisabled()

    await fingers.drag(...at.bandAcrossEdge)
    await expect(selectionChip(page), 'a finger\'s band across the left edge selects the zone').toHaveText(RECT_ZONE_CHIP)
    // Cleared first: a selected zone's 44 px finger handles would take a press beside its corner.
    await fingers.tap(GROUND)
    await fingers.drag(...at.bandAround)
    await expect(selectionChip(page), 'a finger\'s band around the zone selects it with the Apple').toHaveText('2 selected · 1 plant · 1 zone')
    await expect(undo(page)).toBeDisabled()
  })

  test('a plant on the line wins: a tap or a long press on it picks the plant, not the zone', async ({ page }) => {
    const rect = await openBase(page)
    const onLine = await appleOnTheLine(page, rect)
    const fingers = await Fingers.of(page)

    await fingers.tap(onLine)
    await expect(selectionChip(page), 'a tap on the Apple on the line selects the Apple').toHaveText('Apple')
    await fingers.tap(GROUND)
    await fingers.tap(onLine, { holdMs: 600 })
    await expectMenu(page, 'Apple', 'a long press on the Apple on the line opens its menu')
  })

  test('a long press inside opens the empty map\'s menu; near the outline the zone\'s', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)
    const fingers = await Fingers.of(page)

    await fingers.tap(at.inside, { holdMs: 600 })
    await expectMenu(page, EMPTY_MAP_MENU, 'a long press inside opens the empty map\'s menu')
    await expectNothingSelected(page, 'and selects nothing')
    await fingers.tap(at.left(12), { holdMs: 600 })
    await expectMenu(page, /^Rectangle zone/, 'a long press 12 px inside the outline opens the zone\'s menu')
    await expect(selectionChip(page)).toHaveText(RECT_ZONE_CHIP)
  })
})

test.describe('(canopi-qd2k) a finger picks zones by their outline (WebKit)', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'page.touchscreen in WebKit')
  test.use({ hasTouch: true })

  test('a tap within 16 px selects the zone; inside it picks what lies beneath or clears', async ({ page }) => {
    const rect = await openBase(page)
    const at = places(rect)

    await page.touchscreen.tap(at.left(12).x, at.left(12).y)
    await expect(selectionChip(page), 'a tap 12 px inside the outline selects the zone').toHaveText(RECT_ZONE_CHIP)
    await page.touchscreen.tap(at.inside.x, at.inside.y)
    await expectNothingSelected(page, 'a tap inside clears')
    await page.touchscreen.tap(APPLE.x, APPLE.y)
    await expect(selectionChip(page), 'a tap on the Apple inside selects it').toHaveText('Apple')
  })

  test('a plant on the line wins: a tap on it picks the plant, not the zone', async ({ page }) => {
    const rect = await openBase(page)
    const onLine = await appleOnTheLine(page, rect)

    await page.touchscreen.tap(onLine.x, onLine.y)
    await expect(selectionChip(page), 'a tap on the Apple on the line selects the Apple').toHaveText('Apple')
  })
})
