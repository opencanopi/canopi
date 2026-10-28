// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { geoToMercator, mercatorToGeo } from '../canvas/projection'
import type { MapLibreMapConstructorOptions } from './loader'
import {
  mountMapBackground,
  type MapBackgroundHandle,
  type MapBackgroundOptions,
  type MapBackgroundPresentation,
} from './map-background'
import { createSharedMapSceneLayer, type SharedMapSceneLayer, type SharedMapSceneLayerOptions } from './shared-scene-layer'
import { createTestSceneRendererSnapshot } from '../__tests__/support/scene-renderer-snapshot'
import type { ViewTransform } from '../canvas/runtime/view/types'
import { createSessionPlane } from '../canvas/session-plane'
import { describeSavedViewSnapshot, VIEW_SNAPSHOT_THUMBNAIL } from '../app/saved-views/snapshot'
import { createDefaultMapLayers } from '../app/map-layers/state'
import type { SavedView } from '../types/design'
import { createTestCanvasQuerySurface } from '../__tests__/support/canvas-query-surface'
import { groundSizeShown } from '../__tests__/support/saved-view-frame'
import {
  createViewSnapshotMap,
  VIEW_SNAPSHOT_SCENE_LAYER_ID,
  type ViewSnapshotMapOptions,
  type ViewSnapshotRequest,
} from './view-snapshot-map'

const ORIGIN = { lat: 48.2, lon: 0.03 }
const SECRET_KEY = 'AIza-snapshot-secret'

type Listener = (event?: unknown) => void

/**
 * A consistent MapLibre fake: getCenter, getZoom, getBearing, project and unproject describe one camera in Web Mercator at 512-pixel
 * tiles over the canvas' CSS size, which follows the container at construction and on resize; jumpTo fires 'move' synchronously.
 */
class FakeMap {
  static instances: FakeMap[] = []
  static autoLoad = true
  static autoIdle = true
  readonly listeners = new Map<string, Set<Listener>>()
  readonly canvas: HTMLCanvasElement
  readonly layers = new Map<string, Record<string, unknown>>()
  readonly jumps: { center: [number, number]; zoom: number }[] = []
  center: [number, number]
  zoom: number
  bearing: number
  cssWidth = 0
  cssHeight = 0
  tilesLoaded = true
  resizes = 0
  redraws = 0
  removed = false

  constructor(readonly options: MapLibreMapConstructorOptions) {
    FakeMap.instances.push(this)
    this.center = (options.center ?? [0, 0]) as [number, number]
    this.zoom = options.zoom ?? 0
    this.bearing = options.bearing ?? 0
    this.canvas = document.createElement('canvas')
    Object.defineProperties(this.canvas, {
      getContext: { configurable: true, value: (type: string) => (type === 'webgl2' ? ({} as WebGL2RenderingContext) : null) },
      clientWidth: { get: () => this.cssWidth },
      clientHeight: { get: () => this.cssHeight },
    })
    this.syncCanvasSize()
    options.container.appendChild(this.canvas)
    const attribution = document.createElement('div')
    attribution.className = 'maplibregl-ctrl-attrib-inner'
    attribution.innerHTML = '<a>OpenFreeMap</a> | <a>© OpenStreetMap</a> | <a>OpenFreeMap</a>'
    options.container.appendChild(attribution)
    if (FakeMap.autoLoad) queueMicrotask(() => this.fire('load'))
  }

  get pixelRatio(): number { return this.options.pixelRatio ?? 1 }

  syncCanvasSize(): void {
    this.cssWidth = parseInt(this.options.container.style.width, 10)
    this.cssHeight = parseInt(this.options.container.style.height, 10)
    this.canvas.width = Math.round(this.cssWidth * this.pixelRatio)
    this.canvas.height = Math.round(this.cssHeight * this.pixelRatio)
  }

  on(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  off(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener) }
  fire(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0 }

