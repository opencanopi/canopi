// Follow mode's camera half (canopi-f47t.53; design check A3; U54 Q13–Q15, Q17, Q12). Following centres the camera on
// each fix through the view's showPlace jump, the one camera writer's command (ADR 0016; MapLibre's GeolocateControl,
// which calls fitBounds itself, is reference only, A2). The click holds the camera where it is: that jump stops a flight
// still under way (a saved view, a place), whose landing would otherwise read as a move. Any other move ends follow,
// from the click on: the settled camera is compared with the camera at the click until the first jump, then with each
// jump's read-back, and the live camera again on each fix before jumping, with a tolerance of about one pixel on the
// ground (lon/lat), so a re-origin, which moves the session plane and not the ground, keeps following. A Design
// activation and the start of a story presentation end it explicitly. The session (session.ts) owns the mode.
import { effect, type ReadonlySignal } from '@preact/signals'
import type { GeoPoint } from '../../generated/contracts'
import type { ViewCamera } from '../../canvas/runtime/view/types'
import { PLACE_SEARCH_ZOOM } from '../geocoding/place-search-ui'

/** What follow reads and moves: the current canvas's view. */
export interface FollowView {
  /** The camera after 150 ms without change. */
  readonly settledCamera: ReadonlySignal<ViewCamera>
  /** The live frame's camera. */
  captureCamera(): ViewCamera
  showPlace(place: GeoPoint, zoom: number, options: { readonly motion: 'jump' }): void
  showCamera(camera: ViewCamera, options: { readonly motion: 'jump' }): void
}

interface CameraFollowOptions {
  /** The current canvas's view; null while no canvas is mounted (follow waits and jumps nothing). */
  readonly view: ReadonlySignal<FollowView | null>
  /** Changes when another Design becomes current. */
  readonly designIdentity: ReadonlySignal<unknown>
  /** True while a story is presented. */
  readonly presenting: ReadonlySignal<boolean>
  /** Called once, when an outside move, a Design activation or a story presentation ends follow. */
  readonly onEnd: () => void
}

export interface CameraFollow {
  /**
   * Centres the camera on the fix, keeping its bearing. `recentre` is the click that starts or resumes following: it also
   * zooms in to max(zoom, 17), the place-search zoom (Q15); later fixes keep the zoom. A fix that finds the camera moved
   * away since the click or follow's last jump ends follow instead.
   */
  follow(fix: GeoPoint, recentre: boolean): void
  /** Stops watching without calling `onEnd`. */
  dispose(): void
}

/** How far, in screen pixels, the camera may sit from follow's jump and still be following. */
const FOLLOW_TOLERANCE_PX = 1

export function startCameraFollow(options: CameraFollowOptions): CameraFollow {
  let live = true
  const atClick = options.view.peek()
  atClick?.showCamera(atClick.captureCamera(), { motion: 'jump' })
  /**
   * Where the camera should be: the centre at the click until the first jump, then the jump's read-back and fix (a queued
   * jump reads back the old frame).
   */
  let centres: readonly GeoPoint[] = atClick ? [atClick.captureCamera().center] : []
  /** The settled camera at the click or the last jump; it shows the frame before either, so it is no outside move. */
  let settledAtJump: ViewCamera | null = atClick?.settledCamera.peek() ?? null
  const disposers: (() => void)[] = []

  const end = () => {
    if (!live) return
    dispose()
    options.onEnd()
  }
  const dispose = () => {
    if (!live) return
    live = false
    for (const disposer of disposers.splice(0)) disposer()
  }
  const movedAway = (camera: ViewCamera) => centres.length > 0 && centres.every((centre) => !near(camera, centre))

  disposers.push(effect(() => {
    const settled = options.view.value?.settledCamera.value
    if (!settled || settled === settledAtJump) return
    if (movedAway(settled)) end()
  }))
  let firstIdentity = true
  disposers.push(effect(() => {
    void options.designIdentity.value
    if (firstIdentity) firstIdentity = false
    else end()
  }))
  disposers.push(effect(() => {
    if (options.presenting.value) end()
  }))
  // A presentation already under way ended follow while the effects were being installed.
  if (!live) for (const disposer of disposers.splice(0)) disposer()

  return {
    follow(fix, recentre) {
      if (!live) return
      const view = options.view.peek()
      if (!view) return
      const camera = view.captureCamera()
      if (movedAway(camera)) {
        end()
        return
      }
      settledAtJump = view.settledCamera.peek()
      view.showPlace(fix, recentre ? Math.max(camera.zoom, PLACE_SEARCH_ZOOM) : camera.zoom, { motion: 'jump' })
      centres = [view.captureCamera().center, fix]
    },
    dispose,
  }
}

/** Whether the camera's centre is within the tolerance of `centre`, in screen pixels at the camera's zoom. */
function near(camera: ViewCamera, centre: GeoPoint): boolean {
  // Web Mercator at 512 px tiles: x is linear in longitude, y stretches by 1 / cos(latitude) for a short step.
  const degreesPerPixel = 360 / (512 * 2 ** camera.zoom)
  const dx = (camera.center.lon - centre.lon) / degreesPerPixel
  const dy = (camera.center.lat - centre.lat) / (degreesPerPixel * Math.cos(centre.lat * Math.PI / 180))
  return Math.hypot(dx, dy) <= FOLLOW_TOLERANCE_PX
}
