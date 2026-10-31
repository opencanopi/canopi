// Show my location's dot and accuracy polygon as one MapLibre overlay contract (canopi-f47t.53; U54 Q11, Q16).
import { describe, expect, it } from 'vitest'
import { USER_LOCATION_VISUAL } from '../canvas/runtime/scene-visuals'
import { userLocationOverlayContract, userLocationOverlayIds, type UserLocationReading } from './user-location-overlay'

const READING: UserLocationReading = { lon: 2.35, lat: 48.85, accuracy: 30, timestamp: 1_760_000_000_000, stale: false }
const METRES_PER_DEGREE = Math.PI * 6_378_137 / 180

function paintOf(contract: ReturnType<typeof userLocationOverlayContract>, id: string) {
  return contract.layers.find((layer) => layer.id === id)!.paint
}

/** Ground metres from the reading to a polygon vertex. */
function metresFrom(reading: UserLocationReading, [lon, lat]: readonly number[]): number {
  const east = (lon! - reading.lon) * METRES_PER_DEGREE * Math.cos(reading.lat * Math.PI / 180)
  const north = (lat! - reading.lat) * METRES_PER_DEGREE
  return Math.hypot(east, north)
}

describe('the user location map overlay', () => {
  it('draws nothing without a reading, but names every layer so a sync clears them', () => {
    const contract = userLocationOverlayContract(null)
    expect(contract.hasRenderableFeatures).toBe(false)
    expect(contract.source.data.features).toEqual([])
    expect(contract.layers.map((layer) => layer.id)).toEqual(userLocationOverlayIds().layerIds)
  })

  it('draws the accuracy as a closed 64-gon of the accuracy radius under the dot, on one source, back to front', () => {
    const contract = userLocationOverlayContract(READING)
    const ids = userLocationOverlayIds()
    expect(contract.hasRenderableFeatures).toBe(true)
    expect(contract.source.id).toBe(ids.sourceId)
    const [accuracy, dot] = contract.source.data.features
    expect(dot).toEqual({ type: 'Feature', geometry: { type: 'Point', coordinates: [READING.lon, READING.lat] }, properties: { role: 'dot' } })
    expect(accuracy!.properties).toEqual({ role: 'accuracy' })
    expect(accuracy!.geometry.type).toBe('Polygon')
    const ring = (accuracy!.geometry.coordinates as readonly (readonly (readonly number[])[])[])[0]!
    expect(ring).toHaveLength(65)
    expect(ring[64]).toEqual(ring[0])
    for (const vertex of ring) expect(metresFrom(READING, vertex)).toBeCloseTo(READING.accuracy, 1)
    expect(contract.layers.map((layer) => layer.id)).toEqual(ids.layerIds)
    expect(contract.layers.every((layer) => layer.source === ids.sourceId)).toBe(true)
    expect(contract.layers.map((layer) => [layer.type, layer.filter])).toEqual([
      ['fill', ['==', ['get', 'role'], 'accuracy']],
      ['circle', ['==', ['get', 'role'], 'dot']],
      ['circle', ['==', ['get', 'role'], 'dot']],
    ])
  })

  it('carries only the ground: no time, accuracy figure or stale flag reaches the map data', () => {
    const text = JSON.stringify(userLocationOverlayContract({ ...READING, accuracy: 31.5, timestamp: 1_234_567_890 }).source)
    expect(text).not.toContain('1234567890')
    expect(text).not.toContain('31.5')
    expect(text).not.toContain('stale')
  })

  it('paints a platform blue core in a cream ring over an accuracy area of the core at 15 % (U54 Q11)', () => {
    const contract = userLocationOverlayContract(READING)
    const [accuracy, ring, core] = userLocationOverlayIds().layerIds
    expect(USER_LOCATION_VISUAL).toEqual({ core: '#1A73E8', ring: '#FFF8EC', accuracyOpacity: 0.15 })
    expect(paintOf(contract, accuracy)).toEqual({ 'fill-color': '#1A73E8', 'fill-opacity': 0.15 })
    expect(paintOf(contract, ring)['circle-color']).toBe('#FFF8EC')
    expect(paintOf(contract, core)['circle-color']).toBe('#1A73E8')
    expect(paintOf(contract, core)['circle-opacity']).toBe(1)
    expect(Number(paintOf(contract, ring)['circle-radius'])).toBeGreaterThan(Number(paintOf(contract, core)['circle-radius']))
  })

  it('draws a stale reading hollow: the core is an outline in the cream ring (U54 Q16)', () => {
    const core = paintOf(userLocationOverlayContract({ ...READING, stale: true }), userLocationOverlayIds().layerIds[2])
    expect(core['circle-opacity']).toBe(0)
    expect(core['circle-stroke-color']).toBe('#1A73E8')
    expect(Number(core['circle-stroke-width'])).toBeGreaterThan(0)
    expect(paintOf(userLocationOverlayContract(READING), userLocationOverlayIds().layerIds[2])['circle-stroke-width']).toBe(0)
  })

  it('draws no reading whose ground is not finite, and no accuracy area without a finite positive radius', () => {
    expect(userLocationOverlayContract({ ...READING, lon: Number.NaN }).hasRenderableFeatures).toBe(false)
    expect(userLocationOverlayContract({ ...READING, lat: Number.POSITIVE_INFINITY }).hasRenderableFeatures).toBe(false)
    for (const accuracy of [0, -5, Number.NaN]) {
      const contract = userLocationOverlayContract({ ...READING, accuracy })
      expect(contract.source.data.features.map((feature) => feature.properties.role)).toEqual(['dot'])
    }
  })

  it('takes every colour from scene-visuals.ts: each layer of a live or stale reading paints only USER_LOCATION_VISUAL colours', () => {
    const visuals = [USER_LOCATION_VISUAL.core, USER_LOCATION_VISUAL.ring]
    for (const reading of [READING, { ...READING, stale: true }]) {
      const colours = userLocationOverlayContract(reading).layers
        .flatMap((layer) => Object.entries(layer.paint).filter(([key]) => key.endsWith('-color')).map(([, value]) => value))
      expect(colours.length, `stale ${reading.stale}`).toBeGreaterThan(0)
      for (const colour of colours) expect(visuals, `stale ${reading.stale}`).toContain(colour)
    }
  })
})
