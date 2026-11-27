import type { SessionPlane } from '../../geo/session-plane'
import type { CanvasPrintSnapshot, PrintMarkPath } from '../print'
import { resolvePlantDisplayColor, type PlantPresentationContext } from './plant-presentation'
import { resolvePlantSymbolForPlant, type ScenePersistedState } from './scene'
import { getPlantSymbolArt, plantSymbolPath, type PlantSymbolArt } from './plant-symbol-recipes'
import { buildPrintZoneShape, getZoneWorldBounds } from './zone-geometry'
import { zoneDisplayName } from './zone-identity'

export function buildCanvasPrintSnapshot(
  scene: ScenePersistedState,
  context: PlantPresentationContext,
  plane?: Pick<SessionPlane, 'origin'>,
): CanvasPrintSnapshot {
  return {
    ...(plane ? { planeOrigin: { lon: plane.origin.lon, lat: plane.origin.lat } } : {}),
    symbolScale: getCanvasPlantDisplay().symbolScale,
    layers: scene.layers.map(({ name, visible, opacity }) => ({ name, visible, opacity })),
    plants: scene.plants.map((plant) => {
      const symbol = resolvePlantSymbolForPlant(plant, scene.plantSpeciesSymbols)
      return { id: plant.id, canonicalName: plant.canonicalName, speciesCode: scene.plantSpeciesCodes[plant.canonicalName], position: { ...plant.position },
        // Print carries the colour mode, never the stored colour it would override.
        color: resolvePlantDisplayColor(plant, context.speciesCache, context.plantDisplay), symbol,
        mark: markPaths(getPlantSymbolArt(symbol, 24)),
        smallMark: markPaths(getPlantSymbolArt(symbol, 12)), pinnedName: plant.pinnedName === true }
    }),
    zones: scene.zones.flatMap((zone) => {
      const bounds = getZoneWorldBounds(zone)
      if (!bounds) return []
      if (zone.fillColor && !/^(#[\da-f]{3,8}|rgba?\([\d.,\s]+\)|[a-z]+)$/i.test(zone.fillColor)) throw new Error('unsupported-print-color')
      const { path, geometry, fill } = buildPrintZoneShape(zone)
      return [{ name: zoneDisplayName(zone), path, bounds, geometry, fill }]
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
