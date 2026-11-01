// Tools in overview (canopi-n2cg; ADR 0015 and 0018, amended 2026-10-14): zoomed out past 0.1 px/m every tool stays
// enabled; picking a drawing tool by its rail button or its key fits the Design, as Fit to Design does, then arms it;
// a click or a tap on the Design pin or Enter on it fits the Design, while a wheel, a drag or a pinch that starts on it is
// the map's, whose input owns the pin's pointer: its hover shows the pointer cursor and the pin's tooltip, never through a
// dialog drawn over it; a
// plant dragged from the catalog onto the overview fits the Design, places nothing and stays picked for Place plants;
// an empty Design zooms in about the view centre, not the origin; a drop on the pin itself is taken as on the map. Both
// engines, DOM assertions only. The e2e catalog is always 404 (support/offline.ts), so the drag is synthetic dragenter,
// dragover and drop events carrying the catalog's drag data, each sent to the element under the point as the browser does.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap } from '../support/canvas'
import { Fingers } from '../support/fingers'
import { mapHost, nextFrames, openFixture } from '../support/layout'
import { expect, test } from '../support/offline'
import { tooltipOf } from '../support/tooltip'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Empty map, away from every object and chrome of the fixture's opening camera. */
const NEUTRAL = { x: 800, y: 450 }
/** The drawing tools and their keys, as the rail names them. */
const DRAWING_TOOLS = [
  ['Place plants', 'p'],
  ['Plant a row', 'w'],
  ['Place a stamp', 'k'],
  ['Polygon zone', 'z'],
  ['Rectangle zone', 'r'],
  ['Ellipse zone', 'e'],
  ['Line zone', 'l'],
  ['Text note', 't'],
  ['Measure', 'm'],
] as const
/** The plant catalog's drag data (canvas/plant-stamp-source.ts). */
const PLANT_STAMP_MIME = 'application/x.canopi.plant-stamp+json'

function tool(page: Page, name: string) {
  return page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: new RegExp(`^${name}( \\(.+\\))?$`) })
}

function overviewNotice(page: Page) {
  return page.locator('[data-overview-notice]')
}

function designPin(page: Page) {
  return page.getByRole('button', { name: /^Go to Design: / })
}

/** The scale's denominator, from the map scale chip ("1:240" → 240). */
async function scaleDenominator(page: Page): Promise<number> {
  const text = await page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ }).textContent()
  const match = /1:([\d,\s ]+)/.exec(text ?? '')
  if (!match) throw new Error(`no scale in the map scale chip: ${text}`)
  return Number(match[1]!.replace(/[^\d]/g, ''))
}

/** Wheels out about `at` until the overview notice shows: the one wheel path into overview (wheel-into-overview test). */
async function wheelOutToOverview(page: Page, at: { x: number, y: number } = NEUTRAL): Promise<void> {
  await page.mouse.move(at.x, at.y)
  for (let step = 0; step < 80 && await overviewNotice(page).count() === 0; step += 1) {
    await page.mouse.wheel(0, 400)
    await nextFrames(page)
  }
  await expect(overviewNotice(page), 'zoomed out to overview').toBeVisible()
}

/** Deep enough in overview (the threshold is 0.1 px/m, about 1:38,000) that a pinch or a wheel step in stays there. */
const DEEP_OVERVIEW_DENOMINATOR = 100_000

/**
 * Jumps to overview in a few steps (canopi-xs1l): the scale menu's widest scale (1:25,000), then the map's zoom-out
 * key until the view is well past the overview threshold.
 */
async function zoomOutToOverview(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ }).click()
  await page.getByRole('menuitemradio', { name: '1:25,000' }).click()
  await designMap(page).focus()
  for (let step = 0; step < 30 && await scaleDenominator(page) < DEEP_OVERVIEW_DENOMINATOR; step += 1) {
    await page.keyboard.press('-')
    await nextFrames(page)
  }
  await expect(overviewNotice(page), 'zoomed out to overview').toBeVisible()
}

/** The view has left overview at the Design's fit: no notice, and site scale (the fixture fits at about 1:240). */
async function expectFitted(page: Page, what: string): Promise<void> {
  await expect(overviewNotice(page), `${what}: the view left overview`).toHaveCount(0)
  expect(await scaleDenominator(page), `${what}: the Design is framed at site scale`).toBeLessThan(2000)
}

