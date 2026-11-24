// canvas/runtime/view/camera-driver.ts  (types)

import type { ReadonlySignal } from '@preact/signals'
import type { SessionPlane } from '../session-plane'
import type { NavigationPolicy } from './navigation-policy'
import type { DriverFrameSource, ScreenInsets, ScreenPoint, ViewCamera, ViewFrameSource, ViewScreen } from './types'

export type CameraMove =
  /** deltaPx is content movement: the ground under the pointer moves by deltaPx. New centre = unproject(screenCentre − deltaPx). */
  | { readonly kind: 'pan-by'; readonly deltaPx: ScreenPoint }
  | { readonly kind: 'zoom-around'; readonly anchorPx: ScreenPoint; readonly factor: number }
  /** Keep the ground under anchorPx fixed while the bearing changes; the centre is an output. Every turn jumps (U34). */
  | {
      readonly kind: 'rotate-around'
      readonly anchorPx: ScreenPoint | 'centre'
      readonly bearingDeg: number
    }
  /** Go to a full camera. The centre is an input; no anchor. 'fly' is MapLibre flyTo; without a map it jumps. */
  | {
      readonly kind: 'set'
      readonly target: ViewCamera               // pitchDeg: 0 by type
      readonly animation: 'none' | 'fly'
    }

export interface CameraDriver {
  readonly frames: DriverFrameSource
  /** Synchronous for 'none' moves and the incremental kinds: `frames.viewFrame` is current on return (unless queued). */
  apply(move: CameraMove): void
  /** The bearing a running flight will end at, else the live bearing. */
  bearingTarget(): number
  stopAnimation(): void
  /** The runtime's plane effect calls it on a re-origin, and on any plane change while a map is attached: either driver keeps its
   *  geographic camera (the map left still) and re-expresses its frame in the new plane, so its ground is kept, in one frame. */
  planeChanged(plane: SessionPlane): void
  setScreen(screen: ViewScreen): void
  setInsets(insets: ScreenInsets): void
  /** Set when the driver can no longer drive its camera (the MapLibre driver: 'map-lost', 'map-error'); the host it is attached to
   *  detaches and reports it as its own failure. Always null on the headless driver. */
  readonly failure: ReadonlySignal<CameraDriverFailure | null>
  dispose(): void
}

/** Injected into both drivers. */
export interface CameraDriverDeps {
  readonly policy: () => NavigationPolicy
}

export interface CameraDriverFailure { readonly reason: 'map-error'; readonly message: string }

/**
 * Owns the runtime's one camera across attach, detach and failure.
 * The runtime starts on a HeadlessCameraDriver (tests, before attach). `frames` is stable across swaps.
 */
export interface CameraDriverHost {
  readonly frames: ViewFrameSource
  readonly current: () => CameraDriver
  /** Hands the camera to an attached driver: it starts with a 'set'/'none' move to the current camera; ViewFrame.attached becomes true. */
  attach(driver: CameraDriver): void
  /** Back to a HeadlessCameraDriver at the last camera; ViewFrame.attached becomes false. */
  detach(): void
  /** The Scene's plane on a detached hydration: a live headless driver keeps its plane placement and takes the new plane. The
   *  runtime's plane effect calls it; without it the headless camera would report another plane's ground. */
  followPlane(plane: SessionPlane): void
  /** The deps the host built its drivers with; the activation builds the MapLibre driver with them. */
  readonly driverDeps: CameraDriverDeps
  /** Set when the attached driver fails; the host has already detached. */
  readonly failure: ReadonlySignal<CameraDriverFailure | null>
}
