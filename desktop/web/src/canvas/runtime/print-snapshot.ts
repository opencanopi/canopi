import type { SessionPlane } from '../../geo/session-plane'
import type { CanvasPrintSnapshot, PrintMarkPath, PrintZone } from '../print'
import { resolvePlantDisplayColor, type PlantPresentationContext } from './plant-presentation'
import { resolvePlantSymbolForPlant, type ScenePersistedState } from './scene'
import { getPlantSymbolArt, plantSymbolPath, type PlantSymbolArt } from './plant-symbol-recipes'
import { getRectangularZoneCorners, getZoneWorldBounds } from './zone-geometry'
import { zoneDisplayName } from './zone-identity'

export function buildCanvasPrintSnapshot(
  scene: ScenePersistedState,
  context: PlantPresentationContext,
  plane?: Pick<SessionPlane, 'origin'>,
): CanvasPrintSnapshot {
  return {
    ...(plane ? { planeOrigin: { lon: plane.origin.lon, lat: plane.origin.lat } } : {}),
    layers: scene.layers.map(({ name, visible, opacity }) => ({ name, visible, opacity })),
    plants: scene.plants.map((plant) => {
      const symbol = resolvePlantSymbolForPlant(plant, scene.plantSpeciesSymbols)
      return { id: plant.id, canonicalName: plant.canonicalName, speciesCode: scene.plantSpeciesCodes[plant.canonicalName], position: { ...plant.position },
        // Print carries the colour mode, never the stored colour it would override.
        color: resolvePlantDisplayColor(plant, context.speciesCache), symbol,
        mark: markPaths(getPlantSymbolArt(symbol, 24)),
        smallMark: markPaths(getPlantSymbolArt(symbol, 12)), pinnedName: plant.pinnedName === true }
    }),
    zones: scene.zones.flatMap((zone) => {
      const bounds = getZoneWorldBounds(zone)
      if (!bounds) return []
      const points = getRectangularZoneCorners(zone) ?? zone.points
      const path = zone.zoneType === 'ellipse' && points.length >= 2
        ? ellipsePath(points[0]!.x, points[0]!.y, Math.abs(points[1]!.x), Math.abs(points[1]!.y), zone.rotationDeg)
        : points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ') + (zone.zoneType === 'line' ? '' : ' Z')
      if (zone.fillColor && !/^(#[\da-f]{3,8}|rgba?\([\d.,\s]+\)|[a-z]+)$/i.test(zone.fillColor)) throw new Error('unsupported-print-color')
      const geometry: PrintZone['geometry'] = zone.zoneType === 'ellipse' && points.length >= 2
        ? { kind: 'ellipse', center: { ...points[0]! }, radii: { x: Math.abs(points[1]!.x), y: Math.abs(points[1]!.y) }, rotation: zone.rotationDeg }
        : { kind: zone.zoneType === 'line' ? 'line' : zone.zoneType === 'rect' ? 'rect' : 'polygon', points: points.map(p => ({ ...p })) }
      return [{ name: zoneDisplayName(zone), path, bounds, geometry, fill: zone.zoneType === 'line' ? null : zone.fillColor }]
    }),
    annotations: scene.annotations.map((annotation) => ({ id: annotation.id, position: { ...annotation.position },
      text: annotation.text, fontSize: annotation.fontSize, rotation: annotation.rotationDeg ?? 0 })),
    measurements: scene.measurementGuides.map(({ id, start, end }) => ({ id, start: { ...start }, end: { ...end } })),
  }
}

function markPaths(art: PlantSymbolArt): PrintMarkPath[] {
  const body: PrintMarkPath = { d: plantSymbolPath(art.body), paint: 'symbol' }
  return art.cutouts.length > 0 ? [body, { d: plantSymbolPath(art.cutouts), paint: 'cutout' }] : [body]
}

// Cubic ellipse representation is shared by PDF and preview, including rotation.
function ellipsePath(cx: number, cy: number, rx: number, ry: number, rotation: number): string {
  const k = 0.5522847498307936
  const angle = rotation * Math.PI / 180
  const point = (x: number, y: number) => `${cx + x * rx * Math.cos(angle) - y * ry * Math.sin(angle)} ${cy + x * rx * Math.sin(angle) + y * ry * Math.cos(angle)}`
  return `M${point(1, 0)} C${point(1, k)} ${point(k, 1)} ${point(0, 1)} C${point(-k, 1)} ${point(-1, k)} ${point(-1, 0)} C${point(-1, -k)} ${point(-k, -1)} ${point(0, -1)} C${point(k, -1)} ${point(1, -k)} ${point(1, 0)} Z`
}
