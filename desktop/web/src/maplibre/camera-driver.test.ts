// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestView, type TestView } from '../__tests__/support/test-view'
import { geoToMercator, mapZoomToStageScale, mercatorToGeo, stageScaleToMapZoom } from '../canvas/projection'
import type { ScenePersistedState } from '../canvas/runtime/scene'
import type { CameraDriver, CameraDriverDeps } from '../canvas/runtime/view/camera-driver'
import { createCameraDriverHost } from '../canvas/runtime/view/driver-host'
import { createViewNavigation } from '../canvas/runtime/view/navigation'
import { createNavigationPolicy, type NavigationPolicy } from '../canvas/runtime/view/navigation-policy'
import { planarToViewCamera } from '../canvas/runtime/view/camera-math'
import type { GeoPoint } from '../generated/contracts'
import type { PlanarCamera, ViewCamera, ViewFrame, ViewScreen } from '../canvas/runtime/view/types'
import { planarCameraOf } from '../canvas/runtime/view/view-transform'
import { createSessionPlane, type SessionPlane } from '../canvas/session-plane'
import { Camera as SourceCameraClass } from 'maplibre-gl-source/ui/camera.ts'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from './camera-driver'
import type { MapLibreLngLat, MapLibreTransformConstrain } from './loader'

const PLANE = createSessionPlane({ lon: 2.35, lat: 48.85 })
interface SourceCamera {
  readonly transform: {
    readonly centerPoint: object
    resize(width: number, height: number): void
    setConstrainOverride(constrain: MapLibreTransformConstrain | null): void
    screenPointToLocation(point: { x: number; y: number }): unknown
    locationToScreenPoint(ground: unknown): { x: number; y: number }
  }
  jumpTo(options: object): void
  flyTo(options: object): void
  stop(): void
  on(type: string, listener: (event?: unknown) => void): void
  off(type: string, listener: (event?: unknown) => void): void
  getCenter(): MapLibreLngLat
  getZoom(): number
  getBearing(): number
  getPitch(): number
}
const SourceCamera = SourceCameraClass as new (options: object) => SourceCamera
const POLICY = createNavigationPolicy(PLANE.origin.lat, signal(false))

/** MapLibre's LngLat class: the constrain must hand back the class it was given. */
class FakeLngLat implements MapLibreLngLat {
  constructor(readonly lng: number, readonly lat: number) {}
}

interface FakeCamera { center: FakeLngLat; zoom: number; bearing: number; pitch: number }

type Listener = (event?: unknown) => void

/**
 * A consistent MapLibre fake (plan §4, 0A "Attached-map fakes"): getCenter, getZoom, getBearing and unproject describe one camera
 * in Web Mercator at 512-px tiles; jumpTo sets zoom, then centre (each through the installed constrain, as MapLibre does), then the
 * bearing wrapped to (−180, 180], and fires 'move' synchronously; flights run only when the test steps them.
 */
class ConsistentMap {
  readonly listeners = new Map<string, Set<Listener>>()
  /** The container: resize() adopts it, as MapLibre reads its container. */
  container: { width: number; height: number }
  size: { width: number; height: number }
  readonly pixelRatio = 2
  camera: FakeCamera
  constrain: MapLibreTransformConstrain | null = null
  flight: { center: [number, number]; zoom: number; bearing: number } | null = null
  readonly canvas: HTMLCanvasElement

  readonly jumpTo = vi.fn((options: { center: [number, number]; zoom: number; bearing: number; pitch?: number }) => {
    this.stop()
    this.setCameraAsMapLibre(options)
    this.fire('movestart')
    this.fire('move')
    this.fire('moveend')
  })

  readonly flyTo = vi.fn((options: { center: [number, number]; zoom: number; bearing: number }) => {
    this.stop()
    this.flight = options
    this.fire('movestart')
  })

  readonly stop = vi.fn(() => {
    if (!this.flight) return
    this.flight = null
    this.fire('moveend')
  })

  readonly resize = vi.fn(() => {
    this.size = { ...this.container }
    this.applyConstrain()
    this.fire('movestart')
    this.fire('move')
    this.fire('resize')
    this.fire('moveend')
  })

  readonly setTransformConstrain = vi.fn((constrain: MapLibreTransformConstrain | null) => {
    this.constrain = constrain
    this.applyConstrain()
  })

  readonly on = vi.fn((type: string, listener: Listener) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  })

  readonly off = vi.fn((type: string, listener: Listener) => {
    this.listeners.get(type)?.delete(listener)
  })

  constructor(camera: { center: GeoPoint; zoom: number; bearing?: number; pitch?: number }, size = { width: 400, height: 300 }) {
    this.camera = {
      center: new FakeLngLat(camera.center.lon, camera.center.lat),
      zoom: camera.zoom,
      bearing: wrapBearing(camera.bearing ?? 0),
      pitch: camera.pitch ?? 0,
    }
    this.container = { ...size }
    this.size = { ...size }
    this.canvas = document.createElement('canvas')
    Object.defineProperties(this.canvas, {
      clientWidth: { get: () => this.size.width },
      clientHeight: { get: () => this.size.height },
      width: { get: () => this.size.width * this.pixelRatio },
      height: { get: () => this.size.height * this.pixelRatio },
    })
  }

  getCenter(): FakeLngLat { return new FakeLngLat(this.camera.center.lng, this.camera.center.lat) }
  getZoom(): number { return this.camera.zoom }
  getBearing(): number { return this.camera.bearing }
  getPitch(): number { return this.camera.pitch }
  getCanvas(): HTMLCanvasElement { return this.canvas }

  unproject([x, y]: [number, number]): FakeLngLat {
    const worldSize = 512 * 2 ** this.camera.zoom
    const centre = geoToMercator(this.camera.center.lng, this.camera.center.lat)
    const radians = this.camera.bearing * Math.PI / 180
    const dx = x - this.size.width / 2
    const dy = y - this.size.height / 2
    const ground = mercatorToGeo(
      centre.x + (Math.cos(radians) * dx - Math.sin(radians) * dy) / worldSize,
      centre.y + (Math.sin(radians) * dx + Math.cos(radians) * dy) / worldSize,
    )
    return new FakeLngLat(ground.lng, ground.lat)
  }

  /** One animation frame of a running flight: MapLibre moves its camera (through the constrain) and fires 'move'. */
  flightFrame(camera: { center: GeoPoint; zoom: number; bearing: number }): void {
    if (!this.flight) throw new Error('No flight is running.')
    this.setCameraAsMapLibre({ center: [camera.center.lon, camera.center.lat], zoom: camera.zoom, bearing: camera.bearing })
    this.fire('move')
  }

  endFlight(): void {
    const flight = this.flight
    if (!flight) throw new Error('No flight is running.')
    this.setCameraAsMapLibre(flight)
    this.fire('move')
    this.flight = null
    this.fire('moveend')
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }

  private setCameraAsMapLibre(options: { center: [number, number]; zoom: number; bearing: number; pitch?: number }): void {
    if (options.zoom !== this.camera.zoom) {
      this.camera.zoom = options.zoom
      this.applyConstrain()
    }
    this.camera.center = new FakeLngLat(options.center[0], options.center[1])
    this.applyConstrain()
    this.camera.bearing = wrapBearing(options.bearing)
    if (options.pitch !== undefined) this.camera.pitch = options.pitch
  }

  private applyConstrain(): void {
    if (!this.constrain) return
    const { center, zoom } = this.constrain(this.camera.center, this.camera.zoom)
    this.camera.center = center as FakeLngLat
    this.camera.zoom = zoom
  }
}

