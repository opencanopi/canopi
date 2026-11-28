// 2.1-Q118/Q120: switching Settings › Units between Metric and US customary updates live canvas readouts.
import { fileURLToPath } from 'node:url'
import { openFixture } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const RECT_ZONE_EDGE = { x: 367, y: 300 }
const RECT_ZONE_CHIP = 'Rectangle zone · 112 m² · 44 m'

test.use({ draftsKept: true })

test('Settings › Units switches the rectangle zone selection chip and scale bar to US customary', async ({ page }) => {
  await openFixture(page, FIXTURE)
  const scaleBar = page.getByRole('group', { name: 'Zoom' }).getByRole('img', { name: /^Scale bar:/ })
  const selection = page.getByRole('group', { name: 'Selection' })
  await expect(scaleBar, 'seeded metric scale bar reads in metres').toHaveText(/\bm\b/)
  await page.mouse.click(RECT_ZONE_EDGE.x, RECT_ZONE_EDGE.y)
  await expect(selection.getByRole('status'), 'seeded metric selection chip reads in m² and m').toHaveText(RECT_ZONE_CHIP)

  await page.getByRole('button', { name: 'Settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const units = settings.getByRole('radiogroup', { name: 'Units' })
  await expect(units.getByRole('radio', { name: 'Metric' })).toBeChecked()
  await units.getByRole('radio', { name: 'US customary' }).click()
  await expect(units.getByRole('radio', { name: 'US customary' })).toBeChecked()
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toHaveCount(0)

  await expect(selection.getByRole('status'), 'selection chip switches to ft² and ft').toHaveText(/^Rectangle zone · [\d,]+(?:\.\d+)? ft² · [\d,]+(?:\.\d+)? ft$/)
  await expect(scaleBar, 'scale bar switches to ft').toHaveText(/\bft\b/)
  await expect(scaleBar, 'scale bar no longer reads in metres').not.toHaveText(/\bm\b/)
})
