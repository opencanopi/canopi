// canvas/runtime/view/headless-driver.ts
//
// Owns the camera while no map is attached (tests, before attach, after a failure): a geographic ViewCamera, moved with the same
// camera-math and constrainCamera as the MapLibre driver and built with the one buildViewTransform (ADR 0016). Every move publishes
// one ViewFrame when anything in it changed. Every move jumps: without a map a flight jumps too. A resize keeps the view centre, as
// MapLibre does; a re-origin keeps the camera's ground and rebuilds the frame in the new plane.

import { signal } from '@preact/signals'
import type { SessionPlane } from '../session-plane'
import type { CameraDriver, CameraDriverDeps, CameraDriverFailure, CameraMove } from './camera-driver'
import { panCamera, rotateCameraAround, zoomCameraAround } from './camera-math'
import {
  acceptsMove,
  driverFrame,
  driverFrameState,
  normaliseScreen,
  sameDriverFrameState,
  zoomFactorWithinRange,
  type DriverFrameState,
} from './driver-frame'
import { createDriverFrameSource } from './frame-source'
import { constrainCamera, normaliseBearing } from './navigation-policy'
import type { ScreenInsets, ViewCamera, ViewScreen } from './types'

export interface HeadlessCameraDriverOptions {
  readonly deps: CameraDriverDeps
  readonly plane: SessionPlane
  /** Invalid sizes read as 0 and an invalid density as 1. */
  readonly screen: ViewScreen
  /** The starting camera, constrained like a move; it is the first frame, which is not published. */
  readonly camera: ViewCamera
  readonly insets?: ScreenInsets
}

const NO_INSETS: ScreenInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

export function createHeadlessCameraDriver(options: HeadlessCameraDriverOptions): CameraDriver {
  const { deps } = options
  let plane = options.plane
  let planeRevision = 0
  let screen = normaliseScreen(options.screen)
  let insets = frozenInsets(options.insets ?? NO_INSETS)
  let disposed = false
  const queued: Array<() => void> = []
  const failure = signal<CameraDriverFailure | null>(null)

  let camera = constrained(validCamera(options.camera)
    ?? { center: plane.origin, zoom: plane.zoomForPixelsPerMetre(1), bearingDeg: 0, pitchDeg: 0 })
  let published = frameState()
  const frames = createDriverFrameSource(driverFrame(published, false))

  /** The zoom range and the one-world hold (bearing-free). */
  function constrained(candidate: ViewCamera): ViewCamera {
    const held = constrainCamera(candidate, screen, deps.policy())
    return Object.isFrozen(held) ? held : Object.freeze({ ...held, center: Object.freeze({ ...held.center }) })
  }

  function frameState(): DriverFrameState {
    return driverFrameState(camera, { screen, insets, plane, planeRevision }, deps.policy())
  }

  function commit(candidate: ViewCamera | null): void {
    if (!candidate) return
    camera = constrained(candidate)
    const state = frameState()
    if (sameDriverFrameState(published, state)) return
    published = state
    frames.publish(driverFrame(state, false))
    while (!frames.dispatching && queued.length > 0) queued.shift()!()
  }

  /** A call made while a frame is dispatched runs once, after every listener, in the same task. */
  function queuedWhileDispatching(run: () => void): boolean {
    if (!frames.dispatching) return false
    queued.push(run)
    return true
  }

  function apply(move: CameraMove): void {
    if (disposed || !acceptsMove(move) || queuedWhileDispatching(() => apply(move))) return
    switch (move.kind) {
      case 'pan-by':
        commit(panCamera(camera, screen, move.deltaPx))
        return
      case 'zoom-around': {
        // The factor is held inside the zoom range at the live bearing first, as the MapLibre driver holds it, so the anchor holds.
        const factor = zoomFactorWithinRange(camera, screen, deps.policy(), move.factor)
        commit(zoomCameraAround(camera, screen, move.anchorPx, factor))
        return
      }
      case 'rotate-around':
        commit(rotateCameraAround(camera, screen, move.anchorPx, move.bearingDeg))
        return
      case 'set':
        // Without a map there is no flight: 'fly' jumps.
        commit(validCamera(move.target))
        return
    }
  }

  function planeChanged(next: SessionPlane): void {
    if (disposed || queuedWhileDispatching(() => planeChanged(next)) || next === plane) return
    plane = next
    planeRevision += 1
    commit(camera)
  }

  function setScreen(next: ViewScreen): void {
    if (disposed || queuedWhileDispatching(() => setScreen(next))) return
    const normalised = normaliseScreen(next)
    if (
      normalised.width === screen.width
      && normalised.height === screen.height
      && normalised.devicePixelRatio === screen.devicePixelRatio
    ) return
    screen = normalised
    commit(camera)
  }

  function setInsets(next: ScreenInsets): void {
    if (disposed || queuedWhileDispatching(() => setInsets(next))) return
    insets = frozenInsets(next)
    commit(camera)
  }

  return {
    frames,
    failure,
    apply,
    bearingTarget: () => camera.bearingDeg,
    // Nothing ever animates without a map.
    stopAnimation: () => {},
    planeChanged,
    setScreen,
    setInsets,
    dispose() {
      disposed = true
      queued.length = 0
      frames.dispose()
    },
  }
}

/** A camera with any non-finite value is refused; the bearing is normalised. */
function validCamera(camera: ViewCamera): ViewCamera | null {
  if (![camera.center.lon, camera.center.lat, camera.zoom, camera.bearingDeg].every(Number.isFinite)) return null
  const bearingDeg = normaliseBearing(camera.bearingDeg)
  return bearingDeg === camera.bearingDeg ? camera : { ...camera, bearingDeg }
}

function frozenInsets(insets: ScreenInsets): ScreenInsets {
  return Object.freeze({ top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left })
}