/** MapLibre's wrap(bearing, −180, 180). */
function wrapBearing(bearing: number): number {
  const wrapped = ((bearing + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}

const drivers: CameraDriver[] = []

function attach(map: ConsistentMap, policy: NavigationPolicy = POLICY, plane: SessionPlane = PLANE) {
  const driver = createMapLibreCameraDriver(map, plane, { policy: () => policy })
  drivers.push(driver)
  const published: ViewFrame[] = []
  driver.frames.onViewFrame((frame) => published.push(frame))
  return { driver, published }
}

/** A placement as the navigation's fits send it: a 'set' to the camera the plane gives for it on the driver's screen. */
function placeOn(driver: CameraDriver, plane: SessionPlane, placement: PlanarCamera): void {
  const target = planarToViewCamera(placement, driver.frames.viewFrame.peek().view.screen, plane)
  driver.apply({ kind: 'set', target, animation: 'none' })
}

function screenOf(frame: ViewFrame): ViewScreen {
  return frame.view.screen
}

const views: TestView[] = []

/** The deps every driver on a test view's host runs with (its policy), as the workspace activation builds one. */
function hostDeps(view: TestView): CameraDriverDeps {
  return view.host.driverDeps
}

/**
 * A test view whose host drives `map` through a MapLibre driver: the navigation and the host over the attached map. The host hands
 * the map its camera, `viewport` (default { x: 0, y: 0, scale: 1 }).
 */
function viewOn(map: ConsistentMap, viewport?: { x: number; y: number; scale: number }) {
  const plane = PLANE
  const view = createTestView({
    plane,
    screen: { ...map.size, devicePixelRatio: map.pixelRatio },
    viewport,
  })
  views.push(view)
  const driver = createMapLibreCameraDriver(map, plane, hostDeps(view))
  view.host.attach(driver)
  return { view, driver }
}

/** The pixel MapLibre shows a plane point at, from the map's own camera (512-px Mercator tiles, north up). */
function mapPixelOf(map: ConsistentMap, plane: SessionPlane, point: { x: number; y: number }) {
  const geo = plane.toGeo(point)
  const ground = geoToMercator(geo.lon, geo.lat)
  const centre = geoToMercator(map.getCenter().lng, map.getCenter().lat)
  const worldSize = 512 * 2 ** map.getZoom()
  return { x: map.size.width / 2 + (ground.x - centre.x) * worldSize, y: map.size.height / 2 + (ground.y - centre.y) * worldSize }
}

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.dispose()
  for (const view of views.splice(0)) view.dispose()
})

