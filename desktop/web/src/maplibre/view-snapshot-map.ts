import { signal } from '@preact/signals'
import { logMapError } from './redact-credentials'
import type { SceneRendererSnapshot } from '../canvas/runtime/renderers/scene-types'
import type { CameraDriver } from '../canvas/runtime/view/camera-driver'
import { createNavigationPolicy, type NavigationPolicy } from '../canvas/runtime/view/navigation-policy'
import type { ViewTransform } from '../canvas/runtime/view/types'
import { createSessionPlane, type SessionPlane } from '../canvas/session-plane'
import { WORKSPACE_MAP_MIN_ZOOM } from '../canvas/workspace-camera-policy'
import { BasemapTileAuth } from './basemap-tile-auth'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from './camera-driver'
import { createMapLibreEmptyStyle, MAPLIBRE_MAP_MAX_ZOOM } from './config'
import { loadMapLibreModule, type MapLibreMapConstructorOptions } from './loader'
import type { MapLibreBasemapStatus } from './canvas-surface-state'
import type { SatelliteConfig } from './satellite-provider'
import {
  mountMapBackground,
  type MapBackgroundHandle,
  type MapBackgroundMap,
  type MapBackgroundOptions,
  type MapBackgroundPresentation,
} from './map-background'
import {
  createSharedMapSceneLayer,
  type SharedMapSceneLayer,
  type SharedMapSceneLayerOptions,
  type SharedMapSceneMap,
} from './shared-scene-layer'

/** The custom layer id on the snapshot map; the workspace map uses its own. */
export const VIEW_SNAPSHOT_SCENE_LAYER_ID = 'canopi-snapshot-scene'
/** How long the off-screen map (and its WebGL context) outlives its last capture. */
const VIEW_SNAPSHOT_IDLE_RELEASE_MS = 30_000
/** Largest snapshot side in device pixels: MapLibre's default canvas limit. */
const VIEW_SNAPSHOT_MAX_DEVICE_PIXELS = 4096
/** How long the map may take to load, the scene layer to initialize or dispose; past it the capture fails and the map goes. */
const VIEW_SNAPSHOT_SETUP_TIMEOUT_MS = 15_000
/** How long the encoder may take; a `toBlob` that never calls back must not hold the queue. */
const VIEW_SNAPSHOT_ENCODE_TIMEOUT_MS = 10_000
/** A snapshot is one still frame: its camera never animates. */
const VIEW_SNAPSHOT_REDUCED_MOTION = signal(true)

interface ViewSnapshotCamera {
  readonly lon: number
  readonly lat: number
  readonly zoom: number
  /** Degrees clockwise from north: a saved view's bearing, so the image is turned as going to the view turns the map. */
  readonly bearing: number
}

interface ViewSnapshotScene {
  /** Session plane origin that the scene's metres are measured from. */
  readonly origin: { readonly lat: number; readonly lon: number }
  /** Scene state at the snapshot's view (its own driver's frame). Throwing fails the capture. */
  build(view: ViewTransform): SceneRendererSnapshot
}

export type ViewSnapshotImageType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ViewSnapshotRequest {
  readonly camera: ViewSnapshotCamera
  /** CSS pixels; the image is `width * pixelRatio` device pixels wide. */
  readonly width: number
  readonly height: number
  /** Defaults to 1. A change of ratio replaces the off-screen map. */
  readonly pixelRatio?: number
  readonly background: MapBackgroundPresentation
  readonly scene: ViewSnapshotScene
  /** How long to wait for the background and its tiles before reading anyway. */
  readonly timeoutMs: number
  readonly type?: ViewSnapshotImageType
  /** Encoder quality for JPEG and WebP. */
  readonly quality?: number
  readonly signal?: AbortSignal
}

interface ViewSnapshotTimings {
  /** Creating the map, its style and the scene renderer; 0 when reused. */
  readonly mapSetupMs: number
  /** From camera move to a complete frame, or to the timeout. */
  readonly settleMs: number
  /** Copying the WebGL frame to a 2D canvas inside the frame's task. */
  readonly readMs: number
  readonly encodeMs: number
  readonly totalMs: number
}

