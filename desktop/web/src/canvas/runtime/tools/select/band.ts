// canvas/runtime/tools/select/band.ts
//
// Owns Select's band: a press on empty ground (inside a zone away from its outline too, canopi-qd2k) clears the
// selection unless the press is additive, and the drag draws a screen-aligned box from the press to the pointer (the band's `quad` draft:
// the selection stroke at 2 px over the selection fill). The release selects every object the box touches, tested
// against its world quad (turned with the view, never widened to its world box; spec §4.9; a zone by its outline, so a
// box wholly inside a zone leaves it out: hit-testing.ts), the locked ones left out,
// added to the selection when the press was additive, never removed from it (an Alt band adds what it touches). Only a
// drag makes a band, whatever its size: the recogniser's slop tells it from a click (A9). The release runs when the
// scene is settled (CanvasTool.settledRelease).

import { isSceneDesignObjectLocked } from '../../scene/locks'
import { sceneTargetKey, type SceneDesignObjectTarget } from '../../scene/design-object-targets'
import type { WorldPoint, WorldQuad } from '../../../../geo/view/types'
import type { DraftPresentation } from '../draft'
import type { ToolContext, ToolView } from '../tool'

export interface Band {
  readonly start: WorldPoint
  readonly additive: boolean
}

/** The band from its press to `end`, as the renderer draws it. */
export function bandDraft(view: ToolView, band: Band, end: WorldPoint): DraftPresentation {
  return {
    shapes: [{
      kind: 'quad',
      corners: screenAlignedQuad(view, band.start, end),
      style: { token: 'selection', widthPx: 2 },
      fill: { token: 'selection-fill' },
    }],
  }
}

/** What the band released at `end` selects. */
export function bandSelection(ctx: ToolContext, band: Band, end: WorldPoint): SceneDesignObjectTarget[] {
  const scene = ctx.scene.persisted
  const selected = new Map<string, SceneDesignObjectTarget>(
    band.additive ? ctx.scene.selection().map((target) => [sceneTargetKey(target), target]) : [],
  )
  for (const hit of ctx.scene.hitInQuad(screenAlignedQuad(ctx.view, band.start, end))) {
    if (hit.kind !== 'object' || isSceneDesignObjectLocked(scene, hit.target)) continue
    selected.set(sceneTargetKey(hit.target), hit.target)
  }
  return [...selected.values()]
}

/** The box with `a` and `b` as opposite corners, its sides along the screen's axes (the world's at bearing 0). */
function screenAlignedQuad(view: ToolView, a: WorldPoint, b: WorldPoint): WorldQuad {
  const { right, down } = view.screenAxesInWorld()
  // Screen axes are non-orthogonal in plane metres under an anisotropic WGS84 affine; solve the 2x2 basis
  // b - a = across * right + along * down so the quad's edges map strictly horizontal/vertical on screen.
  const det = right.x * down.y - right.y * down.x
  const across = Math.abs(det) > 1e-12
    ? ((b.x - a.x) * down.y - (b.y - a.y) * down.x) / det
    : (b.x - a.x) * right.x + (b.y - a.y) * right.y
  return [
    a,
    { x: a.x + right.x * across, y: a.y + right.y * across },
    b,
    { x: b.x - right.x * across, y: b.y - right.y * across },
  ]
}
