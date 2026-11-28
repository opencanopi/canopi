// The map notice keeps clear of the other chrome in every layout (live-bugs step, item 3). Offline, the Web Edition
// shows "Basemap couldn't load" with Retry. The notice stands above the bottom row, centred in the part of the map the
// other chrome leaves visible (the visible-map-area seam's framing frame), so the zoom group, the view chip, the rails
// and an open dock or bottom sheet never cover it: it is at most two lines tall with no panel open (never a tower of
// single words), Retry is what a click at its centre reaches, and it shares no pixel with that chrome. Beside an open
// dock in a window under about 900 px the visible map is narrower than the notice's widest place: Retry then stands
// below the sentence, which keeps the notice's width and takes at most three lines, never a tower. The notice is
// status chrome on the seam, registered with frames: false: with everything selected the selection chip sits above it,
// but it never moves the camera's framing, so a Design opened while the notice shows opens in the same frame as one
// opened with the basemap hidden, when no notice shows. On phones it is the context bar's top row, in the panel sheet
// (phone-chrome.spec.ts). The pinned-names legend is chrome over the map's left edge on the seam, so the notice centres
// beside it and never stands under it (canopi-f47t.60); where the bottom sheet spans its place, the legend stands above
// the sheet instead, off the seam. Both engines; no baselines.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { holdBasemapStyle } from '../support/basemap'
import { pressMod } from '../support/canvas'
import { boxOf, chipFrame, expectHitAtCentre, mapHost, nextFrames, openFixture, overlap } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** The notice's widest place (its max-width in Panels.module.css). */
const NOTICE_MAX_WIDTH_PX = 480
const CHROME_INSET_PX = 12

const LAYOUTS: ReadonlyArray<{ readonly width: number, readonly height: number, readonly locale?: string }> = [
  { width: 1400, height: 900 },
  { width: 1200, height: 800 },
  { width: 1200, height: 800, locale: 'de' },
  { width: 1100, height: 800 },
  { width: 1024, height: 768 },
  { width: 1024, height: 768, locale: 'de' },
  // The band where a notice in the bottom row became a tower of single words (761 to about 1000 px).
  { width: 900, height: 700 },
  { width: 800, height: 700 },
  { width: 761, height: 700 },
  { width: 761, height: 700, locale: 'de' },
  // The narrowest window that keeps the wide layout; an open panel is a bottom sheet there.
  { width: 700, height: 500 },
]

for (const { width, height, locale = 'en' } of LAYOUTS) {
  test.describe(`${width}x${height} ${locale}`, () => {
    test.use({ viewport: { width, height } })

    test('the notice stands above the bottom row, centred in the visible map, at most two lines tall, and Retry takes the click at its centre', async ({ page }) => {
      await openBaseFixture(page, { locale })
      const { notice, retry } = await expectNoticeWithRetry(page)
      await expectRetryHit(retry)
      const noticeBox = await boxOf(notice)
      const zoomGroup = await boxOf(page.locator('[data-zoom-group]'))
      const viewChip = await boxOf(page.locator('[data-view-chip]'))
      for (const [name, chrome] of [['the zoom group', zoomGroup], ['the view chip', viewChip]] as const) {
        expect(overlap(noticeBox, chrome), `the notice clears ${name}`).toBe(false)
      }
      expect(await lineCount(notice), 'the sentence takes at most two lines').toBeLessThanOrEqual(2)
      expect(noticeBox.y + noticeBox.height, 'the notice stands above the bottom row').toBeLessThanOrEqual(Math.min(zoomGroup.y, viewChip.y) + 0.5)
      // The rails cover the map's sides; the notice's bottom raises only the chips' bottom inset, not their sides.
      const frame = await chipFrame(page)
      expect(noticeBox.x, 'the notice keeps its inset from the tool rail').toBeGreaterThanOrEqual(frame.left + CHROME_INSET_PX - 0.5)
      expect(noticeBox.x + noticeBox.width, 'the notice keeps its inset from the panel rail').toBeLessThanOrEqual(frame.right - CHROME_INSET_PX + 0.5)
      expect(noticeBox.width, 'the notice is no wider than its widest place').toBeLessThanOrEqual(NOTICE_MAX_WIDTH_PX + 0.5)
      expect(Math.abs(noticeBox.x + noticeBox.width / 2 - (frame.left + frame.right) / 2), 'the notice is centred in the visible map').toBeLessThanOrEqual(1)
    })

    test('with a panel open, the notice stands clear of the dock, never a tower of single words, and Retry takes the click at its centre', async ({ page }) => {
      await openBaseFixture(page, { locale })
      await page.locator('[data-panel-rail] [data-panel]').first().click()
      const dock = page.locator('[data-key-region="dock"]')
      await expect(dock).toBeVisible()
      const { notice, retry } = await expectNoticeWithRetry(page)
      await expectRetryHit(retry)
      const noticeBox = await boxOf(notice)
      expect(overlap(noticeBox, await boxOf(dock)), 'the notice clears the dock').toBe(false)
      // At its widest place the sentence wraps beside Retry; narrower, Retry stands below it rather than squeeze it.
      const atWidest = noticeBox.width >= NOTICE_MAX_WIDTH_PX - 0.5
      expect(await lineCount(notice), 'the sentence never becomes a tower of single words').toBeLessThanOrEqual(atWidest ? 2 : 3)
    })

    test('the selection chip and the chips\' visible map frame clear the notice', async ({ page }) => {
      await openBaseFixture(page, { locale })
      const { notice, retry } = await expectNoticeWithRetry(page)
      await selectAll(page)
      const selection = page.locator('[data-selection-chip]')
      await expect(selection).toBeVisible()
      await nextFrames(page)
      await expectRetryHit(retry)
      const noticeBox = await boxOf(notice)
      expect(overlap(noticeBox, await boxOf(selection)), 'the notice clears the selection chip').toBe(false)
      // The notice is bottom chrome on the visible-map-area seam wherever it shows: the chips avoid it.
      const frameBottom = (await chipFrame(page)).bottom
      expect(frameBottom, 'the chips\' visible map frame ends above the notice').toBeLessThanOrEqual(Math.ceil(noticeBox.y))
    })
  })
}