export interface ViewSnapshotCapture {
  readonly blob: Blob
  /** Device pixels. */
  readonly width: number
  readonly height: number
  /**
   * True when the frame was read before every tile arrived: the timeout
   * passed, a tile failed, or the background never installed (for example
   * Satellite without a usable key).
   */
  readonly missingTiles: boolean
  /** Imagery and data credits shown by the snapshot's attribution control. */
  readonly attribution: readonly string[]
  readonly timings: ViewSnapshotTimings
}

/** A copied frame, encoded later outside the frame's task. */
interface ViewSnapshotFrame {
  readonly width: number
  readonly height: number
  encode(type: ViewSnapshotImageType, quality: number | undefined): Promise<Blob>
}

/** What the snapshot owner needs from a MapLibre map; its camera driver moves and resizes it. */
interface ViewSnapshotMapLibreMap extends SharedMapSceneMap, MapLibreCameraDriverMap {
  redraw(): void
  remove(): void
  on(type: string, listener: (event?: unknown) => void): void
  off(type: string, listener: (event?: unknown) => void): void
  loaded(): boolean
  areTilesLoaded(): boolean
  addLayer(layer: Record<string, unknown>, beforeId?: string): void
  getLayer(id: string): unknown
}

interface ViewSnapshotMapLibre {
  readonly Map: new (options: MapLibreMapConstructorOptions) => unknown
}

export interface ViewSnapshotMapOptions {
  /** The Satellite configuration the background band reads (`readSatelliteConfig`); required, like the band's. */
  readonly readSatelliteConfig: () => SatelliteConfig
  readonly loadMapLibre?: () => Promise<ViewSnapshotMapLibre>
  readonly mountBackground?: (options: MapBackgroundOptions) => MapBackgroundHandle
  readonly createSceneLayer?: (options: SharedMapSceneLayerOptions) => SharedMapSceneLayer
  /** Copies the map canvas; runs inside the frame's task. */
  readonly readFrame?: (canvas: HTMLCanvasElement) => ViewSnapshotFrame
  readonly document?: Document
  readonly idleReleaseMs?: number
  readonly setupTimeoutMs?: number
  readonly encodeTimeoutMs?: number
  /**
   * Keep the WebGL drawing buffer between frames. Only for measuring: the
   * capture reads inside the frame's task, so it does not need it.
   */
  readonly preserveDrawingBuffer?: boolean
  readonly now?: () => number
}

/**
 * The one owner of the off-screen snapshot map: a hidden MapLibre map with the
 * production background band and its own shared scene layer. It never touches
 * the visible workspace map or any session state. Captures run one at a time.
 */
export interface ViewSnapshotMap {
  capture(request: ViewSnapshotRequest): Promise<ViewSnapshotCapture>
  /** Releases the map and its WebGL context; later captures reject. */
  dispose(): Promise<void>
}

/** The plane and policy the snapshot's camera driver works in: the current capture's scene origin. */
interface SnapshotView {
  plane: SessionPlane
  policy: NavigationPolicy
}

interface SnapshotInstance {
  readonly container: HTMLElement
  readonly map: ViewSnapshotMapLibreMap
  readonly view: SnapshotView
  /** The map's one camera owner, created once the map has loaded. */
  driver: CameraDriver | null
  readonly tileAuth: BasemapTileAuth
  readonly pixelRatio: number
  readonly teardown: AbortController
  background: MapBackgroundHandle | null
  sceneLayer: SharedMapSceneLayer | null
  width: number
  height: number
  broken: Error | null
  tileErrors: number
  /** The background band's latest status: a capture reads at once once it is `failed` (2.1-M341). */
  basemapStatus: MapLibreBasemapStatus
  releaseListeners: () => void
}

class ViewSnapshotAbortError extends Error {
  constructor() {
    super('The view snapshot was cancelled.')
    this.name = 'AbortError'
  }
}