async function openOverview(page: Page): Promise<void> {
  await openFixture(page, FIXTURE, { basemapHidden: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await zoomOutToOverview(page)
}

test('wheeled out into overview every tool is enabled, and Pan keeps the overview', async ({ page }) => {
  await openFixture(page, FIXTURE, { basemapHidden: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await wheelOutToOverview(page)
  await expect(tool(page, 'Select'), 'Select is enabled in overview').toBeEnabled()
  for (const [name] of DRAWING_TOOLS) await expect(tool(page, name), `${name} is enabled in overview`).toBeEnabled()
  // Pan (H, off the rail) keeps the overview.
  await designMap(page).focus()
  await page.keyboard.press('h')
  await expect(tool(page, 'Select'), 'Pan is armed').toHaveAttribute('aria-pressed', 'false')
  await expect(overviewNotice(page), 'Pan keeps the overview').toBeVisible()
})

// One test per tool (canopi-xs1l); the unit test app/keyboard/arming.test.ts pins every tool's fit-then-arm order.
for (const [name, key] of DRAWING_TOOLS) {
  test(`in overview ${name}'s button or key ${key} fits the Design and arms it`, async ({ page }) => {
    await openOverview(page)
    await tool(page, name).click()
    await expectFitted(page, `${name}'s button`)
    await expect(tool(page, name), `${name}'s button arms it`).toHaveAttribute('aria-pressed', 'true')

    await tool(page, 'Select').click()
    await zoomOutToOverview(page)
    await designMap(page).focus()
    await page.keyboard.press(key)
    await expectFitted(page, `${name}'s key ${key}`)
    await expect(tool(page, name), `${name}'s key arms it`).toHaveAttribute('aria-pressed', 'true')
  })
}

/** A point on the pin's name label, away from its dot: the whole pin is the map's for gestures. */
async function onPin(page: Page): Promise<{ x: number, y: number }> {
  const box = await designPin(page).boundingBox()
  if (!box) throw new Error('no Design pin')
  return { x: box.x + box.width - 12, y: box.y + box.height / 2 }
}

test('a mouse over the Design pin shows the pointer cursor and, after the hover delay, its tooltip; a click or Enter fits', async ({ page }) => {
  await openOverview(page)
  await expect(designPin(page)).toBeVisible()
  // With motion, so the tooltip's hover delay applies.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const tooltip = await tooltipOf(designPin(page))
  const pin = await onPin(page)
  await page.mouse.move(pin.x + 200, pin.y + 120)
  await expect(tooltip).toHaveCount(0)
  await expect(mapHost(page), 'bare map shows the tool\'s cursor').not.toHaveCSS('cursor', 'pointer')

  // The pin takes no pointer events itself (the map has every gesture): the map's hover finds its box.
  await page.mouse.move(pin.x, pin.y, { steps: 4 })
  await expect(mapHost(page), 'over the pin the map shows the pointer cursor').toHaveCSS('cursor', 'pointer')
  await expect(tooltip).toHaveText('Fit the whole Design on screen')
  expect(await tooltip.evaluate((element) => getComputedStyle(element).animationDelay), 'the tooltip waits for the hover delay').not.toBe('0s')
  await page.mouse.move(pin.x + 200, pin.y + 120, { steps: 4 })
  await expect(tooltip, 'off the pin its tooltip hides').toHaveCount(0)
  await expect(mapHost(page)).not.toHaveCSS('cursor', 'pointer')

  await page.mouse.click(pin.x, pin.y)
  await expectFitted(page, 'the pin')
  await expect(tool(page, 'Select'), 'the pin arms no tool').toHaveAttribute('aria-pressed', 'true')
  await expect(designMap(page), 'the map has focus after the click').toBeFocused()

  // From the keyboard: the pin leaves with the overview, so the map takes focus and its keys work at once.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await zoomOutToOverview(page)
  await designPin(page).focus()
  await page.keyboard.press('Enter')
  await expectFitted(page, 'the pin from the keyboard')
  await expect(designMap(page), 'the map has focus').toBeFocused()
})

test('a dialog drawn over the Design pin shows neither its tooltip nor the pointer cursor, and a click on it fits nothing', async ({ page }) => {
  await openOverview(page)
  const pin = await onPin(page)
  await page.mouse.move(pin.x + 200, pin.y + 120)
  await designMap(page).focus()
  await page.keyboard.press('F1')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  const covering = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="dialog"]') !== null, pin)
  expect(covering, 'the dialog covers the pin').toBe(true)

  await page.mouse.move(pin.x, pin.y, { steps: 4 })
  await page.mouse.move(pin.x + 2, pin.y + 1)
  await page.waitForTimeout(800)
  await expect(await tooltipOf(designPin(page)), 'no pin tooltip over the dialog').toHaveCount(0)
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, pin)).not.toBe('pointer')
  await page.mouse.click(pin.x + 2, pin.y + 1)
  await expect(overviewNotice(page), 'a click on the dialog over the pin fits nothing').toBeVisible()
})

test.describe('Chromium touch on the Design pin', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'multi-touch through CDP is Chromium-only')
  test.use({ hasTouch: true })

  test('a tap on the pin fits the Design; a pinch with a still finger on it fits nothing, whichever finger lands first', async ({ page }) => {
    await openOverview(page)
    const fingers = await Fingers.of(page)
    const away = (from: { x: number, y: number }, by: number) => ({ x: from.x - 260 - by, y: from.y + 160 + by / 2 })

    for (const pinFirst of [true, false]) {
      const pin = await onPin(page)
      const other = away(pin, 0)
      if (pinFirst) {
        await fingers.start(0, pin)
        await fingers.start(1, other)
      } else {
        await fingers.start(1, other)
        await fingers.start(0, pin)
      }
      for (let step = 1; step <= 8; step += 1) await fingers.move({ 1: away(pin, step * 12) })
      if (pinFirst) {
        await fingers.end(1)
        await fingers.end(0)
      } else {
        await fingers.end(0)
        await fingers.end(1)
      }
      await page.waitForTimeout(300)
      await expect(overviewNotice(page), `a pinch with a still finger on the pin (${pinFirst ? 'landing first' : 'landing second'}) fits nothing`).toBeVisible()
    }

    await fingers.tap(await onPin(page))
    await expectFitted(page, 'a tap on the pin')
  })
})

