// True ground metres real-browser alignment test (ADR 0001, ADR 0016, 2.1-Q78d, 2.1-M520).
// Opens real .canopi Designs anchored at 0°, 49°, and 65° with a solid red translucent zone
// (opacity 0.7, exercising Pixi v8 WorldRootContainer + AlphaFilter), turns the live MapLibre
// camera to bearing 45°, and verifies in Chromium, WebKit, and Firefox:
//   1. Real MapLibre `map.project(corner)` agrees with the rendered Pixi WebGL fill edge found
//      along perpendicular PNG scanlines on all 4 edges to < 1.0 px.
//   2. Real MapLibre `map.project(corner)` agrees with all 4 DOM vertex handles to < 0.25 px.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { bearing, designMap, expectCanvasDrawn, pressMod, seedPointingDevice } from '../support/canvas'
import { chooseFixtureFromStart, nextFrames } from '../support/layout'
import { expect, test } from '../support/offline'

const BASE_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const BASE_FIXTURE = JSON.parse(readFileSync(BASE_FIXTURE_PATH, 'utf8')) as Record<string, unknown>

test.use({ draftsKept: true, viewport: { width: 1400, height: 1000 } })

interface GeoCorner { readonly lon: number; readonly lat: number }
interface ScreenPt { readonly x: number; readonly y: number }

function makeRectDesignAtLatitude(targetLat: number, targetLon: number): {
  buffer: Buffer
  corners: readonly [GeoCorner, GeoCorner, GeoCorner, GeoCorner]
} {
  // ~100 m (E-W) x 50 m (N-S) WGS84 rectangle centred at (targetLon, targetLat).
  // At 1400x1000 and bearing 45°, the long axis spans ~900 px so WGS84 anisotropy at 0°
  // (~0.674% E-W vs N-S) creates a > 1.5 px error if Pixi's world root regresses to a similarity.
  const halfNsDeg = 25 / 111_195
  const halfEwDeg = 50 / (111_195 * Math.cos((targetLat * Math.PI) / 180))
  const corners: [GeoCorner, GeoCorner, GeoCorner, GeoCorner] = [
    { lon: targetLon - halfEwDeg, lat: targetLat + halfNsDeg },
    { lon: targetLon + halfEwDeg, lat: targetLat + halfNsDeg },
    { lon: targetLon + halfEwDeg, lat: targetLat - halfNsDeg },
    { lon: targetLon - halfEwDeg, lat: targetLat - halfNsDeg },
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
      name: '',
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

/**
 * Intercepts the bundled MapLibre ES module chunk in test-only network routing so we can
 * capture the live `maplibregl.Map` instance and call real `map.project([lon, lat])`
 * without adding any test hook to production code.
 */
async function installMapLibreInstanceProbe(page: Page): Promise<void> {
  await page.route(/\/assets\/maplibre-gl-(?!worker)[^/]+\.js$/, async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const match = /export\{([^}]+)\};?\s*$/.exec(body)
    if (!match) {
      await route.fulfill({ response, body })
      return
    }
    const entries = match[1]!.split(',').map((s) => s.trim()).filter(Boolean)
    const wrappers = entries.map((entry, idx) => {
      const [local] = entry.split(/\s+as\s+/)
      return `const __ml${idx}=(${local}&&typeof ${local}.Map==="function")?Object.assign(Object.create(Object.getPrototypeOf(${local})),${local},{Map:class extends ${local}.Map{constructor(...a){super(...a);(window.__canopiTestMaps??=[]).push(this)}}}):${local};`
    }).join('')
    const reexport = `export{${entries.map((entry, idx) => {
      const parts = entry.split(/\s+as\s+/)
      return `__ml${idx} as ${parts[1] ?? parts[0]}`
    }).join(',')}};`
    await route.fulfill({ response, body: body.slice(0, match.index) + wrappers + reexport })
  })
}