export function createViewSnapshotMap(options: ViewSnapshotMapOptions): ViewSnapshotMap {
  const loadMapLibre = options.loadMapLibre ?? (loadMapLibreModule as () => Promise<ViewSnapshotMapLibre>)
  const mountBackground = options.mountBackground ?? mountMapBackground
  const createSceneLayer = options.createSceneLayer ?? createSharedMapSceneLayer
  const readFrame = options.readFrame ?? readCanvasFrame
  const idleReleaseMs = options.idleReleaseMs ?? VIEW_SNAPSHOT_IDLE_RELEASE_MS
  const setupTimeoutMs = options.setupTimeoutMs ?? VIEW_SNAPSHOT_SETUP_TIMEOUT_MS
  const encodeTimeoutMs = options.encodeTimeoutMs ?? VIEW_SNAPSHOT_ENCODE_TIMEOUT_MS
  const now = options.now ?? (() => performance.now())
  let instance: SnapshotInstance | null = null
  /** A map still loading; dispose aborts it so its load wait cannot hang. */
  let creating: SnapshotInstance | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  let releaseTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const cancelRelease = () => {
    if (releaseTimer !== null) clearTimeout(releaseTimer)
    releaseTimer = null
  }

  const scheduleRelease = () => {
    cancelRelease()
    if (disposed || pending > 0 || !instance) return
    releaseTimer = setTimeout(() => {
      releaseTimer = null
      if (pending > 0) return
      // The release joins the capture queue: a capture arriving now, and
      // dispose(), wait for the teardown instead of racing a new map with it.
      const release = queue.then(() => (pending > 0 ? undefined : releaseInstance()))
      queue = release.catch(() => undefined)
    }, idleReleaseMs)
  }

  async function releaseInstance(): Promise<void> {
    const current = instance
    instance = null
    if (current) await teardownInstance(current, setupTimeoutMs)
  }

  async function createInstance(request: ViewSnapshotRequest, pixelRatio: number): Promise<SnapshotInstance> {
    const doc = options.document ?? document
    const maplibre = await loadMapLibre()
    const container = doc.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.dataset.canopiViewSnapshot = ''
    Object.assign(container.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: `${request.width}px`,
      height: `${request.height}px`,
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'strict',
    })
    doc.body.appendChild(container)
    const tileAuth = new BasemapTileAuth()
    let map: ViewSnapshotMapLibreMap
    try {
      map = new maplibre.Map({
        container,
        style: createMapLibreEmptyStyle(),
        center: [request.camera.lon, request.camera.lat],
        zoom: request.camera.zoom,
        bearing: request.camera.bearing,
        minZoom: WORKSPACE_MAP_MIN_ZOOM,
        maxZoom: MAPLIBRE_MAP_MAX_ZOOM,
        renderWorldCopies: false,
        // The snapshot's camera driver resizes the map; MapLibre never resizes itself behind it.
        trackResize: false,
        pixelRatio,
        // A snapshot is one frame: no tile or label fade to wait for.
        fadeDuration: 0,
        canvasContextAttributes: { antialias: true, preserveDrawingBuffer: options.preserveDrawingBuffer === true },
        attributionControl: false,
        interactive: false,
        pitchWithRotate: false,
        dragRotate: false,
        touchZoomRotate: false,
        transformRequest: tileAuth.transformRequest,
      }) as ViewSnapshotMapLibreMap
    } catch (error) {
      container.remove()
      throw error
    }
    const created: SnapshotInstance = {
      container,
      map,
      view: snapshotView(request.scene.origin),
      driver: null,
      tileAuth,
      pixelRatio,
      teardown: new AbortController(),
      background: null,
      sceneLayer: null,
      width: request.width,
      height: request.height,
      broken: null,
      tileErrors: 0,
      basemapStatus: 'idle',
      releaseListeners: () => undefined,
    }
    const onContextLost = () => {
      created.broken = new Error('The snapshot map lost its WebGL context.')
      created.teardown.abort()
    }
    // Tile and style errors only mark the snapshot incomplete. They are never
    // logged here: an official tile URL carries the Google key.
    const onError = () => { created.tileErrors += 1 }
    map.on('webglcontextlost', onContextLost)
    map.on('error', onError)
    created.releaseListeners = () => {
      map.off('webglcontextlost', onContextLost)
      map.off('error', onError)
    }
    creating = created
    try {
      await bounded(
        waitForEvent(map, 'load', created.teardown.signal, request.signal),
        setupTimeoutMs,
        'The snapshot map did not load in time.',
      )
      const { view } = created
      created.driver = createMapLibreCameraDriver(map, view.plane, { policy: () => view.policy })
      const refused = created.driver.failure.peek()
      if (refused) throw new Error(`The snapshot map cannot place its camera: ${refused.message}`)
      created.background = mountBackground({
        map: map as unknown as MapBackgroundMap,
        maplibre,
        tileAuth,
        readSatelliteConfig: options.readSatelliteConfig,
        lifetime: map,
        onBasemapStatus: (status) => {
          created.basemapStatus = status
          // The map may already be idle when the style fails: ask for one more frame so the capture reads it.
          if (status === 'failed') map.triggerRepaint()
        },
      })
      const context = map.getCanvas().getContext('webgl2')
      if (!context) throw new Error('The snapshot map did not expose a WebGL2 context.')
      const sceneLayer = createSceneLayer({
        id: VIEW_SNAPSHOT_SCENE_LAYER_ID,
        frames: created.driver.frames,
        onFailure: (error) => { created.broken = error },
      })
      created.sceneLayer = sceneLayer
      await bounded(sceneLayer.initialize(map, context), setupTimeoutMs, 'The snapshot scene did not initialize in time.')
      if (created.broken) throw created.broken
      map.addLayer(sceneLayer.layer as unknown as Record<string, unknown>)
      if (!map.getLayer(VIEW_SNAPSHOT_SCENE_LAYER_ID)) throw new Error('The snapshot map did not attach its scene layer.')
    } catch (error) {
      await teardownInstance(created, setupTimeoutMs)
      throw error
    } finally {
      creating = null
    }
    return created
  }

  async function runCapture(request: ViewSnapshotRequest): Promise<ViewSnapshotCapture> {
    const startedAt = now()
    const pixelRatio = request.pixelRatio ?? 1
    throwIfAborted(request.signal)
    if (instance && (instance.broken || instance.pixelRatio !== pixelRatio)) await releaseInstance()
    let mapSetupMs = 0
    if (!instance) {
      const setupStartedAt = now()
      const created = await createInstance(request, pixelRatio)
      if (disposed) {
        await teardownInstance(created, setupTimeoutMs)
        throw new Error('The view snapshot map is disposed.')
      }
      instance = created
      mapSetupMs = now() - setupStartedAt
    }
    const current = instance
    const { map } = current
    const driver = current.driver!
    const background = current.background!
    const sceneLayer = current.sceneLayer!
    throwIfAborted(request.signal)

    if (current.width !== request.width || current.height !== request.height) {
      current.container.style.width = `${request.width}px`
      current.container.style.height = `${request.height}px`
      current.width = request.width
      current.height = request.height
    }
    const settleStartedAt = now()
    const { origin } = request.scene
    if (origin.lat !== current.view.plane.origin.lat || origin.lon !== current.view.plane.origin.lon) {
      Object.assign(current.view, snapshotView(origin))
      driver.planeChanged(current.view.plane)
    }
    current.tileErrors = 0
    // The driver resizes the map (an unchanged size does nothing) and jumps it to the view's camera, its bearing included.
    driver.setScreen({ width: request.width, height: request.height, devicePixelRatio: current.pixelRatio })
    driver.apply({
      kind: 'set',
      target: {
        center: { lon: request.camera.lon, lat: request.camera.lat },
        zoom: request.camera.zoom,
        bearingDeg: request.camera.bearing,
        pitchDeg: 0,
      },
      animation: 'none',
    })
    const failure = driver.failure.peek()
    if (failure) {
      current.broken = new Error(`The snapshot map cannot place its camera: ${failure.message}`)
      throw current.broken
    }
    // No Retry button here: each capture is one, so a Basemap that failed while offline downloads again (ADR 0004).
    background.retry(request.background)
    const scenePresentedBefore = sceneLayer.diagnostics.sceneSyncCount
    sceneLayer.setSnapshot(request.scene.build(driver.frames.viewFrame.peek().view))

    // A Basemap that failed (offline, or Satellite without a usable key) will not arrive before the timeout: read now.
    const backgroundSettled = () => background.isApplied() || current.basemapStatus === 'failed'
    const complete = () => backgroundSettled()
      && map.loaded()
      && map.areTilesLoaded()
      && sceneLayer.diagnostics.sceneSyncCount > scenePresentedBefore
    const settled = await waitForFrame(current, complete, request)
    const settleMs = now() - settleStartedAt
    if (current.broken) throw current.broken

    const attribution = readAttribution(current.container)
    const missingTiles = settled.timedOut || current.tileErrors > 0 || !background.isApplied()
    const encodeStartedAt = now()
    const blob = await bounded(
      settled.frame.encode(request.type ?? 'image/png', request.quality),
      encodeTimeoutMs,
      'The snapshot frame did not encode in time.',
    )
    const encodeMs = now() - encodeStartedAt
    return {
      blob,
      width: settled.frame.width,
      height: settled.frame.height,
      missingTiles,
      attribution,
      timings: { mapSetupMs, settleMs, readMs: settled.readMs, encodeMs, totalMs: now() - startedAt },
    }
  }

  /**
   * Reads the frame in the task that drew it: in the `idle` handler, which
   * MapLibre fires right after rendering a complete frame, or right after a
   * synchronous `redraw()` when the timeout passes first. The drawing buffer is
   * still valid there, so no `preserveDrawingBuffer` is needed.
   */
  function waitForFrame(
    current: SnapshotInstance,
    complete: () => boolean,
    request: ViewSnapshotRequest,
  ): Promise<{ frame: ViewSnapshotFrame; timedOut: boolean; readMs: number }> {
    const { map } = current
    return new Promise((resolve, reject) => {
      let finished = false
      const cleanup = () => {
        finished = true
        clearTimeout(timer)
        map.off('idle', onIdle)
        current.teardown.signal.removeEventListener('abort', onTeardown)
        request.signal?.removeEventListener('abort', onAbort)
      }
      const read = (timedOut: boolean) => {
        if (finished) return
        cleanup()
        if (current.broken) {
          reject(current.broken)
          return
        }
        try {
          const readStartedAt = now()
          const frame = readFrame(map.getCanvas())
          resolve({ frame, timedOut, readMs: now() - readStartedAt })
        } catch (error) {
          reject(error)
        }
      }
      const onIdle = () => {
        if (complete()) read(false)
      }
      const onTimeout = () => {
        if (finished) return
        try {
          map.redraw()
        } catch (error) {
          cleanup()
          reject(error)
          return
        }
        read(true)
      }
      const onTeardown = () => {
        if (finished) return
        cleanup()
        reject(current.broken ?? new Error('The snapshot map was released during a capture.'))
      }
      const onAbort = () => {
        if (finished) return
        cleanup()
        reject(new ViewSnapshotAbortError())
      }
      const timer = setTimeout(onTimeout, Math.max(0, request.timeoutMs))
      map.on('idle', onIdle)
      current.teardown.signal.addEventListener('abort', onTeardown, { once: true })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      map.triggerRepaint()
    })
  }

  return {
    capture(request) {
      if (disposed) return Promise.reject(new Error('The view snapshot map is disposed.'))
      const invalid = validateRequest(request)
      if (invalid) return Promise.reject(new RangeError(invalid))
      pending += 1
      cancelRelease()
      const run = queue.then(() => {
        if (disposed) throw new Error('The view snapshot map is disposed.')
        return runCapture(request)
      })
      queue = run.catch(() => undefined).finally(() => {
        pending -= 1
        scheduleRelease()
      })
      return run
    },
    async dispose() {
      if (disposed) return
      disposed = true
      cancelRelease()
      creating?.teardown.abort()
      const current = instance
      instance = null
      if (current) {
        current.teardown.abort()
        await teardownInstance(current, setupTimeoutMs)
      }
      await queue
    },
  }
}

