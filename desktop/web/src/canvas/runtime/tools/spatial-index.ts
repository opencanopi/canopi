// canvas/runtime/tools/spatial-index.ts
//
// Owns createToolScene: the ToolScene tools and the ToolHost query (spec §1.2a, §1.4, §4.9). A façade over the linear
// hit tests (hit-testing.ts) at the frame's pixelsPerMetre, read at every query; nothing is cached, and an index is
// later work. hitAt is hitTestTopLevel for the filter's pointer, object locks included (the tool rejects them);
// `includeLocked` is hitTestVisibleTopLevel (the host's hover); `zoneEdge` answers only the picked zone's edge nearest the
// point (hitZoneEdge): the editable pick's (Select's double-click corner), or with `includeLocked` the visible pick's
// ("Turn view to this edge"). hitInQuad tests the band's world quad as a polygon, never
// its world box. nearestPlant is today's Place plants scan (today's (a4c86d39)
// interaction/plant-placement-preview.ts): the first plant in scene order wins a tie.
// tools/tool-host.ts re-exports the factory.

import type { ToolSceneSource } from '../interaction-ports'
import { buildPlantPresentationEntries, type PlantPresentationContext } from '../plant-presentation'
import type { ScenePersistedState, ScenePlantEntity } from '../scene/types'
import type { WorldPoint, WorldQuad } from '../../../geo/view/types'
import { hitTestTopLevel, hitTestVisibleTopLevel, hitZoneEdge, queryQuadTopLevel } from './hit-testing'
import type { HitFilter, HitTarget, ToolScene } from './tool'

export function createToolScene(source: ToolSceneSource): ToolScene {
  const persisted = (): ScenePersistedState => source.store.persisted

  function plantContext(pixelsPerMetre: number): PlantPresentationContext {
    return { ...source.plantContext(pixelsPerMetre), speciesCache: source.speciesCache() }
  }

  return {
    get persisted() {
      return persisted()
    },
    get groundMeasure() {
      return source.store.sessionPlane
    },
    hitAt(world: WorldPoint, filter: HitFilter): HitTarget | null {
      if (filter.zoneEdge) {
        const edge = hitZoneEdge(
          persisted(),
          world,
          source.pixelsPerMetre(),
          filter.pointer,
          filter.includeLocked ? 'visible' : 'editable',
          source.speciesCache(),
          source.plantContext,
          source.selection(),
          source.store.session.hoveredTarget,
        )
        return edge ? { kind: 'zone-edge', ...edge } : null
      }
      const hitTest = filter.includeLocked ? hitTestVisibleTopLevel : hitTestTopLevel
      const target = hitTest(
        persisted(),
        world,
        source.pixelsPerMetre(),
        filter.pointer,
        source.speciesCache(),
        source.plantContext,
        source.selection(),
        source.store.session.hoveredTarget,
      )
      return target ? { kind: 'object', target } : null
    },
    hitInQuad(quad: WorldQuad): readonly HitTarget[] {
      return queryQuadTopLevel(
        persisted(),
        quad,
        source.pixelsPerMetre(),
        source.speciesCache(),
        source.plantContext,
        source.selection(),
      ).map((target) => ({ kind: 'object', target }))
    },
    nearestPlant(world: WorldPoint) {
      const scene = persisted()
      if (scene.layers.find((layer) => layer.name === 'plants')?.visible === false) return null
      const plane = source.store.sessionPlane
      let best: { plant: ScenePlantEntity; distanceM: number } | null = null
      for (const plant of scene.plants) {
        const distanceM = plane.groundLength(plant.position, world)
        if (!best || distanceM < best.distanceM) best = { plant, distanceM }
      }
      return best
    },
    plantPresentation(plant: ScenePlantEntity) {
      const context = plantContext(source.pixelsPerMetre())
      const entry = buildPlantPresentationEntries([plant], { ...context, plants: persisted().plants }, new Set())[0]!
      return {
        commonName: context.localizedCommonNames?.get(plant.canonicalName) ?? plant.commonName ?? plant.canonicalName,
        color: entry.color,
        radiusPx: entry.radiusScreenPx,
      }
    },
    isLayerOpenForCreation: (layer) => source.isLayerOpenForCreation(layer),
    selection: () => source.selection(),
    selectionModel: () => source.selectionModel(),
  }
}