describe('MapLibre camera driver', () => {
  it('sends explicit jumpTo values', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver, published } = attach(map)

    driver.apply({ kind: 'zoom-around', anchorPx: { x: 100, y: 80 }, factor: 2 })
    driver.apply({ kind: 'rotate-around', anchorPx: { x: 300, y: 200 }, bearingDeg: 300 })
    driver.apply({ kind: 'pan-by', deltaPx: { x: -7, y: 12 } })
    driver.apply({ kind: 'set', target: { center: { lon: 2.36, lat: 48.86 }, zoom: 17.5, bearingDeg: 15, pitchDeg: 0 }, animation: 'none' })

    expect(map.jumpTo).toHaveBeenCalledTimes(4)
    for (const [options] of map.jumpTo.mock.calls) {
      // Every value explicit: centre, zoom, bearing and a zero pitch, never a partial camera for MapLibre to complete.
      expect(Object.keys(options).sort()).toEqual(['bearing', 'center', 'pitch', 'zoom'])
      expect(options.pitch).toBe(0)
      expect([...options.center, options.zoom, options.bearing].every(Number.isFinite)).toBe(true)
    }
    expect(map.jumpTo.mock.calls[0]![0].zoom).toBe(19)
    expect(map.jumpTo.mock.calls[1]![0].bearing).toBe(300)
    expect(map.jumpTo.mock.calls[3]![0]).toEqual({ center: [2.36, 48.86], zoom: 17.5, bearing: 15, pitch: 0 })
    // One frame per jumpTo, built from the read-backs, the bearing normalised from MapLibre's (−180, 180] to [0, 360).
    expect(published).toHaveLength(4)
    expect(map.getBearing()).toBe(15)
    expect(published[1]!.view.camera.bearingDeg).toBe(300)
    expect(published[3]!.view.camera).toEqual({ center: { lon: 2.36, lat: 48.86 }, zoom: 17.5, bearingDeg: 15, pitchDeg: 0 })
    expect(new Set(published).size).toBe(4)
  })

  it('a pan of +10 px moves the ground 10 px right', () => {
    for (const bearing of [0, 30]) {
      const map = new ConsistentMap({ center: { lon: 2.351, lat: 48.852 }, zoom: 19.3, bearing })
      const { driver, published } = attach(map)
      const ground = map.unproject([120, 90])

      driver.apply({ kind: 'pan-by', deltaPx: { x: 10, y: 0 } })

      // MapLibre's own projection: the ground that was under (120, 90) is now under (130, 90).
      const moved = map.unproject([130, 90])
      expect(moved.lng).toBeCloseTo(ground.lng, 10)
      expect(moved.lat).toBeCloseTo(ground.lat, 10)
      expect(map.getBearing()).toBe(bearing)
      // And the published frame says the same.
      expect(published).toHaveLength(1)
      const onScreen = published[0]!.view.worldToScreen(PLANE.toPlane({ lon: ground.lng, lat: ground.lat }))
      expect(onScreen.x).toBeCloseTo(130, 6)
      expect(onScreen.y).toBeCloseTo(90, 6)
    }
  })

  it('moves during frame dispatch are queued', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver } = attach(map)
    const seen: Array<readonly [string, number]> = []
    const frames: ViewFrame[] = []
    let panned = false
    driver.frames.onViewFrame((frame) => {
      seen.push(['frame', frames.push(frame)])
      if (panned) return
      panned = true
      driver.apply({ kind: 'pan-by', deltaPx: { x: 10, y: 0 } })
      // Neither sent to the map nor published while the frame is dispatched.
      seen.push(['after the move', frames.indexOf(driver.frames.viewFrame.peek()) + 1])
      seen.push(['jumps', map.jumpTo.mock.calls.length])
    })
    const ground = map.unproject([200, 150])

    driver.apply({ kind: 'pan-by', deltaPx: { x: 1, y: 0 } })

    expect(seen).toEqual([
      ['frame', 1],
      ['after the move', 1],
      ['jumps', 1],
      ['frame', 2],
    ])
    const moved = map.unproject([211, 150])
    expect(moved.lng).toBeCloseTo(ground.lng, 10)
    expect(moved.lat).toBeCloseTo(ground.lat, 10)
  })

  it('the guard holds every flight frame at the bearing-free world floor', () => {
    const screen = { width: 1000, height: 800 }
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 3, bearing: 0 }, screen)
    const { driver, published } = attach(map)
    const floor = Math.log2(Math.hypot(1000, 800) / 512)
    // The guard installed on the map: MapLibre calls it on every candidate (centre, zoom), and it never sees the bearing.
    const guard = (zoom: number) => map.constrain!(new FakeLngLat(2.35, 48.85), zoom)
    expect(guard(0).zoom).toBeCloseTo(floor, 6)

    driver.apply({ kind: 'set', target: { center: { lon: 2.4, lat: 48.9 }, zoom: 5, bearingDeg: 90, pitchDeg: 0 }, animation: 'fly' })

    expect(map.flyTo).toHaveBeenCalledWith({ center: [2.4, 48.9], zoom: 5, bearing: 90 })
    expect(map.jumpTo).not.toHaveBeenCalled()
    expect(driver.bearingTarget()).toBe(90)
    const inFlight = guard(0)
    expect(inFlight.zoom).toBeCloseTo(floor, 6)
    expect(inFlight.center).toBeInstanceOf(FakeLngLat)

    // Flight frames are MapLibre's own moves: each rebuilds the frame from the read-backs.
    map.flightFrame({ center: { lon: 2.38, lat: 48.88 }, zoom: 4, bearing: 45 })
    expect(published.at(-1)!.view.camera).toMatchObject({ zoom: 4, bearingDeg: 45 })
    expect(guard(0).zoom).toBeCloseTo(floor, 6)

    map.endFlight()
    const landed = published.at(-1)!
    expect(landed.view.camera).toEqual({ center: { lon: 2.4, lat: 48.9 }, zoom: 5, bearingDeg: 90, pitchDeg: 0 })
    expect(driver.bearingTarget()).toBe(90)
    expect(guard(0).zoom).toBeCloseTo(floor, 6)
  })

  it('fly jumps under reducedMotion', () => {
    // The platform preference reaches the driver through its policy; going to a saved view or a story step asks for a
    // flight and the driver alone chooses the jump, read when the move starts.
    const reducedMotion = signal(true)
    const policy = createNavigationPolicy(PLANE.origin.lat, reducedMotion)
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 3, bearing: 0 }, { width: 1000, height: 800 })
    const { driver, published } = attach(map, policy)
    const target: ViewCamera = { center: { lon: 2.4, lat: 48.9 }, zoom: 5, bearingDeg: 90, pitchDeg: 0 }

    driver.apply({ kind: 'set', target, animation: 'fly' })

    expect(map.flyTo).not.toHaveBeenCalled()
    expect(map.jumpTo).toHaveBeenCalledTimes(1)
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [2.4, 48.9], zoom: 5, bearing: 90, pitch: 0 })
    expect(published.at(-1)!.view.camera).toEqual(target)

    reducedMotion.value = false
    driver.apply({ kind: 'set', target: { ...target, zoom: 6 }, animation: 'fly' })

    expect(map.flyTo).toHaveBeenCalledTimes(1)
    expect(map.jumpTo).toHaveBeenCalledTimes(1)
  })

  it('a resize publishes one frame with the new screen size and keeps the camera', () => {
    const map = new ConsistentMap({ center: { lon: 2.351, lat: 48.852 }, zoom: 18.5, bearing: 20 })
    const { driver, published } = attach(map)
    const before = driver.frames.viewFrame.peek()
    expect(screenOf(before)).toEqual({ width: 400, height: 300, devicePixelRatio: 2 })
    // Once when the driver was created, to the container's size.
    expect(map.resize).toHaveBeenCalledTimes(1)

    map.container = { width: 640, height: 480 }
    driver.setScreen({ width: 640, height: 480, devicePixelRatio: 2 })

    expect(map.resize).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(1)
    expect(screenOf(published[0]!)).toEqual({ width: 640, height: 480, devicePixelRatio: 2 })
    expect(published[0]!.view.camera).toEqual(before.view.camera)
    expect(published[0]!.view.worldToScreen(PLANE.toPlane(before.view.camera.center)).x).toBeCloseTo(320, 6)

    // The second observer reports the same size: nothing happens.
    driver.setScreen({ width: 640, height: 480, devicePixelRatio: 2 })
    expect(map.resize).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(1)
  })

  it('a container resize reported before attach reaches the map when it attaches', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const view = createTestView({
      plane: PLANE,
      screen: { ...map.size, devicePixelRatio: map.pixelRatio },
    })
    views.push(view)
    // The container grows while the style loads: the resize observers report it to the headless camera only.
    const grown = { width: 800, height: 600, devicePixelRatio: 2 }
    map.container = { width: grown.width, height: grown.height }
    view.host.current().setScreen(grown)
    expect(map.resize).not.toHaveBeenCalled()

    view.host.attach(createMapLibreCameraDriver(map, PLANE, hostDeps(view)))

    expect(map.resize).toHaveBeenCalledTimes(1)
    expect(map.size).toEqual({ width: 800, height: 600 })
    const attached = view.frames.viewFrame.peek()
    expect(attached.attached).toBe(true)
    expect(screenOf(attached)).toEqual(grown)
    // Both observers report the size again: nothing happens.
    view.host.current().setScreen(grown)
    expect(map.resize).toHaveBeenCalledTimes(1)
  })

  it('resizing at 45 degrees near the world floor keeps zoom at or above the world floor and keeps the bearing', () => {
    const small = { width: 400, height: 300 }
    const map = new ConsistentMap({ center: { lon: 10, lat: 20 }, zoom: 0, bearing: 45 }, small)
    const { driver, published } = attach(map)
    expect(driver.frames.viewFrame.peek().view.camera.zoom).toBe(0)

    const large = { width: 1600, height: 1200, devicePixelRatio: 2 }
    map.container = { width: large.width, height: large.height }
    driver.setScreen(large)

    const floor = Math.log2(Math.hypot(large.width, large.height) / 512)
    expect(floor).toBeGreaterThan(1.5)
    expect(published).toHaveLength(1)
    const { camera } = published[0]!.view
    expect(camera.zoom).toBeGreaterThanOrEqual(floor - 1e-12)
    expect(camera.bearingDeg).toBe(45)
    expect(map.getZoom()).toBe(camera.zoom)
    expect(map.getBearing()).toBe(45)
    expect(published[0]!.scaleBounds.min).toBeLessThanOrEqual(published[0]!.view.pixelsPerMetre * (1 + 1e-12))
  })

  it('a read-back pitch other than 0 fails with map-error', () => {
    const pitched = new ConsistentMap({ center: PLANE.origin, zoom: 18, pitch: 10 })
    const { driver: refused } = attach(pitched)
    expect(refused.failure.value).toMatchObject({ reason: 'map-error' })

    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver, published } = attach(map)
    expect(driver.failure.value).toBeNull()
    map.camera.pitch = 5
    map.fire('move')

    expect(driver.failure.value).toMatchObject({ reason: 'map-error' })
    expect(published).toHaveLength(0)
    // A failed driver drives nothing.
    driver.apply({ kind: 'pan-by', deltaPx: { x: 10, y: 0 } })
    expect(map.jumpTo).not.toHaveBeenCalled()
  })

  it('a move during a flight stops it and carries its target bearing', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 12, bearing: 0 })
    const { driver } = attach(map)
    driver.apply({ kind: 'set', target: { center: { lon: 2.5, lat: 49 }, zoom: 14, bearingDeg: 60, pitchDeg: 0 }, animation: 'fly' })
    map.flightFrame({ center: { lon: 2.4, lat: 48.9 }, zoom: 13, bearing: 20 })

    driver.apply({ kind: 'pan-by', deltaPx: { x: 5, y: 0 } })

    expect(map.stop).toHaveBeenCalled()
    expect(map.flight).toBeNull()
    expect(map.jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 60, zoom: 13 }))
    expect(driver.bearingTarget()).toBe(60)
  })

  it('dispose releases its map listeners and the guard', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver } = attach(map)
    expect(map.listenerCount()).toBe(2)
    expect(map.constrain).not.toBeNull()

    driver.dispose()

    expect(map.listenerCount()).toBe(0)
    expect(map.setTransformConstrain).toHaveBeenLastCalledWith(null)
    driver.apply({ kind: 'pan-by', deltaPx: { x: 10, y: 0 } })
    expect(map.jumpTo).not.toHaveBeenCalled()
  })

  // Moved from __tests__/maplibre-camera.test.ts (createMapFrame > …): a placement, as the navigation's fits send it (a 'set' to the
  // camera the plane gives for it), reaches the map as one explicit camera.

  it('a placement becomes the north-up camera over the plane point at the screen centre', () => {
    const plane = createSessionPlane({ lon: -122.68, lat: 45.52 })
    const map = new ConsistentMap({ center: plane.origin, zoom: 16 }, { width: 1000, height: 800 })
    const { driver, published } = attach(map, createNavigationPolicy(45.52, signal(false)), plane)

    placeOn(driver, plane, { x: -200, y: -100, scale: 2, bearingDeg: 0 })

    const centre = plane.toGeo({ x: 350, y: 250 })
    const [options] = map.jumpTo.mock.calls.at(-1)!
    expect(options.center[0]).toBeCloseTo(centre.lon, 8)
    expect(options.center[1]).toBeCloseTo(centre.lat, 8)
    expect(options.zoom).toBeCloseTo(stageScaleToMapZoom(2, 45.52), 8)
    expect(options.bearing).toBe(0)
    expect(published).toHaveLength(1)
    expect(published[0]!.view.camera.bearingDeg).toBe(0)
  })

  it('a placement that is not finite or has no scale moves nothing', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver, published } = attach(map)

    for (const planar of [
      { x: 0, y: 0, scale: 0, bearingDeg: 0 },
      { x: 0, y: 0, scale: -2, bearingDeg: 0 },
      { x: Number.NaN, y: 0, scale: 2, bearingDeg: 0 },
      { x: 0, y: 0, scale: Number.POSITIVE_INFINITY, bearingDeg: 0 },
    ]) placeOn(driver, PLANE, planar)

    expect(map.jumpTo).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })

  it('a placement past zoom 27 lands at zoom 27', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const map = new ConsistentMap({ center: plane.origin, zoom: 18 }, { width: 1000, height: 800 })
    const { driver, published } = attach(map, createNavigationPolicy(0, signal(false)), plane)

    placeOn(driver, plane, { x: 0, y: 0, scale: 5000, bearingDeg: 0 })

    expect(map.jumpTo.mock.calls.at(-1)![0]).toMatchObject({ zoom: 27, bearing: 0 })
    expect(published.at(-1)!.view.camera.zoom).toBe(27)
    expect(published.at(-1)!.view.pixelsPerMetre).toBe(published.at(-1)!.scaleBounds.max)
  })

  it('the frame reads back the placed centre and the ground under the four corners', () => {
    const plane = createSessionPlane({ lon: -122.68, lat: 45.52 })
    const map = new ConsistentMap({ center: plane.origin, zoom: 16 }, { width: 1000, height: 800 })
    const { driver } = attach(map, createNavigationPolicy(45.52, signal(false)), plane)

    placeOn(driver, plane, { x: -200, y: -100, scale: 2, bearingDeg: 0 })

    const { view } = driver.frames.viewFrame.peek()
    const centre = view.screenToWorld({ x: 500, y: 400 })
    expect(centre.x).toBeCloseTo(350, 8)
    expect(centre.y).toBeCloseTo(250, 8)
    const corners = view.visibleWorldQuad().map((corner) => plane.toGeo(corner))
    expect(corners).toHaveLength(4)
    expect(corners[0]!.lon).toBeLessThan(corners[1]!.lon)
    expect(corners[0]!.lat).toBeGreaterThan(corners[2]!.lat)
  })

  // Moved from __tests__/maplibre-workspace-camera.test.ts (MapLibreWorkspaceCameraOwner > …): the attached camera is the driver's.

  it('zooming in at zoom 27 sends no jump and publishes nothing', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 27 })
    const { driver, published } = attach(map)
    const boundary = driver.frames.viewFrame.peek()
    expect(boundary.view.pixelsPerMetre).toBe(boundary.scaleBounds.max)

    // Off-centre, so a clamped zoom that still moved the centre would show.
    for (let input = 0; input < 100; input += 1) driver.apply({ kind: 'zoom-around', anchorPx: { x: 120, y: 90 }, factor: 1.1 })

    expect(map.jumpTo).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
    expect(driver.frames.viewFrame.peek()).toBe(boundary)
  })

  it('zooming out at the world floor sends no jump and publishes nothing', () => {
    // The guard lifts the attached camera to the floor as it is installed.
    const map = new ConsistentMap({ center: { lon: 2.35, lat: 0 }, zoom: 0 }, { width: 400, height: 1024 })
    const { driver, published } = attach(map)
    const boundary = driver.frames.viewFrame.peek()
    expect(boundary.view.camera.zoom).toBeCloseTo(Math.log2(Math.hypot(400, 1024) / 512), 6)
    expect(boundary.scaleBounds.min).toBeCloseTo(boundary.view.pixelsPerMetre, 12)

    for (let input = 0; input < 100; input += 1) driver.apply({ kind: 'zoom-around', anchorPx: { x: 200, y: 512 }, factor: 1 / 1.1 })

    expect(map.jumpTo).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
    expect(driver.frames.viewFrame.peek()).toBe(boundary)
  })

  it('publishes the exact zoom-27 scale at a high-latitude session plane origin', () => {
    const plane = createSessionPlane({ lon: 179.9, lat: 80 })
    const map = new ConsistentMap({ center: plane.origin, zoom: 27 })
    const { driver } = attach(map, createNavigationPolicy(80, signal(false)), plane)

    const frame = driver.frames.viewFrame.peek()
    expect(frame.view.pixelsPerMetre).toBe(mapZoomToStageScale(27, 80))
    expect(frame.scaleBounds.max).toBe(mapZoomToStageScale(27, 80))
    expect(frame.mode).toBe('site')
  })

  it('a camera change of the map\'s own publishes one frame in CSS pixels, and an unchanged move none', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver, published } = attach(map)
    const frames = driver.frames.viewFrame
    expect(frames.peek().view.screen).toEqual({ width: 400, height: 300, devicePixelRatio: 2 })

    map.fire('move')
    expect(published).toHaveLength(0)

    map.camera = { ...map.camera, center: new FakeLngLat(2.3501, 48.8502), zoom: 18.5 }
    map.fire('move')

    expect(driver.frames.viewFrame).toBe(frames)
    expect(published).toHaveLength(1)
    expect(published[0]!.view.camera).toEqual({ center: { lon: 2.3501, lat: 48.8502 }, zoom: 18.5, bearingDeg: 0, pitchDeg: 0 })
    expect(published[0]!.view.screen).toEqual({ width: 400, height: 300, devicePixelRatio: 2 })
  })

  it('planeChanged re-expresses the frame in the new plane and the map stays put', () => {
    const map = new ConsistentMap({ center: { lon: 2.3522, lat: 48.8566 }, zoom: 18 })
    const { driver, published } = attach(map)
    const before = driver.frames.viewFrame.peek()
    const screenPoints = [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: 200, y: 150 }, { x: 37.5, y: 211 }]
    const groundBefore = screenPoints.map((point) => PLANE.toGeo(before.view.screenToWorld(point)))
    // A re-origin about 20 km east, as the runtime makes after panning away.
    const next = createSessionPlane(PLANE.toGeo({ x: 20_000, y: -5_000 }))

    driver.planeChanged(next)

    expect(map.jumpTo).not.toHaveBeenCalled()
    expect(published).toHaveLength(1)
    const after = published[0]!
    expect(after.view.planeRevision).toBe(before.view.planeRevision + 1)
    expect(after.view.camera).toEqual(before.view.camera)
    // The same ground under every screen point, expressed once in the next plane: its origin is where the map shows it.
    for (const [index, point] of screenPoints.entries()) {
      const ground = next.toGeo(after.view.screenToWorld(point))
      expect(ground.lon).toBeCloseTo(groundBefore[index]!.lon, 9)
      expect(ground.lat).toBeCloseTo(groundBefore[index]!.lat, 9)
    }
    const originPx = after.view.worldToScreen({ x: 0, y: 0 })
    const origin = map.unproject([originPx.x, originPx.y])
    expect(origin.lng).toBeCloseTo(next.origin.lon, 9)
    expect(origin.lat).toBeCloseTo(next.origin.lat, 9)

    // Never transformed twice: the same plane again changes nothing.
    driver.planeChanged(next)
    expect(published).toHaveLength(1)
  })

  it('detach keeps the attached placement, scale bounds and mode exactly', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { view } = viewOn(map, { x: 200, y: 150, scale: 0.01 })
    const attached = view.frames.viewFrame.peek()
    expect(attached.attached).toBe(true)
    expect(attached.mode).toBe('overview')

    view.host.detach()

    const detached = view.frames.viewFrame.peek()
    expect(detached.attached).toBe(false)
    expect(planarCameraOf(detached.view)).toEqual(planarCameraOf(attached.view))
    expect(detached.scaleBounds).toEqual(attached.scaleBounds)
    expect(detached.mode).toBe('overview')
    // The map's later moves no longer reach the frame.
    map.camera = { ...map.camera, zoom: 5 }
    map.fire('move')
    expect(view.frames.viewFrame.peek()).toBe(detached)
  })

  it('temporary focus and its return reach the map as one jump each', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { view } = viewOn(map)
    const jumps = map.jumpTo.mock.calls.length
    const before = view.view().camera

    expect(view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { paddingCssPx: 48 })).toBe(true)
    expect(view.navigation.returnFromTemporaryFocus()).toBe(true)

    expect(map.jumpTo).toHaveBeenCalledTimes(jumps + 2)
    const returned = view.view().camera
    expect(returned.center.lon).toBeCloseTo(before.center.lon, 9)
    expect(returned.center.lat).toBeCloseTo(before.center.lat, 9)
    expect(returned.zoom).toBeCloseTo(before.zoom, 9)
    // A new camera command drops the bookmark.
    view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { paddingCssPx: 48 })
    view.navigation.panByPx({ x: 5, y: 0 })
    expect(view.navigation.returnFromTemporaryFocus()).toBe(false)
  })

  it('a map call that throws fails the driver, and the host takes the camera back where it was', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { view } = viewOn(map)
    view.navigation.panByPx({ x: 10, y: 0 })
    const last = view.view().camera
    map.jumpTo.mockImplementationOnce(() => { throw new Error('map navigation failed') })

    view.navigation.panByPx({ x: 25, y: 0 })

    expect(view.host.failure.value).toMatchObject({ reason: 'map-error' })
    expect(view.host.failure.value!.message).toContain('map navigation failed')
    expect(view.frames.viewFrame.peek().attached).toBe(false)
    expect(view.view().camera.center.lon).toBeCloseTo(last.center.lon, 9)
    expect(view.view().camera.center.lat).toBeCloseTo(last.center.lat, 9)
    // The headless camera takes the next move; the map is no longer driven.
    const jumps = map.jumpTo.mock.calls.length
    const x = planarCameraOf(view.view()).x
    view.navigation.panByPx({ x: 10, y: 0 })
    expect(planarCameraOf(view.view()).x).toBeCloseTo(x + 10, 6)
    expect(map.jumpTo).toHaveBeenCalledTimes(jumps)
  })

  it('after dispose, late map events publish nothing and a second dispose does nothing', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver, published } = attach(map)
    const last = driver.frames.viewFrame.peek()

    driver.dispose()
    driver.dispose()
    map.camera = { ...map.camera, zoom: 17 }
    map.fire('move')
    map.fire('resize')

    expect(published).toHaveLength(0)
    expect(driver.frames.viewFrame.peek()).toBe(last)
    expect(map.off).toHaveBeenCalledTimes(2)
  })

  it('dispose tries every release and then throws', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { driver } = attach(map)
    map.off.mockImplementation(() => { throw new Error('off failed') })

    expect(() => driver.dispose()).toThrow('could not release')
    expect(map.off).toHaveBeenCalledTimes(2)
    expect(map.setTransformConstrain).toHaveBeenLastCalledWith(null)
  })

  it('a replaced map\'s late moves never reach the frame', () => {
    const first = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { view } = viewOn(first)
    // MapLibre may still emit while the replaced driver removes its listeners.
    first.off.mockImplementation((type: string, listener: (event?: unknown) => void) => {
      first.camera = { ...first.camera, zoom: 12 }
      first.fire('move')
      first.listeners.get(type)?.delete(listener)
    })
    const second = new ConsistentMap({ center: { lon: 2.36, lat: 48.86 }, zoom: 17 })

    view.host.attach(createMapLibreCameraDriver(second, PLANE, hostDeps(view)))

    const settled = view.frames.viewFrame.peek()
    expect(settled.view.camera.zoom).toBeCloseTo(second.getZoom(), 12)
    first.camera = { ...first.camera, zoom: 9 }
    first.fire('move')
    expect(view.frames.viewFrame.peek()).toBe(settled)
  })

  it('showPlace flies an attached map when asked to, and jumps otherwise', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const { view } = viewOn(map)
    const jumps = map.jumpTo.mock.calls.length
    const target = PLANE.toGeo({ x: 40, y: 25 })

    expect(view.navigation.showPlace(target, 19, { motion: 'fly' })).toBe(true)

    expect(map.flyTo).toHaveBeenCalledTimes(1)
    const [flight] = map.flyTo.mock.calls[0]!
    expect(flight.center[0]).toBeCloseTo(target.lon, 9)
    expect(flight.center[1]).toBeCloseTo(target.lat, 9)
    expect(flight.zoom).toBeCloseTo(19, 9)
    expect(flight.bearing).toBe(0)
    expect(map.jumpTo).toHaveBeenCalledTimes(jumps)

    expect(view.navigation.showPlace(target, 19)).toBe(true)
    expect(map.flyTo).toHaveBeenCalledTimes(1)
    expect(map.jumpTo).toHaveBeenCalledTimes(jumps + 1)
  })
})

