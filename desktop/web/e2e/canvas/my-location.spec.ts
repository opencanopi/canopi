// Show my location in the Web Edition (canopi-f47t.53; plan section 4 "2.0 live bugs, guards and location", U54 Q9–Q18),
// in Chromium and WebKit with Playwright's emulated geolocation. Real input only; the dot is read from the map's pixels.
//
// What this spec reads, the button's contract: "Show my location" is a button of the Zoom group, just before Reset
// north. A click from Off starts location and follows it: the camera jumps to the fix at max(zoom, 17), centred on the
// whole map, and the button is aria-pressed while Following (and only then). A new fix while Following moves the camera
// with it. Any other camera move (a pan) is Moved away: the dot stays where the fix is and the button is not pressed; a
// click re-centres and follows again. A click while Following turns location off (no dot). Without permission the
// request fails with code 1 and design check A4's rule applies to the permission state the engine reports: 'denied'
// is Blocked (aria-disabled; Playwright WebKit), anything else is Off (Chromium reports 'prompt'). A touch screen has no
// hover, so a tap while Blocked shows the tooltip's reason for a few seconds (Q16), whole inside a phone's window in the
// longest locales, undimmed by the disabled button and drawn inside its background (a long label wraps too). The dot's
// core is platform blue #1A73E8 (U54 Q11) over an accuracy polygon of the fix's accuracy radius.
// Chromium sends a code 2 error to a running watch before each setGeolocation fix (design check §6); every check after a
// new fix polls until that fix's longitude has been delivered (a count would pass on an earlier second read), and a
// single code 2 never ends Following. The moved fix has a wider accuracy than the first, so the moved fix being drawn
// is seen positively (its wider polygon tints the centre), not only as the absence of an off-centre dot, which a frame
// not yet drawn would also give.
// The trust half: while not following, the downloaded .canopi, the Draft record and the saved view carry no fix (the
// fix's digits, such as 12.3456789). A camera saved while following is a view (Q10), so these checks run after a pan.
// No baselines: nothing here is compared with a recorded screenshot.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { designMap } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { pixel, pixelsAround, type Pixels } from '../support/pixels'
import { expect, test } from '../support/offline'
import { DRAFT_DATABASE, draftStoreDump } from '../support/web-storage'
import { tooltipOf } from '../support/tooltip'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

/** Far from the fixture's site (Montpellier), so the map around the dot is empty paper. */
const FIX = { latitude: 45.6789012, longitude: 12.3456789, accuracy: 25 } as const
/**
 * About 156 m east of FIX: some 370 px at zoom 17, so a dot that is not followed leaves the centre. Twice FIX's
 * accuracy, so its polygon, when centred, tints a ring that FIX's polygon leaves clear.
 */
const MOVED_FIX = { ...FIX, longitude: 12.3476789, accuracy: 50 } as const
/** How far east of the centre the moved fix would be drawn at zoom 17 if the camera did not follow it. */
const MOVED_FIX_PX = Math.round(((MOVED_FIX.longitude - FIX.longitude) / 360) * 512 * 2 ** 17)
/** Each fix's digits; none may reach a saved file or the Draft while not following. */
const FIX_DIGITS = ['12.3456789', '12.3476789', '45.6789012'] as const
/** The scale the map is zoomed out to first, so the jump to zoom 17 shows. */
const ZOOMED_OUT = '1:25,000'
/** A middle-button pan away from the dot, with a vertical part, so the camera keeps neither of the fix's coordinates. */
const PAN = { dx: 200, dy: 120 } as const
/** One CSS pixel on screen is 1/96 inch (canvas/map-scale.ts). */
const CSS_PIXEL_METRES = 0.0254 / 96
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6_378_137

interface Point { readonly x: number, readonly y: number }

/** The longitude of each fix the page's geolocation delivered, in order, and each error code. */
interface GeolocationRecord { readonly longitudes: number[], readonly errors: number[] }

declare global {
  interface Window { __geolocation?: GeolocationRecord }
}