// Where the legend, beside the tool rail at the bottom, and the notice can meet: an open panel moves the visible map's
// centre left, towards the legend (canopi-f47t.60: at 1280x800 with Layers open the notice stood under the legend).
const LEGEND_LAYOUTS: ReadonlyArray<{ readonly width: number, readonly height: number, readonly iconRail?: boolean }> = [
  { width: 1400, height: 900 },
  { width: 1280, height: 800 },
  { width: 1200, height: 800 },
  { width: 1024, height: 768 },
  { width: 900, height: 700 },
  { width: 800, height: 700 },
  { width: 761, height: 700 },
  // The Web edition's desktop layout under 761 px: an open panel is the bottom sheet, which spans the legend's place.
  // Beside the icon rail the legend leaves the map room enough to cover its left edge, were the sheet not over it.
  { width: 750, height: 700, iconRail: true },
  { width: 700, height: 700, iconRail: true },
]

for (const { width, height, iconRail = false } of LEGEND_LAYOUTS) {
  test.describe(`${width}x${height}${iconRail ? ' icon rail' : ''} pinned-names legend`, () => {
    test.use({ viewport: { width, height } })

    for (const panelOpen of [false, true]) {
      test(`${panelOpen ? 'with Layers open' : 'with no panel open'}, the notice stands clear of the legend, never a tower of single words, and Retry takes the click at its centre`, async ({ page }) => {
        await openFixture(page, pinnedNamesFixture(), iconRail ? { settings: { tool_names_visible: false } } : {})
        const legend = page.locator('[data-pinned-plant-name-legend]')
        await expect(legend).toBeVisible()
        const dock = page.locator('[data-key-region="dock"]')
        if (panelOpen) {
          await page.locator('[data-panel-rail] [data-panel="layers"]').click()
          await expect(dock).toBeVisible()
        }
        const { notice, retry } = await expectNoticeWithRetry(page)
        // The legend's enter animation lifts it into place.
        await expect.poll(async () => await legend.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
        await nextFrames(page)
        await expectRetryHit(retry)
        // The legend never stands under the open dock (the bottom sheet), where the notice and framing would keep clear
        // of a legend no one sees.
        if (panelOpen) expect(overlap(await boxOf(legend), await boxOf(dock)), 'the legend clears the dock').toBe(false)
        const noticeBox = await boxOf(notice)
        expect(overlap(noticeBox, await boxOf(legend)), 'the notice clears the legend').toBe(false)
        const atWidest = noticeBox.width >= NOTICE_MAX_WIDTH_PX - 0.5
        expect(await lineCount(notice), 'the sentence never becomes a tower of single words').toBeLessThanOrEqual(atWidest ? 2 : 3)
      })
    }
  })
}

for (const viewport of [{ width: 1024, height: 768 }, { width: 800, height: 700 }]) {
  test.describe(`${viewport.width}x${viewport.height} opening framing`, () => {
    test.use({ viewport })

    test('a Design opened while the notice shows is framed as one opened with the basemap hidden', async ({ page, context }) => {
      // input-probe.spec.ts and touch.spec.ts tap fixed places of the opening camera at 1024x768.
      // The basemap's style request is held, so "Loading basemap" shows while the Design opens and frames.
      const held = await holdBasemapStyle(page)
      await openBaseFixture(page)
      await expect(page.locator('[data-map-notice][data-tone="loading"]')).toBeVisible()
      await expect.poll(() => held.length, 'the style request is held').toBeGreaterThan(0)
      const zoomGroup = await boxOf(page.locator('[data-zoom-group]'))
      expect((await boxOf(page.locator('[data-map-notice]'))).y, 'the notice stands above the bottom row').toBeLessThan(zoomGroup.y)
      const withNotice = await openingFraming(page)
      // Released, the request reaches the offline rule, which aborts it: the notice turns to Retry, and the camera stays.
      for (const route of held) await route.fallback()
      await expectNoticeWithRetry(page)
      expect(await openingFraming(page), 'the notice turning to Retry leaves the camera where it was').toEqual(withNotice)
      // WebKit opens no file chooser from a page behind another: the second open runs alone.
      await page.close()

      const quiet = await context.newPage()
      await quiet.bringToFront()
      await openBaseFixture(quiet, { basemapHidden: true })
      await expect(quiet.locator('[data-zoom-group] button')).toHaveCount(ZOOM_GROUP_BUTTONS)
      await nextFrames(quiet)
      await expect(quiet.locator('[data-map-notice]')).toHaveCount(0)
      expect(withNotice, 'the camera the Design opens with').toEqual(await openingFraming(quiet))
    })
  })
}

test.describe('700x500 bottom sheet closing', () => {
  test.use({ viewport: { width: 700, height: 500 } })

  test('closing the bottom sheet brings the selection chip back just above the notice, not where the sheet was', async ({ page }) => {
    // The sheet's release is one measure; the notice then moves down without resizing, so nothing observes it again.
    await openBaseFixture(page)
    const { notice } = await expectNoticeWithRetry(page)
    await selectAll(page)
    const panel = page.locator('[data-panel-rail] [data-panel]').first()
    await panel.click()
    const dock = page.locator('[data-key-region="dock"]')
    await expect(dock).toBeVisible()
    await nextFrames(page)
    await panel.click()
    await expect(dock).toHaveCount(0)
    await nextFrames(page)
    const noticeBox = await boxOf(notice)
    const selection = await boxOf(page.locator('[data-selection-chip]'))
    const gap = noticeBox.y - (selection.y + selection.height)
    expect(gap, 'the selection chip stands above the notice').toBeGreaterThanOrEqual(-0.5)
    expect(gap, 'the selection chip stands just above the notice').toBeLessThanOrEqual(CHROME_INSET_PX)
  })
})

/** The zoom group's buttons once Show my location has joined it: zoom out, the scale, zoom in, Fit, Show my location and
 *  the compass. */
const ZOOM_GROUP_BUTTONS = 6

/** Opens the base fixture in a fresh browser with `locale`, and with `basemapHidden` no notice. */
async function openBaseFixture(page: Page, options: { locale?: string, basemapHidden?: boolean } = {}): Promise<void> {
  await openFixture(page, FIXTURE, options)
}

/** The base fixture with every plant's name pinned, so the legend shows; written once per test, beside its output. */
function pinnedNamesFixture(): string {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { plants: Array<{ pinned_name: boolean }> }
  for (const plant of design.plants) plant.pinned_name = true
  const path = test.info().outputPath('pinned-names.canopi')
  writeFileSync(path, JSON.stringify(design))
  return path
}

async function expectNoticeWithRetry(page: Page): Promise<{ notice: Locator, retry: Locator }> {
  const notice = page.locator('[data-map-notice][data-tone="error"]')
  const retry = notice.getByRole('button')
  await expect(retry).toBeVisible()
  // The Zoom group, Show my location included, has laid out, and the seam has placed the chrome around it.
  await expect(page.locator('[data-zoom-group] button')).toHaveCount(ZOOM_GROUP_BUTTONS)
  await nextFrames(page)
  return { notice, retry }
}

async function selectAll(page: Page): Promise<void> {
  await mapHost(page).focus()
  await pressMod(page, 'a')
  await expect(page.locator('[data-selection-chip]')).toBeVisible()
  await nextFrames(page)
}

/**
 * Where the camera opened the Design: the selection's rotate handle (above the middle of the whole Design's top edge,
 * from the camera's centre) and the map scale (its zoom). Selecting changes neither.
 */
async function openingFraming(page: Page): Promise<{ handle: { x: number, y: number }, scale: string | null }> {
  if (await page.locator('[data-selection-chip]').count() === 0) await selectAll(page)
  const handle = await boxOf(page.locator('[data-canvas-handle-glyph="rotate"]'))
  const scale = await page.locator('[data-zoom-group] button[aria-haspopup]').textContent()
  return { handle: { x: Math.round(handle.x * 4) / 4, y: Math.round(handle.y * 4) / 4 }, scale }
}

async function expectRetryHit(retry: Locator): Promise<void> {
  await expectHitAtCentre(retry, 'Retry')
}

/** The lines the notice's sentence takes: one client rect per line box of its text. */
async function lineCount(notice: Locator): Promise<number> {
  return await notice.locator('[role="status"]').evaluate((status) => {
    const range = document.createRange()
    range.selectNodeContents(status)
    return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size
  })
}
