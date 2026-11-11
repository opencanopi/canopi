// canvas/runtime/view/navigation.ts  (the camera policy; the only user of CameraDriver; implements RotationSession from read-surface.ts)
//
// Owns how the view moves on command: zoom steps, the fits (Fit to Design, Return to Design, zoom to selection, the opening fit),
// the temporary-focus bookmark (LiDAR's Fit to data), jumps to a place or a camera, key turns, resets, turning to an edge, and rotation sessions. Every
// fit is oriented at its bearing (fit.ts) and lands as a 'set' move to the camera that shows its placement.

import { isWorkspaceOverviewScale, WORKSPACE_OVERVIEW_SCALE_THRESHOLD } from '../../workspace-camera-policy'
import type { CameraDriverHost, CameraMove } from './camera-driver'
import { placementCentre, screenToGeo } from './camera-math'
import { designPinContains, validDesignPinExtent } from './design-pin'
import { acceptsMove } from './driver-frame'
import { fitScene, fitTemporaryBounds, isEmptyExtent, type FitFrame } from './fit'
import {
  nextStep,
  normaliseBearing,
  roundToStep,
  shortestArc,
  snapBearing,
  type NavigationPolicy,
} from './navigation-policy'
import type { RotationSession, ViewCommandSurface } from './read-surface'
import type {
  DesignPinExtent,
  PlanarCamera,
  SceneBounds,
  SceneExtent,
  ScreenInsets,
  ScreenPoint,
  TemporaryBoundsFocusOptions,
  ViewCamera,
  ViewTransform,
  WorldPoint,
} from './types'
import { planarCameraOf } from './view-transform'

export interface ViewNavigationDeps {
  readonly driver: CameraDriverHost                   // the only CameraDriver user
  readonly policy: () => NavigationPolicy
  /** The current scene's extent, for Fit to Design, Return to Design and the opening fit. */
  readonly readSceneExtent: () => SceneExtent
  /** The selected objects' outlines at the live scale, for zoom to selection. */
  readonly readSelectionPoints: () => readonly WorldPoint[]
}

export interface ViewNavigation extends ViewCommandSurface {
  zoomToFit(): void   // keeps the bearing
  /** Oriented at the current bearing: the box's four corners are fitted, not the box on screen axes. */
  focusTemporaryBounds(bounds: SceneBounds, options: TemporaryBoundsFocusOptions): boolean
  returnFromTemporaryFocus(): boolean        // bookmark is a ViewCamera: re-origin cannot invalidate it
  clearTemporaryFocus(): void
  /** Opening a Design: the camera it was saved with (`saved`, already framed for this map) or else the oriented fit at the
   *  given bearing; an empty scene opens at its saved camera north up, else on the north-up fit (spec §4.15, 2.1-Q28);
   *  a saved camera that is not finite is ignored. Every open path calls it through
   *  document-surface.ts's open fit; Fit to Design stays zoomToFit. */
  openAt(bearingDeg: number, saved?: ViewCamera | null): void

  // rotation
  turnToEdge(a: WorldPoint, b: WorldPoint): void   // smaller turn that makes a→b horizontal; never snapped
  beginRotation(pivot: ScreenPoint | 'centre'): RotationSession

  /** Whether a screen point is on the overview's Design pin, by the box it registered (setDesignPinExtent); the ToolHost's
   *  tap and hover in overview. */
  onDesignPin(at: ScreenPoint): boolean

  // gesture sinks (InputRouter only)
  panByPx(deltaPx: ScreenPoint): void
  zoomAroundPx(anchor: ScreenPoint, factor: number): void
}

/** Zoom in and zoom out: the step about the screen centre. */
const ZOOM_STEP_FACTOR = 1.1
/** Return to Design's fallback frames this many metres across the shorter screen side. */
const RETURN_VIEW_METRES = 100
const ROTATION_STEP_DEG = 15
const NO_INSETS: ScreenInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