test.describe('granted', () => {
  test.use({ permissions: ['geolocation'], geolocation: FIX })

  test('the button shows, follows, moves away, re-centres and turns off; nothing saved while not following carries the fix', async ({ page, context }) => {
    await recordGeolocation(page)
    await openBaseFixture(page)

    await test.step('the button is in the Zoom group, before Reset north, and starts Off', async () => {
      await expectButtonBeforeCompass(page)
      await expect(locationButton(page)).not.toHaveAttribute('aria-pressed', 'true')
      await expectNoDot(page, await mapCentre(page), 'Off draws no dot')
    })

    await test.step('zoom out, so the jump to zoom 17 can be seen', async () => {
      await zoomGroup(page).getByRole('button', { name: /^Map scale/ }).click()
      await page.getByRole('menuitemradio', { name: ZOOMED_OUT }).click()
      await expect(scaleChip(page)).toHaveText(ZOOMED_OUT)
    })

    await test.step('a click shows the dot and its accuracy, centred at zoom 17 or closer, and follows', async () => {
      await locationButton(page).click()
      await expect(locationButton(page), 'Following').toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => scaleDenominator(page), 'the camera jumped to zoom 17 or closer')
        .toBeLessThanOrEqual(roundScale(denominatorAtZoom(17, FIX.latitude)))
      const centre = await mapCentre(page)
      await expectDot(page, centre, 'the dot is centred on the whole map')
      await expectAccuracyTint(page, centre, FIX.accuracy / (await scaleDenominator(page) * CSS_PIXEL_METRES))
    })

    await test.step('a moved fix is followed', async () => {
      await context.setGeolocation(MOVED_FIX)
      await expect.poll(async () => (await geolocationRecord(page)).longitudes, 'the moved fix arrived').toContain(MOVED_FIX.longitude)
      const centre = await mapCentre(page)
      const movedRadiusPx = MOVED_FIX.accuracy / (await scaleDenominator(page) * CSS_PIXEL_METRES)
      // The ring at 0.75 of the moved radius lies outside FIX's polygon (half the moved radius), and some 280 px from
      // where the moved polygon would be if the camera had stayed: only the moved fix drawn at the centre tints it.
      await expectAccuracyTint(page, centre, movedRadiusPx, 0.75)
      await expectDot(page, centre, 'the camera followed the moved fix')
      await expectNoDot(page, { x: centre.x + MOVED_FIX_PX, y: centre.y }, 'the dot did not move off the centre')
      await expect(locationButton(page), 'still Following after the fix (and Chromium\'s code 2 before it)').toHaveAttribute('aria-pressed', 'true')
    })

    const centre = await mapCentre(page)
    await test.step('a pan is Moved away: the dot stays on the fix', async () => {
      await panBy(page, centre, PAN)
      await expect(locationButton(page), 'Moved away').not.toHaveAttribute('aria-pressed', 'true')
      await expectDot(page, { x: centre.x + PAN.dx, y: centre.y + PAN.dy }, 'the dot moved with the map')
      await expectNoDot(page, centre, 'the camera stayed where the pan left it')
    })

    await test.step('while not following, the saved view, the Draft record and the downloaded .canopi carry no fix', async () => {
      const viewName = await saveCurrentView(page)
      await expect.poll(async () => draftRecord(page), 'the Draft holds the saved view').toContain(viewName)
      expectNoFix(await draftRecord(page), 'the Draft record')
      const canopi = await downloadCopy(page)
      expect(canopi, 'the download holds the saved view').toContain(viewName)
      expectNoFix(canopi, 'the downloaded .canopi')
    })

    await test.step('a click while Moved away re-centres and follows', async () => {
      await locationButton(page).click()
      await expect(locationButton(page), 'Following again').toHaveAttribute('aria-pressed', 'true')
      await expectDot(page, centre, 'the dot is centred again')
    })

    await test.step('a click while Following turns location off', async () => {
      await locationButton(page).click()
      await expect(locationButton(page), 'Off').not.toHaveAttribute('aria-pressed', 'true')
      await expectNoDot(page, centre, 'Off removes the dot')
    })
  })

  test.describe('phone landscape', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true })

    // The inspection lens's launcher is a button of the column on a phone, so there is no lens button to clear.
    test('the zoom column with the location button clears the top bar, the tools and the panel sheet', async ({ page }) => {
      await openBaseFixture(page)
      await expectButtonBeforeCompass(page)
      const column = await boxOf(zoomGroup(page))
      expect(column.y, 'the column starts in the window').toBeGreaterThanOrEqual(0)
      expect(column.y + column.height, 'the column ends in the window').toBeLessThanOrEqual(390)
      for (const [name, chrome] of [
        ['the top bar', page.getByRole('banner')],
        ['the tools', page.getByRole('toolbar', { name: 'Tools' })],
        ['the panel sheet', page.getByRole('region', { name: 'Panels' })],
      ] as const) {
        expect(overlap(column, await boxOf(chrome)), `the zoom column clears ${name}`).toBe(false)
      }
      for (const button of await zoomGroup(page).getByRole('button').all()) {
        const box = await boxOf(button)
        expect(Math.min(box.width, box.height), 'a 44 px touch target').toBeGreaterThanOrEqual(44)
      }
    })
  })
})

