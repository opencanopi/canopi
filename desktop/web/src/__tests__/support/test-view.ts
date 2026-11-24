// __tests__/support/test-view.ts  (test support)
//
// createTestView: the one way tests build a camera (spec §1.1b). A driver host starting on a HeadlessCameraDriver, built with the
// production factories, and the navigation over it. The settle runs on the window's timers: a test that steps time uses Vitest
// fake timers.

import { signal } from '@preact/signals'
import type { ScenePersistedState } from '../../canvas/runtime/scene'
import { sceneExtentPoints } from '../../canvas/runtime/scene-extent'
import type { CameraDriverHost } from '../../geo/view/camera-driver'
import { planarToViewCamera } from '../../geo/view/camera-math'
import { createCameraDriverHost } from '../../geo/view/driver-host'
import { createViewNavigation, type ViewNavigation } from '../../geo/view/navigation'
import { planarCameraOf } from '../../geo/view/view-transform'
import type {
  PlanarCamera,
  SceneExtent,
  ScreenInsets,
  ViewCamera,
  ViewFrame,
  ViewFrameSource,
  ViewScreen,
  ViewTransform,
} from '../../geo/view/types'
import { stageScaleToMapZoom } from '../../geo/projection'
import { createSessionPlane, type SessionPlane } from '../../geo/session-plane'

export interface TestViewOptions {
  /** Default { width: 400, height: 300, devicePixelRatio: 1 }: the split files' camera today. */
  readonly screen?: Partial<ViewScreen>
  /** Bearing-0 placement in today's terms (screen = world × scale + { x, y }). Default { x: 0, y: 0, scale: 1 }. */
  readonly viewport?: { readonly x: number; readonly y: number; readonly scale: number }
  /** Instead of viewport: a full camera (rotated tests from phase 1). */
  readonly camera?: Partial<ViewCamera>
  /** Default createSessionPlane({ lon: 0, lat: 0 }). */
  readonly plane?: SessionPlane
  /** The host's zoom-in limit; default WORKSPACE_MAP_MAX_ZOOM. */
  readonly maxZoom?: number
  readonly insets?: ScreenInsets
}

export interface TestView {
  /** Starts on a HeadlessCameraDriver, built with the production factories. */
  readonly host: CameraDriverHost
  readonly frames: ViewFrameSource            // host.frames
  readonly navigation: ViewNavigation         // fits see an empty scene unless the test passes one to setScene
  view(): ViewTransform                       // frames.viewFrame.peek().view
  setViewport(v: { readonly x: number; readonly y: number; readonly scale: number }): void   // a 'set' to the camera the plane gives, bearing kept
  /** The bearing-0 placement in today's terms (planarCameraOf(view()) without the bearing): the split suites' camera.viewport. */
  viewport(): { readonly x: number; readonly y: number; readonly scale: number }
  /** The session plane re-origins to `next`: the camera keeps its ground, as the runtime's re-origin moves it (planeChanged). */
  setPlane(next: SessionPlane): void
  /** The scene the fits frame: its extent at each scale unless `extent` gives the points; an empty scene keeps the view unless
   *  `extent` gives an empty-scene scale. */
  setScene(scene: ScenePersistedState, extent?: Partial<SceneExtent>): void
  dispose(): void
}

const DEFAULT_SCREEN: ViewScreen = { width: 400, height: 300, devicePixelRatio: 1 }

export function createTestView(options: TestViewOptions = {}): TestView {
  let plane = options.plane ?? createSessionPlane({ lon: 0, lat: 0 })
  const screen: ViewScreen = { ...DEFAULT_SCREEN, ...options.screen }
  const camera: ViewCamera = options.camera
    ? {
      center: options.camera.center ?? plane.origin,
      zoom: options.camera.zoom ?? stageScaleToMapZoom(1, plane.origin.lat),
      bearingDeg: options.camera.bearingDeg ?? 0,
      pitchDeg: 0,
    }
    : planarToViewCamera({ ...(options.viewport ?? { x: 0, y: 0, scale: 1 }), bearingDeg: 0 }, screen, plane)
  const host = createCameraDriverHost({
    maxZoom: options.maxZoom,
    reducedMotion: signal(false),
    plane: () => plane,
    screen,
    camera,
    insets: options.insets,
  })
  let extent: SceneExtent = { extentPoints: () => [], emptySceneScale: 0 }
  const navigation = createViewNavigation({
    driver: host,
    policy: host.driverDeps.policy,
    readSceneExtent: () => extent,
    readSelectionPoints: () => [],
  })

  const place = (placement: PlanarCamera): void => placeOnHost(host, plane, placement)

  return {
    host,
    frames: host.frames,
    navigation,
    view: () => host.frames.viewFrame.peek().view,
    setViewport(v) {
      const bearingDeg = host.frames.viewFrame.peek().view.camera.bearingDeg
      place({ x: v.x, y: v.y, scale: v.scale, bearingDeg })
    },
    viewport() {
      const { x, y, scale } = planarCameraOf(host.frames.viewFrame.peek().view)
      return { x, y, scale }
    },
    setPlane(next) {
      plane = next
      host.current().planeChanged(next)
    },
    setScene(scene, given = {}) {
      extent = {
        extentPoints: given.extentPoints ?? sceneExtentPoints(scene, { pixelsPerMetre: 1, speciesCache: new Map() }),
        emptySceneScale: given.emptySceneScale ?? 0,
      }
    },
    dispose() {
      host.dispose()
    },
  }
}

/** Shows a placement on a host's live camera: the camera the plane gives for it on the live screen, as a 'set' with no animation. */
export function placeOnHost(
  host: Pick<CameraDriverHost, 'current' | 'frames'>,
  plane: SessionPlane,
  placement: { readonly x: number; readonly y: number; readonly scale: number; readonly bearingDeg?: number },
): void {
  const { view } = host.frames.viewFrame.peek()
  const target = planarToViewCamera({ ...placement, bearingDeg: placement.bearingDeg ?? 0 }, view.screen, plane)
  host.current().apply({ kind: 'set', target, animation: 'none' })
}

/** The frame a test view built with these options shows: for chrome that takes one frame (the grid). */
export function testViewFrame(options: TestViewOptions = {}): ViewFrame {
  const view = createTestView(options)
  const frame = view.frames.viewFrame.peek()
  view.dispose()
  return frame
}