// Moved from __tests__/maplibre-camera.test.ts: a placement on the attached map keeps every plane point on the canvas pixel the
// placement gives it (p × scale + { x, y }), through MapLibre's own Mercator camera.
/** The runtime's camera as the runtime builds it: a host on the runtime's plane, with the navigation over it and one attached map. */
function runtimeCameraOn(map: ConsistentMap) {
  let runtimePlane = PLANE
  const host = createCameraDriverHost({
    reducedMotion: signal(false),
    plane: () => runtimePlane,
    screen: { width: 400, height: 300, devicePixelRatio: 1 },
  })
  const navigation = createViewNavigation({
    driver: host,
    policy: host.driverDeps.policy,
    readSceneExtent: () => ({ extentPoints: () => [], emptySceneScale: 0 }),
    readSelectionPoints: () => [],
  })
  // Attached on the host, as the workspace activation attaches each map.
  host.attach(createMapLibreCameraDriver(map, PLANE, host.driverDeps))
  return {
    host,
    navigation,
    /** The runtime's plane effect on a re-origin: the Scene's plane moves, then the live driver is re-expressed in it. */
    reorigin(next: SessionPlane) {
      runtimePlane = next
      host.current().planeChanged(next)
    },
  }
}

// The attached re-origin, which the runtime's plane effect makes (it was the MapLibre shim's refreshOrigin before 0E).
/** MapLibre 6.10.0's own Camera (the test-only `maplibre-gl-source` alias, vite.config.ts) on its MercatorTransform, with no WebGL:
 *  the map methods the driver calls, over the real camera. Animation frames are only queued, never run. */
