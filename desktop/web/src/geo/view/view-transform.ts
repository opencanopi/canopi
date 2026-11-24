// geo/view/view-transform.ts  (pure)
//
// Owns the one ViewTransform (ADR 0016): the world-to-screen general affine every reader projects with, its inverse,
// quads, bulk anchors and ground resolution, built from a geographic camera (both drivers' truth) and the WGS84
// per-axis session plane.
//
// Audited similarity-site inventory (2m-1, 2.1-Q78d, 2.1-M519, 2.1-M520):
// - World geometry roots (Pixi): `canvas/runtime/renderers/scene-paint.ts` (`WorldRootContainer` overriding
//   `updateLocalTransform`), `world-layers.ts`, `draft-layer.ts` -> general 2x3 affine `[wa, wb, wc, wd, tx, ty]`.
// - View projection / inverse / framing / navigation: `geo/view/{view-transform,camera-math,fit,navigation,
//   navigation-policy,driver-host,headless-driver}.ts` -> affine & `toView`/`fromView` + `SessionPlane`.
// - Screen-aligned tool geometry (non-orthogonal screen axes in plane metres): `tools/tool-host.ts`
//   (`screenAlignedRect` orthonormal ground axes at bearingDeg; `nudge` normalised), `tools/select/band.ts`,
//   `tools/select/selection-hull.ts`, `tools/constraints.ts`, `tools/plant-row.ts`, `tools/measure-labels.ts`,
//   `canvas/runtime/inspection-lens.ts` -> dual-basis 2x2 inverse or `worldToScreen`/`screenToWorld`.
// - Ground-sized screen-upright marks (`2.1-M520`): `canvas/runtime/renderers/billboard-layer.ts` and
//   `canvas/runtime/plant-presentation.ts` (sized via `view.metresPerPixelAt(p)` -> `plane.groundScaleAt(p)`),
//   `canvas/runtime/inspection-lens-drawing.ts` (drawn in screen-upright pixel space, zero affine stretch),
//   `canvas/runtime/renderers/draft-layer.ts` (upright turns mapped through linear affine `[wa, wb, wc, wd]`).
// - Pixel-sized chrome / strokes / handles: `scene-paint.ts` (`screenPxToWorldPx`), `billboard-layer.ts` labels/badges,
//   `canvas/saved-view-framing.ts`, `app/data-library/camera-request.ts`, `canvas/runtime/scene-runtime/construction.ts`.
// - Remaining non-2m-1 latitude-scale sites ratcheted under `scale-only-through-plane` (`canopi-f47t.52.189`, 2m-2):
//   `app/data-library/import-coverage.ts`, `app/my-location/follow.ts`, `maplibre/user-location-overlay.ts`.
// - `trueNorthAt`: confirmed absent (0 sites, 2.1-M519).

import { conformalPoint, type ConformalPoint, type SessionPlane } from '../session-plane'
import { angularDistanceToNorth, bearingCosSin } from './navigation-policy'
import type {
  PlanarCamera,
  ScreenPoint,
  ViewCamera,
  ViewScreen,
  ViewTransform,
  WorldPoint,
  WorldQuad,
  WorldVector,
} from './types'

/** Under this angle from north the view reads as north-up (the compass). */
const NORTH_UP_TOLERANCE_DEG = 0.05

/** Pitch 0: centre, zoom and bearing, through the plane's toPlane → toView → affine. Both drivers, the snapshot map's
 *  driver and the lens call this. The plane origin lands at turn(−centre_conformal × scale, bearing) + screen centre. */
export function buildViewTransform(input: {
  readonly camera: ViewCamera
  readonly screen: ViewScreen
  readonly plane: SessionPlane
  readonly planeRevision: number
}): ViewTransform {
  const { camera, screen, plane } = input
  const scale = plane.pixelsPerMetre(camera.zoom).mean
  const centre = plane.toView(plane.toPlane(camera.center))
  const [cos, sin] = bearingCosSin(camera.bearingDeg)
  const placement: PlanarCamera = {
    x: screen.width / 2 - (cos * centre.x + sin * centre.y) * scale,
    y: screen.height / 2 - (cos * centre.y - sin * centre.x) * scale,
    scale,
    bearingDeg: camera.bearingDeg,
  }
  return affineTransform(camera, placement, input)
}

