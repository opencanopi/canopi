// The large fixture Design the perf lane opens, pans and zooms (ADR 0029 Performance budgets, 2.1-M240).
// e2e/perf generates it at run time into the perf project's output directory; it is never committed, and
// src/__tests__/large-fixture.test.ts admits it through the real decoder so a .canopi format change fails there.
//
// Geometry is laid out in ground metres on a square site and placed through the caller's `toGeo`: the real session
// plane (canvas/session-plane.ts, contracts §20), so this file holds no Earth model. Files store WGS84 lon/lat
// (ADR 0001). The same seed gives the same Design byte for byte.
import { writeFileSync } from 'node:fs'

/** The site centre: the base fixture's (e2e/fixtures/canvas-base.canopi), so the plane's scale is a real one. */
export const LARGE_FIXTURE_SITE = Object.freeze({ lon: 3.8772, lat: 43.6112 })
/** The square site's side: one hectare. */
export const LARGE_FIXTURE_SIDE_METRES = 100
export const LARGE_FIXTURE_DEFAULT_SEED = 20261027

/** Canopy species first (wide spacing), then shrubs and ground cover. */
const SPECIES = [
  ['Malus domestica', 'Apple', 'MDO', 6],
  ['Pyrus communis', 'Pear', 'PCO', 6],
  ['Prunus avium', 'Sweet cherry', 'PAV', 7],
  ['Corylus avellana', 'Hazel', 'CAV', 4],
  ['Ribes rubrum', 'Redcurrant', 'RRU', 1.5],
  ['Rubus idaeus', 'Raspberry', 'RID', 1],
  ['Symphytum officinale', 'Comfrey', 'SOF', 0.8],
  ['Fragaria vesca', 'Wild strawberry', 'FVE', 0.4],
]
const PLANT_ROWS = 50
const PLANTS_PER_ROW = 50
const ZONES = 60
const ANNOTATIONS = 120
const STAMP = '2026-10-27T00:00:00.000Z'
const LAYERS = ['climate', 'zones', 'water', 'plants', 'measurement-guides', 'annotations']

/** mulberry32: a small seeded generator, so the fixture never depends on Math.random. */
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function uuid(next) {
  const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16))
  hex[12] = '4'
  hex[16] = '89ab'[Math.floor(next() * 4)]
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/**
 * The large fixture as a .canopi value: 2,500 plants in jittered rows, 60 zones (rectangles and polygons) and 120
 * text annotations on a one-hectare site, every point within the site square around LARGE_FIXTURE_SITE.
 * @param {{ seed: number, toGeo: (point: { x: number, y: number }) => { lon: number, lat: number } }} options
 *   `toGeo` maps ground metres (x east, y south, from the site centre) to WGS84; pass the real session plane's.
 * @returns {Record<string, unknown>}
 */
export function largeFixture({ seed, toGeo }) {
  const next = random(seed)
  const half = LARGE_FIXTURE_SIDE_METRES / 2
  const clamp = (v) => Math.max(-half, Math.min(half, v))
  const at = (x, y) => {
    const { lon, lat } = toGeo({ x: clamp(x), y: clamp(y) })
    return { lon, lat }
  }
  const pitch = LARGE_FIXTURE_SIDE_METRES / PLANTS_PER_ROW
  const plants = []
  for (let row = 0; row < PLANT_ROWS; row += 1) {
    for (let column = 0; column < PLANTS_PER_ROW; column += 1) {
      const [canonical, common, , spread] = SPECIES[Math.floor(next() * SPECIES.length)]
      const x = -half + pitch * (column + 0.5) + (next() - 0.5) * pitch * 0.6
      const y = -half + pitch * (row + 0.5) + (next() - 0.5) * pitch * 0.6
      plants.push({
        id: uuid(next), locked: false, canonical_name: canonical, common_name: common, color: null, symbol: null,
        pinned_name: false, position: at(x, y), rotation: null, scale: spread, notes: null, planted_date: null, quantity: 1,
      })
    }
  }
  const zones = []
  for (let index = 0; index < ZONES; index += 1) {
    const cx = (next() - 0.5) * (LARGE_FIXTURE_SIDE_METRES - 12)
    const cy = (next() - 0.5) * (LARGE_FIXTURE_SIDE_METRES - 12)
    const w = 2 + next() * 8
    const h = 2 + next() * 8
    const rect = index % 2 === 0
    const corners = rect
      ? [[-w, -h], [w, -h], [w, h], [-w, h]]
      : Array.from({ length: 6 }, (_, k) => {
        const angle = (k / 6) * 2 * Math.PI
        const r = 0.6 + next() * 0.4
        return [Math.cos(angle) * w * r, Math.sin(angle) * h * r]
      })
    zones.push({
      id: `zone-${uuid(next)}`, name: null, locked: false, zone_type: rect ? 'rect' : 'polygon',
      points: corners.map(([dx, dy]) => at(cx + dx / 2, cy + dy / 2)), rotation: 0, fill_color: null, notes: null,
    })
  }
  const annotations = Array.from({ length: ANNOTATIONS }, (_, index) => ({
    id: uuid(next), locked: false, annotation_type: 'text',
    position: at((next() - 0.5) * LARGE_FIXTURE_SIDE_METRES, (next() - 0.5) * LARGE_FIXTURE_SIDE_METRES),
    text: `Note ${index + 1}`, font_size: 14, rotation: null,
  }))
  return {
    version: 9,
    name: 'Large fixture',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: Object.fromEntries(SPECIES.map(([canonical, , code]) => [canonical, code])),
    layers: LAYERS.map((name) => ({ name, visible: name !== 'climate' && name !== 'water', locked: false, opacity: 1 })),
    plants,
    zones,
    annotations,
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: STAMP,
    updated_at: STAMP,
  }
}

/**
 * Writes the large fixture to `path` as .canopi JSON.
 * @param {string} path
 * @param {{ seed: number, toGeo: (point: { x: number, y: number }) => { lon: number, lat: number } }} options
 */
export function writeLargeFixture(path, options) {
  writeFileSync(path, `${JSON.stringify(largeFixture(options), null, 1)}\n`)
}