function sourceCameraMap(screen: { readonly width: number; readonly height: number }) {
  const frames: Array<() => void> = []
  const camera = new SourceCamera({
    minZoom: 0, maxZoom: 27, minPitch: 0, maxPitch: 60, bearingSnap: 0, zoomSnap: 0, renderWorldCopies: false,
    centerClampedToGround: true, terrain: null, transformConstrain: null, transformCameraUpdate: null,
    requestRenderFrame: (frame: () => void) => frames.push(frame),
    cancelRenderFrame: () => { frames.length = 0 },
  })
  camera.transform.resize(screen.width, screen.height)
  const canvas = { clientWidth: screen.width, clientHeight: screen.height, width: screen.width } as HTMLCanvasElement
  const map: MapLibreCameraDriverMap = {
    jumpTo: (options) => { camera.jumpTo(options) },
    flyTo: (options) => { camera.flyTo(options) },
    stop: () => { camera.stop() },
    resize: () => {},
    on: (type, listener) => { camera.on(type, listener) },
    off: (type, listener) => { camera.off(type, listener) },
    getCenter: () => camera.getCenter(),
    getZoom: () => camera.getZoom(),
    getBearing: () => camera.getBearing(),
    getPitch: () => camera.getPitch(),
    setTransformConstrain: (constrain) => { camera.transform.setConstrainOverride(constrain) },
    getCanvas: () => canvas,
  }
  const Point = camera.transform.centerPoint.constructor as new (x: number, y: number) => { x: number; y: number }
  return {
    map,
    frames,
    /** MapLibre's own ground under a screen point, and the screen point it shows a ground point at. */
    groundAt: (x: number, y: number) => camera.transform.screenPointToLocation(new Point(x, y)),
    pixelOf: (ground: unknown) => camera.transform.locationToScreenPoint(ground),
    camera: () => ({ lng: camera.getCenter().lng, lat: camera.getCenter().lat, zoom: camera.getZoom(), bearing: camera.getBearing() }),
  }
}

