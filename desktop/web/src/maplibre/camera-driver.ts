// maplibre/camera-driver.ts
//
// Owns one MapLibre map's camera while it is attached (ADR 0016): the only code that calls camera methods (jumpTo, flyTo, stop,
// resize) on the workspace and snapshot maps. Targets come from view/camera-math and constrainCamera; the map receives explicit
// jumpTo values for every move but a flight (every turn jumps, U34) and flyTo for flights, and every frame is built from MapLibre's
// read-backs. The map's transformConstrain is an adapter over the same constrainCamera, which is bearing-free (U34), so it covers
// every flight frame.

import { signal } from '@preact/signals'
import type { SessionPlane } from '../canvas/session-plane'
import type { CameraDriver, CameraDriverDeps, CameraDriverFailure, CameraMove } from '../canvas/runtime/view/camera-driver'
import {
  panCamera,
  rotateCameraAround,
  zoomCameraAround,
} from '../canvas/runtime/view/camera-math'
import {
  acceptsMove,
  driverFrame,
  driverFrameState,
  normaliseScreen,
  sameDriverFrameState,
  zoomFactorWithinRange,
  type DriverFrameState,
} from '../canvas/runtime/view/driver-frame'
import { createDriverFrameSource } from '../canvas/runtime/view/frame-source'
import { constrainCamera, normaliseBearing } from '../canvas/runtime/view/navigation-policy'
import type { GeoPoint } from '../generated/contracts'
import type {
  ScreenInsets,
  ViewCamera,
  ViewScreen,
} from '../canvas/runtime/view/types'
import type { MapLibreLngLat, MapLibreMapInstance, MapLibreTransformConstrain } from './loader'
import { redactCredentials } from './redact-credentials'

/** The map operations the driver uses: MapLibre 6.10.0 declares every one, so the driver never falls back. */
export type MapLibreCameraDriverMap = Required<Pick<MapLibreMapInstance,
  | 'jumpTo'
  | 'flyTo'
  | 'stop'
  | 'resize'
  | 'on'
  | 'off'
  | 'getCenter'
  | 'getZoom'
  | 'getBearing'
  | 'getPitch'
  | 'setTransformConstrain'
  | 'getCanvas'
>>

const NO_INSETS: ScreenInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
const EMPTY_SCREEN: ViewScreen = Object.freeze({ width: 0, height: 0, devicePixelRatio: 1 })

interface Flight {
  readonly targetBearingDeg: number
  /** False while flyTo itself runs: a flight MapLibre completes inside that call (reduced motion) ends there. */
  started: boolean
  ended: boolean
}

/**
 * `createMapLibreCameraDriver(map, plane, deps)` (spec §1.1 Attachment). A map whose camera cannot be read, or whose read-back
 * pitch is not 0, fails the driver with 'map-error'; its host then detaches it. The driver resizes its map to the container once,
 * starts at the map canvas' CSS size, and changes it only through setScreen.
 */
