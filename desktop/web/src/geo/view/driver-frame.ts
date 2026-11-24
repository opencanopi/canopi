// canvas/runtime/view/driver-frame.ts  (pure)
//
// The frame helpers both camera drivers share (the headless driver and maplibre/camera-driver.ts): what a frame is built from, when
// a change publishes, the frame itself, the screen and move checks, and the zoom factor held inside the zoom range.

import type { SessionPlane } from '../session-plane'
import { isWorkspaceOverviewScale } from '../workspace-camera-policy'
import type { CameraMove } from './camera-driver'
import { scaleBoundsAt, worldZoomFloor, type NavigationPolicy } from './navigation-policy'
import type { ScreenInsets, ScreenPoint, ViewCamera, ViewFrame, ViewScreen } from './types'
import { buildViewTransform } from './view-transform'

/** Everything a frame is built from; a change publishes only when one of these moved. */
export interface DriverFrameState {
  readonly camera: ViewCamera
  readonly screen: ViewScreen
  readonly insets: ScreenInsets
  readonly scaleBounds: { readonly min: number; readonly max: number }
  readonly plane: SessionPlane
  readonly planeRevision: number
}

/** A driver's frame state for `camera`, with the scale bounds of its screen. */
export function driverFrameState(
  camera: ViewCamera,
  placed: { readonly screen: ViewScreen; readonly insets: ScreenInsets; readonly plane: SessionPlane; readonly planeRevision: number },
  policy: NavigationPolicy,
): DriverFrameState {
  return {
    ...placed,
    camera,
    scaleBounds: scaleBoundsAt(placed.screen, policy),
  }
}

/** The frame a driver publishes; the driver host stamps the revisions readers see. */
export function driverFrame(state: DriverFrameState, attached: boolean): ViewFrame {
  const view = buildViewTransform({
    camera: state.camera,
    screen: state.screen,
    plane: state.plane,
    planeRevision: state.planeRevision,
  })
  return Object.freeze<ViewFrame>({
    view,
    mode: isWorkspaceOverviewScale(view.pixelsPerMetre) ? 'overview' : 'site',
    scaleBounds: state.scaleBounds,
    insets: state.insets,
    attached,
    revision: 0,
  })
}

export function sameDriverFrameState(previous: DriverFrameState, next: DriverFrameState): boolean {
  return previous.camera.center.lon === next.camera.center.lon
    && previous.camera.center.lat === next.camera.center.lat
    && previous.camera.zoom === next.camera.zoom
    && previous.camera.bearingDeg === next.camera.bearingDeg
    && previous.screen.width === next.screen.width
    && previous.screen.height === next.screen.height
    && previous.screen.devicePixelRatio === next.screen.devicePixelRatio
    && previous.insets.top === next.insets.top
    && previous.insets.right === next.insets.right
    && previous.insets.bottom === next.insets.bottom
    && previous.insets.left === next.insets.left
    && previous.scaleBounds.min === next.scaleBounds.min
    && previous.scaleBounds.max === next.scaleBounds.max
    && previous.plane === next.plane
    && previous.planeRevision === next.planeRevision
}

/** Invalid or missing sizes read as 0, an invalid density as 1. */
export function normaliseScreen(screen: {
  readonly width?: number
  readonly height?: number
  readonly devicePixelRatio?: number
}): ViewScreen {
  const size = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0)
  const density = screen.devicePixelRatio
  return Object.freeze({
    width: size(screen.width),
    height: size(screen.height),
    devicePixelRatio: density !== undefined && Number.isFinite(density) && density > 0 ? density : 1,
  })
}

/** A move with a non-finite number, or a zoom factor that is not positive, is refused: both drivers ignore it, and navigation
 *  keeps its bookmark because the view did not move. */
export function acceptsMove(move: CameraMove): boolean {
  switch (move.kind) {
    case 'pan-by':
      return finitePoint(move.deltaPx)
    case 'zoom-around':
      return Number.isFinite(move.factor) && move.factor > 0 && finitePoint(move.anchorPx)
    case 'rotate-around':
      return Number.isFinite(move.bearingDeg) && (move.anchorPx === 'centre' || finitePoint(move.anchorPx))
    case 'set': {
      const { center, zoom, bearingDeg } = move.target
      return [center.lon, center.lat, zoom, bearingDeg].every(Number.isFinite)
    }
  }
}

function finitePoint(point: ScreenPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

/** The zoom factor held inside the zoom range, so a zoom about an anchor keeps the anchor. */
export function zoomFactorWithinRange(camera: ViewCamera, screen: ViewScreen, policy: NavigationPolicy, factor: number): number {
  const floor = Math.max(policy.minZoom, worldZoomFloor(screen))
  const wanted = camera.zoom + Math.log2(factor)
  const zoom = Math.min(policy.maxZoom, Math.max(Math.min(policy.maxZoom, floor), wanted))
  return zoom === wanted ? factor : 2 ** (zoom - camera.zoom)
}
