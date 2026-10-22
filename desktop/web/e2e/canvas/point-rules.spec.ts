// One point rule for zone corners, and Esc stepping back in Polygon (canopi-f47t.54, stream Z; plan section 4 "2.0
// plant along a path", amendment A2, A16, A17): under Select, Alt+click deletes a corner (guard), a click on a midpoint
// dot adds nothing and its double-click inserts a corner (guard), and a dot drag now inserts a corner where it is
// released; right-click, a long press or Shift+F10 on a corner opens the point menu, Delete point only, which Delete and
// Backspace pressed in it run and which Undo or a tool letter closes (stream D); in Polygon, Esc
// removes the last point, steps back to nothing, then returns to Select, Ctrl+Shift+Z restores a removed point, and
// Alt+click on a placed corner deletes it. Both engines unless a test says otherwise; the long press is Chromium-only (CDP touch). DOM assertions only, no baselines.
//
// Profile's Esc (A17) has no browser test here: the Web build has no Profile (Desktop only, input-probe.spec.ts), so the
// jsdom suite (canvas-interaction-e2e.profile.test.ts) and the native live check carry it.
//
// The base fixture at 1024x768 with grid snapping off: a click on its polygon zone's top edge selects it, and its corners
// and dots are canvas handles `vertex:<zone>:<index>` and `edge-mid:<zone>:<index>`.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { pressMod } from '../support/canvas'
import { Fingers, type Point } from '../support/fingers'
import { mapHost, openFixture } from '../support/layout'
import { pageBundle } from '../support/page-bundle'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** On the polygon zone's top edge. */
const POLYGON_EDGE: Point = { x: 740, y: 209 }
const POLYGON_CORNERS = 5
/** Empty ground for a new polygon, clear of the selection chip the finished zone brings up. */
const NEW_POLYGON: readonly Point[] = [{ x: 860, y: 560 }, { x: 940, y: 560 }, { x: 940, y: 620 }, { x: 860, y: 620 }]

test.use({ viewport: { width: 1024, height: 768 } })

async function openBase(page: Page): Promise<void> {
  await openFixture(page, FIXTURE, { settings: { snap_to_grid: false } })
}

function undo(page: Page): Locator {
  return page.getByRole('button', { name: 'Undo', exact: true })
}

