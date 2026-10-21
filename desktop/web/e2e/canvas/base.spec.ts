// The base scenario of the Web Edition browser checks (canvas v2 plan section 3.2): open the
// base fixture through the file chooser, pan, zoom, Present, PDF. Every later phase runs it.
// Real input only: page.mouse and page.keyboard (locator clicks are real mouse clicks too).
// Screenshots are taken on settled states only, never mid-drag or mid-flight, and of the canvas
// only once it has drawn the change the DOM checks saw (expectCanvasDrawn).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

// The baselines show the title bar's save status; Drafts kept, as persistence is not this spec's subject (canopi-eon8.15.1).
test.use({ draftsKept: true })
/** Empty map, away from every object and chrome of the fixture's opening camera. */
const NEUTRAL = { x: 800, y: 450 }
/** A point on the left edge of the fixture's rectangle zone (14 m x 8 m) at the opening camera. */
const RECT_ZONE_EDGE = { x: 367, y: 300 }
const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44 m'

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
  ])
  await chooser.setFiles(FIXTURE)
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

function selectionChip(page: Page) {
  return page.getByRole('group', { name: 'Selection' }).getByRole('status')
}

/**
 * Centre of the selected zone's first control point, in page pixels. Read in one pass in the
 * page: the overlay rebuilds its handles on every refresh, and a handle found in one call could
 * be replaced before a second call measures it.
 */
async function zoneCorner(page: Page): Promise<{ x: number, y: number }> {
  const [corner] = await page.getByRole('button', { name: 'Zone control point 1' }).evaluateAll((handles) => handles.map((handle) => {
    const box = handle.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }))
  if (!corner) throw new Error('no zone is selected: "Zone control point 1" is not shown')
  return corner
}

/** Selects the rectangle zone by its edge, reads its first corner, then clears the selection. */
async function rectZoneCornerAt(page: Page, edge: { x: number, y: number }): Promise<{ x: number, y: number }> {
  await page.mouse.click(edge.x, edge.y)
  await expect(selectionChip(page), 'the click on the rectangle zone edge selects it').toHaveText(RECT_ZONE_CHIP)
  const corner = await zoneCorner(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: 'Selection' })).toHaveCount(0)
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
  return corner
}

test('open, pan, zoom, Present and PDF', async ({ page }) => {
  await test.step('open the base fixture through the file chooser', async () => {
    await openBaseFixture(page)
    await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Undo' })).toBeDisabled()
    await expect(page).toHaveScreenshot('base-01-opened.png')
  })

  await test.step('a middle-button drag pans the map 200 px', async () => {
    const before = await rectZoneCornerAt(page, RECT_ZONE_EDGE)
    await page.mouse.move(500, 620)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(700, 620, { steps: 10 })
    await page.mouse.up({ button: 'middle' })
    await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
    await expect(scaleChip(page), 'a pan keeps the scale').toHaveText('1:240')
    await expectCanvasDrawn(page)
    await expect(page).toHaveScreenshot('base-02-panned.png')
    const after = await rectZoneCornerAt(page, { x: RECT_ZONE_EDGE.x + 200, y: RECT_ZONE_EDGE.y })
    // Both engines lay boxes out in 1/64 px units, so the measure allows 1/16 px.
    expect(Math.abs(after.x - before.x - 200), 'the zone moved with the map, 200 px right').toBeLessThanOrEqual(1 / 16)
    expect(Math.abs(after.y - before.y), 'a horizontal drag does not move the map vertically').toBeLessThanOrEqual(1 / 16)
    await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Undo' }), 'panning never edits the Design').toBeDisabled()
  })

  await test.step('the wheel zooms in', async () => {
    await page.mouse.wheel(0, -300)
    await expect(scaleChip(page)).not.toHaveText('1:240')
    const denominator = Number((await scaleChip(page).textContent())?.replace(/^1:/, '').replace(/[^\d]/g, ''))
    expect(denominator, 'wheel up zooms in (a smaller scale denominator)').toBeLessThan(240)
    await expectCanvasDrawn(page)
    await expect(page).toHaveScreenshot('base-03-zoomed.png')
  })

  await test.step('Present the story', async () => {
    await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
    await expect(page.getByRole('list', { name: 'Steps of Tour' }).getByRole('button', { name: 'Step 1: Overview' })).toBeVisible()
    // Presenting flies the camera to the step's view (a MapLibre flight), and the canvas is never
    // busy for a camera frame, so nothing could say when the flight has ended. Under reduced
    // motion the camera jumps there instead, and the screenshot shows where it lands.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Present' }).click()
    const presentation = page.getByRole('dialog', { name: 'Presenting Tour' })
    await expect(presentation).toBeVisible()
    await expect(presentation.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(presentation.getByRole('status').filter({ hasText: /^Step \d/ })).toHaveText('Step 1 of 1: Overview')
    await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
    await expectCanvasDrawn(page)
    await expect(page).toHaveScreenshot('base-04-present.png')
    await presentation.getByRole('button', { name: 'Leave presentation' }).click()
    await expect(presentation).toBeHidden()
    await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible()
    await page.emulateMedia({ reducedMotion: null })
  })

  await test.step('export the planting plan as a PDF, then go back to the Design', async () => {
    await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
    await page.getByRole('menuitem', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: 'Planting plan (PDF)…' }).click()
    const workspace = page.getByRole('dialog', { name: 'Export to PDF' })
    await expect(workspace).toBeVisible()
    await expect(workspace.getByRole('status').filter({ hasText: /^Page 1 of 1$/ })).toBeVisible()
    await page.mouse.move(NEUTRAL.x, NEUTRAL.y)
    await expect(page).toHaveScreenshot('base-05-pdf.png')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      workspace.getByRole('button', { name: /^Save PDF/ }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.pdf$/)
    const pdf = await readFile(await download.path())
    expect(pdf.byteLength, 'the saved PDF is not empty').toBeGreaterThan(0)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    await workspace.getByRole('button', { name: '← Back to the Design' }).click()
    await expect(workspace).toBeHidden()
    await expect(designMap(page)).toBeVisible()
    await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible()
  })
})
