// canvas/runtime/tools/measure-labels.ts  (pure)
//
// Owns the zone measurement chips as draft shapes (spec §1.4, label tones): the selected zone's W/H, edge and area chips
// that the ToolHost draws under every tool, and the chips of the shape tools' drafts. The area is `measure`; edges and
// dimensions are `measure-quiet`; an edge shorter than 36 px on screen gets no chip, as today's (a4c86d39) overlay
// (interaction/zone-measurement-overlay.ts). An edge whose midpoint dot shows has its chip beside the dot, outside the
// polygon (U38). The measurements themselves are zone-measurements.ts's.

import type { SceneDesignObjectSelection } from '../scene/design-object-targets'
import { isSceneObjectGroupMemberTarget } from '../scene/group-members'
import type { ScenePersistedState } from '../scene/types'
import type { ScreenPoint, WorldPoint, WorldVector } from '../../../geo/view/types'
import { getRectangularZoneCorners, polygonArea } from '../zone-geometry'
import {
  createEllipticalZoneMeasurements,
  createLinearZoneMeasurements,
  createPolygonalZoneMeasurements,
  createRectangularZoneMeasurements,
  type ZoneMeasurementLabel,
} from '../zone-measurements'
import type { DraftShape } from './draft'

/** An edge chip needs this much edge on screen. */
const MIN_EDGE_LABEL_PX = 36
/** A chip beside a midpoint dot keeps this much screen between the edge line and its nearest side: the dot's grown
 *  4 px mark and a little air. */
const BESIDE_DOT_GAP_PX = 6
const NO_OFFSET = Object.freeze({ x: 0, y: 0 })

/** The polygon edges whose midpoint dots show (U38): its corners (edge i runs from corner i to the next), those edges'
 *  indices, and ToolView.screenAxesInWorld. */
export interface EdgeDots {
  readonly corners: readonly WorldPoint[]
  readonly edges: ReadonlySet<number>
  readonly screenAxes: { readonly right: WorldVector; readonly down: WorldVector }
}

/** The chips of `labels`, centred on their points, an edge with a dot in `dots` beside it; `screenDistance` is
 *  ToolView.screenDistance. */
export function measureLabelShapes(
  labels: readonly ZoneMeasurementLabel[],
  screenDistance: (a: WorldPoint, b: WorldPoint) => number,
  dots?: EdgeDots,
): DraftShape[] {
  const shapes: DraftShape[] = []
  // The interior lies left of every edge, as (−dy, dx) turns it, when the signed area is positive; computed once.
  const interiorLeft = dots ? polygonArea(dots.corners) > 0 : false
  for (const label of labels) {
    if (label.kind === 'edge' && label.worldStart && label.worldEnd
      && screenDistance(label.worldStart, label.worldEnd) < MIN_EDGE_LABEL_PX) continue
    const normalPx = dots && label.kind === 'edge' ? outwardNormalPx(dots, label.id, interiorLeft) : null
    shapes.push({
      kind: 'label',
      anchor: label.worldPosition,
      offsetPx: NO_OFFSET,
      text: label.text,
      tone: label.kind === 'area' ? 'measure' : 'measure-quiet',
      ...(normalPx ? { beside: { normalPx, gapPx: BESIDE_DOT_GAP_PX } } : {}),
    })
  }
  return shapes
}

/** The unit screen normal of edge `edge-<i>` pointing away from the polygon's interior, or null when it shows no dot.
 *  `interiorLeft`: the polygon's signed area is positive. */
function outwardNormalPx(dots: EdgeDots, labelId: string, interiorLeft: boolean): ScreenPoint | null {
  const index = Number(labelId.slice('edge-'.length))
  if (!labelId.startsWith('edge-') || !dots.edges.has(index)) return null
  const { corners, screenAxes } = dots
  const start = corners[index]
  const end = corners[(index + 1) % corners.length]
  if (!start || !end) return null
  // The outside is the side away from the interior; both turn together under any axis convention.
  const dx = end.x - start.x
  const dy = end.y - start.y
  const outward = interiorLeft ? { x: dy, y: -dx } : { x: -dy, y: dx }
  const x = outward.x * screenAxes.right.x + outward.y * screenAxes.right.y
  const y = outward.x * screenAxes.down.x + outward.y * screenAxes.down.y
  const length = Math.hypot(x, y)
  return length > 0 ? { x: x / length, y: y / length } : null
}

/**
 * The measurements of the one selected zone: nothing unless exactly one zone is selected, its layer is visible and no
 * group holds it (today's (a4c86d39) refreshSelectedZoneMeasurements, interaction/zone-drawing-tool.ts).
 */
export function selectedZoneMeasurementLabels(
  scene: Readonly<ScenePersistedState>,
  selection: SceneDesignObjectSelection,
): ZoneMeasurementLabel[] {
  if (selection.length !== 1) return []
  const target = selection[0]!
  if (target.kind !== 'zone') return []
  if (scene.layers.find((layer) => layer.name === 'zones')?.visible === false) return []
  if (scene.groups.some((group) => group.members.some((member) => isSceneObjectGroupMemberTarget(member, target)))) return []
  const zone = scene.zones.find((entry) => entry.id === target.id)
  if (!zone) return []

  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    return createEllipticalZoneMeasurements(zone.points[0]!, zone.points[1]!, zone.rotationDeg)
  }
  if (zone.zoneType === 'line' && zone.points.length >= 2) {
    return createLinearZoneMeasurements(zone.points[0]!, zone.points[1]!)
  }
  if (zone.zoneType === 'polygon') return createPolygonalZoneMeasurements(zone.points)
  if (zone.zoneType !== 'rect') return []
  return createRectangularZoneMeasurements(getRectangularZoneCorners(zone) ?? zone.points)
}
