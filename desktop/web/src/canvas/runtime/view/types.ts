// canvas/runtime/view/types.ts  (pure: no DOM, MapLibre, Pixi)

import type { ReadonlySignal } from '@preact/signals'
import type { GeoPoint } from '../../../generated/contracts'

/** Session-plane metres: x east, y south (ADR 0001). */
export interface WorldPoint { readonly x: number; readonly y: number }
export interface WorldVector { readonly x: number; readonly y: number }
/** CSS px relative to the map canvas' top-left corner. */
export interface ScreenPoint { readonly x: number; readonly y: number }
/** Screen TL, TR, BR, BL order. */
export type WorldQuad = readonly [WorldPoint, WorldPoint, WorldPoint, WorldPoint]
export interface ScreenInsets { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
/** The overview's Design pin box as CSS px offsets from its point: left and top at or below zero, right and bottom at or above
 *  (view/design-pin.ts). */
export interface DesignPinExtent { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** World-axis box in plane metres. */
export interface SceneBounds { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
/** What Fit to Design, Return to Design and the opening fit frame. */
export interface SceneExtent {
  /** The scene's extent at a candidate scale: corner points of every plant, zone and note footprint, in plane metres.
   *  Notes and default-mode plants are screen-sized, so the extent depends on the scale. The runtime supplies it through
   *  canvas/runtime/scene-extent.ts, from plant-presentation.ts, annotation-layout.ts and zone-geometry.ts, so view/ imports
   *  none of them (P4). */
  readonly extentPoints: (pixelsPerMetre: number) => readonly WorldPoint[]
  /** Scale that frames an empty Design, centred on the session plane origin; not above zero keeps the view. */
  readonly emptySceneScale: number
}
export interface TemporaryBoundsFocusOptions {
  /** Symmetric CSS-pixel padding reserved by the caller's presentation. */
  readonly paddingCssPx: number
  /** Optional external ceiling, such as a MapLibre zoom-limit equivalent. */
  readonly maximumScale?: number
}

/**
 * The geographic camera in MapLibre's terms. bearingDeg: the compass direction that is
 * up on screen, degrees clockwise from true north, normalised to [0, 360)
 * (common-types views.rs validates [0, 360]).
 */
export interface ViewCamera {
  readonly center: GeoPoint          // ground point under the screen centre
  readonly zoom: number              // MapLibre zoom
  readonly bearingDeg: number
  /** Literal 0 until the pitch phase widens it to number; the compiler then lists every consumer. */
  readonly pitchDeg: 0
}

/**
 * A plane placement: a plane point p lands on screen at turn(p × scale, bearingDeg) + { x, y }: scaled, turned counter-clockwise
 * on screen by bearingDeg about the screen origin (so the compass direction bearingDeg points up), then translated, so { x, y } is
 * the plane origin's screen point; at bearing 0, screen = p × scale + { x, y }. No driver holds one (both hold a
 * ViewCamera): it is what a fit computes (fit.ts), what planarCameraOf reads off a transform for the chrome, and how tests place
 * the test view. A placement read back from a camera matches within 1e-6 px, not bit for bit.
 */
export interface PlanarCamera { readonly x: number; readonly y: number; readonly scale: number; readonly bearingDeg: number }

export interface ViewScreen { readonly width: number; readonly height: number; readonly devicePixelRatio: number }

/** Renderer and bulk-projection fast path. */
export interface PlanarProjection {
  /** 2x3 affine in Pixi order [a, b, c, d, tx, ty]. */
  readonly affine: readonly [number, number, number, number, number, number]
}

export interface ViewTransform {
  readonly planeRevision: number     // session-plane identity; stale transforms are refused after re-origin
  readonly camera: ViewCamera
  readonly screen: ViewScreen
  readonly planar: PlanarProjection

  worldToScreen(p: WorldPoint): ScreenPoint
  /** The ground under a screen point. */
  screenToWorld(s: ScreenPoint): WorldPoint
  /** Bulk billboard projection: reads [x0,y0,x1,y1,…] metres, writes CSS px. No allocation. */
  projectAnchors(world: Float64Array, out: Float32Array, count: number): void

  /** Local ground resolution at a world point (view centre if omitted): the scale bar and ratio read it. */
  metresPerPixelAt(p?: WorldPoint): number
  screenDistance(a: WorldPoint, b: WorldPoint): number
  /** Unit world vectors of screen-right and screen-down: one pair for the whole plane (the camera has no pitch). */
  screenAxesInWorld(): { readonly right: WorldVector; readonly down: WorldVector }

  /** The ground under the whole screen's corners; framing inside the insets is fit.ts's framingRect. */
  visibleWorldQuad(): WorldQuad
  /** Four projected corners, never two (rotation-handle anchor, menu anchor). */
  worldQuadToScreen(q: WorldQuad): readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint]

  readonly pixelsPerMetre: number            // at the plane origin (zoom bands, policy)
  readonly northUp: boolean                  // angularDistanceToNorth(bearing) < 0.05° and pitch 0
}

/** Everything the runtime publishes per camera change. Runtime-only (policy P10). */
export interface ViewFrame {
  readonly view: ViewTransform
  readonly mode: 'site' | 'overview'         // overview below 0.1 px/m (canvas/workspace-camera-policy.ts)
  readonly scaleBounds: { readonly min: number; readonly max: number }   // the effective bounds: policy zooms with the single-world floor at the live bearing (§1.1b)
  readonly insets: ScreenInsets              // from the visible-map-area seam
  readonly attached: boolean
  readonly revision: number
}

export type FramePhase = 'tools' | 'overlays'   // run in this order inside the `move` handler

export interface ViewFrameSource {
  readonly viewFrame: ReadonlySignal<ViewFrame>
  /** The frame after 150 ms without camera change (re-origin, last view, label admission, coverage). */
  readonly settledViewFrame: ReadonlySignal<ViewFrame>
  /** Synchronous per-frame callbacks; never effects, so per-frame work cannot fan out into Preact. */
  onViewFrame(phase: FramePhase, listener: (frame: ViewFrame) => void): () => void
}

/**
 * A driver's own frames: nobody reads a driver's settled frame or its overlays phase (only the host's own frame source, which
 * relays 'tools' and keeps its own settle, is read for either), so a driver publishes one unphased listener list and no settle.
 */
export interface DriverFrameSource {
  readonly viewFrame: ReadonlySignal<ViewFrame>
  onViewFrame(listener: (frame: ViewFrame) => void): () => void
}