/** The PlanarCamera a pitch-0 transform places the plane with (the chrome and the test view read it). */
export function planarCameraOf(view: ViewTransform): PlanarCamera {
  const { affine } = view.planar
  return { x: affine[4], y: affine[5], scale: view.pixelsPerMetre, bearingDeg: view.camera.bearingDeg }
}

function unitVector(x: number, y: number): WorldVector {
  const len = Math.hypot(x, y)
  return len > 0 ? Object.freeze({ x: x / len, y: y / len }) : Object.freeze({ x: 0, y: 0 })
}

/**
 * screen = turn(diag(1/ax, 1/ay) · p × scale, bearing) + { x, y }:
 * Pixi's [wa, wb, wc, wd, tx, ty] where wa = (scale·cos)/ax, wb = (−scale·sin)/ax, wc = (scale·sin)/ay, wd = (scale·cos)/ay.
 */
function affineTransform(
  camera: ViewCamera,
  planar: PlanarCamera,
  input: { readonly screen: ViewScreen; readonly plane: SessionPlane; readonly planeRevision: number },
): ViewTransform {
  const { screen, plane } = input
  const { x: tx, y: ty, scale } = planar
  const { ax, ay } = plane.axisScale
  const [cos, sin] = bearingCosSin(planar.bearingDeg)
  const wa = (scale * cos) / ax
  const wb = (0 - scale * sin) / ax
  const wc = (scale * sin) / ay
  const wd = (scale * cos) / ay

  const worldToScreen = (p: WorldPoint): ScreenPoint => ({ x: wa * p.x + wc * p.y + tx, y: wb * p.x + wd * p.y + ty })
  const screenToWorld = (s: ScreenPoint): WorldPoint => {
    const across = (s.x - tx) / scale
    const down = (s.y - ty) / scale
    return plane.fromView(conformalPoint(cos * across - sin * down, sin * across + cos * down))
  }
  const isotropic = ax === 1 && ay === 1
  const axes = Object.freeze({
    right: isotropic ? Object.freeze<WorldVector>({ x: cos, y: sin }) : unitVector(cos * ax, sin * ay),
    down: isotropic ? Object.freeze<WorldVector>({ x: 0 - sin, y: cos }) : unitVector((0 - sin) * ax, cos * ay),
  })

  return Object.freeze<ViewTransform>({
    planeRevision: input.planeRevision,
    camera,
    screen,
    planar: Object.freeze({
      affine: Object.freeze([wa, wb, wc, wd, tx, ty] as const),
    }),
    worldToScreen,
    screenToWorld,
    projectAnchors(world: Float64Array, out: Float32Array, count: number): void {
      for (let index = 0; index < count; index++) {
        const x = world[index * 2]!
        const y = world[index * 2 + 1]!
        out[index * 2] = wa * x + wc * y + tx
        out[index * 2 + 1] = wb * x + wd * y + ty
      }
    },
    metresPerPixelAt(p?: WorldPoint): number {
      const groundScale = plane.groundScaleAt(p ?? plane.toPlane(camera.center))
      return Math.sqrt(groundScale.x * groundScale.y) / scale
    },
    screenDistance(from: WorldPoint, to: WorldPoint): number {
      return Math.hypot((to.x - from.x) / ax, (to.y - from.y) / ay) * scale
    },
    screenAxesInWorld(): { readonly right: WorldVector; readonly down: WorldVector } {
      return axes
    },
    visibleWorldQuad(): WorldQuad {
      return [
        screenToWorld({ x: 0, y: 0 }),
        screenToWorld({ x: screen.width, y: 0 }),
        screenToWorld({ x: screen.width, y: screen.height }),
        screenToWorld({ x: 0, y: screen.height }),
      ]
    },
    worldQuadToScreen(q: WorldQuad): readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] {
      return [worldToScreen(q[0]), worldToScreen(q[1]), worldToScreen(q[2]), worldToScreen(q[3])]
    },
    pixelsPerMetre: scale,
    toView: (p: WorldPoint): ConformalPoint => plane.toView(p),
    fromView: (p: ConformalPoint): WorldPoint => plane.fromView(p),
    northUp: angularDistanceToNorth(camera.bearingDeg) < NORTH_UP_TOLERANCE_DEG && camera.pitchDeg === 0,
  })
}

/** Local CSS pixels per true WGS84 ground metre at `point` (reciprocal of `view.metresPerPixelAt(point)`). */
export function pixelsPerMetreAt(view: Pick<ViewTransform, 'metresPerPixelAt'>, point: WorldPoint): number {
  return 1 / view.metresPerPixelAt(point)
}
