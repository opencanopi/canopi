// @vitest-environment jsdom

// Follow mode's camera half (canopi-f47t.53; design check A3; U54 Q13–Q15, Q17, Q12): the jumps through showPlace and
// the exits on outside moves, a Design activation and a story presentation.
import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Camera as SourceCameraClass } from 'maplibre-gl-source/ui/camera.ts'
import { restoreNow, setNow } from 'maplibre-gl-source/util/time_control.ts'
import { createTestView, type TestView } from '../../__tests__/support/test-view'
import { createViewReadSurface, SETTLE_MS } from '../../canvas/runtime/view/frame-source'
import type { GeoPoint } from '../../generated/contracts'
import type { ViewCamera } from '../../canvas/runtime/view/types'
import { createSessionPlane } from '../../canvas/session-plane'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from '../../maplibre/camera-driver'
import { startCameraFollow, type FollowView } from './follow'

const FIX: GeoPoint = { lon: 12.3456789, lat: 45.6789012 }
const MOVED: GeoPoint = { lon: 12.3476789, lat: 45.6789012 }

/** A view whose camera jumps at once, as the driver's 'none' moves do, and settles when the test says. */
function fakeView(start: ViewCamera = { center: { lon: 3.87, lat: 43.61 }, zoom: 14, bearingDeg: 30, pitchDeg: 0 }) {
  let live = start
  const settledCamera = signal<ViewCamera>(start)
  const showPlace = vi.fn((place: GeoPoint, zoom: number, _options: { readonly motion: 'jump' }) => {
    live = { ...live, center: { ...place }, zoom }
    return true
  })
  const showCamera = vi.fn((camera: ViewCamera, _options: { readonly motion: 'jump' }) => { live = { ...camera } })
  const view: FollowView = { settledCamera, captureCamera: () => live, showPlace, showCamera }
  return {
    view,
    showPlace,
    live: () => live,
    /** The user moved the camera: the live frame now, the settled camera 150 ms later. */
    move(camera: Partial<ViewCamera>) { live = { ...live, ...camera } },
    settle() { settledCamera.value = { ...live } },
  }
}

function setup(view = fakeView()) {
  const current = signal<FollowView | null>(view.view)
  const designIdentity = signal<object>({})
  const presenting = signal(false)
  const onEnd = vi.fn()
  const follow = startCameraFollow({ view: current, designIdentity, presenting, onEnd })
  return { follow, view, current, designIdentity, presenting, onEnd }
}

/** One screen pixel in degrees of longitude at this zoom (512 px tiles; Web Mercator x is linear in longitude). */
function pixelDegreesLon(zoom: number): number {
  return 360 / (512 * 2 ** zoom)
}

