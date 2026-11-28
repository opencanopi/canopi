/**
 * The legend against the renderer that draws the map: the pinned
 * `cog-tiler-wasm`, its WebAssembly started in Node. An unknown colormap name
 * falls back to grey without an error, so every ramp's colormap must be one
 * the wasm compiles in, and every ramp a kind offers must show in its legend
 * the colours `colorize()` paints at its stops and between them, where the CSS
 * gradient blends in a straight line. Blue-means-water is checked here too.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { colorize, colormap_names, initSync } from 'cog-tiler-wasm/wasm'
import type { LidarRamp, RasterQuantity } from '../../generated/contracts'
import { legendGradient } from './display-legend'
import { itemTypeStyle, kindRamps, RASTER_QUANTITIES } from './item-types'

const require = createRequire(import.meta.url)
const wasmPath = join(dirname(require.resolve('cog-tiler-wasm/wasm')), 'cog_tiler_wasm_bg.wasm')

const QUANTITIES = Object.keys(RASTER_QUANTITIES) as RasterQuantity[]

/** The renderer colormap a ramp draws with, read through the style an entry of a kind offering it gets. */
function colormapOf(ramp: LidarRamp): string {
  const quantity = QUANTITIES.find((candidate) => kindRamps({ kind: 'Raster', quantity: candidate }).includes(ramp))
  if (!quantity) throw new Error(`no kind offers ${ramp}`)
  return itemTypeStyle({ kind: 'Raster', quantity }, { units: '', displayRange: null, ramp, reversed: false, range: null }).colormap
}

const ALL_RAMPS: readonly LidarRamp[] = ['Relief', 'Terrain', 'Earth', 'Greens', 'YellowRed', 'Magma', 'Gray']

/** Every ramp some kind offers that shows a legend, each once; Relief draws stored greys and shows none. */
function listedRamps(): LidarRamp[] {
  return [...new Set(QUANTITIES.flatMap((quantity) => kindRamps({ kind: 'Raster', quantity })))]
    .filter((ramp) => ramp !== 'Relief')
    .sort()
}

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]
}

/** The wasm's colour at each position in 0..1, as RGB triples. */
function wasmColours(colormap: string, positions: readonly number[]): [number, number, number][] {
  const rgba = colorize(Float64Array.from(positions), positions.length, 1, 0, 1, colormap, null, false, 'linear', 1, false, 1)
  return positions.map((_, i) => [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!])
}

/** The legend's stops for a ramp, read back from the gradient it renders. */
function legendStops(ramp: LidarRamp): [number, number, number][] {
  return (legendGradient(ramp, false).match(/#[0-9a-f]{6}/gi) ?? []).map(hexChannels)
}

/** The legend's colour at a position: the straight-line blend of its evenly spaced stops. */
function legendColour(stops: readonly [number, number, number][], position: number): [number, number, number] {
  const scaled = position * (stops.length - 1)
  const below = Math.min(stops.length - 2, Math.floor(scaled))
  const share = scaled - below
  return stops[below]!.map((channel, c) => channel * (1 - share) + stops[below + 1]![c]! * share) as [number, number, number]
}

function worstGap(legend: readonly [number, number, number][], wasm: readonly [number, number, number][]): number {
  return Math.max(...legend.flatMap((rgb, i) => rgb.map((channel, c) => Math.abs(channel - wasm[i]![c]!))))
}

/** 1025 positions, so every stop of a 9-, 17-, 33- or 65-stop ramp is among them. */
const FINE = Array.from({ length: 1025 }, (_, k) => k / 1024)

beforeAll(() => {
  initSync({ module: readFileSync(wasmPath) })
})

/** sRGB channels (0–255) to CIELAB under D65: lightness, chroma and hue angle in degrees. */
function cielab([r, g, b]: readonly [number, number, number]): { l: number, c: number, h: number } {
  const linear = (channel: number) => {
    const v = channel / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  const a = 500 * (fx - fy)
  const bb = 200 * (fy - fz)
  return { l: 116 * fy - 16, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 }
}

/** Blue as the blue-means-water rule counts it: CIELAB hue 190–285°, chroma at least 20, lightness at least 25. */
function isBlue(rgb: readonly [number, number, number]): boolean {
  const { l, c, h } = cielab(rgb)
  return h >= 190 && h <= 285 && c >= 20 && l >= 25
}

/** 65 evenly spaced samples of a colormap as the renderer paints them. */
const SAMPLES = Array.from({ length: 65 }, (_, k) => k / 64)

describe('LiDAR legend ramps against the real renderer', () => {
  it('keeps blue for water: no ramp a non-water kind offers has a blue sample', () => {
    // Every 2.0 kind is non-water; hydrology 2.1's water kinds will need at least 16 blue samples of 65.
    const blue = QUANTITIES.flatMap((quantity) => kindRamps({ kind: 'Raster', quantity })
      .map((ramp) => ({ quantity, ramp, blue: wasmColours(colormapOf(ramp), SAMPLES).filter(isBlue).length })))
      .filter((entry) => entry.blue > 0)
    expect(blue).toEqual([])
  })

  it('counts a blue ramp as blue and a warm one as not, and catches viridis, the 2.0 offender', () => {
    expect(wasmColours('blues', SAMPLES).filter(isBlue).length).toBeGreaterThanOrEqual(16)
    expect(wasmColours('ylorrd', SAMPLES).filter(isBlue).length).toBe(0)
    expect(wasmColours('viridis', SAMPLES).filter(isBlue).length).toBeGreaterThan(0)
  })

  it('swatches Relief as one fixed shaded picture, never Gray\'s ramp and whatever Reverse says', () => {
    expect(legendGradient('Relief', false)).toBe(legendGradient('Relief', true))
    expect(legendGradient('Relief', false)).not.toBe(legendGradient('Gray', false))
    expect(legendGradient('Relief', false)).toMatch(/^radial-gradient\(/)
  })

  it('draws every ramp with a colormap the wasm compiles in', () => {
    const known = new Set(JSON.parse(colormap_names()) as string[])
    expect(ALL_RAMPS.map(colormapOf).filter((name) => !known.has(name))).toEqual([])
  })

  it.each(listedRamps())('shows the colours colorize() paints for %s at its stops within ±2', (ramp) => {
    const legend = legendStops(ramp)
    expect(legend.length).toBeGreaterThanOrEqual(2)
    const wasm = wasmColours(colormapOf(ramp), legend.map((_, i) => i / (legend.length - 1)))
    expect(worstGap(legend, wasm), `${ramp} legend ${JSON.stringify(legend)} vs wasm ${JSON.stringify(wasm)}`).toBeLessThanOrEqual(2)
  })

  it.each(listedRamps())('blends to within ±8 of colorize() between the stops of %s', (ramp) => {
    const stops = legendStops(ramp)
    const legend = FINE.map((position) => legendColour(stops, position))
    const wasm = wasmColours(colormapOf(ramp), FINE)
    const gaps = legend.map((rgb, k) => worstGap([rgb], [wasm[k]!]))
    const at = gaps.indexOf(Math.max(...gaps))
    expect(gaps[at], `${ramp} at ${FINE[at]}: legend ${legend[at]!.map(Math.round)} vs wasm ${wasm[at]}`).toBeLessThanOrEqual(8)
  })
})