export function createMapLibreCameraDriver(
  map: MapLibreCameraDriverMap,
  initialPlane: SessionPlane,
  deps: CameraDriverDeps,
): CameraDriver {
  let plane = initialPlane
  let planeRevision = 0
  let screen: ViewScreen = EMPTY_SCREEN
  let insets = NO_INSETS
  let flight: Flight | null = null
  let disposed = false
  /** Depth of the driver's own map calls: the 'move' and 'moveend' events they fire are not MapLibre's own changes. */
  let ownCalls = 0
  /** False when the first read failed: dispose then has no guard to take back. */
  let guardInstalled = false
  const queued: Array<() => void> = []
  const failure = signal<CameraDriverFailure | null>(null)

  /** MapLibre's guard never sees the bearing, and needs none: the constrain is bearing-free. */
  const guard: MapLibreTransformConstrain = (lngLat, zoom) => {
    const candidate: ViewCamera = { center: { lon: lngLat.lng, lat: lngLat.lat }, zoom, bearingDeg: 0, pitchDeg: 0 }
    const held = constrainCamera(candidate, screen, deps.policy())
    if (held === candidate) return { center: lngLat, zoom }
    return { center: held.center === candidate.center ? lngLat : sameKindOfLngLat(lngLat, held.center), zoom: held.zoom }
  }

  // The map never resizes itself (trackResize: false), and a container resize reported before this driver existed reached only
  // the headless camera: the map takes its container's size once here, before the guard reads the screen.
  if (live()) send(() => map.resize())
  screen = canvasScreen(map)
  if (readCamera()) {
    try {
      map.setTransformConstrain(guard)
      guardInstalled = true
    } catch (error) {
      fail(`The map could not take the camera guard: ${messageOf(error)}`)
    }
  }
  // MapLibre applies the guard as soon as it is installed, so the first frame is read after it.
  let published = frameState(readCamera() ?? placeholderCamera())
  const frames = createDriverFrameSource(driverFrame(published, true))

  const onMove = () => {
    if (ownCalls > 0 || !live()) return
    if (queuedWhileDispatching(refresh)) return
    refresh()
  }
  const onMoveEnd = () => {
    const running = flight
    if (!running || !live()) return
    if (!running.started) {
      running.ended = true
      return
    }
    if (ownCalls > 0) return
    endFlight()
  }
  const listeners = [['move', onMove], ['moveend', onMoveEnd]] as const
  const subscribed: Array<(typeof listeners)[number]> = []
  if (live()) {
    try {
      for (const entry of listeners) {
        map.on(entry[0], entry[1])
        subscribed.push(entry)
      }
    } catch (error) {
      fail(`The map could not report its camera: ${messageOf(error)}`)
    }
  }

  function live(): boolean {
    return !disposed && failure.peek() === null
  }

  function fail(message: string): void {
    if (failure.peek()) return
    flight = null
    queued.length = 0
    failure.value = { reason: 'map-error', message: redactCredentials(message) }
  }

  function placeholderCamera(): ViewCamera {
    return { center: plane.origin, zoom: deps.policy().minZoom, bearingDeg: 0, pitchDeg: 0 }
  }

  /** MapLibre's camera, the bearing normalised from its (−180, 180] to [0, 360). Null (and the driver failed) when it cannot be read. */
  function readCamera(): ViewCamera | null {
    if (failure.peek()) return null
    try {
      const pitch = map.getPitch()
      if (pitch !== 0) {
        fail(`The map reported a pitched camera (${pitch}°).`)
        return null
      }
      const center = map.getCenter()
      const zoom = map.getZoom()
      const bearing = map.getBearing()
      if (![center.lng, center.lat, zoom, bearing].every(Number.isFinite)) {
        fail('The map reported a camera that is not finite.')
        return null
      }
      return { center: { lon: center.lng, lat: center.lat }, zoom, bearingDeg: normaliseBearing(bearing), pitchDeg: 0 }
    } catch (error) {
      fail(`The map camera could not be read: ${messageOf(error)}`)
      return null
    }
  }

  function frameState(camera: ViewCamera): DriverFrameState {
    return driverFrameState(camera, { screen, insets, plane, planeRevision }, deps.policy())
  }

  /** Publishes one frame when anything in it changed, then runs the calls queued meanwhile. */
  function commit(camera: ViewCamera): void {
    const state = frameState(camera)
    if (sameDriverFrameState(published, state)) return
    published = state
    frames.publish(driverFrame(state, true))
    while (!frames.dispatching && queued.length > 0 && live()) queued.shift()!()
  }

  function refresh(): void {
    const camera = readCamera()
    if (camera) commit(camera)
  }

  /** A call made while a frame is dispatched runs once, after every listener, in the same task. */
  function queuedWhileDispatching(run: () => void): boolean {
    if (!frames.dispatching) return false
    queued.push(run)
    return true
  }

  /** Runs one of the driver's own map calls; a throw fails the driver. */
  function send(call: () => void): boolean {
    ownCalls += 1
    try {
      call()
      return true
    } catch (error) {
      fail(`The map could not move: ${messageOf(error)}`)
      return false
    } finally {
      ownCalls -= 1
    }
  }

  /** Sends the target (already constrained) as explicit jumpTo values and publishes the read-back frame. */
  function jumpTo(target: ViewCamera): void {
    const sent = send(() => map.jumpTo({
      center: [target.center.lon, target.center.lat],
      zoom: target.zoom,
      bearing: target.bearingDeg,
      pitch: 0,
    }))
    if (sent) refresh()
  }

  /** Sends the target unless the move changed nothing (the shown camera back from camera-math): then only the frame is refreshed. */
  function moveTo(target: ViewCamera, start: { readonly camera: ViewCamera; readonly shown: boolean }): void {
    if (start.shown && target === start.camera) refresh()
    else jumpTo(target)
  }

  /**
   * The camera a move starts from, and whether the map shows it now. A flight is stopped by any other move; an incremental move
   * (pan, zoom) carries the flight's target bearing, so its jump is sent even when the move itself changes nothing.
   */
  function startingCamera(carryFlightBearing: boolean): { readonly camera: ViewCamera; readonly shown: boolean } | null {
    const running = flight
    if (running) {
      flight = null
      if (!send(() => map.stop())) return null
    }
    const camera = readCamera()
    if (!camera) return null
    if (!running || !carryFlightBearing) return { camera, shown: !running }
    return { camera: rotateCameraAround(camera, screen, 'centre', running.targetBearingDeg), shown: false }
  }

  function endFlight(): void {
    flight = null
    const camera = readCamera()
    if (!camera) return
    commit(camera)
  }

  function fly(target: ViewCamera): void {
    if (deps.policy().reducedMotion.peek()) {
      jumpTo(constrainCamera(target, screen, deps.policy()))
      return
    }
    const held = constrainCamera(target, screen, deps.policy())
    const running: Flight = { targetBearingDeg: held.bearingDeg, started: false, ended: false }
    flight = running
    const sent = send(() => map.flyTo({ center: [held.center.lon, held.center.lat], zoom: held.zoom, bearing: held.bearingDeg }))
    if (!sent) return
    running.started = true
    if (running.ended && flight === running) endFlight()
    else refresh()
  }

  function apply(move: CameraMove): void {
    if (!live() || !acceptsMove(move) || queuedWhileDispatching(() => apply(move))) return
    switch (move.kind) {
      case 'pan-by': {
        const start = startingCamera(true)
        if (start) moveTo(constrainCamera(panCamera(start.camera, screen, move.deltaPx), screen, deps.policy()), start)
        return
      }
      case 'zoom-around': {
        const start = startingCamera(true)
        if (!start) return
        // The factor is held inside the zoom range at the live bearing first, as the headless driver holds it, so the anchor holds.
        const factor = zoomFactorWithinRange(start.camera, screen, deps.policy(), move.factor)
        moveTo(constrainCamera(zoomCameraAround(start.camera, screen, move.anchorPx, factor), screen, deps.policy()), start)
        return
      }
      case 'rotate-around': {
        const start = startingCamera(false)
        if (!start) return
        const turned = rotateCameraAround(start.camera, screen, move.anchorPx, move.bearingDeg)
        moveTo(constrainCamera(turned, screen, deps.policy()), start)
        return
      }
      case 'set': {
        const { target } = move
        const start = startingCamera(false)
        if (!start) return
        const normalised: ViewCamera = { ...target, bearingDeg: normaliseBearing(target.bearingDeg), pitchDeg: 0 }
        if (move.animation === 'fly') fly(normalised)
        else jumpTo(constrainCamera(normalised, screen, deps.policy()))
        return
      }
    }
  }

  function stopAnimation(): void {
    if (!live() || queuedWhileDispatching(stopAnimation) || !flight) return
    flight = null
    if (send(() => map.stop())) refresh()
  }

  function planeChanged(next: SessionPlane): void {
    if (!live() || queuedWhileDispatching(() => planeChanged(next)) || next === plane) return
    // MapLibre's camera is geographic: only the plane the frame is expressed in changes.
    plane = next
    planeRevision += 1
    refresh()
  }

  function setScreen(next: ViewScreen): void {
    if (!live() || queuedWhileDispatching(() => setScreen(next))) return
    const normalised = normaliseScreen(next)
    if (
      normalised.width === screen.width
      && normalised.height === screen.height
      && normalised.devicePixelRatio === screen.devicePixelRatio
    ) return
    if (!readCamera()) return
    screen = normalised
    // MapLibre re-runs the guard at the new size.
    if (send(() => map.resize())) refresh()
  }

  function setInsets(next: ScreenInsets): void {
    if (!live() || queuedWhileDispatching(() => setInsets(next))) return
    insets = Object.freeze({ top: next.top, right: next.right, bottom: next.bottom, left: next.left })
    refresh()
  }

  return {
    frames,
    failure,
    apply,
    bearingTarget: () => flight?.targetBearingDeg ?? published.camera.bearingDeg,
    stopAnimation,
    planeChanged,
    setScreen,
    setInsets,
    dispose() {
      if (disposed) return
      disposed = true
      queued.length = 0
      const errors: unknown[] = []
      const release = (step: () => void) => {
        try {
          step()
        } catch (error) {
          errors.push(error)
        }
      }
      if (flight) {
        flight = null
        release(() => map.stop())
      }
      for (const [type, listener] of subscribed.splice(0)) release(() => map.off(type, listener))
      if (guardInstalled) release(() => map.setTransformConstrain(null))
      frames.dispose()
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new MapLibreCameraDriverReleaseError(errors)
    },
  }
}

class MapLibreCameraDriverReleaseError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super('The MapLibre camera driver could not release its map.')
  }
}

/** MapLibre keeps the returned centre as its transform's LngLat, so it is built with the class MapLibre passed in. */
function sameKindOfLngLat(template: MapLibreLngLat, center: GeoPoint): MapLibreLngLat {
  const LngLat: unknown = template.constructor
  return typeof LngLat === 'function' && LngLat !== Object
    ? new (LngLat as new (lng: number, lat: number) => MapLibreLngLat)(center.lon, center.lat)
    : { lng: center.lon, lat: center.lat }
}

/** The canvas' CSS size and density, as MapLibre last sized it: the screen the map renders now. */
function canvasScreen(map: MapLibreCameraDriverMap): ViewScreen {
  const canvas = map.getCanvas()
  const width = canvas.clientWidth
  return normaliseScreen({ width, height: canvas.clientHeight, devicePixelRatio: width ? canvas.width / width : undefined })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