test.describe('WebKit touch on the Design pin', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'page.touchscreen in WebKit')
  test.use({ hasTouch: true })

  test('a touchscreen tap on the pin fits the Design', async ({ page }) => {
    await openOverview(page)
    const pin = await onPin(page)
    await page.touchscreen.tap(pin.x, pin.y)
    await expectFitted(page, 'a tap on the pin')
  })
})

test('a wheel or a drag that starts on the Design pin acts on the map; a press dragged off it fits nothing', async ({ page }) => {
  await openOverview(page)
  const pin = await designPin(page).boundingBox()
  if (!pin) throw new Error('no Design pin')
  // On the name label, away from the dot: the whole pin is the map's for gestures.
  const onPin = { x: pin.x + pin.width - 12, y: pin.y + pin.height / 2 }

  const before = await scaleDenominator(page)
  await page.mouse.move(onPin.x, onPin.y)
  await page.mouse.wheel(0, 400)
  await nextFrames(page)
  await expect.poll(() => scaleDenominator(page), 'a wheel on the pin zooms the map').toBeGreaterThan(before)
  await expect(overviewNotice(page), 'the wheel out keeps the overview').toBeVisible()

  const start = await designPin(page).boundingBox()
  if (!start) throw new Error('no Design pin')
  const grab = { x: start.x + start.width - 12, y: start.y + start.height / 2 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x - 200, grab.y - 100, { steps: 10 })
  await page.mouse.up()
  await nextFrames(page)
  await expect(overviewNotice(page), 'a drag from the pin pans, it does not fit the Design').toBeVisible()
  const moved = await designPin(page).boundingBox()
  if (!moved) throw new Error('no Design pin after the pan')
  expect(Math.abs(moved.x - (start.x - 200)), 'the drag from the pin panned the map: the pin followed it').toBeLessThan(8)
  expect(Math.abs(moved.y - (start.y - 100)), 'the drag from the pin panned the map: the pin followed it').toBeLessThan(8)
})

test('a plant dropped from the catalog on the overview fits the Design, places nothing and stays picked', async ({ page }) => {
  await openOverview(page)
  const undo = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Undo' })
  await expect(undo).toBeDisabled()

  // Bare map beside the pin (the fixture's origin, so its pin, sits at NEUTRAL in overview).
  const pin = await designPin(page).boundingBox()
  if (!pin) throw new Error('no Design pin')
  const defaultPrevented = await dragPlantOnto(page, { x: pin.x + pin.width + 120, y: pin.y + pin.height / 2 + 120 })

  expect(defaultPrevented, 'the overview takes the drag, so the browser fires the drop').toEqual({ over: true, effect: 'copy', drop: true })
  await expectFitted(page, 'the drop')
  await expect(tool(page, 'Place plants'), 'the drop arms Place plants').toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-tool-card]'), 'the dropped plant stays picked').toContainText('Pear')
  await expect(undo, 'the drop placed nothing').toBeDisabled()
})

test('a plant dragged onto the Design pin is taken as on the map: the Design fits and the plant stays picked', async ({ page }) => {
  await openOverview(page)
  const box = await designPin(page).boundingBox()
  if (!box) throw new Error('no Design pin')
  const defaultPrevented = await dragPlantOnto(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 })

  expect(defaultPrevented, 'the drag over the pin reaches the map, so the browser fires the drop').toEqual({ over: true, effect: 'copy', drop: true })
  await expectFitted(page, 'the drop on the pin')
  await expect(tool(page, 'Place plants'), 'the drop arms Place plants').toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-tool-card]'), 'the dropped plant stays picked').toContainText('Pear')
})

