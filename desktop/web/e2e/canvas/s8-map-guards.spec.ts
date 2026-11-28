// S8 real-browser guards (docs/plans/2-1-foundations.md, 2d-1):
//   1. A map contribution change while Retry is in progress completes cleanly without crashing or dropping the map.
//   2. Presenting a story step and switching to another Design cleanly ends the story overrides and leaves the new
//      Design interactive with no leaked story presentation state.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { BASEMAP_STYLE_URL, minimalBasemapStyle } from '../support/basemap'
import { chooseFixtureFromStart } from '../support/layout'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

async function openFixture(page: Page): Promise<void> {
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)
}

test('S8 guard: changing a map contribution while Retry is in flight keeps the map healthy', async ({ page }) => {
  await openFixture(page)
  const notice = page.locator('[data-map-notice]')
  await expect(notice).toContainText('Basemap couldn’t load')

  // Hold the Retry style request so we can toggle a map contribution mid-Retry.
  let releaseRetry!: () => void
  const held = new Promise<void>((resolve) => { releaseRetry = resolve })
  await page.route(BASEMAP_STYLE_URL, async (route) => {
    await held
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(minimalBasemapStyle({ attribution: null })),
    })
  })

  await notice.getByRole('button', { name: 'Retry', exact: true }).click()

  // While Retry is in flight, open Layers and change a real map background contribution (switch to None then back to Street map).
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Layers' }).click()
  const noneRadio = page.getByRole('radio', { name: /None/i })
  await expect(noneRadio).toBeVisible()
  await noneRadio.click()
  const streetMapRadio = page.getByRole('radio', { name: /Street map/i })
  await streetMapRadio.click()

  releaseRetry()
  await expect(page.getByText('Basemap couldn’t load')).toHaveCount(0)
  await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1)
  await expectCanvasDrawn(page)
})

test('S8 guard: a story step override is applied while presenting and does not leak across leave or Design switch', async ({ page }) => {
  await openFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })

  // Set Background to None before presenting; the offline basemap notice clears.
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Layers' }).click()
  const noneRadio = page.getByRole('radio', { name: /None/i })
  await expect(noneRadio).toBeVisible()
  await noneRadio.click()
  await expect(noneRadio).toBeChecked()
  await expect(page.locator('[data-map-notice]')).toHaveCount(0)

  // Present the Tour story: its step overrides background to Street map (liberty), which triggers the offline notice
  // inside the presenter — proving the step's map override is genuinely live on the real MapLibre map.
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
  await page.getByRole('button', { name: 'Present' }).click()
  const presentation = page.getByRole('dialog', { name: 'Presenting Tour' })
  await expect(presentation).toBeVisible()
  await expect(presentation).toContainText('Basemap couldn’t load')

  // Web Edition's BrowserAppShell is inert while the modal presenter is open (the direct Design-replacement path
  // without leaving first is covered in story-presentation.test.tsx). Leave the presenter and verify the step's
  // background override clears immediately before switching to a new Design.
  await page.keyboard.press('Escape')
  await expect(presentation).toHaveCount(0)
  await expect(page.locator('[data-map-notice]')).toHaveCount(0)

  // Switch Design via File › New Design and verify no story presentation state or background override leaked.
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New Design' }).click()
  await page.getByRole('button', { name: /Skip, I’ll find it on the map/i }).click()
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)
  await expect(page.locator('[data-story-presenter]')).toHaveCount(0)
  await expect(page.locator('[data-map-notice]')).toHaveCount(0)
  await expect(designMap(page).locator('canvas.maplibregl-canvas')).toHaveCount(1)
  await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Layers' }).click()
  await expect(page.getByRole('radio', { name: /None/i })).toBeChecked()
})