async function teardownInstance(instance: SnapshotInstance, timeoutMs: number): Promise<void> {
  if (!instance.teardown.signal.aborted) instance.teardown.abort()
  const errors: unknown[] = []
  try {
    // A scene layer whose initialization hung never finishes disposing; the map goes anyway.
    if (instance.sceneLayer) {
      await bounded(instance.sceneLayer.dispose(), timeoutMs, 'The snapshot scene did not dispose in time.')
    }
  } catch (error) {
    errors.push(error)
  }
  instance.sceneLayer = null
  try {
    instance.background?.dispose()
  } catch (error) {
    errors.push(error)
  }
  instance.background = null
  try {
    instance.driver?.dispose()
  } catch (error) {
    errors.push(error)
  }
  instance.driver = null
  instance.tileAuth.clear()
  instance.releaseListeners()
  try {
    instance.map.remove()
  } catch (error) {
    errors.push(error)
  }
  instance.container.remove()
  if (errors.length > 0) logMapError('View snapshot map teardown failed:', errors[0])
}

function validateRequest(request: ViewSnapshotRequest): string | null {
  const ratio = request.pixelRatio ?? 1
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 4) return 'Snapshot pixel ratio must be in (0, 4].'
  for (const side of [request.width, request.height]) {
    if (!Number.isInteger(side) || side < 1) return 'Snapshot size must be whole positive CSS pixels.'
    if (Math.round(side * ratio) > VIEW_SNAPSHOT_MAX_DEVICE_PIXELS) {
      return `Snapshot sides are limited to ${VIEW_SNAPSHOT_MAX_DEVICE_PIXELS} device pixels.`
    }
  }
  const { lon, lat, zoom, bearing } = request.camera
  if (![lon, lat, zoom, bearing].every(Number.isFinite)) return 'Snapshot camera must be finite.'
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) return 'Snapshot timeout must be a finite, non-negative time.'
  return null
}