test('an empty Design picked from overview zooms in about the view centre, not the origin', async ({ page }) => {
  await page.goto('')
  await page.locator('[data-start-screen]').getByRole('button', { name: 'New Design' }).first().click()
  await page.locator('[data-site-locate]').getByRole('button', { name: 'Skip, I’ll find it on the map' }).click()
  await expect(overviewNotice(page)).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const host = await mapHost(page).boundingBox()
  if (!host) throw new Error('no map')
  const centre = { x: host.x + host.width / 2, y: host.y + host.height / 2 }
  await expect.poll(() => lastView(page), 'the opening view is remembered').not.toBeNull()
  const opening = (await lastView(page))!

  // A New Design opens with its origin (and pin) at the centre; a left drag beside the pin pans the map.
  const grab = { x: centre.x + 150, y: centre.y + 120 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x - 200, grab.y - 100, { steps: 10 })
  await page.mouse.up()
  // last_view is written once the view settles, which can happen mid-drag when a step is slow: wait for the whole drag
  // (the view centre 200 px right and 100 px down of the opening one, north up) rather than for any change.
  const target = worldPx(opening, opening.zoom)
  target.x += 200
  target.y += 100
  await expect.poll(async () => {
    const view = await lastView(page)
    if (!view) return Infinity
    const at = worldPx(view, opening.zoom)
    return Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y))
  }, 'the whole pan settled').toBeLessThan(1)
  const panned = (await lastView(page))!

  await designMap(page).focus()
  await page.keyboard.press('r')
  await expect(overviewNotice(page), 'the view left overview').toHaveCount(0)
  await expect(tool(page, 'Rectangle zone')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await lastView(page))?.zoom ?? 0, 'the zoom-in settled').toBeGreaterThan(panned.zoom + 4)
  const fitted = (await lastView(page))!
  const fromPanned = Math.hypot(fitted.lon - panned.lon, fitted.lat - panned.lat)
  const panLength = Math.hypot(panned.lon - opening.lon, panned.lat - opening.lat)
  expect(fromPanned, 'the view stays centred where it was').toBeLessThan(panLength / 100)
})

/** A lon/lat's Web Mercator world pixel at MapLibre's zoom (512 px tiles). */
function worldPx(at: { lon: number, lat: number }, zoom: number): { x: number, y: number } {
  const size = 512 * 2 ** zoom
  const sin = Math.sin(at.lat * Math.PI / 180)
  return { x: (at.lon + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size }
}

/** The view the Web Edition remembers (settings `last_view`, written once the view settles). */
async function lastView(page: Page): Promise<{ lon: number, lat: number, zoom: number } | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('canopi:web-app-data:v3:settings')
    const view = raw ? (JSON.parse(raw) as { settings?: { last_view?: { lon: number, lat: number, zoom: number } } }).settings?.last_view : null
    return view ?? null
  })
}

/**
 * Drags the catalog's Pear to `at` as the browser does: each drag step's events go to the element under the point (hit
 * testing, so chrome over the map is in the way), dragenter first, a frame between steps. Returns what the page did.
 */
async function dragPlantOnto(page: Page, at: { x: number, y: number }): Promise<{ over: boolean, effect: string, drop: boolean }> {
  const fire = (type: string) => page.evaluate(({ mime, at, type }) => {
    const store = window as unknown as { __e2eDragData?: Map<string, string>, __e2eDropEffect?: string }
    store.__e2eDragData ??= new Map<string, string>([[mime, JSON.stringify({
      canonical_name: 'Pyrus communis', common_name: 'Pear', stratum: 'mid', width_max_m: 3,
    })]])
    const data = store.__e2eDragData
    const dataTransfer = {
      effectAllowed: 'copy',
      get dropEffect() { return store.__e2eDropEffect ?? 'none' },
      set dropEffect(value: string) { store.__e2eDropEffect = value },
      get types() { return Array.from(data.keys()) },
      setData(type: string, value: string) { data.set(type, value) },
      getData(type: string) { return data.get(type) ?? '' },
    }
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      clientX: { value: at.x },
      clientY: { value: at.y },
      dataTransfer: { value: dataTransfer },
    })
    const target = document.elementFromPoint(at.x, at.y)
    if (!target) throw new Error('nothing under the drag')
    if (type === 'dragover') store.__e2eDropEffect = 'none'
    target.dispatchEvent(event)
    return { prevented: event.defaultPrevented, effect: dataTransfer.dropEffect }
  }, { mime: PLANT_STAMP_MIME, at, type })
  await fire('dragenter')
  await nextFrames(page)
  const over = await fire('dragover')
  await nextFrames(page)
  const drop = await fire('drop')
  return { over: over.prevented, effect: over.effect, drop: drop.prevented }
}
