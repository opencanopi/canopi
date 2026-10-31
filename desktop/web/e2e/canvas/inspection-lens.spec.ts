// The inspection lens (canopi-n54g; design check fixes20-dc-lens): it opens in the tool card's slot and draws above the
// armed tool's card (the user's call, 2026-10-14, reversing U58), so its title, close button and preview take the
// pointer wherever the card would cover them, even under Place plants' tall species chooser. A hollow crosshair marks
// the preview's centre, the inspected point, after a hover over the map. Chromium, WebKit and Firefox, 1440x900 (icon and named
// rail) and 1024x768; DOM assertions only, no baselines.
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { boxOf, expectHitAtCentre, mapHost, openFixture, overlap } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

const LAYOUTS = [
  { width: 1440, height: 900, namedRail: false },
  { width: 1440, height: 900, namedRail: true },
  { width: 1024, height: 768, namedRail: false },
] as const

function lens(page: Page): Locator {
  return page.locator('#canopi-inspection-lens')
}

async function openLens(page: Page): Promise<void> {
  const launcher = page.locator('[data-inspection-launcher]')
  await launcher.click()
  await expect(launcher, 'the inspection lens is open').toBeHidden()
  await expect(lens(page)).toBeVisible()
}

/**
 * Points of the lens the card covers too, inset from their shared box by the larger corner radius of the two: each
 * reaches the lens. Firefox clips hit-testing to border-radius, so a point nearer a rounded corner than its radius can
 * miss both boxes and reach the map below.
 */
async function expectLensOnTopOfCard(page: Page, tool: string): Promise<void> {
  const card = page.locator('[data-tool-card]').first()
  await expect(card).toBeVisible()
  const lensBox = await boxOf(lens(page))
  const cardBox = await boxOf(card)
  expect(overlap(lensBox, cardBox), `${tool}: the card shares the lens's slot`).toBe(true)
  const radiusOf = (element: Element) => {
    const style = getComputedStyle(element)
    return Math.max(...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map((value) => parseFloat(value) || 0))
  }
  const inset = Math.max(await lens(page).evaluate(radiusOf), await card.evaluate(radiusOf), 4)
  const left = Math.max(lensBox.x, cardBox.x) + inset
  const top = Math.max(lensBox.y, cardBox.y) + inset
  const right = Math.min(lensBox.x + lensBox.width, cardBox.x + cardBox.width) - inset
  const bottom = Math.min(lensBox.y + lensBox.height, cardBox.y + cardBox.height) - inset
  const misses = await lens(page).evaluate((element, points) => points.flatMap(([x, y]) => {
    const hit = document.elementFromPoint(x!, y!)
    return hit && element.contains(hit) ? [] : [`(${Math.round(x!)}, ${Math.round(y!)}) hits ${hit?.tagName}.${String(hit?.className)}`]
  }), [[left, top], [right, top], [left, bottom], [right, bottom], [(left + right) / 2, (top + bottom) / 2]])
  expect(misses, `${tool}: the lens is above the card where they meet`).toEqual([])
  await expectHitAtCentre(lens(page).locator('h2'), `${tool}: the lens's title`)
  await expectHitAtCentre(lens(page).getByRole('button', { name: 'Close inspection lens' }), `${tool}: the lens's close button`)
  await expectHitAtCentre(lens(page).locator('[data-inspection-frame]'), `${tool}: the lens's preview`)
}

for (const layout of LAYOUTS) {
  test.describe(`${layout.width}x${layout.height}${layout.namedRail ? ', named rail' : ''}`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height } })

    test('the lens draws above the tool card, Place plants\' chooser included', async ({ page }) => {
      await openFixture(page, FIXTURE, { settings: { tool_names_visible: layout.namedRail } })
      await openLens(page)
      await expectLensOnTopOfCard(page, 'Select')
      await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: /^Place plants/ }).click()
      await expect(page.locator('[data-tool-card]').first()).toHaveAttribute('data-tool-card', 'plant-stamp')
      await expectLensOnTopOfCard(page, 'Place plants with its chooser')
    })

    test('a crosshair marks the preview\'s centre, the inspected point', async ({ page }) => {
      await openFixture(page, FIXTURE, { settings: { tool_names_visible: layout.namedRail } })
      await openLens(page)
      const map = await boxOf(mapHost(page))
      await page.mouse.move(map.x + map.width * 0.6, map.y + map.height * 0.5)
      await page.mouse.move(map.x + map.width * 0.6 + 8, map.y + map.height * 0.5 + 8, { steps: 2 })
      const centre = lens(page).locator('[data-inspection-frame] [data-inspection-centre]')
      await expect(centre).toHaveCount(1)
      const frame = await boxOf(lens(page).locator('[data-inspection-frame]'))
      const mark = await boxOf(centre)
      expect(Math.abs(mark.x + mark.width / 2 - (frame.x + frame.width / 2)), 'centred across').toBeLessThanOrEqual(1.5)
      expect(Math.abs(mark.y + mark.height / 2 - (frame.y + frame.height / 2)), 'centred down').toBeLessThanOrEqual(1.5)
      expect(await centre.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const hit = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return hit.some((node) => node.closest('[data-plant-id]') !== null)
      }), 'no plant name sits on the centre').toBe(false)
    })
  })
}
