// Satellite with the user's Google key, through the real MapLibre map (canopi-k94s): a key Google rejects shows the
// map notice with Retry instead of a map that silently loses its imagery, and Retry with Google answering brings the
// imagery back on the same map. Google's Map Tiles API is answered in the page (page routes take precedence over the
// offline rule's context route, ../support/offline.ts); every answer carries `access-control-allow-origin: *`, which
// both engines need for the provider's CORS requests (probe P-B1). The test key must never reach the console, and the
// key or a session may only ever travel to tile.googleapis.com.
import { fileURLToPath } from 'node:url'
import type { Route } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { chooseFixtureFromStart } from '../support/layout'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** The Web Edition's settings record (web/browser-app-data.ts). */
const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'
const TEST_KEY = 'AIzaTestKeyNeverLogged-0123456789'
const GOOGLE = 'https://tile.googleapis.com/'
const COPYRIGHT = 'Imagery ©2026 Test Google'
/** A 1x1 PNG: any tile Google is asked for. */
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const CORS = { 'access-control-allow-origin': '*' }
/** Marks the map canvas that showed the failure, so the check can see Retry kept it. */
const FAILED_MAP = 'data-e2e-satellite-failed-map'

test.use({
  forbiddenText: [TEST_KEY],
  // Exact lines: the browser's own line for Google's 403 (its text names no URL in either engine, probe P-B3), and
  // the provider's log, which names the status only.
  expectedConsoleLines: [
    'Failed to load resource: the server responded with a status of 403 (Forbidden)',
    'Satellite session request failed (HTTP 403).',
  ],
})

test('a rejected Google key shows the Satellite notice, and Retry brings the imagery back on the same map', async ({ page, context }) => {
  const credentialled: string[] = []
  context.on('request', (request) => {
    const url = request.url()
    if (/[?&](key|session)=/.test(url)) credentialled.push(url)
  })
  let googleAnswers = false
  const fulfilled: Record<string, string>[] = []
  const answer = (route: Route, response: Parameters<Route['fulfill']>[0] & object) => {
    fulfilled.push({ ...CORS, ...response.headers })
    return route.fulfill({ ...response, headers: { ...CORS, ...response.headers } })
  }
  await page.route(`${GOOGLE}**`, (route) => {
    const url = route.request().url()
    if (!googleAnswers) {
      return answer(route, { status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 403 } }) })
    }
    if (url.includes('/v1/createSession')) {
      return answer(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ session: 'test-session', expiry: '9999999999', tileWidth: 256 }) })
    }
    if (url.includes('/v1/viewport')) {
      return answer(route, {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ copyright: COPYRIGHT, maxZoomRects: [{ maxZoom: 21, north: 90, south: -90, east: 180, west: -180 }] }),
      })
    }
    return answer(route, { status: 200, contentType: 'image/png', body: TILE })
  })

  // Satellite on, the Basemap hidden beneath it; the key goes in through Settings › Map and imagery.
  await page.addInitScript(({ key }) => {
    localStorage.clear()
    localStorage.setItem(key, JSON.stringify({ version: 3, settings: { locale: 'en', satellite_visible: true } }))
  }, { key: SETTINGS_KEY })
  await page.goto('')
  await page.locator('[data-start-screen]').getByRole('button', { name: 'Settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.locator('[data-settings-section="map"]').click()
  await settings.getByRole('radio', { name: 'My Google key' }).click()
  await settings.locator('[data-google-key-input]').fill(TEST_KEY)
  await settings.getByRole('button', { name: 'Save key' }).click()
  await settings.getByRole('button', { name: 'Close' }).click()

  await chooseFixtureFromStart(page, FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)

  // Google rejects the key: the notice names Satellite, offers Retry, and the Design stays drawn.
  const notice = page.locator('[data-map-notice]')
  await expect(notice).toContainText('Satellite imagery couldn’t load. Check your connection or your Google key in Settings.')
  const credits = designMap(page).locator('.maplibregl-ctrl-attrib')
  await expect(credits).not.toContainText(COPYRIGHT)
  await page.locator('canvas.maplibregl-canvas').evaluate((canvas, name) => canvas.setAttribute(name, ''), FAILED_MAP)

  // Google answers again; Retry opens a new session on the same map.
  googleAnswers = true
  await notice.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('Satellite imagery couldn’t load')).toHaveCount(0)
  await expect(credits).toContainText(COPYRIGHT)
  await expect(page.locator(`[${FAILED_MAP}]`), 'Retry kept the map').toHaveCount(1)
  await expect(page.locator('canvas.maplibregl-canvas'), 'no second map was built').toHaveCount(1)
  await expect.poll(() => credentialled.some((url) => url.includes('/v1/2dtiles/')), 'the imagery tiles were asked for').toBe(true)
  await expectCanvasDrawn(page)

  // The key and the session only ever travel to Google's tile API, and every answer allowed the page's origin.
  expect(credentialled.length).toBeGreaterThan(0)
  expect(credentialled.filter((url) => !url.startsWith(GOOGLE))).toEqual([])
  expect(fulfilled.every((headers) => headers['access-control-allow-origin'] === '*')).toBe(true)
})
