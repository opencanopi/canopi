// A Design opened offline, then the network comes back and the user presses Retry (ADR 0004). The map is admitted
// on its first style.load and never reloads its style: the Basemap installs on the live map through its sources and
// layers, so Retry keeps the same map, camera and drawn Design. The offline rule (../support/offline.ts) aborts the
// Basemap's style; "reconnecting" answers it in the page with a small style whose credits show once it installs.
import { fileURLToPath } from 'node:url'
import { routeMinimalBasemap } from '../support/basemap'
import { chooseFixtureFromStart } from '../support/layout'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** Marks the map canvas that opened offline, so the check can see Retry kept it. */
const OFFLINE_MAP = 'data-e2e-offline-map'

test('a Basemap that could not load offline installs on the same map after reconnecting and Retry', async ({ page }) => {
  await page.goto('')
  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)

  // Offline: the Basemap's style request is aborted, the map keeps drawing the Design and offers Retry.
  const notice = page.locator('[data-map-notice]')
  await expect(notice).toContainText('Basemap couldn’t load')
  const credits = designMap(page).locator('.maplibregl-ctrl-attrib')
  await expect(credits.getByText('OpenStreetMap')).toHaveCount(0)
  await page.locator('canvas.maplibregl-canvas').evaluate((canvas, name) => canvas.setAttribute(name, ''), OFFLINE_MAP)

  // Reconnect: page routes take precedence over the offline rule's context route.
  let styleRequests = 0
  await routeMinimalBasemap(page, { onRequest: () => { styleRequests += 1 } })
  await notice.getByRole('button', { name: 'Retry', exact: true }).click()

  await expect(page.getByText('Basemap couldn’t load')).toHaveCount(0)
  await expect(credits).toContainText('OpenStreetMap')
  expect(styleRequests, 'Retry downloaded the style once').toBe(1)
  await expect(page.locator(`[${OFFLINE_MAP}]`), 'Retry kept the map that opened offline').toHaveCount(1)
  await expect(page.locator('canvas.maplibregl-canvas'), 'no second map was built').toHaveCount(1)
  await expectCanvasDrawn(page)
})
