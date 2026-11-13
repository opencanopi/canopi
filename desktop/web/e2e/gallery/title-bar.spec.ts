// The Desktop title bar's space at the Desktop default window, 1280 x 800 (R1 canopi-f47t.52.270): a Design a newer
// Canopi saved shows its read-only save status in words beside Update (2.1-Q317), never squeezed to its icon. Geometry
// only, no baselines: each engine lays out its own fonts, as the real app does on WebKitGTK and WebView2.
import { expect, openGallery, test } from '../support/gallery'

test.use({ viewport: { width: 1280, height: 800 } })

test('R1 canopi-f47t.52.270: the read-only save status keeps its whole label beside Update in the Desktop title bar at 1280 px', async ({ page }) => {
  await openGallery(page, { surface: 'workspace', session: 'read-only' })
  const status = page.locator('[data-workspace-title-bar] [data-save-status]')
  await expect(status.getByRole('button', { name: 'Update' })).toBeVisible()
  const label = status.getByRole('button', { name: 'Read-only: saved by a newer Canopi' }).locator('span')
  await expect(label).toBeVisible()
  const { clientWidth, scrollWidth } = await label.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(clientWidth, 'the label has room').toBeGreaterThan(0)
  expect(scrollWidth, 'the label is not cut short').toBeLessThanOrEqual(clientWidth)
})