test('without permission the click gives Blocked when the permission is denied, otherwise Off', async ({ page }) => {
  await recordGeolocation(page)
  await openBaseFixture(page)
  await expect(locationButton(page)).toBeVisible()
  await locationButton(page).click()
  await expect.poll(async () => (await geolocationRecord(page)).errors, 'the request was refused with code 1').toContain(1)
  await expect(locationButton(page)).not.toHaveAttribute('aria-pressed', 'true')
  const permission = await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
  if (permission === 'denied') {
    await expect(locationButton(page), 'a denied permission is Blocked (A4)').toHaveAttribute('aria-disabled', 'true')
  } else {
    await expect(locationButton(page), `a '${permission}' permission is Off, not Blocked (A4)`).not.toHaveAttribute('aria-disabled', 'true')
  }
  await expectNoDot(page, await mapCentre(page), 'no fix, no dot')
})

test.describe('phone portrait, touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a tap while Blocked shows the tooltip\'s reason for a few seconds, inside the window (Q16)', async ({ page }) => {
    await denyGeolocationPermission(page)
    await openBaseFixture(page)
    const tooltip = await tooltipOf(locationButton(page))
    await locationButton(page).tap()
    await expect(locationButton(page), 'a denied permission is Blocked (A4)').toHaveAttribute('aria-disabled', 'true')
    await expect(tooltip, 'the reason leaves after a few seconds, though the tap left the button hovered').toBeHidden({ timeout: 8_000 })

    // A Blocked button is aria-disabled, which Playwright's actionability wait reads as disabled; a finger still taps it.
    await locationButton(page).tap({ force: true })
    await expectReasonReadable(page, tooltip, 'en')
    await expect(tooltip, 'and leaves again').toBeHidden({ timeout: 8_000 })
  })

  // The longest Blocked reasons: German's and Russian's run past 500 px on one line.
  for (const locale of ['de', 'ru'] as const) {
    test(`in ${locale}, a tap while Blocked shows the whole reason inside the window`, async ({ page }) => {
      await denyGeolocationPermission(page)
      await openBaseFixture(page, locale)
      const button = page.locator('[data-zoom-group] [data-my-location]')
      await button.tap()
      await expect(button, 'a denied permission is Blocked (A4)').toHaveAttribute('aria-disabled', 'true')
      await button.tap({ force: true })
      await expectReasonReadable(page, await tooltipOf(button), locale)
    })
  }

  // Some tooltips' labels are whole sentences with no description, such as French Site data's "Affichez un calque
  // d’altitude ou de hauteur pour tracer un profil" (334 px on one line): the label wraps at the tooltip's measure too.
  test('a label longer than the tooltip\'s measure wraps inside its box', async ({ page }) => {
    await denyGeolocationPermission(page)
    await openBaseFixture(page)
    const tooltip = await tooltipOf(locationButton(page))
    await locationButton(page).tap()
    await expect(locationButton(page), 'a denied permission is Blocked (A4)').toHaveAttribute('aria-disabled', 'true')
    const fr = JSON.parse(await readFile(fileURLToPath(new URL('../../src/i18n/fr.json', import.meta.url)), 'utf8'))
    await tooltip.locator('span').first().evaluate((label, text: string) => { label.textContent = text }, fr.siteData.profileNeedsLayer)
    await expect(tooltip).toContainText(fr.siteData.profileNeedsLayer)
    await expectTextInsideBox(tooltip)
  })
})

/** Both engines answer the refused request with code 1; with the permission reading 'denied' in both, it is Blocked. */
async function denyGeolocationPermission(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const query = Permissions.prototype.query
    Permissions.prototype.query = function (this: Permissions, descriptor: PermissionDescriptor) {
      if (descriptor.name !== 'geolocation') return query.call(this, descriptor)
      return Promise.resolve(Object.assign(new EventTarget(), { name: 'geolocation', state: 'denied', onchange: null }) as unknown as PermissionStatus)
    }
  })
}