  jumpTo(options: { center: [number, number]; zoom: number; bearing?: number }): void {
    this.center = options.center
    this.zoom = options.zoom
    if (options.bearing !== undefined) this.bearing = options.bearing
    this.jumps.push({ center: options.center, zoom: options.zoom })
    this.fire('move')
  }
  flyTo(options: { center: [number, number]; zoom: number; bearing: number }): void {
    this.jumpTo(options)
    this.fire('moveend')
  }
  stop(): void {}
  setTransformConstrain(): void {}
  resize(): void {
    this.resizes += 1
    this.syncCanvasSize()
    this.fire('move')
    this.fire('resize')
  }
  redraw(): void { this.redraws += 1 }
  remove(): void { this.removed = true }
  loaded(): boolean { return true }
  isStyleLoaded(): boolean { return true }
  areTilesLoaded(): boolean { return this.tilesLoaded }
  triggerRepaint(): void {
    if (FakeMap.autoIdle) queueMicrotask(() => this.fire('idle'))
  }
  getCanvas(): HTMLCanvasElement { return this.canvas }
  getPitch(): number { return 0 }
  getCenter(): { lng: number; lat: number } { return { lng: this.center[0], lat: this.center[1] } }
  getZoom(): number { return this.zoom }
  getBearing(): number { return this.bearing }
  addLayer(layer: Record<string, unknown>): void { this.layers.set(String(layer.id), layer) }
  getLayer(id: string): unknown { return this.layers.get(id) }
  /** Web Mercator at 512-pixel tiles, like MapLibre. */
  project(point: { lng: number; lat: number }): { x: number; y: number } {
    const worldSize = 512 * 2 ** this.zoom
    const centre = geoToMercator(this.center[0], this.center[1])
    const target = geoToMercator(point.lng, point.lat)
    const radians = this.bearing * Math.PI / 180
    const dx = (target.x - centre.x) * worldSize
    const dy = (target.y - centre.y) * worldSize
    return {
      x: Math.cos(radians) * dx + Math.sin(radians) * dy + this.cssWidth / 2,
      y: Math.cos(radians) * dy - Math.sin(radians) * dx + this.cssHeight / 2,
    }
  }
  unproject([x, y]: [number, number]): { lng: number; lat: number } {
    const worldSize = 512 * 2 ** this.zoom
    const centre = geoToMercator(this.center[0], this.center[1])
    const radians = this.bearing * Math.PI / 180
    const dx = x - this.cssWidth / 2
    const dy = y - this.cssHeight / 2
    return mercatorToGeo(
      centre.x + (Math.cos(radians) * dx - Math.sin(radians) * dy) / worldSize,
      centre.y + (Math.sin(radians) * dx + Math.cos(radians) * dy) / worldSize,
    )
  }
}

interface FakeLayer extends SharedMapSceneLayer {
  readonly options: SharedMapSceneLayerOptions
  readonly snapshots: unknown[]
}

let layers: FakeLayer[] = []
let backgrounds: (MapBackgroundHandle & { presentations: MapBackgroundPresentation[]; disposed: boolean; applied: boolean; options: MapBackgroundOptions })[] = []

function createFakeLayer(options: SharedMapSceneLayerOptions): FakeLayer {
  let sceneSyncCount = 0
  const snapshots: unknown[] = []
  const layer: FakeLayer = {
    options,
    snapshots,
    layer: { id: options.id, type: 'custom', render: () => undefined },
    get diagnostics() { return { sceneSyncCount } as SharedMapSceneLayer['diagnostics'] },
    initialize: vi.fn(async () => undefined),
    setSnapshot(snapshot) {
      snapshots.push(snapshot)
      sceneSyncCount += 1
    },
    dispose: vi.fn(async () => undefined),
  }
  layers.push(layer)
  return layer
}

function createFakeBackground(options: MapBackgroundOptions) {
  const handle = {
    options,
    presentations: [] as MapBackgroundPresentation[],
    disposed: false,
    applied: true,
    update(presentation: MapBackgroundPresentation) { handle.presentations.push(presentation) },
    retry(presentation: MapBackgroundPresentation) { handle.presentations.push(presentation) },
    claimMapError: () => false,
    restore: () => undefined,
    isApplied: () => handle.applied,
    setAttributionCompact: () => undefined,
    dispose() { handle.disposed = true },
  }
  backgrounds.push(handle)
  return handle
}

function createOwner(overrides: Partial<ViewSnapshotMapOptions> = {}) {
  return createViewSnapshotMap({
    readSatelliteConfig: () => ({ googleMapsApiKey: null, locale: 'en' }),
    loadMapLibre: async () => ({ Map: FakeMap as unknown as new (options: MapLibreMapConstructorOptions) => unknown }),
    mountBackground: createFakeBackground,
    createSceneLayer: createFakeLayer,
    readFrame: (canvas) => ({
      width: canvas.width,
      height: canvas.height,
      encode: async (type) => new Blob(['frame'], { type }),
    }),
    ...overrides,
  })
}

