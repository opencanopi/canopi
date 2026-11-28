// canvas/runtime/view/driver-host.ts
//
// Owns the runtime's one camera across attach, detach and failure (ADR 0016): the live CameraDriver (a HeadlessCameraDriver until a
// map is attached, and again after a detach or a failure), the NavigationPolicy every driver on it reads, and the one frame stream
// readers subscribe to. The host relays the live driver's frames with its own revisions (the drivers keep none), so revisions and
// plane revisions stay monotonic across swaps, and marks them attached while an attached driver is live.

import { signal, type ReadonlySignal } from '@preact/signals'
import type { SessionPlane } from '../session-plane'
import type { CameraDriver, CameraDriverDeps, CameraDriverFailure, CameraDriverHost } from './camera-driver'
import { planarToViewCamera } from './camera-math'
import { createViewFrameSource } from './frame-source'
import { createHeadlessCameraDriver } from './headless-driver'
import { createNavigationPolicy, type NavigationPolicy } from './navigation-policy'
import type { ScreenInsets, ViewCamera, ViewFrame, ViewScreen } from './types'
import { planarCameraOf } from './view-transform'

export interface CameraDriverHostOptions {
  /** Default WORKSPACE_MAP_MAX_ZOOM: a test lowers it to compare both drivers at the zoom-in clamp. */
  readonly maxZoom?: number
  readonly reducedMotion: ReadonlySignal<boolean>
  /** The session plane the runtime works in: headless drivers are built on it, and planeChanged is called with it after a re-origin. */
  readonly plane: () => SessionPlane
  /** Default: an empty screen at density 1. */
  readonly screen?: ViewScreen
  /** Default: the plane origin at 1 px/m, bearing 0. */
  readonly camera?: ViewCamera
  readonly insets?: ScreenInsets
}

/**
 * The host as its creator holds it. Only the host's own frames settle (its drivers settle nothing: nobody reads a driver's own
 * settled frame). `followPlane` takes the plane `options.plane` returns from then on: a headless camera keeps its plane placement
 * and reads its ground on that plane; nothing happens while an attached driver is live (only planeChanged moves the
 * map's plane) or while the headless driver is already on it.
 */
export interface CameraDriverHostController extends CameraDriverHost {
  dispose(): void
}

const EMPTY_SCREEN: ViewScreen = Object.freeze({ width: 0, height: 0, devicePixelRatio: 1 })