describe('the MapLibre camera driver over MapLibre\'s own camera', () => {
  it('a turn about an anchor keeps the anchor\'s ground and lands where the headless jump lands', () => {
    const screen = { width: 900, height: 600 }
    const options = { plane: PLANE, screen: { ...screen, devicePixelRatio: 1 }, camera: { center: { lon: 2.36, lat: 48.86 }, zoom: 18, bearingDeg: 40 } }
    const source = sourceCameraMap(screen)
    const attached = createTestView(options)
    const headless = createTestView(options)
    views.push(attached, headless)
    attached.host.attach(createMapLibreCameraDriver(source.map, PLANE, attached.host.driverDeps))
    const anchor = { x: 200, y: 150 }
    const ground = source.groundAt(anchor.x, anchor.y)

    // A free turn released within 7 degrees of north jumps to north about its pivot (U34).
    for (const view of [attached, headless]) {
      const session = view.navigation.beginRotation(anchor)
      session.update(-35, { step: false })
      session.end()
    }

    // Landed at once: MapLibre never needed an animation frame.
    expect(source.frames).toHaveLength(0)
    const landed = source.camera()
    expect(landed.bearing).toBeCloseTo(0, 6)
    const kept = source.pixelOf(ground)
    expect(kept.x).toBeCloseTo(anchor.x, 6)
    expect(kept.y).toBeCloseTo(anchor.y, 6)
    const jumped = headless.view().camera
    expect(jumped.bearingDeg).toBe(0)
    expect(landed.lng).toBeCloseTo(jumped.center.lon, 9)
    expect(landed.lat).toBeCloseTo(jumped.center.lat, 9)
    expect(landed.zoom).toBeCloseTo(jumped.zoom, 9)
    expect(attached.view().camera.bearingDeg).toBe(0)
  })
})