const BASEMAP: MapBackgroundPresentation = {
  basemap: { style: 'liberty', visible: true, opacity: 1 },
  satellite: { visible: false, opacity: 1 },
  locale: 'en',
}

function request(overrides: Partial<ViewSnapshotRequest> = {}): ViewSnapshotRequest {
  return {
    camera: { lon: ORIGIN.lon, lat: ORIGIN.lat, zoom: 18, bearing: 0 },
    width: 320,
    height: 200,
    background: BASEMAP,
    scene: {
      origin: ORIGIN,
      build: () => createTestSceneRendererSnapshot(),
    },
    timeoutMs: 5_000,
    ...overrides,
  }
}

beforeEach(() => {
  FakeMap.instances = []
  FakeMap.autoLoad = true
  FakeMap.autoIdle = true
  layers = []
  backgrounds = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('view snapshot map', () => {
  it('captures on the first complete frame without touching another map', async () => {
    const owner = createOwner()
    const build = vi.fn((_view: ViewTransform) => createTestSceneRendererSnapshot())

    const capture = await owner.capture(request({ scene: { origin: ORIGIN, build } }))

    expect(capture.missingTiles).toBe(false)
    expect(capture.blob.type).toBe('image/png')
    expect(capture).toMatchObject({ width: 320, height: 200 })
    expect(capture.attribution).toEqual(['OpenFreeMap', '© OpenStreetMap'])
    const [map] = FakeMap.instances
    expect(map!.options).toMatchObject({
      pixelRatio: 1,
      fadeDuration: 0,
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
    })
    expect(map!.jumps.at(-1)).toEqual({ center: [ORIGIN.lon, ORIGIN.lat], zoom: 18 })
    // The plane origin is the map centre, so the snapshot's view puts it there.
    const origin = build.mock.calls[0]![0].worldToScreen({ x: 0, y: 0 })
    expect(origin.x).toBeCloseTo(160, 6)
    expect(origin.y).toBeCloseTo(100, 6)
    expect(map!.layers.has(VIEW_SNAPSHOT_SCENE_LAYER_ID)).toBe(true)
    expect(backgrounds[0]!.presentations).toEqual([BASEMAP])
    // The scene layer draws from the snapshot map's own driver, whose view the scene was built at.
    expect(layers[0]!.options.frames.viewFrame.peek().view).toBe(build.mock.calls[0]![0])
    const container = map!.options.container
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.style.visibility).toBe('hidden')
    expect(container.style.position).toBe('fixed')
    expect(FakeMap.instances).toHaveLength(1)
    expect(map!.removed).toBe(false)
    await owner.dispose()
  })

  it('draws a view at its saved bearing', async () => {
    const owner = createOwner()
    const build = vi.fn((_view: ViewTransform) => createTestSceneRendererSnapshot())

    await owner.capture(request({ camera: { lon: ORIGIN.lon, lat: ORIGIN.lat, zoom: 18, bearing: 30 }, scene: { origin: ORIGIN, build } }))

    const [map] = FakeMap.instances
    expect(map!.getBearing()).toBeCloseTo(30, 9)
    // The scene is built at the turned view: the plane's east axis points 30° up-right of the screen's.
    const view = build.mock.calls[0]![0]
    expect(view.camera.bearingDeg).toBeCloseTo(30, 9)
    const origin = view.worldToScreen({ x: 0, y: 0 })
    const east = view.worldToScreen({ x: 1, y: 0 })
    expect(origin.x).toBeCloseTo(160, 6)
    expect(origin.y).toBeCloseTo(100, 6)
    expect(Math.atan2(origin.y - east.y, east.x - origin.x) * 180 / Math.PI).toBeCloseTo(30, 6)

    // A second capture at north turns the shared map back.
    await owner.capture(request())
    expect(map!.getBearing()).toBeCloseTo(0, 9)
    await owner.dispose()
  })

  it('a saved view\'s thumbnail shows its whole framed area at its bearing, through the real snapshot map', async () => {
    // Framed in a 1000 × 500 window at zoom 18, turned 30°; the 400 × 300 workspace it is drawn from plays no part.
    const camera = { lon: ORIGIN.lon, lat: ORIGIN.lat, zoom: 18, bearing: 30 }
    const ground = groundSizeShown(camera, { width: 1000, height: 500 })
    const view: SavedView = {
      id: 'hedges', name: 'Hedges', title: null, text: [],
      camera: { ...camera, ground_size_m: ground },
      visible_layers: { background: { kind: 'none' }, terrain: { contours: false, hillshade: false }, scene_layers: [], site_data: [] },
      highlighted: { species: [], objects: [] },
    }
    const plane = createSessionPlane(ORIGIN)
    const queries = createTestCanvasQuerySurface({ sessionPlane: plane })
    const thumbnail = describeSavedViewSnapshot(view, VIEW_SNAPSHOT_THUMBNAIL, {
      queries, mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names',
    })!
    const owner = createOwner()

    await owner.capture(thumbnail)

    // The ground the view framed, its corners turned with the view: right along the bearing, down across it (x east, y south).
    const map = FakeMap.instances[0]!
    expect(map.getBearing()).toBeCloseTo(30, 9)
    const radians = 30 * Math.PI / 180
    const right = { x: Math.cos(radians), y: Math.sin(radians) }
    const down = { x: -Math.sin(radians), y: Math.cos(radians) }
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([across, along]) => {
      const point = plane.toGeo({
        x: across! * ground.width / 2 * right.x + along! * ground.height / 2 * down.x,
        y: across! * ground.width / 2 * right.y + along! * ground.height / 2 * down.y,
      })
      return map.project({ lng: point.lon, lat: point.lat })
    })
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.x).toBeLessThanOrEqual(320 + 1e-6)
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.y).toBeLessThanOrEqual(200 + 1e-6)
    }
    // Fitted, not shrunk: the width (1000 / 320 > 500 / 200) spans the image.
    expect(Math.min(...corners.map((corner) => corner.x))).toBeCloseTo(0, 3)
    expect(Math.max(...corners.map((corner) => corner.x))).toBeCloseTo(320, 3)
    await owner.dispose()
  })

  // Live check 7b: a reused snapshot map drew every later thumbnail's scene at the first capture's centre, zoom and bearing.
  it('moves the real scene layer to each capture\'s view when the snapshot map is reused', async () => {
    const gl = {} as WebGL2RenderingContext
    /** MapLibre as the real scene layer meets it: one context, onAdd on addLayer, and a render on every repaint request. */
    class RenderingMap extends FakeMap {
      constructor(options: MapLibreMapConstructorOptions) {
        super(options)
        Object.defineProperty(this.canvas, 'getContext', { value: (type: string) => (type === 'webgl2' ? gl : null) })
      }
      override addLayer(layer: Record<string, unknown>): void {
        super.addLayer(layer)
        ;(layer as { onAdd?: (map: unknown, context: WebGL2RenderingContext) => void }).onAdd?.(this, gl)
      }
      override triggerRepaint(): void {
        for (const layer of this.layers.values()) {
          (layer as { render?: (context: WebGL2RenderingContext, input: unknown) => void }).render?.(gl, {})
        }
        super.triggerRepaint()
      }
    }
    const present = vi.fn((_view: ViewTransform) => undefined)
    const owner = createOwner({
      loadMapLibre: async () => ({ Map: RenderingMap as unknown as new (options: MapLibreMapConstructorOptions) => unknown }),
      createSceneLayer: (options) => createSharedMapSceneLayer({
        ...options,
        createRenderer: () => ({
          init: async () => undefined,
          render: () => undefined,
          resize: () => undefined,
          resetState: () => undefined,
          destroy: () => undefined,
          context: { extensions: {} },
        }),
        createStage: () => ({ destroy: () => undefined }) as never,
        createPresentation: () => ({ dispose: () => undefined, resize: () => undefined, present, setDraft: () => undefined }),
      }),
    })

    await owner.capture(request())
    expect(present).toHaveBeenCalled()
    expect(present.mock.lastCall![0].camera.bearingDeg).toBeCloseTo(0, 9)

    const elsewhere = { lon: ORIGIN.lon + 0.001, lat: ORIGIN.lat + 0.001 }
    await owner.capture(request({ camera: { ...elsewhere, zoom: 19, bearing: 30 } }))
    expect(FakeMap.instances).toHaveLength(1)
    const presented = present.mock.lastCall![0]
    expect(presented.camera.bearingDeg).toBeCloseTo(30, 9)
    expect(presented.camera.zoom).toBeCloseTo(19, 9)
    expect(presented.camera.center.lon).toBeCloseTo(elsewhere.lon, 9)
    expect(presented.camera.center.lat).toBeCloseTo(elsewhere.lat, 9)
    await owner.dispose()
  })

  it('waits for the background to be installed before reading', async () => {
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    const map = FakeMap.instances[0]!
    backgrounds[0]!.applied = false
    map.fire('idle')
    map.tilesLoaded = false
    backgrounds[0]!.applied = true
    map.fire('idle')
    expect(map.listenerCount('idle')).toBe(1)
    map.tilesLoaded = true
    map.fire('idle')

    await expect(pending).resolves.toMatchObject({ missingTiles: false })
    expect(map.listenerCount('idle')).toBe(0)
    await owner.dispose()
  })

  it('reads a redrawn frame with the missing-tiles flag when the timeout passes', async () => {
    vi.useFakeTimers()
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request({ timeoutMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeMap.instances[0]!.redraws).toBe(0)
    await vi.advanceTimersByTimeAsync(1)

    const capture = await pending
    expect(capture.missingTiles).toBe(true)
    expect(FakeMap.instances[0]!.redraws).toBe(1)
    await owner.dispose()
  })

  it('flags missing tiles after a tile error and never logs the failing URL', async () => {
    FakeMap.autoIdle = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    const map = FakeMap.instances[0]!
    map.fire('error', { error: new Error(`403 https://tile.googleapis.com/v1/2dtiles/1/2/3?session=s&key=${SECRET_KEY}`) })
    map.fire('idle')

    const capture = await pending
    expect(capture.missingTiles).toBe(true)
    expect(JSON.stringify(capture)).not.toContain(SECRET_KEY)
    for (const call of [...consoleError.mock.calls, ...consoleWarn.mock.calls]) {
      expect(String(call)).not.toContain(SECRET_KEY)
    }
    await owner.dispose()
  })

  it('flags a background that never installed', async () => {
    vi.useFakeTimers()
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request({ timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(0)
    backgrounds[0]!.applied = false
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({ missingTiles: true })
    await owner.dispose()
  })

  // The snapshot map has no Retry button, and the workspace sends the same background on every capture: a Basemap
  // style that failed while offline must download again on the next capture, or every later thumbnail lacks it.
  it('downloads a Basemap style that failed again on the next capture, through the real background band', async () => {
    vi.useFakeTimers()
    const loadStyle = vi.fn(async () => { throw new Error('Basemap style request failed (503).') })
    const owner = createOwner({ mountBackground: (options) => mountMapBackground({ ...options, loadStyle }) })

    const first = owner.capture(request({ timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toMatchObject({ missingTiles: true })
    expect(loadStyle).toHaveBeenCalledTimes(1)

    const second = owner.capture(request({ timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    await expect(second).resolves.toMatchObject({ missingTiles: true })
    expect(loadStyle).toHaveBeenCalledTimes(2)
    await owner.dispose()
  })

  it('shares one map across captures, resizing it and replacing it for a new pixel ratio', async () => {
    const owner = createOwner()
    const order: string[] = []
    const first = owner.capture(request()).then(() => order.push('thumbnail'))
    const second = owner.capture(request({ width: 1600, height: 1000 })).then(() => order.push('export'))
    await Promise.all([first, second])
    expect(order).toEqual(['thumbnail', 'export'])
    expect(FakeMap.instances).toHaveLength(1)
    // The driver is the map's one resize owner: MapLibre never resizes itself behind it. The driver resizes it once when it is
    // created and once for the export's size.
    expect(FakeMap.instances[0]!.options.trackResize).toBe(false)
    expect(FakeMap.instances[0]!.resizes).toBe(2)
    expect(FakeMap.instances[0]!.options.container.style.width).toBe('1600px')

    const retina = await owner.capture(request({ pixelRatio: 2 }))
    expect(retina).toMatchObject({ width: 640, height: 400 })
    expect(FakeMap.instances).toHaveLength(2)
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await owner.dispose()
  })

  it('releases the map and its context after the idle delay and recreates it on demand', async () => {
    vi.useFakeTimers()
    const owner = createOwner({ idleReleaseMs: 1_000 })
    await owner.capture(request())
    const map = FakeMap.instances[0]!
    const container = map.options.container
    expect(container.isConnected).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(map.removed).toBe(true)
    expect(container.isConnected).toBe(false)
    expect(layers[0]!.dispose).toHaveBeenCalledOnce()
    expect(backgrounds[0]!.disposed).toBe(true)
    expect(map.listenerCount('error')).toBe(0)

    await owner.capture(request())
    expect(FakeMap.instances).toHaveLength(2)
    await owner.dispose()
  })

  it('waits for a release in progress before the next capture or dispose, instead of racing a new map with it', async () => {
    vi.useFakeTimers()
    let finishDisposal!: () => void
    const disposal = new Promise<void>((resolve) => { finishDisposal = resolve })
    const owner = createOwner({
      idleReleaseMs: 1_000,
      createSceneLayer: (options) => Object.assign(createFakeLayer(options), { dispose: vi.fn(async () => { await disposal }) }),
    })
    await owner.capture(request())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeMap.instances[0]!.removed).toBe(false)

    const next = owner.capture(request())
    let disposed = false
    const disposing = owner.dispose().then(() => { disposed = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeMap.instances).toHaveLength(1)
    expect(disposed).toBe(false)

    finishDisposal()
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await expect(next).rejects.toThrow('disposed')
    await disposing
    expect(FakeMap.instances).toHaveLength(1)
  })

  it('fails a capture whose map never loads once the setup bound passes, and removes that map', async () => {
    vi.useFakeTimers()
    FakeMap.autoLoad = false
    const owner = createOwner({ setupTimeoutMs: 1_000 })
    const pending = owner.capture(request())
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeMap.instances[0]!.removed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).rejects.toThrow('did not load in time')
    expect(FakeMap.instances[0]!.removed).toBe(true)
    expect(FakeMap.instances[0]!.options.container.isConnected).toBe(false)
    await owner.dispose()
  })

  it('fails a capture whose scene layer never initializes, and removes the map even when that layer never disposes', async () => {
    vi.useFakeTimers()
    const owner = createOwner({
      setupTimeoutMs: 1_000,
      createSceneLayer: (options) => Object.assign(createFakeLayer(options), {
        initialize: vi.fn(() => new Promise<void>(() => {})),
        dispose: vi.fn(() => new Promise<void>(() => {})),
      }),
    })
    const pending = owner.capture(request())
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).rejects.toThrow('did not initialize in time')
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await owner.dispose()
  })

  it('fails a capture whose encoder never answers once the encode bound passes, and keeps the map', async () => {
    vi.useFakeTimers()
    const owner = createOwner({
      encodeTimeoutMs: 1_000,
      readFrame: (canvas) => ({ width: canvas.width, height: canvas.height, encode: () => new Promise<Blob>(() => {}) }),
    })
    const pending = owner.capture(request())
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).rejects.toThrow('did not encode in time')
    expect(FakeMap.instances[0]!.removed).toBe(false)
    await owner.dispose()
  })

  it('fails a capture on context loss and starts the next one on a new map', async () => {
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    FakeMap.instances[0]!.fire('webglcontextlost')
    await expect(pending).rejects.toThrow('lost its WebGL context')

    FakeMap.autoIdle = true
    await owner.capture(request())
    expect(FakeMap.instances).toHaveLength(2)
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await owner.dispose()
  })

  it('cancels a capture through its signal and keeps the map', async () => {
    FakeMap.autoIdle = false
    const owner = createOwner()
    const controller = new AbortController()
    const pending = owner.capture(request({ signal: controller.signal }))
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeMap.instances[0]!.listenerCount('idle')).toBe(0)
    expect(FakeMap.instances[0]!.removed).toBe(false)

    const aborted = new AbortController()
    aborted.abort()
    await expect(owner.capture(request({ signal: aborted.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    await owner.dispose()
  })

  it('fails a capture whose scene cannot be built and keeps serving the next', async () => {
    const owner = createOwner()
    const failing = request({ scene: { origin: ORIGIN, build: () => { throw new Error('busy') } } })
    await expect(owner.capture(failing)).rejects.toThrow('busy')
    await expect(owner.capture(request())).resolves.toMatchObject({ missingTiles: false })
    expect(FakeMap.instances).toHaveLength(1)
    await owner.dispose()
  })

  it('refuses sizes and cameras it cannot draw', async () => {
    const owner = createOwner()
    await expect(owner.capture(request({ width: 2049, pixelRatio: 2 }))).rejects.toThrow('4096')
    await expect(owner.capture(request({ width: 10.5 }))).rejects.toThrow('whole positive')
    await expect(owner.capture(request({ pixelRatio: 0 }))).rejects.toThrow('pixel ratio')
    await expect(owner.capture(request({ camera: { lon: Number.NaN, lat: 0, zoom: 1, bearing: 0 } }))).rejects.toThrow('finite')
    await expect(owner.capture(request({ camera: { lon: 0, lat: 0, zoom: 1, bearing: Number.POSITIVE_INFINITY } }))).rejects.toThrow('finite')
    await expect(owner.capture(request({ timeoutMs: -1 }))).rejects.toThrow('timeout')
    expect(FakeMap.instances).toHaveLength(0)
  })

  it('tears down on dispose, fails the capture in flight and refuses later ones', async () => {
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    await owner.dispose()
    await expect(pending).rejects.toThrow('released')
    expect(FakeMap.instances[0]!.removed).toBe(true)
    expect(document.querySelector('[data-canopi-view-snapshot]')).toBeNull()
    await expect(owner.capture(request())).rejects.toThrow('disposed')
    await owner.dispose()
  })

  it('removes a map whose setup failed', async () => {
    const owner = createOwner({
      createSceneLayer: (options) => {
        const layer = createFakeLayer(options)
        ;(layer as { initialize: SharedMapSceneLayer['initialize'] }).initialize = async () => { throw new Error('no pixi') }
        return layer
      },
    })
    await expect(owner.capture(request())).rejects.toThrow('no pixi')
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await owner.dispose()
  })
  it('copies the frame to a 2D canvas and encodes it, failing without 2D or an encoder result', async () => {
    const drawImage = vi.fn()
    let blob: Blob | null = new Blob(['png'], { type: 'image/png' })
    let context: unknown = { drawImage }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as never)
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type, quality) => {
      expect([type, quality]).toEqual(['image/webp', 0.8])
      callback(blob)
    })
    const owner = createOwner({ readFrame: undefined })

    const capture = await owner.capture(request({ type: 'image/webp', quality: 0.8 }))
    expect(capture.blob).toBe(blob)
    expect(drawImage).toHaveBeenCalledWith(FakeMap.instances[0]!.canvas, 0, 0)
    expect(toBlob).toHaveBeenCalledTimes(1)

    blob = null
    await expect(owner.capture(request({ type: 'image/webp', quality: 0.8 }))).rejects.toThrow('encode')
    context = null
    await expect(owner.capture(request())).rejects.toThrow('copy')
    await owner.dispose()
  })

  it('cancels a capture while the map loads and releases that map', async () => {
    FakeMap.autoLoad = false
    const owner = createOwner()
    const controller = new AbortController()
    const pending = owner.capture(request({ signal: controller.signal }))
    await vi.waitFor(() => expect(FakeMap.instances).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeMap.instances[0]!.removed).toBe(true)
    await owner.dispose()
  })

  it('disposes while a map loads without waiting for it', async () => {
    FakeMap.autoLoad = false
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances).toHaveLength(1))
    await owner.dispose()
    await expect(pending).rejects.toThrow('released while loading')
    expect(FakeMap.instances[0]!.removed).toBe(true)
  })

  it('fails a capture whose scene layer failed and replaces the map next time', async () => {
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request())
    await vi.waitFor(() => expect(FakeMap.instances[0]?.listenerCount('idle')).toBe(1))
    layers[0]!.options.onFailure?.(new Error('pixi failed'))
    FakeMap.instances[0]!.fire('idle')
    await expect(pending).rejects.toThrow('pixi failed')
    FakeMap.autoIdle = true
    await owner.capture(request())
    expect(FakeMap.instances).toHaveLength(2)
    await owner.dispose()
  })

  it('fails a capture when the forced redraw throws', async () => {
    vi.useFakeTimers()
    FakeMap.autoIdle = false
    const owner = createOwner()
    const pending = owner.capture(request({ timeoutMs: 10 }))
    const settled = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    FakeMap.instances[0]!.redraw = () => { throw new Error('redraw failed') }
    await vi.advanceTimersByTimeAsync(10)
    expect(await settled).toMatchObject({ message: 'redraw failed' })
    await owner.dispose()
  })

  it('reports a teardown failure once and still removes the container', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const owner = createOwner()
    await owner.capture(request())
    const map = FakeMap.instances[0]!
    map.remove = () => { throw new Error('remove failed') }
    await owner.dispose()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(map.options.container.isConnected).toBe(false)
  })
})
