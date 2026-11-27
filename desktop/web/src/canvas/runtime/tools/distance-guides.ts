// canvas/runtime/tools/distance-guides.ts  (pure)
//
// Owns the plant distance guide as draft shapes: a 1.5 px draft line dashed 4 4 over its casing, from a plant to a
// neighbour, with a `measure` chip (Source Sans 3, 600). The Select move-drag guides the dragged plant to the two nearest plants
// left behind, by distance then id, in a linear scan of the scene (nothing while the plants layer is hidden); Place plants
// and the stamps draw their own guide with ToolScene.nearestPlant, which keeps the scene order on a tie instead.

import type { ScenePlantEntity } from '../scene/types'
import type { ScreenPoint, WorldPoint } from '../../../geo/view/types'
import { formatMetricDistance } from '../zone-measurements'
import type { DraftShape, DraftStroke } from './draft'
import type { ToolScene } from './tool'

const DISTANCE_GUIDE_STROKE: DraftStroke = Object.freeze({ token: 'draft', widthPx: 1.5, dash: Object.freeze([4, 4]) })
/** A move-drag shows this many guides. */
const DRAG_DISTANCE_GUIDES = 2

/** The guide from `start` to `end` with its chip at the middle, or at `label.anchor` moved by `label.offsetPx`. */
export function distanceGuideShapes(
  start: WorldPoint,
  end: WorldPoint,
  text: string,
  label: { readonly anchor?: WorldPoint; readonly offsetPx?: ScreenPoint } = {},
): DraftShape[] {
  return [
    { kind: 'polyline', points: [start, end], style: DISTANCE_GUIDE_STROKE },
    {
      kind: 'label',
      anchor: label.anchor ?? { x: start.x + (end.x - start.x) / 2, y: start.y + (end.y - start.y) / 2 },
      offsetPx: label.offsetPx ?? { x: 0, y: 0 },
      text,
      tone: 'measure',
    },
  ]
}

/** The move-drag's guides from `active` (one of `dragged`) to the nearest plants outside `dragged`. */
export function plantDragDistanceGuideShapes(
  scene: Pick<ToolScene, 'persisted' | 'groundMeasure'>,
  active: ScenePlantEntity,
  dragged: ReadonlySet<string>,
): DraftShape[] {
  const { layers, plants } = scene.persisted
  const plantsLayer = layers.find((layer) => layer.name === 'plants')
  if (!dragged.has(active.id) || plantsLayer?.visible === false || (plantsLayer?.opacity ?? 1) <= 0) return []
  const measure = scene.groundMeasure
  return plants
    .filter((plant) => !dragged.has(plant.id))
    .map((plant) => ({
      plant,
      distanceM: measure
        ? measure.groundLength(active.position, plant.position)
        : Math.hypot(plant.position.x - active.position.x, plant.position.y - active.position.y),
    }))
    .sort((left, right) => left.distanceM - right.distanceM || left.plant.id.localeCompare(right.plant.id))
    .slice(0, DRAG_DISTANCE_GUIDES)
    .flatMap(({ plant, distanceM }) =>
      distanceGuideShapes(active.position, plant.position, formatMetricDistance(distanceM)))
}