export function createCameraDriverHost(options: CameraDriverHostOptions): CameraDriverHostController {
  let policyPlane: SessionPlane | null = null
  let navigationPolicy: NavigationPolicy | null = null
  /** The policy at the runtime plane's latitude, so a re-origin moves the scale bounds (and the zoom buttons' limits) with the plane. */
  function policyNow(): NavigationPolicy {
    const plane = options.plane()
    if (!navigationPolicy || plane !== policyPlane) {
      policyPlane = plane
      const policy = createNavigationPolicy(plane.origin.lat, options.reducedMotion)
      navigationPolicy = options.maxZoom === undefined ? policy : Object.freeze({ ...policy, maxZoom: options.maxZoom })
    }
    return navigationPolicy
  }
  const driverDeps: CameraDriverDeps = Object.freeze({ policy: policyNow })
  const failure = signal<CameraDriverFailure | null>(null)

  const initialPlane = options.plane()
  let live: CameraDriver = createHeadlessCameraDriver({
    deps: driverDeps,
    plane: initialPlane,
    screen: options.screen ?? EMPTY_SCREEN,
    camera: options.camera ?? { center: initialPlane.origin, zoom: initialPlane.zoomForPixelsPerMetre(1), bearingDeg: 0, pitchDeg: 0 },
    insets: options.insets,
  })
  let attached = false
  /** The plane the live headless driver places the camera in; null while an attached driver is live. */
  let headlessPlane: SessionPlane | null = initialPlane
  let revision = 0
  let planeRevision = 0
  let relayedDriver = live
  let relayedDriverPlaneRevision = live.frames.viewFrame.peek().view.planeRevision
  let relayedPlane = initialPlane
  let disposed = false
  let release = connect(live)

  const frames = createViewFrameSource(stamp(live.frames.viewFrame.peek()))

  function stamp(frame: ViewFrame): ViewFrame {
    const view = Object.freeze({ ...frame.view, planeRevision })
    return Object.freeze<ViewFrame>({ ...frame, view, attached, revision })
  }

  /** Relays one frame of the live driver. The plane revision moves when the driver re-origins, or when a swap finds a new plane. */
  function relay(driver: CameraDriver, frame: ViewFrame): void {
    if (disposed || driver !== live) return
    const reoriginated = driver === relayedDriver && frame.view.planeRevision !== relayedDriverPlaneRevision
    // A headless driver re-origins only through planeChanged, which the runtime calls with its own plane.
    if (reoriginated && headlessPlane) headlessPlane = options.plane()
    const plane = headlessPlane ?? options.plane()
    if (reoriginated || (driver !== relayedDriver && plane !== relayedPlane)) planeRevision += 1
    relayedDriver = driver
    relayedDriverPlaneRevision = frame.view.planeRevision
    relayedPlane = plane
    revision += 1
    frames.publish(stamp(frame))
  }

  function connect(driver: CameraDriver): () => void {
    const stopRelay = driver.frames.onViewFrame((frame) => relay(driver, frame))
    let connecting = true
    const stopFailure = driver.failure.subscribe((reported) => {
      if (!connecting && reported && driver === live && attached) fail(reported)
    })
    connecting = false
    return () => {
      stopRelay()
      stopFailure()
    }
  }

  /**
   * Swaps the live driver: `prepare` brings the new one to the last frame's camera unrelayed, then the host publishes one frame. An
   * attached driver that fails meanwhile is never relayed: the host detaches at the camera it had. The new driver is not dispatching
   * that frame, so a move a listener makes on it reaches the driver at once; the frame source dispatches the move's frame after it.
   * When the previous driver cannot release its map, the swap still completes and its error is thrown afterwards.
   */
  function swapTo(driver: CameraDriver, nextAttached: boolean, prepare: () => void): void {
    release()
    release = () => {}
    const previous = live
    live = driver
    attached = nextAttached
    let releaseError: { readonly error: unknown } | null = null
    try {
      previous.dispose()
    } catch (error) {
      releaseError = { error }
    }
    prepare()
    const reported = driver.failure.peek()
    if (reported) fail(reported)
    else {
      release = connect(driver)
      relay(driver, driver.frames.viewFrame.peek())
    }
    if (releaseError) throw releaseError.error
  }

  function detachTo(): void {
    toHeadless(options.plane(), frames.viewFrame.peek().view.camera)
  }

  function toHeadless(plane: SessionPlane, camera: ViewCamera): void {
    const last = frames.viewFrame.peek()
    headlessPlane = plane
    swapTo(createHeadlessCameraDriver({
      deps: driverDeps,
      plane,
      screen: last.view.screen,
      camera,
      insets: last.insets,
    }), false, () => {})
  }

  function fail(reported: CameraDriverFailure): void {
    try {
      detachTo()
    } catch {
      // The failed driver could not release its map: that is not the failure reported here, and the camera is already back.
    }
    failure.value = reported
  }

  return {
    frames,
    driverDeps,
    failure,
    current: () => live,
    attach(driver) {
      if (disposed) return
      const refused = driver.failure.peek()
      if (refused) {
        // Built failed (a map it cannot drive): it never takes the camera.
        driver.dispose()
        if (attached) detachTo()
        failure.value = refused
        return
      }
      const last = frames.viewFrame.peek()
      failure.value = null
      headlessPlane = null
      swapTo(driver, true, () => {
        driver.setInsets(last.insets)
        driver.apply({ kind: 'set', target: last.view.camera, animation: 'none' })
      })
    },
    detach() {
      if (disposed || !attached) return
      detachTo()
    },
    followPlane(plane) {
      if (disposed || attached || !headlessPlane || plane === headlessPlane) return
      const { view } = frames.viewFrame.peek()
      toHeadless(plane, planarToViewCamera(planarCameraOf(view), view.screen, plane))
    },
    dispose() {
      if (disposed) return
      disposed = true
      release()
      live.dispose()
      frames.dispose()
    },
  }
}