/** Calls real `map.project([lon, lat])` on the live MapLibre instance and converts to page CSS coordinates. */
async function projectCornersWithMapLibre(page: Page, corners: readonly GeoCorner[]): Promise<ScreenPt[]> {
  return await page.evaluate((pts) => {
    const maps = (window as unknown as {
      __canopiTestMaps?: Array<{
        getContainer(): HTMLElement
        project(lngLat: [number, number]): { x: number; y: number }
      }>
    }).__canopiTestMaps
    const map = maps?.[maps.length - 1]
    if (!map) throw new Error('MapLibre Map instance was not captured by installMapLibreInstanceProbe')
    const rect = map.getContainer().getBoundingClientRect()
    return pts.map((pt) => {
      const projected = map.project([pt.lon, pt.lat])
      return { x: rect.left + projected.x, y: rect.top + projected.y }
    })
  }, corners)
}

interface DecodedPng {
  readonly width: number
  readonly height: number
  readonly bpp: number
  readonly stride: number
  readonly data: Buffer
}

/** Minimal 8-bit RGB/RGBA non-interlaced PNG decoder for Playwright screenshots. */
function decodePng(png: Buffer): DecodedPng {
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
  const data = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!
    const srcStart = row * (stride + 1) + 1
    const dstStart = row * stride
    for (let col = 0; col < stride; col++) {
      const byte = raw[srcStart + col]!
      const left = col >= bpp ? data[dstStart + col - bpp]! : 0
      const up = row > 0 ? data[dstStart - stride + col]! : 0
      const upLeft = row > 0 && col >= bpp ? data[dstStart - stride + col - bpp]! : 0
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
      data[dstStart + col] = recon
    }
  }
  return { width, height, bpp, stride, data }
}

/** Bilinear RGB sample at fractional PNG pixel `(x, y)`. */
function rgbAt(img: DecodedPng, x: number, y: number): { r: number; g: number; b: number } {
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(x)))
  const y0 = Math.max(0, Math.min(img.height - 2, Math.floor(y)))
  const fx = Math.max(0, Math.min(1, x - x0))
  const fy = Math.max(0, Math.min(1, y - y0))
  const ch = (c: number) => {
    const p = (px: number, py: number) => img.data[py * img.stride + px * img.bpp + c]!
    return (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy)
      + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy
  }
  return { r: ch(0), g: ch(1), b: ch(2) }
}

/**
 * Scans along the outward normal from `(midX, midY)` at `s in [-12, +12]` px (step 0.25 px)
 * and returns the signed offset `s` (in CSS px) of the rendered Pixi zone border stroke
 * centreline (the dark `zone-stroke` trough in luminance), while also confirming the red
 * translucent fill (`r - b`) sits strictly inside (`s = -12`) and neutral background outside (`s = +12`).
 */
function findZoneEdgeOffsetPx(
  img: DecodedPng,
  midX: number,
  midY: number,
  nx: number,
  ny: number,
): number {
  const inRgb = rgbAt(img, midX - nx * 12, midY - ny * 12)
  const outRgb = rgbAt(img, midX + nx * 12, midY + ny * 12)
  expect((inRgb.r - inRgb.b) - (outRgb.r - outRgb.b), 'Pixi red fill inside vs neutral background outside').toBeGreaterThan(15)
  const baselineLuma = Math.min(inRgb.r + inRgb.g + inRgb.b, outRgb.r + outRgb.g + outRgb.b)
  const step = 0.25
  const samples: Array<{ s: number; luma: number }> = []
  let minLuma = Infinity
  for (let s = -6; s <= 6; s += step) {
    const c = rgbAt(img, midX + nx * s, midY + ny * s)
    const luma = c.r + c.g + c.b
    samples.push({ s, luma })
    if (luma < minLuma) minLuma = luma
  }
  expect(baselineLuma - minLuma, 'visible dark zone border stroke on Pixi edge').toBeGreaterThan(20)
  // Centroid of the dark stroke trough below midpoint(minLuma, baselineLuma) locates the exact stroke centreline.
  const threshold = minLuma + (baselineLuma - minLuma) * 0.5
  let sumW = 0
  let sumWS = 0
  for (const { s, luma } of samples) {
    if (luma <= threshold) {
      const w = threshold - luma
      sumW += w
      sumWS += w * s
    }
  }
  if (sumW <= 0) throw new Error(`No zone border stroke trough found near (${midX.toFixed(1)}, ${midY.toFixed(1)})`)
  return sumWS / sumW
}

