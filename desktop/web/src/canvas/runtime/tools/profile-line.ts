// canvas/runtime/tools/profile-line.ts
//
// Owns the Profile tool (canopi-f47t.42, spec §1.10, §3.2, §3.7): a temporary line drawn point by point with Polygon's
// grammar (createVertexPathTool) but never closed or filled. The second press of a double-click or double tap, Enter or
// "Finish shape" ends a line of 2 points or more: the tool hands it to the Site data profile through
// ToolEffects.finishProfile and arms Select, since site and design work interleave. It never selects, edits the Design
// or pins. Its draft is the rubber band, a disc per point and one length chip per segment (tools/measure-labels.ts).

import type { GroundMeasure } from '../../../geo/session-plane'
import type { WorldPoint } from '../../../geo/view/types'
import { createPolylineDraftMeasurements } from '../zone-measurements'
import type { DraftShape } from './draft'
import { measureLabelShapes } from './measure-labels'
import { createVertexPathTool, VERTEX_MARKER, type VertexPathSpec } from './polygon'
import type { CanvasTool, ToolView } from './tool'
import { DRAFT_STROKE } from './zone-drag'

export function createProfileLineTool(): CanvasTool {
  return createVertexPathTool(PROFILE_LINE)
}

const PROFILE_LINE: VertexPathSpec = {
  id: 'profile',
  minPoints: 2,
  draft: profileDraftShapes,
  finish(points, { effects }, done) {
    effects.finishProfile(points)
    done()
    effects.requestTool('select')
  },
}

function profileDraftShapes(
  points: readonly WorldPoint[],
  active: WorldPoint | null,
  view: ToolView,
  groundMeasure?: GroundMeasure,
): DraftShape[] {
  const band = active ? [...points, active] : points
  const shapes: DraftShape[] = []
  if (band.length >= 2) shapes.push({ kind: 'polyline', points: band, style: DRAFT_STROKE })
  for (const center of points) shapes.push({ kind: 'circle-px', center, ...VERTEX_MARKER })
  const chips = createPolylineDraftMeasurements(points, active, groundMeasure)
  shapes.push(...measureLabelShapes(chips, (a, b) => view.screenDistance(a, b)))
  return shapes
}