/** The Blocked reason is shown in `locale`, wholly inside the 390 px window and at full opacity (a dimmed button does not dim it). */
async function expectReasonReadable(page: Page, tooltip: Locator, locale: string): Promise<void> {
  const messages = JSON.parse(await readFile(fileURLToPath(new URL(`../../src/i18n/${locale}.json`, import.meta.url)), 'utf8'))
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(messages.canvas.myLocation.blocked)
  const box = await boxOf(tooltip)
  expect(box.x, 'the reason starts in the window').toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, 'the reason ends in the window').toBeLessThanOrEqual(page.viewportSize()!.width)
  await expectTextInsideBox(tooltip)
  await expect.poll(async () => tooltip.evaluate((element) => {
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
    return opacity
  }), { message: 'the reason is drawn at full opacity', timeout: 3_000 }).toBe(1)
}

/** Every line of the tooltip's text is drawn inside its background, none past its end edge. */
async function expectTextInsideBox(tooltip: Locator): Promise<void> {
  const overflow = await tooltip.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const lines = [...element.querySelectorAll('span')].flatMap((span) => [...span.getClientRects()])
    return { scroll: element.scrollWidth - element.clientWidth, past: Math.max(0, ...lines.map((line) => line.right - box.right)) }
  })
  expect(overflow, 'the text stays inside the tooltip\'s background').toEqual({ scroll: 0, past: 0 })
}

/** Records the fixes' longitudes and the error codes the page's geolocation delivers, without changing them. */
async function recordGeolocation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = { longitudes: [] as number[], errors: [] as number[] }
    window.__geolocation = record
    const geolocation = Geolocation.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['watchPosition', 'getCurrentPosition']) {
      const original = geolocation[name]!
      geolocation[name] = function (this: Geolocation, success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) {
        return original.call(
          this,
          (position: GeolocationPosition) => { record.longitudes.push(position.coords.longitude); success(position) },
          (failure: GeolocationPositionError) => { record.errors.push(failure.code); error?.(failure) },
          options,
        )
      } as (...args: unknown[]) => unknown
    }
  })
}

async function geolocationRecord(page: Page): Promise<GeolocationRecord> {
  return page.evaluate(() => window.__geolocation ?? { longitudes: [], errors: [] })
}

/** Opens the base fixture; with `locale`, in a fresh browser whose Web Edition settings take that language. */
async function openBaseFixture(page: Page, locale?: string): Promise<void> {
  if (locale) {
    await page.addInitScript((chosen) => {
      localStorage.clear()
      // The Web Edition's settings record (web/browser-app-data.ts), with the language chosen.
      localStorage.setItem('canopi:web-app-data:v3:settings', JSON.stringify({ version: 3, settings: { locale: chosen } }))
    }, locale)
  }
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  // The map host by role alone: its name follows the page's language.
  const map = page.getByRole('application').first()
  await expect(map).toBeVisible()
  await expect(map, 'the canvas has drawn the opened Design').not.toHaveAttribute('aria-busy')
}

function zoomGroup(page: Page) {
  return page.getByRole('group', { name: 'Zoom' })
}

function locationButton(page: Page) {
  return zoomGroup(page).getByRole('button', { name: 'Show my location' })
}

function scaleChip(page: Page) {
  return zoomGroup(page).getByRole('button', { name: /^Map scale/ })
}

async function expectButtonBeforeCompass(page: Page): Promise<void> {
  await expect(locationButton(page)).toBeVisible()
  const names = await zoomGroup(page).getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''))
  expect(names.indexOf('Show my location'), `the location button comes just before Reset north: ${names.join(', ')}`)
    .toBe(names.indexOf('Reset north') - 1)
}

/** The N of the scale chip's "1:N". */
async function scaleDenominator(page: Page): Promise<number> {
  const text = await scaleChip(page).textContent()
  return Number((text ?? '').replace(/^1:/, '').replace(/[^\d]/g, ''))
}

/** "1:N" at a MapLibre zoom (512 px tiles) and latitude, as the chip would show it before rounding. */
function denominatorAtZoom(zoom: number, latitude: number): number {
  const metresPerPixel = EARTH_CIRCUMFERENCE_M * Math.cos(latitude * Math.PI / 180) / (512 * 2 ** zoom)
  return metresPerPixel / CSS_PIXEL_METRES
}