test.describe('true ground metres alignment across latitudes (2.1-Q78d, 2.1-M520)', () => {
  for (const { label, lat, lon } of [
    { label: 'equator (0°)', lat: 0, lon: 0.5 },
    { label: 'mid-latitude (49°)', lat: 49, lon: 2.3522 },
    { label: 'high-latitude (65°)', lat: 65, lon: 25.47 },
  ]) {
    test(`MapLibre map.project and Pixi WorldRootContainer + AlphaFilter align at ${label} with bearing 45°`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))

      await installMapLibreInstanceProbe(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await seedPointingDevice(page)
      await page.goto('')
      const { buffer, corners } = makeRectDesignAtLatitude(lat, lon)
      await chooseFixtureFromStart(page, {
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
      await expectCanvasDrawn(page)
      // Software WebGL (CI WebKit) can lag one composite behind the bearing signal; let 2 rAFs flush.
      await nextFrames(page)

      // 1. Project all 4 WGS84 corners with real MapLibre `map.project(corner)`.
      const projected = await projectCornersWithMapLibre(page, corners)
      expect(projected).toHaveLength(4)

      // 2. Capture screenshot while unselected (clean red Pixi fill + stroke, no selection handles)
      //    and verify the rendered Pixi WebGL fill edge matches `map.project(corner)` along scanlines
      //    on all 4 edges to < 1.0 px.
      const img = decodePng(await page.screenshot())
      const cx = (projected[0]!.x + projected[1]!.x + projected[2]!.x + projected[3]!.x) / 4
      const cy = (projected[0]!.y + projected[1]!.y + projected[2]!.y + projected[3]!.y) / 4
      for (let edge = 0; edge < 4; edge++) {
        const a = projected[edge]!
        const b = projected[(edge + 1) % 4]!
        const ex = b.x - a.x
        const ey = b.y - a.y
        const len = Math.hypot(ex, ey)
        // Outward unit normal perpendicular to edge a -> b
        let nx = ey / len
        let ny = -ex / len
        const midX = (a.x + b.x) / 2
        const midY = (a.y + b.y) / 2
        if ((midX - cx) * nx + (midY - cy) * ny < 0) {
          nx = -nx
          ny = -ny
        }
        // Median of 3 perpendicular scanlines along the edge (clear of corners and any stray grid line)
        const offsets = [0.35, 0.5, 0.65]
          .map((t) => findZoneEdgeOffsetPx(img, a.x + ex * t, a.y + ey * t, nx, ny))
          .sort((u, v) => u - v)
        const medianOffset = offsets[1]!
        expect(
          Math.abs(medianOffset),
          `edge ${edge} Pixi rendered edge (${medianOffset.toFixed(2)} px) aligns with map.project`,
        ).toBeLessThan(1.0)
      }

      // 3. Select the zone so its 4 DOM vertex handles render and compare every handle directly
      //    against live MapLibre `map.project(corner)` (< 0.25 px).
      await pressMod(page, 'a')
      const handleLocator = page.locator('[data-canvas-handle^="vertex:"]')
      await expect(handleLocator).toHaveCount(4)
      await expectCanvasDrawn(page)

      const handles = await handleLocator.evaluateAll((els) => els.map((el) => {
        const box = el.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }))
      expect(handles).toHaveLength(4)

      for (let idx = 0; idx < 4; idx++) {
        const errPx = Math.hypot(handles[idx]!.x - projected[idx]!.x, handles[idx]!.y - projected[idx]!.y)
        expect(errPx, `handle ${idx} matches live map.project(corner)`).toBeLessThan(0.25)
      }

      expect(errors).toEqual([])
    })
  }
})
