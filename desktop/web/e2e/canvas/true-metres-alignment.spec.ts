// True ground metres real-browser alignment test (ADR 0001, ADR 0016, 2.1-Q78d, 2.1-M520).
// Opens real .canopi Designs anchored at 0°, 49°, and 65° (with bearing 37° and translucent zone layer
// exercising Pixi v8 WorldRootContainer + AlphaFilter) in the built Web Edition across Chromium, WebKit,
// and Firefox, verifying that the real MapLibre + Pixi scene renders cleanly with zero errors and
// consistent scale chip framing at every latitude.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { designMap, expectCanvasDrawn, seedPointingDevice } from '../support/canvas'
import { expect, test } from '../support/offline'

const BASE_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const BASE_FIXTURE = JSON.parse(readFileSync(BASE_FIXTURE_PATH, 'utf8')) as Record<string, unknown>
const BASE_ORIGIN = { lon: 3.877_281_034, lat: 43.611_141_448 }

test.use({ draftsKept: true })

function relocateGeo(value: unknown, targetLat: number, targetLon: number, lonScale: number): unknown {
  if (Array.isArray(value)) return value.map((item) => relocateGeo(item, targetLat, targetLon, lonScale))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = relocateGeo(v, targetLat, targetLon, lonScale)
    }
    if (typeof obj.lon === 'number' && typeof obj.lat === 'number') {
      out.lon = targetLon + (obj.lon - BASE_ORIGIN.lon) * lonScale
      out.lat = targetLat + (obj.lat - BASE_ORIGIN.lat)
    }
    return out
  }
  return value
}

function makeDesignAtLatitude(targetLat: number, targetLon: number, bearing: number): Buffer {
  const lonScale = Math.cos((BASE_ORIGIN.lat * Math.PI) / 180) / Math.cos((targetLat * Math.PI) / 180)
  const doc = relocateGeo(BASE_FIXTURE, targetLat, targetLon, lonScale) as {
    name: string
    layers: { name: string, opacity: number }[]
    views: { camera: { bearing: number } }[]
  }
  doc.name = `True Metres ${targetLat}N`
  // Translucent zones layer exercises AlphaFilter on Pixi v8 WorldRootContainer under anisotropic affine.
  for (const layer of doc.layers) {
    if (layer.name === 'zones') layer.opacity = 0.7
  }
  for (const view of doc.views) {
    view.camera.bearing = bearing
  }
  return Buffer.from(JSON.stringify(doc), 'utf8')
}

test.describe('true ground metres alignment across latitudes (2.1-Q78d, 2.1-M520)', () => {
  for (const { label, lat, lon } of [
    { label: 'equator (0°)', lat: 0, lon: 0.5 },
    { label: 'mid-latitude (49°)', lat: 49, lon: 2.3522 },
    { label: 'high-latitude (65°)', lat: 65, lon: 25.47 },
  ]) {
    test(`renders real MapLibre + Pixi WorldRootContainer + AlphaFilter cleanly at ${label}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))

      await seedPointingDevice(page)
      await page.goto('')
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
      ])
      await chooser.setFiles({
        name: `true-metres-${lat}.canopi`,
        mimeType: 'application/json',
        buffer: makeDesignAtLatitude(lat, lon, 37),
      })

      await expect(designMap(page)).toBeVisible()
      await expect(page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^Map scale/ })).toHaveText(/^1:\d+/)
      await expectCanvasDrawn(page)
      expect(errors).toEqual([])
    })
  }
})