describe('the runtime camera on an attached map', () => {
  it('an attached re-origin keeps the map still and frames in the new plane', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const camera = runtimeCameraOn(map)
    try {
      const before = camera.host.frames.viewFrame.peek()
      const groundAtCentre = PLANE.toGeo(before.view.screenToWorld({ x: 200, y: 150 }))
      const jumps = map.jumpTo.mock.calls.length
      const next = createSessionPlane(PLANE.toGeo({ x: 20_000, y: -5_000 }))

      camera.reorigin(next)

      expect(map.jumpTo).toHaveBeenCalledTimes(jumps)
      const after = camera.host.frames.viewFrame.peek()
      expect(after.attached).toBe(true)
      expect(after.view.planeRevision).toBeGreaterThan(before.view.planeRevision)
      expect(after.view.camera).toEqual(before.view.camera)
      const ground = next.toGeo(after.view.screenToWorld({ x: 200, y: 150 }))
      expect(ground.lon).toBeCloseTo(groundAtCentre.lon, 9)
      expect(ground.lat).toBeCloseTo(groundAtCentre.lat, 9)
      // The new latitude's scale bounds.
      expect(after.scaleBounds.max).toBeCloseTo(mapZoomToStageScale(27, next.origin.lat), 6)
    } finally {
      camera.host.dispose()
    }
  })

  it('a re-origin during a flight keeps the flight running', () => {
    const map = new ConsistentMap({ center: PLANE.origin, zoom: 18 })
    const camera = runtimeCameraOn(map)
    try {
      const far = { x: 30_000, y: -60_000 }
      const target = PLANE.toGeo(far)
      camera.navigation.showCamera({ center: target, zoom: 17, bearingDeg: 0, pitchDeg: 0 }, { motion: 'fly' })
      expect(map.flight).not.toBeNull()
      map.flightFrame({ center: target, zoom: 14, bearing: 0 })

      // The re-origin the flight triggered: the Scene's plane moves to a new latitude, and the runtime re-expresses the camera.
      const next = createSessionPlane(target)
      const stops = map.stop.mock.calls.length
      camera.reorigin(next)

      expect(map.stop).toHaveBeenCalledTimes(stops)
      expect(map.jumpTo).not.toHaveBeenCalledWith(expect.objectContaining({ zoom: 14 }))
      expect(map.flight).not.toBeNull()
      const during = camera.host.frames.viewFrame.peek()
      expect(during.view.camera.zoom).toBe(14)
      map.endFlight()
      const landed = camera.host.frames.viewFrame.peek()
      expect(landed.view.camera.zoom).toBeCloseTo(17, 9)
      // The landed frame carries the new latitude's scale bounds and is expressed in the new plane.
      expect(landed.scaleBounds.max).toBeCloseTo(mapZoomToStageScale(27, next.origin.lat), 6)
      const originPx = landed.view.worldToScreen({ x: 0, y: 0 })
      const shown = map.unproject([originPx.x, originPx.y])
      expect(shown.lng).toBeCloseTo(next.origin.lon, 9)
      expect(shown.lat).toBeCloseTo(next.origin.lat, 9)
    } finally {
      camera.host.dispose()
    }
  })
})