/** view/ cannot measure a scene (P4): every fit reads the runtime's extent of the current scene from `readSceneExtent`. */
export function createViewNavigation(deps: ViewNavigationDeps): ViewNavigation {
  /**
   * The view to go back to: the one before the first unreturned temporary focus, a camera so a re-origin cannot invalidate it.
   * Every move the camera accepts goes through `apply`, which drops it: a pan, zoom, turn, fit or jump is the user going elsewhere, so a later return
   * frames the Design instead of a stale view. Only a temporary focus and frameBounds keep it across their own move.
   */
  let bookmark: ViewCamera | null = null
  /** The live rotation session; key turns and resets wait until it ends. */
  let rotation: object | null = null
  /** The Design pin's measured box about its point, while it shows. */
  let pinExtent: DesignPinExtent | null = null

  const frame = () => deps.driver.frames.viewFrame.peek()
  const driver = () => deps.driver.current()
  const apply = (move: CameraMove): void => {
    if (!acceptsMove(move)) return   // the view stays, and so does the bookmark
    bookmark = null
    driver().apply(move)
  }
  const jump = (target: ViewCamera): void => apply({ kind: 'set', target, animation: 'none' })
  /** Shows a fit's placement: the camera that puts its centre at the screen centre, at its scale and bearing. */
  const place = (planar: PlanarCamera): void => {
    const { view } = frame()
    jump(cameraCentredOn(view, placementCentre(planar, view.screen), planar.scale, planar.bearingDeg))
  }

  function screenCentre(): ScreenPoint {
    const { screen } = frame().view
    return { x: screen.width / 2, y: screen.height / 2 }
  }

  function fitFrame(): FitFrame {
    const current = frame()
    const { view } = current
    return { screen: view.screen, insets: current.insets, scaleBounds: current.scaleBounds, current: planarCameraOf(view) }
  }

  /** A temporary focus's framing of `bounds` at the current bearing, or null when they cannot be framed. */
  function boundsFraming(bounds: SceneBounds, options: TemporaryBoundsFocusOptions): PlanarCamera | null {
    const bearing = driver().bearingTarget()
    return fitTemporaryBounds(fitFrame(), bounds, options, bearing)
  }

  function turnTo(bearingDeg: number): void {
    apply({ kind: 'rotate-around', anchorPx: 'centre', bearingDeg })
  }

  function zoomAroundPx(anchor: ScreenPoint, factor: number): void {
    apply({ kind: 'zoom-around', anchorPx: anchor, factor })
  }

  return {
    zoomIn() {
      zoomAroundPx(screenCentre(), ZOOM_STEP_FACTOR)
    },
    zoomOut() {
      zoomAroundPx(screenCentre(), 1 / ZOOM_STEP_FACTOR)
    },
    zoomBy(factor) {
      zoomAroundPx(screenCentre(), factor)
    },
    zoomToFit() {
      const bearing = driver().bearingTarget()
      place(fitScene(fitFrame(), deps.readSceneExtent(), bearing))
    },
    zoomToSelection() {
      const points = deps.readSelectionPoints()
      if (points.length === 0) return
      const bearing = driver().bearingTarget()
      // Never empty here, so no empty-scene scale applies.
      place(fitScene(fitFrame(), { extentPoints: () => points, emptySceneScale: 0 }, bearing))
    },
    returnToDesign(options) {
      // The fit when it reaches site scale and moves the view, else a usable scale: the plane origin centred, or the
      // ground at the view centre kept there (picking a tool in overview).
      const bearing = driver().bearingTarget()
      const framing = fitFrame()
      const fitted = fitScene(framing, deps.readSceneExtent(), bearing)
      if (!isWorkspaceOverviewScale(fitted.scale) && !samePlanar(fitted, framing.current)) {
        place(fitted)
        return
      }
      const { width, height } = framing.screen
      const clamped = Math.min(framing.scaleBounds.max, Math.max(framing.scaleBounds.min, Math.min(width, height) / RETURN_VIEW_METRES))
      const scale = Math.max(WORKSPACE_OVERVIEW_SCALE_THRESHOLD, clamped)
      if (options?.around === 'view-centre') {
        zoomAroundPx(screenCentre(), scale / framing.current.scale)
        return
      }
      place({ x: width / 2, y: height / 2, scale, bearingDeg: bearing })
    },
    focusTemporaryBounds(bounds, options) {
      const focused = boundsFraming(bounds, options)
      if (!focused) return false
      // A chained focus keeps the first one's bookmark: a return lands on the view before the first focus.
      const saved = bookmark ?? frame().view.camera
      place(focused)
      bookmark = saved
      return true
    },
    frameBounds(bounds, options) {
      const framed = boundsFraming(bounds, options)
      if (!framed) return false
      const saved = bookmark   // the plant finder's zoom neither sets nor drops it
      place(framed)
      bookmark = saved
      return true
    },
    returnFromTemporaryFocus() {
      const saved = bookmark
      if (!saved) return false
      jump(saved)   // drops the bookmark
      return true
    },
    clearTemporaryFocus() {
      bookmark = null
    },
    setDesignPinExtent(extent) {
      pinExtent = validDesignPinExtent(extent)
    },
    onDesignPin(at) {
      return designPinContains(frame(), pinExtent, at)
    },
    setFramingInsets(insets) {
      const valid = [insets.top, insets.right, insets.bottom, insets.left].every((edge) => Number.isFinite(edge) && edge >= 0)
      driver().setInsets(valid ? insets : NO_INSETS)
    },
    openAt(bearingDeg, saved) {
      const extent = deps.readSceneExtent()
      // A new or empty Design opens north up: "Where is your site?" appears over a north-up overview, unless the empty
      // Design was saved with a view (placed by a search, canopi-eon8.9, 2.1-Q28), which opens there, north up.
      const empty = isEmptyExtent(extent, frame().view.pixelsPerMetre)
      if (saved && isFiniteCamera(saved)) {
        jump(empty ? { ...saved, bearingDeg: 0 } : saved)
        return
      }
      const bearing = empty ? 0 : normaliseBearing(bearingDeg)
      const fitted = fitScene(fitFrame(), extent, bearing)
      // A fit that kept another bearing turns about the screen centre: the same centre and scale at the opening bearing.
      const { view } = frame()
      jump(cameraCentredOn(view, placementCentre(fitted, view.screen), fitted.scale, bearing))
    },
    showPlace(target, zoom, options) {
      if (![target.lon, target.lat, zoom].every(Number.isFinite)) return false
      apply({
        kind: 'set',
        target: { center: { lon: target.lon, lat: target.lat }, zoom, bearingDeg: driver().bearingTarget(), pitchDeg: 0 },
        animation: options?.motion === 'fly' ? 'fly' : 'none',
      })
      return true
    },
    showCamera(camera, options) {
      const motion = options?.motion ?? 'jump'
      apply({ kind: 'set', target: camera, animation: motion === 'jump' ? 'none' : motion })
    },
    resetNorth() {
      if (rotation || driver().bearingTarget() === 0) return
      turnTo(0)
    },
    rotateBy(direction) {
      if (rotation) return
      turnTo(nextStep(driver().bearingTarget(), direction, ROTATION_STEP_DEG))
    },
    turnToEdge(a, b) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (![dx, dy].every(Number.isFinite) || (dx === 0 && dy === 0)) return
      // At bearing β a plane vector turns counter-clockwise on screen by β, so a→b is level at atan2(dy, dx) and half a turn on.
      const along = normaliseBearing(Math.atan2(dy, dx) * 180 / Math.PI)
      const opposite = normaliseBearing(along + 180)
      const from = driver().bearingTarget()
      turnTo(Math.abs(shortestArc(from, along)) <= Math.abs(shortestArc(from, opposite)) ? along : opposite)
    },
    beginRotation(pivot) {
      driver().stopAnimation()
      const start = frame().view.camera
      const session = {}
      rotation = session
      const live = () => rotation === session
      // A twist's pivot moves with its centroid (A5): each turn, and the release's snap, go about the latest one.
      let anchor = pivot
      return {
        update(totalDeltaDeg, { step, anchorPx }) {
          if (!live() || !Number.isFinite(totalDeltaDeg)) return
          if (anchorPx) anchor = anchorPx
          const raw = start.bearingDeg + totalDeltaDeg
          apply({
            kind: 'rotate-around',
            anchorPx: anchor,
            bearingDeg: step ? roundToStep(raw, ROTATION_STEP_DEG) : normaliseBearing(raw),
          })
        },
        end() {
          if (!live()) return
          rotation = null
          const bearing = frame().view.camera.bearingDeg
          if (bearing !== 0 && snapBearing(bearing) === 0) {
            apply({ kind: 'rotate-around', anchorPx: anchor, bearingDeg: 0 })
          }
        },
        cancel() {
          if (!live()) return
          rotation = null
          jump(start)
        },
      }
    },
    panByPx(deltaPx) {
      apply({ kind: 'pan-by', deltaPx })
    },
    zoomAroundPx,
  }
}

/** The camera that shows a plane point at the screen centre at a scale and bearing, measured through the current view (a flight's target). */
function cameraCentredOn(view: ViewTransform, point: WorldPoint, pixelsPerMetre: number, bearingDeg: number): ViewCamera {
  return {
    center: screenToGeo(view.camera, view.screen, view.worldToScreen(point)),
    zoom: view.camera.zoom + Math.log2(pixelsPerMetre / view.pixelsPerMetre),
    bearingDeg,
    pitchDeg: 0,
  }
}

function isFiniteCamera(camera: ViewCamera): boolean {
  return [camera.center.lon, camera.center.lat, camera.zoom, camera.bearingDeg].every(Number.isFinite)
}

function samePlanar(a: PlanarCamera, b: PlanarCamera): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale && a.bearingDeg === b.bearingDeg
}