function selectionChip(page: Page): Locator {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

function tool(page: Page, name: string): Locator {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.\\))?$`) })
}

interface Handle { readonly id: string, readonly x: number, readonly y: number }

async function handles(page: Page, prefix: 'vertex' | 'edge-mid'): Promise<Handle[]> {
  return page.locator(`[data-canvas-handle^="${prefix}:"]`).evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { id: element.getAttribute('data-canvas-handle') ?? '', x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }))
}

async function corners(page: Page): Promise<number> {
  return (await handles(page, 'vertex')).length
}

async function selectPolygon(page: Page): Promise<void> {
  await page.mouse.click(POLYGON_EDGE.x, POLYGON_EDGE.y)
  await expect(selectionChip(page)).toHaveText(/^Polygon zone/)
  await expect.poll(() => corners(page), 'the selected polygon shows its corners').toBe(POLYGON_CORNERS)
}

async function firstCorner(page: Page): Promise<Locator> {
  const [corner] = await handles(page, 'vertex')
  if (!corner) throw new Error('the selected polygon shows no corner')
  return page.locator(`[data-canvas-handle="${corner.id}"]`)
}

/** Undo is on, one Undo turns it off and brings the polygon's corners back. */
async function expectOneUndoStep(page: Page, what: string): Promise<void> {
  await expect(undo(page), `${what}: one Design edit`).toBeEnabled()
  await undo(page).click()
  await expect(undo(page), `${what}: one Undo restores the Design`).toBeDisabled()
  await expect.poll(() => corners(page), `${what}: the corners are back`).toBe(POLYGON_CORNERS)
}

/** The open menu's entries, by their accessible names. */
function pointMenu(page: Page): Locator {
  return page.getByRole('menu').getByRole('menuitem')
}

async function expectDeletePointOnly(page: Page, how: string): Promise<void> {
  await expect(pointMenu(page), `${how} opens the point menu`).toHaveCount(1)
  await expect(pointMenu(page).first(), `${how}: Delete point only`).toHaveAccessibleName(/^Delete point/)
}

async function drawPolygon(page: Page, points: readonly Point[]): Promise<void> {
  await mapHost(page).focus()
  await page.keyboard.press('z')
  await expect(tool(page, 'Polygon zone')).toHaveAttribute('aria-pressed', 'true')
  for (const point of points) await page.mouse.click(point.x, point.y)
}

/** Finishes the draft with Enter and reads the new zone's corners under Select. */
async function finishAndCountCorners(page: Page): Promise<number> {
  await page.keyboard.press('Enter')
  await expect(selectionChip(page), 'Enter finishes a polygon').toHaveText(/^Polygon zone/)
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => corners(page)).toBeGreaterThan(0)
  return corners(page)
}

/**
 * The real DOM input source and recogniser (src/canvas/runtime/input/), bundled as one script: `window.__shadowInput`.
 * The probe attaches a second copy to the map host as a shadow that only listens: it applies no effect but the long
 * press's timer, installs no native-menu listener of its own (so the app's alone decides the native menu), and records
 * every gesture it recognises: the recogniser log.
 */
function shadowInputScript(): Promise<string> {
  const input = fileURLToPath(new URL('../../src/canvas/runtime/input/', import.meta.url))
  const contents = [
    "export { createDomInputSource } from './dom-input-source'",
    "export { initialRecogniserState, recognise } from './recognise'",
    "export { detectPlatform } from './platform'",
    "export { DEFAULT_THRESHOLDS } from './thresholds'",
  ].join('\n')
  return pageBundle(contents, input, '__shadowInput')
}

interface Logged { readonly kind: string, readonly source?: string, readonly handle?: string, readonly target?: { readonly kind: string, readonly id?: string } }
interface NativeMenu { readonly prevented: boolean }

/** Records each native contextmenu after every listener has run (window, bubble phase); changes nothing. */
async function recordNativeMenus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const menus: Array<{ prevented: boolean }> = []
    Object.assign(window, { __probeNativeMenus: menus })
    window.addEventListener('contextmenu', (event) => { menus.push({ prevented: event.defaultPrevented }) })
  })
}

/** Attaches the shadow recogniser to the map host; returns a reader of its log since the last read. */
async function attachShadowRecogniser(page: Page): Promise<() => Promise<Logged[]>> {
  await page.addScriptTag({ content: await shadowInputScript() })
  await page.evaluate(() => {
    type Lib = {
      createDomInputSource(deps: unknown): { attach(sink: (input: unknown) => void): () => void, apply(effects: readonly { kind: string }[]): void }
      initialRecogniserState(): unknown
      recognise(state: unknown, input: unknown, config: unknown): { state: unknown, gestures: readonly unknown[], effects: readonly { kind: string }[] }
      detectPlatform(nav: Navigator, win: unknown): unknown
      DEFAULT_THRESHOLDS: unknown
    }
    const lib = (window as unknown as { __shadowInput: Lib }).__shadowInput
    const host = document.querySelector<HTMLElement>('[role="application"]')
    if (!host) throw new Error('no map host')
    const platform = lib.detectPlatform(navigator, window)
    const config = { platform, thresholds: lib.DEFAULT_THRESHOLDS }
    const timers = { set: (delayMs: number, callback: () => void) => window.setTimeout(callback, delayMs), clear: (id: number) => window.clearTimeout(id) }
    const source = lib.createDomInputSource({ host, platform, timers })
    const log: unknown[] = []
    let state = lib.initialRecogniserState()
    // The shadow leaves the native menu to the app's own listener: its contextmenu listener is not installed.
    const addEventListener = Document.prototype.addEventListener
    Document.prototype.addEventListener = function (this: Document, type: string, ...rest: unknown[]) {
      if (type === 'contextmenu') return
      return (addEventListener as (...args: unknown[]) => void).call(this, type, ...rest)
    } as typeof addEventListener
    try {
      source.attach((input) => {
        const result = lib.recognise(state, input, config)
        state = result.state
        source.apply(result.effects.filter((effect) => effect.kind === 'set-timer' || effect.kind === 'clear-timer'))
        log.push(...result.gestures)
      })
    } finally {
      Document.prototype.addEventListener = addEventListener
    }
    Object.assign(window, { __shadowLog: log })
  })
  return () => page.evaluate(() => (window as unknown as { __shadowLog: Logged[] }).__shadowLog.splice(0))
}

async function nativeMenus(page: Page): Promise<NativeMenu[]> {
  return page.evaluate(() => (window as unknown as { __probeNativeMenus: NativeMenu[] }).__probeNativeMenus.splice(0))
}

function menuRequests(log: readonly Logged[]): Logged[] {
  return log.filter((gesture) => gesture.kind === 'menu-request')
}

/**
 * Probe (stream Z's first commit, amendment section (d)): the riskiest input assumption behind the point menu and the
 * dot drag. A right-click on a selected polygon's corner reaches the recogniser with the corner handle as its press
 * target and yields one menu request carrying the handle's id, while the native menu stays shut (every contextmenu is
 * default-prevented once the app's listeners ran); a press on a midpoint dot dragged past the slop arrives as a press on
 * that handle and a drag, which the host turns into `handle-drag` moves. The native WebKitGTK right-click is the main
 * agent's live check.
 */
test('(canopi-f47t.54, Z) probe: a right-click on a corner requests one menu carrying its handle with the native menu shut, and a dot drag arrives as a handle drag', async ({ page }) => {
  await recordNativeMenus(page)
  await openBase(page)
  await selectPolygon(page)
  const readLog = await attachShadowRecogniser(page)
  const [corner] = await handles(page, 'vertex')
  if (!corner) throw new Error('the selected polygon shows no corner')

  await page.mouse.click(corner.x, corner.y, { button: 'right' })
  await expect(page.getByRole('menu'), 'the canvas menu opens').toBeVisible()
  const rightClick = await readLog()
  expect(menuRequests(rightClick), 'one menu request, carrying the corner\'s handle').toEqual([{ kind: 'menu-request', at: expect.anything(), source: 'mouse', handle: corner.id }])
  expect(rightClick.some((gesture) => gesture.kind === 'press'), 'the right press reaches no tool').toBe(false)
  const menus = await nativeMenus(page)
  test.info().annotations.push({ type: 'native contextmenu events', description: JSON.stringify(menus) })
  expect(menus.length, 'the engine sent its native contextmenu').toBeGreaterThan(0)
  expect(menus.every((menu) => menu.prevented), 'every native contextmenu is prevented: the native menu stays shut').toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => corners(page), 'the polygon is still selected').toBe(POLYGON_CORNERS)

  const [dot] = await handles(page, 'edge-mid')
  if (!dot) throw new Error('the selected polygon shows no midpoint dot')
  await readLog()
  await page.mouse.move(dot.x, dot.y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(dot.x, dot.y - 2.5 * step)
  await page.mouse.up()
  const drag = (await readLog()).filter((gesture) => gesture.kind !== 'hover' && gesture.kind !== 'hover-end')
  expect(drag[0], 'the press lands on the dot handle').toMatchObject({ kind: 'press', target: { kind: 'handle', id: dot.id } })
  expect(drag.slice(1).map((gesture) => gesture.kind), 'past the slop it drags to the release').toEqual(['drag-start', ...Array<string>(drag.length - 3).fill('drag-move'), 'drag-end'])
  expect(drag.length, 'the drag moves').toBeGreaterThan(3)
})

test('(canopi-f47t.54, Z) Alt+click on a zone corner deletes it in one Undo step (guard: passes today)', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  await (await firstCorner(page)).click({ modifiers: ['Alt'] })
  await expect.poll(() => corners(page), 'Alt+click deletes the corner').toBe(POLYGON_CORNERS - 1)
  await expectOneUndoStep(page, 'the deleted corner')
})

test('(canopi-f47t.54, Z) a click on a zone\'s midpoint dot adds nothing and a double-click inserts a corner in place (guard)', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  const [dot] = await handles(page, 'edge-mid')
  if (!dot) throw new Error('the selected polygon shows no midpoint dot')
  await page.mouse.click(dot.x, dot.y)
  await page.waitForTimeout(500)
  expect(await corners(page), 'a click on a dot adds nothing').toBe(POLYGON_CORNERS)
  await expect(undo(page)).toBeDisabled()
  await page.mouse.dblclick(dot.x, dot.y)
  await expect.poll(() => corners(page), 'a double-click on a dot inserts a corner').toBe(POLYGON_CORNERS + 1)
  const inserted = (await handles(page, 'vertex')).some((corner) => Math.hypot(corner.x - dot.x, corner.y - dot.y) <= 2)
  expect(inserted, 'the new corner is where the dot was').toBe(true)
  await expectOneUndoStep(page, 'the inserted corner')
})

test('(canopi-f47t.54, Z) dragging a zone\'s midpoint dot inserts a corner where it is released, in one Undo step', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  const [dot] = await handles(page, 'edge-mid')
  if (!dot) throw new Error('the selected polygon shows no midpoint dot')
  const release = { x: dot.x, y: dot.y - 25 }
  await page.mouse.move(dot.x, dot.y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(dot.x, dot.y - 2.5 * step)
  await expect(undo(page), 'nothing reaches the Design before the release').toBeDisabled()
  await page.mouse.up()
  await expect.poll(() => corners(page), 'the dot drag inserts a corner').toBe(POLYGON_CORNERS + 1)
  const placed = (await handles(page, 'vertex')).some((corner) => Math.hypot(corner.x - release.x, corner.y - release.y) <= 2)
  expect(placed, 'the new corner is where the drag was released').toBe(true)
  await expectOneUndoStep(page, 'the inserted corner')
})

test('(canopi-f47t.54, Z) Esc removes the last polygon point, steps back to nothing, then returns to Select; Ctrl+Shift+Z restores a removed point', async ({ page }) => {
  await openBase(page)
  await drawPolygon(page, NEW_POLYGON)
  await page.keyboard.press('Escape')
  expect(await finishAndCountCorners(page), 'Esc removed the fourth point only').toBe(3)
  await undo(page).click()
  await expect(undo(page)).toBeDisabled()

  await drawPolygon(page, NEW_POLYGON)
  await page.keyboard.press('Escape')
  await pressMod(page, 'Shift+z')
  expect(await finishAndCountCorners(page), 'Ctrl+Shift+Z restored the removed point').toBe(4)
  await undo(page).click()
  await expect(undo(page)).toBeDisabled()

  await drawPolygon(page, NEW_POLYGON.slice(0, 2))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Polygon zone'), 'two Escs step back through two points and keep Polygon').toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(tool(page, 'Select'), 'the Esc after the last point returns to Select').toHaveAttribute('aria-pressed', 'true')
  await expect(undo(page), 'stepping back edits nothing').toBeDisabled()
})

test('(prepush, Z) while a polygon is drawn, Alt+click on a placed corner deletes it and adds none (answer 2)', async ({ page }) => {
  await openBase(page)
  await drawPolygon(page, NEW_POLYGON)
  const [, , third] = NEW_POLYGON
  // page.mouse.click takes no modifiers: Alt is held on the keyboard.
  await page.keyboard.down('Alt')
  await page.mouse.click(third!.x - 3, third!.y - 3)
  await page.keyboard.up('Alt')
  expect(await finishAndCountCorners(page), 'four corners, one deleted').toBe(3)
  await undo(page).click()
  await expect(undo(page)).toBeDisabled()
})

test('(canopi-f47t.54, Z) right-click on a zone corner opens a menu of Delete point only, which deletes it in one Undo step', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  await (await firstCorner(page)).click({ button: 'right' })
  await expectDeletePointOnly(page, 'a right-click on a corner')
  await pointMenu(page).first().click()
  await expect.poll(() => corners(page), 'Delete point deletes the corner').toBe(POLYGON_CORNERS - 1)
  await expectOneUndoStep(page, 'the deleted corner')
})

test.describe('long press', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'a finger long press goes through CDP touch input, Chromium-only')
  test.use({ hasTouch: true })

  test('(canopi-f47t.54, Z) probe: a finger long press on a corner requests one menu carrying its handle (Chromium)', async ({ page }) => {
    await recordNativeMenus(page)
    await openBase(page)
    const fingers = await Fingers.of(page)
    await fingers.tap(POLYGON_EDGE)
    await expect(selectionChip(page)).toHaveText(/^Polygon zone/)
    await expect.poll(() => corners(page)).toBe(POLYGON_CORNERS)
    const readLog = await attachShadowRecogniser(page)
    const [corner] = await handles(page, 'vertex')
    await fingers.tap(corner!, { holdMs: 600 })
    await expect(page.getByRole('menu'), 'the canvas menu opens').toBeVisible()
    const log = await readLog()
    expect(menuRequests(log), 'one menu request, carrying the corner\'s handle').toEqual([{ kind: 'menu-request', at: expect.anything(), source: 'long-press', handle: corner!.id }])
    expect(log.some((gesture) => gesture.kind === 'press' || gesture.kind === 'tap'), 'the held finger reaches no tool').toBe(false)
    expect((await nativeMenus(page)).every((menu) => menu.prevented), 'the native menu stays shut').toBe(true)
  })

  test('(canopi-f47t.54, Z) a long press on a zone corner opens the point menu (Chromium)', async ({ page }) => {
    await openBase(page)
    const fingers = await Fingers.of(page)
    await fingers.tap(POLYGON_EDGE)
    await expect(selectionChip(page)).toHaveText(/^Polygon zone/)
    await expect.poll(() => corners(page)).toBe(POLYGON_CORNERS)
    const [corner] = await handles(page, 'vertex')
    await fingers.tap(corner!, { holdMs: 600 })
    await expectDeletePointOnly(page, 'a long press on a corner')
    await expect(undo(page), 'the lift runs no entry').toBeDisabled()
  })
})

// The canvas menu's keys are its entries' shortcuts on what it names; a point menu names a corner.
test('(canopi-f47t.54, D) Delete and Backspace in a corner\'s point menu delete that corner, never the zone; refused at three corners, the menu stays', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  for (const [key, left] of [['Delete', POLYGON_CORNERS - 1], ['Backspace', POLYGON_CORNERS - 2]] as const) {
    await (await firstCorner(page)).focus()
    await page.keyboard.press('Shift+F10')
    await expectDeletePointOnly(page, 'Shift+F10 on a focused corner')
    await expect(pointMenu(page).first(), 'Delete point shows Delete\'s keys').toHaveAttribute('aria-keyshortcuts', /Delete/)
    await expect(pointMenu(page).first(), 'the menu has focus').toBeFocused()
    await page.keyboard.press(key)
    await expect.poll(() => corners(page), `${key} deletes the corner`).toBe(left)
    await expect(page.getByRole('menu'), `${key} closes the menu`).toHaveCount(0)
    await expect(selectionChip(page), `${key} keeps the zone`).toHaveText(/^Polygon zone/)
  }
  await (await firstCorner(page)).focus()
  await page.keyboard.press('Shift+F10')
  await expectDeletePointOnly(page, 'Shift+F10 on a triangle\'s corner')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('menu'), 'a refused Delete point keeps the menu').toHaveCount(1)
  await expect.poll(() => corners(page), 'the triangle keeps its corners').toBe(3)
  await expect(selectionChip(page), 'the zone stays').toHaveText(/^Polygon zone/)
})

// The point menu names its corner by index; once the corners or the tool change, it closes.
test('(canopi-f47t.54, D) a corner\'s point menu closes on Undo and on a tool letter pressed in it', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  await (await firstCorner(page)).click({ modifiers: ['Alt'] })
  await expect.poll(() => corners(page), 'Alt+click deletes a corner: an edit to undo').toBe(POLYGON_CORNERS - 1)
  await (await firstCorner(page)).click({ button: 'right' })
  await expectDeletePointOnly(page, 'a right-click on a corner')
  await pressMod(page, 'z')
  await expect(page.getByRole('menu'), 'Undo closes the point menu').toHaveCount(0)
  await expect.poll(() => corners(page), 'Undo brings the corner back').toBe(POLYGON_CORNERS)
  await expect(mapHost(page), 'focus goes back to the map').toBeFocused()

  await (await firstCorner(page)).click({ button: 'right' })
  await expectDeletePointOnly(page, 'a right-click on a corner')
  await page.keyboard.press('w')
  await expect(page.getByRole('menu'), 'a tool letter closes the point menu').toHaveCount(0)
  await expect(page.locator('[data-tool-card]'), 'the letter arms Plant a row').toHaveAttribute('data-tool-card', 'plant-spacing')
  await expect(undo(page), 'nothing is deleted').toBeDisabled()
})

test('(canopi-f47t.54, Z) Shift+F10 on a focused zone corner opens the point menu', async ({ page }) => {
  await openBase(page)
  await selectPolygon(page)
  await (await firstCorner(page)).focus()
  await page.keyboard.press('Shift+F10')
  await expectDeletePointOnly(page, 'Shift+F10 on a focused corner')
})