function snapshotView(origin: { readonly lat: number; readonly lon: number }): SnapshotView {
  return {
    plane: createSessionPlane(origin),
    policy: createNavigationPolicy(origin.lat, VIEW_SNAPSHOT_REDUCED_MOTION),
  }
}

/** `work`, or a rejection with `message` after `timeoutMs`; the timer never outlives the work. */
function bounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ViewSnapshotAbortError()
}

function waitForEvent(
  map: ViewSnapshotMapLibreMap,
  type: string,
  teardown: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      map.off(type, onEvent)
      teardown.removeEventListener('abort', onTeardown)
      signal?.removeEventListener('abort', onAbort)
    }
    const onEvent = () => { cleanup(); resolve() }
    const onTeardown = () => { cleanup(); reject(new Error('The snapshot map was released while loading.')) }
    const onAbort = () => { cleanup(); reject(new ViewSnapshotAbortError()) }
    if (signal?.aborted) {
      reject(new ViewSnapshotAbortError())
      return
    }
    map.on(type, onEvent)
    teardown.addEventListener('abort', onTeardown, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The credits the snapshot map's own attribution control shows. */
function readAttribution(container: HTMLElement): string[] {
  const credits = new Set<string>()
  for (const element of container.querySelectorAll('.maplibregl-ctrl-attrib-inner')) {
    for (const part of (element.textContent ?? '').split('|')) {
      const credit = part.replace(/\s+/g, ' ').trim()
      if (credit) credits.add(credit)
    }
  }
  return [...credits]
}

function readCanvasFrame(source: HTMLCanvasElement): ViewSnapshotFrame {
  const copy = source.ownerDocument.createElement('canvas')
  copy.width = source.width
  copy.height = source.height
  const context = copy.getContext('2d')
  if (!context) throw new Error('Could not copy the snapshot frame.')
  context.drawImage(source, 0, 0)
  return {
    width: copy.width,
    height: copy.height,
    encode: (type, quality) => new Promise((resolve, reject) => {
      copy.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not encode the snapshot frame.'))
      }, type, quality)
    }),
  }
}
