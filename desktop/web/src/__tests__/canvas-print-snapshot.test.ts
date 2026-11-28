import { describe, expect, it } from 'vitest'
import { buildCanvasPrintSnapshot } from '../canvas/runtime/print-snapshot'
import { createDefaultScenePersistedState, PLANT_SYMBOL_IDS } from '../canvas/runtime/scene'
import { getPlantSymbolArt, plantSymbolPath } from '../canvas/runtime/plant-symbol-recipes'

describe('Canvas print capture', () => {
  it('captures rotated rectangular and elliptical Zones and open lines with their true ground bounds', () => {
    const scene = createDefaultScenePersistedState()
    const common = { kind: 'zone' as const, locked: false, fillColor: null, notes: null }
    scene.zones.push(
      { ...common, id: 'Bed', name: 'Bed', zoneType: 'rect', rotationDeg: 90, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }, { x: 0, y: 4 }] },
      { ...common, id: 'zone-pond', name: 'Pond', zoneType: 'ellipse', rotationDeg: 90, points: [{ x: 10, y: 20 }, { x: 4, y: 2 }] },
      { ...common, id: 'zone-path', name: null, zoneType: 'line', rotationDeg: 0, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
    )
    const result = buildCanvasPrintSnapshot(scene)
    expect(result.zones[0]!.bounds).toEqual({ x: -1, y: expect.closeTo(1, 12), width: 4, height: 2 })
    expect(result.zones[0]!.path.match(/L/g)).toHaveLength(3)
    expect(result.zones[1]!.bounds).toEqual({ x: 8, y: 16, width: 4, height: 8 })
    expect(result.zones[1]!.path.match(/C/g)).toHaveLength(4)
    expect(result.zones[2]!.path).toBe('M0 0 L5 5')
    // Print carries each zone's display name, never its id.
    expect(result.zones.map((zone) => zone.name)).toEqual(['Bed', 'Pond', null])
  })
  it('captures owned primitive geometry so ellipse diameters are independent of rotated bounds', () => {
    const scene = createDefaultScenePersistedState()
    scene.zones.push({ kind: 'zone', id: 'Pond', name: 'Pond', zoneType: 'ellipse', rotationDeg: 45, locked: false, fillColor: null, notes: null,
      points: [{ x: 10, y: 20 }, { x: 4, y: 2 }] })
    const result = buildCanvasPrintSnapshot(scene)
    expect(result.zones[0]!.geometry).toEqual({ kind: 'ellipse', center: { x: 10, y: 20 }, radii: { x: 4, y: 2 }, rotation: 45 })
    scene.zones[0]!.points[0]!.x = 99
    expect(result.zones[0]!.geometry).toMatchObject({ center: { x: 10, y: 20 } })
  })
  it('preserves authored appearance and pinning independently of screen zoom and selection', () => {
    const scene = createDefaultScenePersistedState()
    scene.plantSpeciesSymbols['Malus domestica'] = 'canopy'
    scene.plants.push({ kind: 'plant', id: 'apple', canonicalName: 'Malus domestica', commonName: 'Apple',
      color: '#123456', pinnedName: true, locked: true, canopySpreadM: null,
      position: { x: 12, y: -4 }, rotationDeg: 90, notes: null, plantedDate: null, quantity: 1 })
    const before = structuredClone(scene)
    const result = buildCanvasPrintSnapshot(scene)
    expect(result.plants).toEqual([expect.objectContaining({ id: 'apple', canonicalName: 'Malus domestica',
      position: { x: 12, y: -4 }, color: '#123456', symbol: 'canopy', pinnedName: true })])
    expect(result.plants[0]!.mark.length).toBeGreaterThan(0)
    expect(scene).toEqual(before)
    expect(result.plants[0]!.position).not.toBe(scene.plants[0]!.position)
  })
  it('prints every symbol from the shared recipe: body in the plant colour, then its cut-outs', () => {
    const scene = createDefaultScenePersistedState()
    PLANT_SYMBOL_IDS.forEach((symbol, index) => scene.plants.push({ kind: 'plant', id: symbol, canonicalName: `Species ${index}`, commonName: null,
      color: '#123456', symbol, locked: false, canopySpreadM: null,
      position: { x: index, y: 0 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1 }))
    const result = buildCanvasPrintSnapshot(scene)
    for (const plant of result.plants) {
      const symbol = plant.symbol as (typeof PLANT_SYMBOL_IDS)[number]
      for (const [marks, art] of [[plant.mark, getPlantSymbolArt(symbol, 24)], [plant.smallMark!, getPlantSymbolArt(symbol, 12)]] as const) {
        expect(marks[0], symbol).toEqual({ d: plantSymbolPath(art.body), paint: 'symbol' })
        expect(marks.slice(1)).toEqual(art.cutouts.length > 0 ? [{ d: plantSymbolPath(art.cutouts), paint: 'cutout' }] : [])
      }
    }
  })
})