describe('camera follow', () => {
  it('jumps to the fix at max(zoom, 17) on the click, keeping the bearing to the driver, and at the current zoom on later fixes', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    expect(f.view.showPlace).toHaveBeenLastCalledWith(FIX, 17, { motion: 'jump' })
    f.view.settle()
    f.view.move({ zoom: 18.5 })
    f.view.settle()
    f.follow.follow(MOVED, false)
    expect(f.view.showPlace).toHaveBeenLastCalledWith(MOVED, 18.5, { motion: 'jump' })
    f.view.settle()
    f.follow.follow(FIX, true)
    expect(f.view.showPlace).toHaveBeenLastCalledWith(FIX, 18.5, { motion: 'jump' })
    expect(f.onEnd).not.toHaveBeenCalled()
  })

  it('keeps following through its own jump\'s settle, a zoom about the centre and a turn, which keep the fix centred', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    f.view.settle()
    f.view.move({ zoom: 19 })
    f.view.settle()
    f.view.move({ bearingDeg: 75 })
    f.view.settle()
    expect(f.onEnd).not.toHaveBeenCalled()
  })

  it('ends on an outside move once the camera settles away from follow\'s jump, and never jumps again', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    f.view.settle()
    f.view.move({ center: { lon: FIX.lon + 0.001, lat: FIX.lat } })
    f.view.settle()
    expect(f.onEnd).toHaveBeenCalledOnce()
    const jumps = f.view.showPlace.mock.calls.length
    f.follow.follow(MOVED, false)
    expect(f.view.showPlace).toHaveBeenCalledTimes(jumps)
  })

  it('compares the live camera on each fix before jumping: a pan not yet settled ends follow and the fix moves nothing', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    f.view.settle()
    f.view.move({ center: { lon: FIX.lon, lat: FIX.lat + 0.001 } })
    f.follow.follow(MOVED, false)
    expect(f.onEnd).toHaveBeenCalledOnce()
    expect(f.view.live().center).toEqual({ lon: FIX.lon, lat: FIX.lat + 0.001 })
  })

  it('waits for the first fix from the camera at the click: an outside move then ends follow, and the fix jumps nothing', () => {
    const settledPan = setup()
    settledPan.view.move({ center: { lon: 4.5, lat: 44 }, zoom: 15 })
    settledPan.view.settle()
    expect(settledPan.onEnd).toHaveBeenCalledOnce()
    settledPan.follow.follow(FIX, true)
    expect(settledPan.view.showPlace).not.toHaveBeenCalled()

    const livePan = setup()
    livePan.view.move({ center: { lon: 4.5, lat: 44 } })
    livePan.follow.follow(FIX, true)
    expect(livePan.onEnd).toHaveBeenCalledOnce()
    expect(livePan.view.live().center).toEqual({ lon: 4.5, lat: 44 })
  })

  it('a settle due when the click came, mid-pan, is no outside move', () => {
    const view = fakeView()
    view.move({ center: { lon: 3.9, lat: 43.61 } })
    const f = setup(view)
    view.settle()
    expect(f.onEnd).not.toHaveBeenCalled()
    f.follow.follow(FIX, true)
    expect(f.view.showPlace).toHaveBeenLastCalledWith(FIX, 17, { motion: 'jump' })
    expect(f.onEnd).not.toHaveBeenCalled()
  })

  it('has a tolerance of about one pixel: rounding and a re-origin\'s round trip through the plane keep following', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    f.view.settle()
    // A re-origin moves the session plane, not the ground: the settled camera comes back with the same lon/lat, to float noise.
    const halfPixel = pixelDegreesLon(17) / 2
    f.view.move({ center: { lon: FIX.lon + halfPixel, lat: FIX.lat + 1e-9 } })
    f.view.settle()
    expect(f.onEnd).not.toHaveBeenCalled()
    f.view.move({ center: { lon: FIX.lon + 3 * pixelDegreesLon(17), lat: FIX.lat } })
    f.view.settle()
    expect(f.onEnd).toHaveBeenCalledOnce()
  })

  it('a settle that was due before follow\'s jump is no outside move', () => {
    const view = fakeView()
    const f = setup(view)
    f.follow.follow(FIX, true)
    // The settled camera still shows the pre-jump frame; a re-read of the view (a new canvas surface) must not end follow.
    f.current.value = { ...view.view }
    expect(f.onEnd).not.toHaveBeenCalled()
  })

  it('accepts a settled camera on the fix when the jump was queued and the read-back still showed the old frame', () => {
    let live: ViewCamera = { center: { lon: 3.87, lat: 43.61 }, zoom: 14, bearingDeg: 0, pitchDeg: 0 }
    const settledCamera = signal<ViewCamera>(live)
    const queued: ViewCamera[] = []
    const view: FollowView = {
      settledCamera,
      captureCamera: () => live,
      showPlace: (place, zoom) => { queued.push({ ...live, center: { ...place }, zoom }); return true },
      showCamera: () => {},
    }
    const f = setup({ view, showPlace: vi.fn(), live: () => live, move: () => {}, settle: () => {} })
    f.follow.follow(FIX, true)
    live = queued[0]!
    settledCamera.value = live
    expect(f.onEnd).not.toHaveBeenCalled()
  })

  it('ends when another Design becomes current, and when a story presentation starts (U54 Q17, Q12)', () => {
    const design = setup()
    design.follow.follow(FIX, true)
    design.designIdentity.value = {}
    expect(design.onEnd).toHaveBeenCalledOnce()

    const story = setup()
    story.follow.follow(FIX, true)
    story.presenting.value = true
    story.presenting.value = false
    expect(story.onEnd).toHaveBeenCalledOnce()
  })

  it('ends at once when started during a story presentation, and waits for a canvas without jumping', () => {
    const presenting = signal(true)
    const onEnd = vi.fn()
    startCameraFollow({ view: signal(null), designIdentity: signal({}), presenting, onEnd })
    expect(onEnd).toHaveBeenCalledOnce()

    const f = setup()
    f.current.value = null
    f.follow.follow(FIX, true)
    expect(f.view.showPlace).not.toHaveBeenCalled()
  })

  it('stops watching once disposed: no exit and no jump after', () => {
    const f = setup()
    f.follow.follow(FIX, true)
    f.follow.dispose()
    f.view.move({ center: MOVED })
    f.view.settle()
    f.designIdentity.value = {}
    expect(f.onEnd).not.toHaveBeenCalled()
    f.follow.follow(MOVED, false)
    expect(f.view.showPlace).toHaveBeenCalledOnce()
  })
})

/**
 * MapLibre 6.10.0's own Camera (the test-only `maplibre-gl-source` alias) with no WebGL, under the real MapLibre camera
 * driver, navigation, frame source and read surface: the view follow reads and moves in the app. Animation frames are
 * queued and run by `step`, at MapLibre's own clock set to the step's time.
 */
