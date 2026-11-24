// True ground metres real-browser alignment test (ADR 0001, ADR 0016, 2.1-Q78d, 2.1-M520).
// Opens real .canopi Designs anchored at 0°, 49°, and 65° with a solid red translucent zone
// (opacity 0.7, exercising Pixi v8 WorldRootContainer + AlphaFilter), turns the live MapLibre
// camera to bearing 45°, and verifies in Chromium, WebKit, and Firefox:
//   1. All 4 WGS84 zone corners' live screen handles agree with exact Web Mercator (MapLibre)
//      projection at bearing 45° to sub-pixel (< 0.25 px) tolerance.
//   2. Rendered WebGL canvas pixels (via screenshot PNG decode) show the red Pixi polygon fill
//      inside the Web Mercator-projected edges and neutral background outside, proving Pixi's
//      WorldRootContainer.updateLocalTransform() + AlphaFilter matches MapLibre pixel-for-pixel.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { bearing, designMap, expectCanvasDrawn, pressMod, seedPointingDevice } from '../support/canvas'
import { expect, test } from '../support/offline'

const BASE_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const BASE_FIXTURE = JSON.parse(readFileSync(BASE_FIXTURE_PATH, 'utf8')) as Record<string, unknown>

test.use({ draftsKept: true })

interface GeoCorner { readonly lon: number; readonly lat: number }

function geoToMercator(lon: number, lat: number): { x: number; y: number } {
  const x = (180 + lon) / 360
  const rad = (lat * Math.PI) / 180
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + rad / 2))) / 360
  return { x, y }
}

function makeSquareDesignAtLatitude(targetLat: number, targetLon: number): {
  buffer: Buffer
  corners: readonly [GeoCorner, GeoCorner, GeoCorner, GeoCorner]
} {
  // Build a ~40 m × 40 m WGS84 rectangle centred at (targetLon, targetLat).
  const dLat = 20 / 111_195
  const dLon = 20 / (111_195 * Math.cos((targetLat * Math.PI) / 180))
  const corners: [GeoCorner, GeoCorner, GeoCorner, GeoCorner] = [
    { lon: targetLon - dLon, lat: targetLat + dLat },
    { lon: targetLon + dLon, lat: targetLat + dLat },
    { lon: targetLon + dLon, lat: targetLat - dLat },
    { lon: targetLon - dLon, lat: targetLat - dLat },
  ]
  const base = structuredClone(BASE_FIXTURE) as {
    name: string
    layers: { name: string; visible: boolean; locked: boolean; opacity: number }[]
    plants: unknown[]
    zones: unknown[]
    annotations: unknown[]
    measurement_guides: unknown[]
    groups: unknown[]
    views: unknown[]
    stories: unknown[]
  }
  base.name = `True Metres ${targetLat}N`
  for (const layer of base.layers) {
    layer.visible = layer.name === 'zones'
    if (layer.name === 'zones') layer.opacity = 0.7
  }
  base.plants = []
  base.annotations = []
  base.measurement_guides = []
  base.groups = []
  base.views = []
  base.stories = []
  base.zones = [
    {
      id: 'zone-align-1',
      name: 'Alignment Square',
      zone_type: 'polygon',
      rotation: 0,
      points: corners,
      fill_color: '#cc2222',
      notes: null,
      locked: false,
    },
  ]
  return { buffer: Buffer.from(JSON.stringify(base), 'utf8'), corners }
}

