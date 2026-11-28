// The Layers redesign's input probe (canopi-f47t.42, plan section 4, "Commit 0": the riskiest assumption, probed
// first). The Site data pin follows a resolved tap no tool uses, and Profile finishes on the second press of a
// double-click or a double tap, as Polygon does. WebKitGTK's pointerdown sends `detail` 0, so the recogniser counts the
// clicks itself (input/recognise.ts clickCountOf), and a finger's double tap counts the same way. Through the Web build,
// in Chromium and WebKit, the paths the pin and Profile use (Select's tap on empty ground, Polygon's double-click and
// double tap) reach their handlers; each test records the engine's `detail` as an annotation. Measured 2026-10-08:
// Chromium sends detail 0 for mouse and touch, like WebKitGTK; Playwright's WebKit sends 1 then 2 for a double-click
// and 0 for touch. WebKit's double tap is not asserted (no timestamped touch input; see that test). The Web build has no pin or Profile (Desktop only): jsdom drives them through the real pipeline
// (src/__tests__/canvas-interaction-e2e.*.test.ts), and the native WebKitGTK double-click with Profile armed is the live
// check n4. DOM assertions only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

interface Point { readonly x: number, readonly y: number }

/** The base fixture at its opening camera at 1024x768 (as touch.spec.ts): empty ground and the Apple. */
const GROUND: Point = { x: 560, y: 590 }
const APPLE: Point = { x: 353, y: 265 }
/** Corners of a new polygon on empty ground, clear of the chip the finished zone brings up. */
const POLYGON = [{ x: 860, y: 560 }, { x: 940, y: 560 }, { x: 940, y: 620 }] as const
/** Past the recogniser's 500 ms multi-click window, so each corner is a first click. */
const PAST_MULTI_CLICK_MS = 600

declare global {
  interface Window { __probePointerDowns?: Array<{ detail: number, pointerType: string, t: number }> }
}

async function openBaseFixture(page: Page): Promise<void> {
  // Records every pointerdown the engine sends, before the canvas hears it; changes nothing.
  await page.addInitScript(() => {
    window.__probePointerDowns = []
    window.addEventListener('pointerdown', (event) => {
      window.__probePointerDowns?.push({ detail: event.detail, pointerType: event.pointerType, t: event.timeStamp })
    }, { capture: true })
  })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expectCanvasDrawn(page)
  await page.evaluate(() => { window.__probePointerDowns = [] })
}

function tool(page: Page, name: string) {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.\\))?$`) })
}

function selectionChip(page: Page) {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function corners(page: Page) {
  return page.locator('[data-canvas-handle^="vertex:"]')
}

/** The pointerdowns since the last call, as `pointerType:detail`, recorded on the test. */
async function recordPointerDowns(page: Page, what: string): Promise<string[]> {
  const downs = await page.evaluate(() => {
    const recorded = window.__probePointerDowns ?? []
    window.__probePointerDowns = []
    return recorded
  })
  const summary = downs.map((down) => `${down.pointerType}:${down.detail}`)
  const gaps = downs.slice(1).map((down, index) => Math.round(down.t - downs[index]!.t))
  test.info().annotations.push({ type: `pointerdowns, ${what}`, description: `${summary.join(' ')}; ms apart: ${gaps.join(' ')}` })
  return summary
}

/** Select's tap on the Apple selects it; its tap on empty ground clears the selection: the tap the pin follows. */
async function expectGroundTapClears(page: Page, tap: (at: Point) => Promise<void>): Promise<void> {
  await tap(APPLE)
  await expect(selectionChip(page), 'the tap on the Apple selects it').toContainText('Apple')
  await page.waitForTimeout(PAST_MULTI_CLICK_MS)
  await tap(GROUND)
  await expect(selectionChip(page), 'the tap on empty ground reached Select').toHaveCount(0)
}

/** Polygon (Profile's grammar): three corners, then a second press on the third finishes the shape. */
async function expectDoubleFinishes(page: Page, single: (at: Point) => Promise<void>, double: (at: Point) => Promise<void>): Promise<void> {
  await page.keyboard.press('z')
  await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')
  const [first, second, third] = POLYGON
  await single(first)
  await page.waitForTimeout(PAST_MULTI_CLICK_MS)
  await single(second)
  await page.waitForTimeout(PAST_MULTI_CLICK_MS)
  await double(third)
  await expect(selectionChip(page), 'the double finished the shape').toHaveText(/^Polygon zone/)
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(corners(page), 'three corners, none doubled').toHaveCount(3)
}

test('a mouse click on empty ground reaches Select, and a double-click finishes a polygon', async ({ page, browserName }) => {
  await openBaseFixture(page)
  const click = (at: Point) => page.mouse.click(at.x, at.y)

  await expectGroundTapClears(page, click)
  expect(await recordPointerDowns(page, 'two clicks')).toHaveLength(2)

  await expectDoubleFinishes(page, click, (at) => page.mouse.dblclick(at.x, at.y))
  const downs = await recordPointerDowns(page, 'two clicks and a double-click')
  // Chromium's pointerdown sends detail 0, as WebKitGTK's does; Playwright's WebKit counts clicks itself (1, then 2).
  if (browserName === 'chromium') expect(downs, 'Chromium sends detail 0').toEqual(Array(4).fill('mouse:0'))
  else expect(downs.map((down) => down.split(':')[0]), 'mouse pointerdowns').toEqual(Array(4).fill('mouse'))
})

test.describe('touchscreen', () => {
  test.use({ hasTouch: true })

  test('a finger\'s tap on empty ground reaches Select', async ({ page }) => {
    await openBaseFixture(page)
    await expectGroundTapClears(page, (at) => page.touchscreen.tap(at.x, at.y))
    expect(await recordPointerDowns(page, 'two taps'), 'touch pointerdowns send detail 0').toEqual(['touch:0', 'touch:0'])
  })

  test('a finger\'s double tap 20 px apart finishes a polygon', async ({ page, browserName }) => {
    // A double tap is two taps within the recogniser's 500 ms, and a busy page (two cores, the corner just drawn) answers
    // a tap late. Chromium's CDP touch events carry their own time, so the taps are stamped 200 ms apart; WebKit's
    // touchscreen.tap carries none, and at two cores its taps land 80 to 470 ms apart, too near the window to assert.
    // jsdom counts a finger's double tap through the real pipeline (canvas-interaction-e2e.touch.test.ts); the native
    // WebKitGTK check is n4.
    test.skip(browserName !== 'chromium', 'WebKit has no timestamped touch input')
    await openBaseFixture(page)
    const cdp = await page.context().newCDPSession(page)
    const taps = async (...points: Point[]) => {
      const start = Date.now() / 1000
      // Sent together, never one after the other's answer.
      await Promise.all(points.flatMap((at, index) => {
        const timestamp = start + index * 0.2
        return [
          cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, x: at.x, y: at.y, radiusX: 4, radiusY: 4, force: 1 }], timestamp }),
          cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: timestamp + 0.05 }),
        ]
      }))
    }

    await expectDoubleFinishes(page, (at) => taps(at), (at) => taps(at, { x: at.x, y: at.y + 20 }))
    expect(await recordPointerDowns(page, 'taps and a double tap'), 'touch pointerdowns send detail 0').toEqual(Array(4).fill('touch:0'))
  })
})