/** Two significant figures, as the chip rounds (canvas/map-scale.ts roundScaleDenominator). */
function roundScale(denominator: number): number {
  const power = 10 ** Math.max(0, Math.floor(Math.log10(denominator)) - 1)
  return Math.round(denominator / power) * power
}

interface Box extends Point { readonly width: number, readonly height: number }

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`no box for ${locator}`)
  return box
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** The centre of the whole map, where a followed fix is drawn. */
async function mapCentre(page: Page): Promise<Point> {
  const box = await boxOf(designMap(page))
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

/** A middle-button drag that pans the map, starting below and left of `centre`, away from the dot and the chrome. */
async function panBy(page: Page, centre: Point, by: { readonly dx: number, readonly dy: number }): Promise<void> {
  const from = { x: centre.x - 150, y: centre.y + 40 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(from.x + by.dx, from.y + by.dy, { steps: 10 })
  await page.mouse.up({ button: 'middle' })
}

/** Near the dot's platform blue core, #1A73E8. */
function isPlatformBlue([r, g, b]: readonly [number, number, number]): boolean {
  return Math.abs(r - 0x1a) <= 48 && Math.abs(g - 0x73) <= 48 && Math.abs(b - 0xe8) <= 48
}

async function bluePixelsNear(page: Page, at: Point, radius: number): Promise<number> {
  const pixels = await pixelsAround(page, at, radius)
  let count = 0
  for (let y = pixels.y; y < pixels.y + pixels.height; y += 1) {
    for (let x = pixels.x; x < pixels.x + pixels.width; x += 1) {
      if (Math.hypot(x - at.x, y - at.y) <= radius && isPlatformBlue(pixel(pixels, x, y))) count += 1
    }
  }
  return count
}

async function expectDot(page: Page, at: Point, message: string): Promise<void> {
  await expect.poll(async () => bluePixelsNear(page, at, 10), message).toBeGreaterThanOrEqual(8)
}

async function expectNoDot(page: Page, around: Point, message: string): Promise<void> {
  await expect.poll(async () => bluePixelsNear(page, around, 120), message).toBe(0)
}

/** The per-channel median of the pixels on a circle. Thin grid lines fall out of the median. */
function ringMedian(pixels: Pixels, at: Point, radius: number): [number, number, number] {
  const samples = Array.from({ length: 72 }, (_, index) => {
    const angle = (index / 72) * 2 * Math.PI
    return pixel(pixels, at.x + radius * Math.cos(angle), at.y + radius * Math.sin(angle))
  })
  const median = (channel: number) => samples.map((sample) => sample[channel]!).sort((a, b) => a - b)[36]!
  return [median(0), median(1), median(2)]
}

/** Inside the accuracy radius (on the ring at `insideAt` of it) the paper is tinted; well outside it is not. */
async function expectAccuracyTint(page: Page, centre: Point, radiusPx: number, insideAt = 0.6): Promise<void> {
  const half = Math.ceil(radiusPx * 2.2) + 2
  await expect.poll(async () => {
    const pixels = await pixelsAround(page, centre, half)
    const inside = ringMedian(pixels, centre, radiusPx * insideAt)
    const outside = ringMedian(pixels, centre, radiusPx * 2)
    return inside.reduce((sum, value, index) => sum + Math.abs(value - outside[index]!), 0)
  }, `the accuracy polygon (${Math.round(radiusPx)} px) tints the map under it`).toBeGreaterThanOrEqual(12)
}

function expectNoFix(text: string, what: string): void {
  for (const digits of FIX_DIGITS) expect(text.includes(digits), `${what} carries no fix (${digits})`).toBe(false)
}

async function saveCurrentView(page: Page): Promise<string> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitem', { name: 'Save current view…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save current view' })
  await expect(dialog).toBeVisible()
  const name = await dialog.getByRole('textbox').first().inputValue()
  expect(name, 'the new view gets a default name').not.toBe('')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(dialog).toBeHidden()
  return name
}

/** Every Draft the browser holds in IndexedDB (`canopi-drafts`), as stored. */
async function draftRecord(page: Page): Promise<string> {
  const dump = await page.evaluate(draftStoreDump, DRAFT_DATABASE)
  if (!dump) return ''
  const drafts = Array.isArray(dump.drafts) ? dump.drafts : []
  return drafts.map((record) => JSON.stringify(record)).join('\n')
}

async function downloadCopy(page: Page): Promise<string> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Download a copy/ }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.canopi$/)
  return readFile(await download.path(), 'utf8')
}