describe('screen-lock validation', () => {
  const location = { lat: 48.8566, lon: 2.3522 }
  const plane = createSessionPlane(location)
  const worldPoints = [
    { x: 0, y: 0 },
    { x: 12.5, y: -6.25 },
    { x: -50, y: 24 },
    { x: 500, y: -250 },
  ] as const

  function placedOn(size: { width: number; height: number }, viewport: { x: number; y: number; scale: number }) {
    const map = new ConsistentMap({ center: plane.origin, zoom: 16 }, size)
    const { driver } = attach(map, createNavigationPolicy(location.lat, signal(false)), plane)
    placeOn(driver, plane, { ...viewport, bearingDeg: 0 })
    return map
  }

  function canvasPixelOf(viewport: { x: number; y: number; scale: number }, point: { x: number; y: number }) {
    return { x: viewport.x + point.x * viewport.scale, y: viewport.y + point.y * viewport.scale }
  }

  /** Today's fit of the scene on a fresh screen, through the navigation (at bearing 0, today's CameraController fit). */
  function fittedViewport(scene: ScenePersistedState, size: { width: number; height: number }) {
    const view = createTestView({ screen: size, viewport: { x: size.width / 2 - 50 * 8, y: size.height / 2 - 50 * 8, scale: 8 } })
    views.push(view)
    view.setScene(scene)
    view.navigation.zoomToFit()
    const { x, y, scale } = planarCameraOf(view.view())
    return { x, y, scale }
  }

  function screenLockScene(): ScenePersistedState {
    return {
      plantSpeciesColors: {},
      plantSpeciesSymbols: {},
      plantSpeciesCodes: {},
      layers: [],
      plants: [
        {
          kind: 'plant', locked: false, id: 'plant-1', canonicalName: 'Malus domestica', commonName: null, color: null,
          canopySpreadM: null, position: { x: -40, y: 15 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1,
        },
        {
          kind: 'plant', locked: false, id: 'plant-2', canonicalName: 'Prunus avium', commonName: null, color: null,
          canopySpreadM: null, position: { x: 30, y: -20 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1,
        },
      ],
      zones: [
        {
          kind: 'zone', locked: false, id: 'zone-1', name: null, zoneType: 'rect', rotationDeg: 0,
          points: [{ x: -60, y: -30 }, { x: 60, y: -30 }, { x: 60, y: 50 }, { x: -60, y: 50 }], fillColor: null, notes: null,
        },
      ],
      annotations: [],
      measurementGuides: [],
      groups: [],
    }
  }

  it('keeps the same world point on the same screen pixel', () => {
    const viewport = { x: -175.25, y: 92.5, scale: 3.75 }
    const map = placedOn({ width: 1200, height: 800 }, viewport)

    for (const point of worldPoints) {
      const canvas = canvasPixelOf(viewport, point)
      const onMap = mapPixelOf(map, plane, point)
      expect(onMap.x).toBeCloseTo(canvas.x, 6)
      expect(onMap.y).toBeCloseTo(canvas.y, 6)
    }
  })

  it('preserves screen lock across tiny pan changes', () => {
    const beforeViewport = { x: -200.125, y: 50.75, scale: 2.2 }
    const afterViewport = { x: -200.0625, y: 50.6875, scale: 2.2 }
    const world = { x: 42.5, y: -18.25 }
    const beforeMap = mapPixelOf(placedOn({ width: 1200, height: 800 }, beforeViewport), plane, world)
    const afterMap = mapPixelOf(placedOn({ width: 1200, height: 800 }, afterViewport), plane, world)
    const beforeCanvas = canvasPixelOf(beforeViewport, world)
    const afterCanvas = canvasPixelOf(afterViewport, world)

    expect(afterMap.x - beforeMap.x).toBeCloseTo(afterCanvas.x - beforeCanvas.x, 6)
    expect(afterMap.y - beforeMap.y).toBeCloseTo(afterCanvas.y - beforeCanvas.y, 6)
  })

  it('preserves screen lock across tiny zoom changes', () => {
    const beforeViewport = { x: -80, y: 32, scale: 0.95 }
    const afterViewport = { x: -80, y: 32, scale: 0.9505 }
    const world = { x: -120, y: 75 }
    const beforeMap = mapPixelOf(placedOn({ width: 1200, height: 800 }, beforeViewport), plane, world)
    const afterMap = mapPixelOf(placedOn({ width: 1200, height: 800 }, afterViewport), plane, world)
    const beforeCanvas = canvasPixelOf(beforeViewport, world)
    const afterCanvas = canvasPixelOf(afterViewport, world)

    expect(afterMap.x - beforeMap.x).toBeCloseTo(afterCanvas.x - beforeCanvas.x, 6)
    expect(afterMap.y - beforeMap.y).toBeCloseTo(afterCanvas.y - beforeCanvas.y, 6)
  })

  it('keeps screen lock after viewport resize', () => {
    const viewport = { x: -200, y: 80, scale: 2.1 }
    const point = { x: 150, y: -45 }
    const map = placedOn({ width: 1600, height: 900 }, viewport)

    const canvas = canvasPixelOf(viewport, point)
    const onMap = mapPixelOf(map, plane, point)
    expect(onMap.x).toBeCloseTo(canvas.x, 6)
    expect(onMap.y).toBeCloseTo(canvas.y, 6)
  })

  it('keeps screen lock for fit-to-content viewports', () => {
    const scene = screenLockScene()
    const size = { width: 1280, height: 820 }
    const viewport = fittedViewport(scene, size)
    const map = placedOn(size, viewport)
    const point = scene.plants[1]!.position

    const canvas = canvasPixelOf(viewport, point)
    const onMap = mapPixelOf(map, plane, point)
    expect(onMap.x).toBeCloseTo(canvas.x, 6)
    expect(onMap.y).toBeCloseTo(canvas.y, 6)
  })

  it('keeps screen lock for document-open auto-fit viewports', () => {
    const scene = screenLockScene()
    scene.annotations.push({
      kind: 'annotation', locked: false, id: 'annotation-1', annotationType: 'text',
      position: { x: 95, y: -55 }, text: 'Open document', fontSize: 18, rotationDeg: null,
    })
    const size = { width: 1100, height: 760 }
    const viewport = fittedViewport(scene, size)
    const map = placedOn(size, viewport)
    const point = scene.annotations[0]!.position

    const canvas = canvasPixelOf(viewport, point)
    const onMap = mapPixelOf(map, plane, point)
    expect(onMap.x).toBeCloseTo(canvas.x, 6)
    expect(onMap.y).toBeCloseTo(canvas.y, 6)
  })
})