function mapLibreView() {
  vi.useFakeTimers()
  setNow(0)
  const screen = { width: 900, height: 600 }
  const frames: Array<() => void> = []
  const camera = new (SourceCameraClass as new (options: object) => {
    transform: { resize(width: number, height: number): void; setConstrainOverride(constrain: unknown): void }
    jumpTo(options: object): void
    flyTo(options: object): void
    stop(): void
    on(type: string, listener: () => void): void
    off(type: string, listener: () => void): void
    getCenter(): { lng: number; lat: number }
    getZoom(): number
    getBearing(): number
    getPitch(): number
  })({
    minZoom: 0, maxZoom: 27, minPitch: 0, maxPitch: 60, bearingSnap: 0, zoomSnap: 0, renderWorldCopies: false,
    centerClampedToGround: true, terrain: null, transformConstrain: null, transformCameraUpdate: null,
    requestRenderFrame: (frame: () => void) => frames.push(frame),
    cancelRenderFrame: () => { frames.length = 0 },
  })
  camera.transform.resize(screen.width, screen.height)
  const map: MapLibreCameraDriverMap = {
    jumpTo: (options) => { camera.jumpTo(options) },
    flyTo: (options) => { camera.flyTo(options) },
    stop: () => { camera.stop() },
    resize: () => {},
    on: (type, listener) => { camera.on(type, listener) },
    off: (type, listener) => { camera.off(type, listener) },
    getCenter: () => camera.getCenter() as ReturnType<MapLibreCameraDriverMap['getCenter']>,
    getZoom: () => camera.getZoom(),
    getBearing: () => camera.getBearing(),
    getPitch: () => camera.getPitch(),
    setTransformConstrain: (constrain) => { camera.transform.setConstrainOverride(constrain) },
    getCanvas: () => ({ clientWidth: screen.width, clientHeight: screen.height, width: screen.width }) as HTMLCanvasElement,
  }
  const plane = createSessionPlane({ lon: 3.87, lat: 43.61 })
  const test: TestView = createTestView({ plane, screen: { ...screen, devicePixelRatio: 1 }, camera: { center: plane.origin, zoom: 14 } })
  mapLibreViews.push(test)
  test.host.attach(createMapLibreCameraDriver(map, plane, test.host.driverDeps))
  vi.advanceTimersByTime(SETTLE_MS)
  const read = createViewReadSurface(test.frames)
  const view: FollowView = {
    settledCamera: read.settledCamera,
    captureCamera: () => read.captureView().camera,
    showPlace: (place, zoom, options) => test.navigation.showPlace(place, zoom, options),
    showCamera: (camera, options) => test.navigation.showCamera(camera, options),
  }
  return {
    view,
    navigation: test.navigation,
    live: () => read.captureView().camera,
    /** MapLibre's clock reaches `ms` and every queued animation frame runs. */
    step(ms: number) {
      setNow(ms)
      for (const frame of frames.splice(0)) frame()
    },
  }
}

const mapLibreViews: TestView[] = []

describe('camera follow on MapLibre\'s own camera', () => {
  afterEach(() => {
    for (const view of mapLibreViews.splice(0)) view.dispose()
    restoreNow()
    vi.useRealTimers()
  })

  const SAVED_VIEW: ViewCamera = { center: { lon: 3.95, lat: 43.66 }, zoom: 16, bearingDeg: 0, pitchDeg: 0 }
  const NEAR_FIX: GeoPoint = { lon: 3.9, lat: 43.62 }

  /** A saved view's flight, caught halfway: the camera is neither where it started nor where it is going. */
  function midFlight() {
    const map = mapLibreView()
    map.navigation.showCamera(SAVED_VIEW, { motion: 'fly' })
    map.step(1)
    map.step(400)
    const live = map.live()
    expect(live.center.lon).toBeGreaterThan(3.87)
    expect(live.center.lon).toBeLessThan(SAVED_VIEW.center.lon)
    const onEnd = vi.fn()
    const follow = startCameraFollow({ view: signal(map.view), designIdentity: signal({}), presenting: signal(false), onEnd })
    return { map, follow, onEnd }
  }

  it('a click mid-flight stops the flight: a fix after the camera settles is followed, not Moved away', () => {
    const { map, follow, onEnd } = midFlight()
    map.step(60_000)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(onEnd).not.toHaveBeenCalled()
    follow.follow(NEAR_FIX, true)
    expect(map.live().center.lon).toBeCloseTo(NEAR_FIX.lon, 6)
    expect(map.live().center.lat).toBeCloseTo(NEAR_FIX.lat, 6)
    expect(map.live().zoom).toBeCloseTo(17, 6)
  })

  it('a click mid-flight with a fix a few frames later jumps to the fix, and the flight never lands', () => {
    const { map, follow, onEnd } = midFlight()
    map.step(700)
    follow.follow(NEAR_FIX, true)
    map.step(60_000)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(onEnd).not.toHaveBeenCalled()
    expect(map.live().center.lon).toBeCloseTo(NEAR_FIX.lon, 6)
    expect(map.live().center.lat).toBeCloseTo(NEAR_FIX.lat, 6)
  })
})