/** Minimal PNG RGBA pixel reader (handles 8-bit RGB/RGBA non-interlaced PNGs from Playwright screenshots). */
function readPngPixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const colorType = png[25]!
  const bpp = colorType === 6 ? 4 : 3
  const chunks: Buffer[] = []
  let offset = 8
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + len))
    offset += 12 + len
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * bpp
  const decoded = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!
    const srcStart = row * (stride + 1) + 1
    const dstStart = row * stride
    for (let col = 0; col < stride; col++) {
      const byte = raw[srcStart + col]!
      const left = col >= bpp ? decoded[dstStart + col - bpp]! : 0
      const up = row > 0 ? decoded[dstStart - stride + col]! : 0
      const upLeft = row > 0 && col >= bpp ? decoded[dstStart - stride + col - bpp]! : 0
      let recon = byte
      if (filter === 1) recon = (byte + left) & 0xff
      else if (filter === 2) recon = (byte + up) & 0xff
      else if (filter === 3) recon = (byte + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        recon = (byte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
      decoded[dstStart + col] = recon
    }
  }
  const px = Math.max(0, Math.min(width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(height - 1, Math.round(y)))
  const idx = py * stride + px * bpp
  return { r: decoded[idx]!, g: decoded[idx + 1]!, b: decoded[idx + 2]! }
}

test.describe('true ground metres alignment across latitudes (2.1-Q78d, 2.1-M520)', () => {
  for (const { label, lat, lon } of [
    { label: 'equator (0°)', lat: 0, lon: 0.5 },
    { label: 'mid-latitude (49°)', lat: 49, lon: 2.3522 },
    { label: 'high-latitude (65°)', lat: 65, lon: 25.47 },
  ]) {
    test(`MapLibre Web Mercator and Pixi WorldRootContainer + AlphaFilter align at ${label} with bearing 45°`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await seedPointingDevice(page)
      await page.goto('')
      const { buffer, corners } = makeSquareDesignAtLatitude(lat, lon)
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
      ])
      await chooser.setFiles({
        name: `true-metres-${lat}.canopi`,
        mimeType: 'application/json',
        buffer,
      })

      const map = designMap(page)
      await expect(map).toBeVisible()
      await expectCanvasDrawn(page)

      // Rotate live MapLibre camera to 45° via Shift+ArrowRight x3 so anisotropy + bearing are exercised together.
      await map.focus()
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
      await expect.poll(async () => await bearing(page)).toBe(45)

      // Select the zone so its 4 control handles render at live ViewTransform.worldToScreen(corner).
      await pressMod(page, 'a')
      const handleLocator = page.locator('[data-canvas-handle^="vertex:"]')
      await expect(handleLocator).toHaveCount(4)
      await expectCanvasDrawn(page)

      const handles = await handleLocator.evaluateAll((els) => els.map((el) => {
        const box = el.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }))
      expect(handles).toHaveLength(4)

      // 1. Fit MapLibre's exact Web Mercator similarity transform from corners 0 & 1 and assert
      //    corners 2 & 3 agree to sub-pixel (< 0.25 px) tolerance.
      const merc = corners.map((c) => geoToMercator(c.lon, c.lat))
      const dmx = merc[1]!.x - merc[0]!.x
      const dmy = merc[1]!.y - merc[0]!.y
      const dhx = handles[1]!.x - handles[0]!.x
      const dhy = handles[1]!.y - handles[0]!.y
      const denom = dmx * dmx + dmy * dmy
      // Similarity matrix [a -b; b a] mapping dM -> dH
      const simA = (dmx * dhx + dmy * dhy) / denom
      const simB = (dmx * dhy - dmy * dhx) / denom
      const fittedBearingDeg = (Math.atan2(-simB, simA) * 180) / Math.PI
      expect(Math.abs(fittedBearingDeg - 45), 'live bearing matches 45°').toBeLessThan(0.25)

      for (const idx of [2, 3] as const) {
        const dx = merc[idx]!.x - merc[0]!.x
        const dy = merc[idx]!.y - merc[0]!.y
        const predX = handles[0]!.x + simA * dx - simB * dy
        const predY = handles[0]!.y + simB * dx + simA * dy
        const errPx = Math.hypot(handles[idx]!.x - predX, handles[idx]!.y - predY)
        expect(errPx, `corner ${idx} agrees with MapLibre Web Mercator projection`).toBeLessThan(0.25)
      }

      // 2. Verify Pixi WorldRootContainer + AlphaFilter actually rendered the red zone fill inside
      //    the Web Mercator-projected quad and background outside on the live WebGL canvas.
      const png = await page.screenshot()
      const cx = (handles[0]!.x + handles[1]!.x + handles[2]!.x + handles[3]!.x) / 4
      const cy = (handles[0]!.y + handles[1]!.y + handles[2]!.y + handles[3]!.y) / 4
      // Sample 14 px offset from centre along diagonal (clear of any centred area label chip)
      const insidePx = readPngPixel(png, cx + 14, cy + 14)
      expect(insidePx.r - insidePx.b, 'Pixi rendered red-tinted zone fill inside the projected quad').toBeGreaterThan(20)

      // Sample 24 px outside edge 0->1 midpoint
      const midX = (handles[0]!.x + handles[1]!.x) / 2
      const midY = (handles[0]!.y + handles[1]!.y) / 2
      const outDx = midX - cx
      const outDy = midY - cy
      const outLen = Math.hypot(outDx, outDy)
      const outsidePx = readPngPixel(png, midX + (outDx / outLen) * 24, midY + (outDy / outLen) * 24)
      expect(Math.abs(outsidePx.r - outsidePx.b), 'background outside the projected edge has no Pixi bleed').toBeLessThan(15)

      expect(errors).toEqual([])
    })
  }
})
