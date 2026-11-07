// @vitest-environment jsdom

import { createDefaultScenePersistedState } from '../../canvas/runtime/scene'
import type { WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapLibreSurface } from '../../maplibre/surface'
import type {
  MapLibreApi,
  MapLibreMapConstructorOptions,
  MapLibreMapInstance,
} from '../../maplibre/loader'
import type { WorkspaceMapSnapshot } from '../../maplibre/workspace-map'
import {
  MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
  MAPLIBRE_SATELLITE_LAYER_ID,
  MAPLIBRE_SATELLITE_SOURCE_ID,
} from '../../maplibre/config'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import { OPENFREEMAP_BASEMAPS } from '../../maplibre/openfreemap-basemap'
import { GOOGLE_SESSION_TILES } from '../../maplibre/basemap-tile-auth'
import { GOOGLE_KEYLESS_TILES } from '../../maplibre/satellite-provider'
import { MAPLIBRE_SHARED_SCENE_LAYER_ID } from '../../maplibre/shared-scene-layer'
import { WorkspaceMapControls } from './workspace-map-controls'
import { ringEntries } from '../../failures/ring'
import { getMapNoticeReadModel } from './map-notice'
import type { MapLibreCanvasSurfaceState } from '../../maplibre/canvas-surface-state'
import { t } from '../../i18n'

type MapListener = (event?: unknown) => void

class FakeMap implements MapLibreMapInstance {
  readonly canvas = document.createElement('canvas')
  readonly jumpTo = vi.fn()
  readonly resize = vi.fn()
  readonly remove = vi.fn()
  readonly sources = new Map<string, unknown>()
  readonly layers = new Map<string, unknown>()
  readonly layerOrder: string[] = []
  readonly addSource = vi.fn((id: string, source: unknown) => { this.sources.set(id, source) })
  readonly getSource = vi.fn((id: string) => this.sources.get(id) as { setData(data: unknown): void } | undefined)
  readonly removeSource = vi.fn((id: string) => { this.sources.delete(id) })
  readonly addLayer = vi.fn((layer: { id?: string }, beforeId?: string) => {
    if (!layer.id) return
    this.layers.set(layer.id, layer)
    const existingIndex = this.layerOrder.indexOf(layer.id)
    if (existingIndex >= 0) this.layerOrder.splice(existingIndex, 1)
    const beforeIndex = beforeId == null ? -1 : this.layerOrder.indexOf(beforeId)
    if (beforeIndex >= 0) this.layerOrder.splice(beforeIndex, 0, layer.id)
    else this.layerOrder.push(layer.id)
  })
  readonly setPaintProperty = vi.fn()
  readonly setLayoutProperty = vi.fn()
  readonly setGlyphs = vi.fn()
  readonly setSprite = vi.fn()
  readonly setGlobalStateProperty = vi.fn()
  readonly controls = new Set<unknown>()
  readonly addControl = vi.fn((control: unknown, _position?: string) => { this.controls.add(control) })
  readonly removeControl = vi.fn((control: unknown) => { this.controls.delete(control) })
  readonly getLayer = vi.fn((id: string) => this.layers.get(id))
  readonly getLayersOrder = vi.fn(() => [...this.layerOrder])
  readonly moveLayer = vi.fn((id: string, beforeId?: string) => {
    const index = this.layerOrder.indexOf(id)
    if (index < 0) return
    this.layerOrder.splice(index, 1)
    const beforeIndex = beforeId == null ? -1 : this.layerOrder.indexOf(beforeId)
    if (beforeIndex < 0) this.layerOrder.push(id)
    else this.layerOrder.splice(beforeIndex, 0, id)
  })
  readonly removeLayer = vi.fn((id: string) => {
    this.layers.delete(id)
    const index = this.layerOrder.indexOf(id)
    if (index >= 0) this.layerOrder.splice(index, 1)
  })
  readonly listeners = new Map<string, Set<MapListener>>()

  constructor(
    readonly options: MapLibreMapConstructorOptions,
    webgl2: WebGL2RenderingContext | null = {} as WebGL2RenderingContext,
  ) {
    Object.defineProperty(this.canvas, 'getContext', {
      configurable: true,
      value: vi.fn((type: string) => type === 'webgl2' ? webgl2 : null),
    })
  }

  on(type: 'load' | 'style.load' | 'error' | 'sourcedata' | 'move' | 'moveend' | 'resize' | 'webglcontextlost' | 'webglcontextrestored', listener: MapListener): void {
    const listeners = this.listeners.get(type) ?? new Set<MapListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  off(type: 'load' | 'style.load' | 'error' | 'sourcedata' | 'move' | 'moveend' | 'resize' | 'webglcontextlost' | 'webglcontextrestored', listener: MapListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  getCanvas(): HTMLCanvasElement { return this.canvas }
  readonly container = document.createElement('div')
  getContainer(): HTMLElement { return this.container }
  isStyleLoaded(): boolean { return true }
  // The whole world at zoom 0.
  getZoom(): number { return 0 }
  getBounds() { return { getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85 } }
  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakeAttributionControl {
  constructor(readonly options?: { compact?: boolean; customAttribution?: string | string[] }) {}
}

function createApi(
  maps: FakeMap[],
  webgl2: WebGL2RenderingContext | null = {} as WebGL2RenderingContext,
): MapLibreApi {
  class TestMap extends FakeMap {
    constructor(options: MapLibreMapConstructorOptions) {
      super(options, webgl2)
      maps.push(this)
    }
  }
  return { Map: TestMap, addProtocol: vi.fn(), AttributionControl: FakeAttributionControl } as unknown as MapLibreApi
}

/** A small OpenFreeMap-like style; the network is never reached. */
const OPENFREEMAP_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#9ec8e0', 'fill-opacity': 0.8 } },
    { id: 'place-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'] } },
  ],
}
const OPENFREEMAP_LAYER_IDS = ['ofm:background', 'ofm:water', 'ofm:place-label']

function serveOpenFreeMapStyle(): Response {
  return new Response(
    JSON.stringify(OPENFREEMAP_STYLE),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const styleFetch = vi.fn(async (_url: string | URL | Request) => serveOpenFreeMapStyle())

function background(
  basemap: Partial<MapBackgroundPresentation['basemap']> = {},
  satellite: Partial<MapBackgroundPresentation['satellite']> = {},
  locale = 'en',
): MapBackgroundPresentation {
  return {
    basemap: { style: 'liberty', visible: false, opacity: 0.4, ...basemap },
    satellite: { visible: false, opacity: 0.4, ...satellite },
    locale,
  }
}

/** Keyless Google imagery is ready synchronously, so the band lands at admission. */
function satelliteOn(opacity = 0.4): MapBackgroundPresentation {
  return background({}, { visible: true, opacity })
}

function hidden(opacity = 0.4): MapBackgroundPresentation {
  return background({ opacity }, { opacity })
}

function basemapOn(
  basemap: Partial<MapBackgroundPresentation['basemap']> = {},
  locale = 'en',
): MapBackgroundPresentation {
  return background({ visible: true, ...basemap }, {}, locale)
}

function hasOpenFreeMapBasemap(map: FakeMap): boolean {
  return OPENFREEMAP_LAYER_IDS.every((id) => map.getLayer(id) !== undefined)
    && map.getSource('ofm-openmaptiles') !== undefined
}

function hasAnyOpenFreeMapLayer(map: FakeMap): boolean {
  return [...map.layers.keys()].some((id) => id.startsWith('ofm:'))
    || [...map.sources.keys()].some((id) => id.startsWith('ofm-'))
}

function createControls(options: {
  contributions?: ConstructorParameters<typeof WorkspaceMapControls>[0]['contributions']
  background?: MapBackgroundPresentation
  logError?: (message?: unknown, ...optionalParams: unknown[]) => void
  load?: () => Promise<MapLibreApi>
  webgl2?: WebGL2RenderingContext | null
  canCreateWebGL2Context?: () => boolean
  setScreen?: ConstructorParameters<typeof WorkspaceMapControls>[0]['setScreen']
} = {}) {
  const maps: FakeMap[] = []
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; callback: ResizeObserverCallback }> = []
  const api = createApi(
    maps,
    options.webgl2 === undefined ? {} as WebGL2RenderingContext : options.webgl2,
  )
  const surface = new MapLibreSurface<FakeMap>({
    loadMapLibre: options.load ?? (async () => api),
    createResizeObserver: (callback) => {
      const observer = { observe: vi.fn(), disconnect: vi.fn(), callback }
      observers.push(observer)
      return observer
    },
  })
  const snapshot: WorkspaceMapSnapshot = {
    initialCenter: { lat: 48.86, lon: 2.35 },
    background: options.background ?? satelliteOn(),
  }
  const container = document.createElement('div')
  const controls = new TestWorkspaceMapControls({
    container,
    surface,
    contributions: options.contributions ?? {},
    ...(options.logError ? { logError: options.logError } : {}),
    canCreateWebGL2Context: options.canCreateWebGL2Context ?? (() => true),
    setScreen: options.setScreen ?? vi.fn(),
  }, snapshot)
  createdControls.push({ controls, maps })
  return { controls, maps, observers, container }
}

/**
 * Every controls instance a test made, so `afterEach` can release its maps: a
 * map left alive keeps its settings observers and would answer later tests.
 */
const createdControls: Array<{ controls: WorkspaceMapControls; maps: readonly FakeMap[] }> = []

function releaseCreatedMaps(): void {
  for (const { controls, maps } of createdControls.splice(0)) {
    for (const map of maps) controls.releaseMap(map as never)
  }
}

class TestWorkspaceMapControls extends WorkspaceMapControls {
  readonly sessionIdentity = {}
  constructor(
    options: ConstructorParameters<typeof WorkspaceMapControls>[0],
    private readonly defaultSnapshot: WorkspaceMapSnapshot,
  ) {
    super(options)
  }

  override createMap(signal: AbortSignal, snapshot = this.defaultSnapshot) {
    return super.createMap(signal, snapshot)
  }
}

async function waitForMap(maps: FakeMap[]): Promise<FakeMap> {
  await vi.waitFor(() => expect(maps).toHaveLength(1))
  return maps[0]!
}

function targetContribution(sessionIdentity: object): WorkspaceMapContributionSnapshot {
  const scene = createDefaultScenePersistedState()
  scene.zones = [{ kind: 'zone', locked: false, id: 'plot', name: 'plot', zoneType: 'polygon', rotationDeg: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], fillColor: null, notes: null }]
  return {
    sessionIdentity, lidar: [],
    terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
    overlays: { runtime: { getSceneSnapshot: () => scene }, location: { lat: 48, lon: 2 }, hoveredTargets: [{ kind: 'zone', zone_id: 'plot' }], selectedTargets: [] , site: null },
  }
}

function lidarLayer(id: string): WorkspaceMapContributionSnapshot['lidar'][number] {
  return { id, name: id, opacity: 1, assets: [], bounds: [1, 2, 3, 4], rescale: [0, 10], colormap: 'terrain', reversed: false }
}

beforeEach(() => {
  styleFetch.mockReset()
  styleFetch.mockImplementation(async () => serveOpenFreeMapStyle())
  vi.stubGlobal('fetch', styleFetch)
})

afterEach(() => {
  releaseCreatedMaps()
  vi.unstubAllGlobals()
})

const LEAKED_KEY = 'AIzaLeakedTestKey123'

function serializedCalls(calls: unknown[][]): string {
  return JSON.stringify(calls, (_key, value) => value instanceof Error
    ? { ...value, name: value.name, message: value.message }
    : value)
}

describe('WorkspaceMapControls', () => {
  it('hands the map container size to the camera instead of resizing the map', async () => {
    const setScreen = vi.fn()
    const { controls, maps, observers, container } = createControls({ setScreen })
    Object.defineProperties(container, { clientWidth: { value: 640 }, clientHeight: { value: 480 } })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    try {
      observers[0]!.callback([], {} as ResizeObserver)

      expect(setScreen).toHaveBeenCalledTimes(1)
      expect(setScreen).toHaveBeenCalledWith({ width: 640, height: 480, devicePixelRatio: window.devicePixelRatio })
      expect(map.resize).not.toHaveBeenCalled()
      // Nor does MapLibre resize itself behind the camera driver.
      expect(map.options.trackResize).toBe(false)
    } finally { controls.releaseMap(admitted) }
  })

  it('acceptance: repeated Satellite hide/show releases mount-owned movement listeners', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    try {
      expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeDefined()
      const initial = map.listeners.get('moveend')?.size ?? 0
      expect(initial).toBeGreaterThan(0)
      for (let i = 0; i < 3; i++) {
        controls.updateBackgroundPresentation(hidden())
        expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeUndefined()
        controls.updateBackgroundPresentation(satelliteOn())
        expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeDefined()
      }
      expect(map.listeners.get('moveend')?.size).toBe(initial)
    } finally { controls.releaseMap(admitted) }
    expect(map.listeners.get('moveend')?.size ?? 0).toBe(0)
  })

  it('acceptance: workspace leaves attribution control ownership to the background mount', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    try {
      expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeDefined()
      expect(map.options.attributionControl).toBe(false)
      // One control, owned by the background band, at any time; MapLibre folds it only on narrow maps.
      const attribution = () => {
        expect(map.controls.size).toBe(1)
        const [control] = [...map.controls]
        expect(control).toBeInstanceOf(FakeAttributionControl)
        return control as FakeAttributionControl
      }
      expect(attribution().options?.compact).toBeUndefined()
      expect(attribution().options?.customAttribution).toBe('&copy; Google')
      expect(map.addControl).toHaveBeenLastCalledWith(attribution(), 'bottom-right')

      controls.updateBackgroundPresentation(hidden())
      expect(attribution().options?.customAttribution).toBeUndefined()
      controls.updateBackgroundPresentation(satelliteOn())
      expect(attribution().options?.customAttribution).toBe('&copy; Google')
    } finally { controls.releaseMap(admitted) }
    expect(map.controls.size).toBe(0)
  })

  it('requests antialiasing before the shared workspace creates its WebGL context', async () => {
    const { controls, maps } = createControls({ background: hidden() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition

    try {
      expect(map.options.canvasContextAttributes).toEqual({ antialias: true })
    } finally {
      controls.releaseMap(admitted)
    }
  })

  it('configures the production map shell at MapLibre\'s tile ceiling (z25; the camera guard reaches 27) and one world', async () => {
    const { controls, maps } = createControls({ background: hidden() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition

    try {
      expect(map.options).toMatchObject({
        minZoom: 0,
        maxZoom: 25,
        renderWorldCopies: false,
        interactive: false,
      })
    } finally {
      controls.releaseMap(admitted)
    }
  })

  // Raster rollback belongs to the upstream renderer adapter; terrain keeps
  // the synchronous rollback contract here.
  it.each([
    ['terrain', 'removeLayer'], ['terrain', 'removeSource'],
  ] as const)('releases the map after %s rollback cannot %s', async (kind, removeMethod) => {
    const states = vi.fn()
    const { controls, maps } = createControls({ contributions: {
      onStateChange: states,
      loadTerrainSupport: async () => ({ sharedDemProtocolUrl: 'dem://tiles', contourProtocolUrl: () => 'contour://tiles' }),
    } })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    const failure = vi.fn((error: unknown) => controls.releaseMap(admitted, error))
    controls.watchFailure(admitted, failure)
    const partialLayer = 'hillshade-layer'
    const partialSource = 'terrain-dem'
    const add = map.addLayer.getMockImplementation()!
    map.addLayer.mockImplementation((candidate, before) => {
      add(candidate, before)
      if (candidate.id === partialLayer) throw new Error('partial contribution add')
    })
    const cleanup = new Error(`${kind} rollback failed`)
    const remove = map[removeMethod].getMockImplementation()!
    map[removeMethod].mockImplementation((id) => {
      if (id === partialLayer || id === partialSource) throw cleanup
      remove(id)
    })
    const input: WorkspaceMapContributionSnapshot = {
      ...targetContribution(controls.sessionIdentity),
      terrain: { ...targetContribution(controls.sessionIdentity).terrain, hillshadeVisible: kind === 'terrain' },
      lidar: [],
    }
    controls.updateMapContributions(input)
    await vi.waitFor(() => expect(failure).toHaveBeenCalledExactlyOnceWith(cleanup))
    expect(map.remove).toHaveBeenCalledOnce()
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'error' })
    const mutations = map.addSource.mock.calls.length
    controls.updateMapContributions(input)
    expect(map.addSource).toHaveBeenCalledTimes(mutations)
  })

  it('admits the map when a Target overlay fails during initial contribution work', async () => {
    const states = vi.fn()
    const logError = vi.fn()
    const { controls, maps } = createControls({ contributions: { onStateChange: states }, logError })
    const acquisition = controls.createMap(new AbortController().signal)
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    const map = await waitForMap(maps)
    const error = new Error('target layer failed')
    const add = map.addLayer.getMockImplementation()!
    map.addLayer.mockImplementation((layer, before) => {
      if (layer.id?.startsWith('panel-target-')) throw error
      add(layer, before)
    })
    map.emit('style.load')
    await expect(acquisition).resolves.toBe(map)
    expect(map.remove).not.toHaveBeenCalled()
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'ready', layerSkipped: true })
    expect([...map.layers.keys()].some((id) => id.startsWith('panel-target-'))).toBe(false)
    expect(logError).toHaveBeenCalledWith('Skipped a map overlay that failed to sync:', error)
  })

  it.each(['addSource', 'addLayer'] as const)('keeps the map admitted and editable when a live Target overlay %s throws', async (method) => {
    const states = vi.fn()
    const { controls, maps } = createControls({ contributions: { onStateChange: states }, logError: vi.fn() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    const failure = vi.fn()
    controls.watchFailure(admitted, failure)
    const error = new Error('target contribution failed')
    if (method === 'addSource') {
      const add = map.addSource.getMockImplementation()!
      map.addSource.mockImplementation((id, source) => {
        if (id.startsWith('panel-target-')) throw error
        add(id, source)
      })
    } else {
      const add = map.addLayer.getMockImplementation()!
      map.addLayer.mockImplementation((layer, before) => {
        if (layer.id?.startsWith('panel-target-')) throw error
        add(layer, before)
      })
    }
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    expect(failure).not.toHaveBeenCalled()
    expect(map.remove).not.toHaveBeenCalled()
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'ready', layerSkipped: true })
    // The background band keeps working.
    controls.updateBackgroundPresentation(satelliteOn(0.7))
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(MAPLIBRE_SATELLITE_LAYER_ID, 'raster-opacity', 0.7)
    expect(failure).not.toHaveBeenCalled()
  })

  it('keeps the map admitted when MapLibre rejects an overlay source specification', async () => {
    const states = vi.fn()
    const logError = vi.fn()
    const { controls, maps } = createControls({ contributions: { onStateChange: states }, logError })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    const failure = vi.fn()
    controls.watchFailure(admitted, failure)
    const add = map.addSource.getMockImplementation()!
    map.addSource.mockImplementation((id, source) => {
      // MapLibre validates, emits an error event and does not add the source.
      if (id.startsWith('panel-target-')) map.emit('error', { error: new Error(`sources.${id}: unknown property "id"`) })
      else add(id, source)
    })
    const addLayer = map.addLayer.getMockImplementation()!
    map.addLayer.mockImplementation((layer, before) => {
      if (layer.id?.startsWith('panel-target-') && !map.sources.has(String((layer as { source?: unknown }).source))) {
        map.emit('error', { error: new Error(`layers.${layer.id}: source "${String((layer as { source?: unknown }).source)}" not found`) })
        return
      }
      addLayer(layer, before)
    })
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    expect(failure).not.toHaveBeenCalled()
    expect(map.remove).not.toHaveBeenCalled()
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'ready', layerSkipped: true })
  })

  it.each([
    ['terrain source', { sourceId: 'terrain-dem', error: new Error('dem tile failed') }],
    ['terrain layer', { error: new Error('layers.hillshade-layer.paint.hillshade-exaggeration: number expected') }],
    ['raster tile', { sourceId: 'mlrcog0-src-lidar-a', error: new Error('tile failed') }],
    ['basemap layer', { error: new Error('layers.ofm:water.paint.fill-color: color expected') }],
  ] as const)('keeps the map admitted for an optional %s error', async (_name, event) => {
    const { controls, maps } = createControls({ logError: vi.fn() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    const failure = vi.fn()
    controls.watchFailure(admitted, failure)
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    map.emit('error', event)
    expect(failure).not.toHaveBeenCalled()
    expect(map.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['unattributed engine', { error: new Error('map engine failed') }],
    ['shared scene layer', { layer: { id: MAPLIBRE_SHARED_SCENE_LAYER_ID }, error: new Error('scene draw failed') }],
  ] as const)('still reports a core %s failure', async (_name, event) => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    const failure = vi.fn()
    controls.watchFailure(admitted, failure)
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    map.emit('error', event)
    expect(failure).toHaveBeenCalledExactlyOnceWith(event.error)
  })

  it.each(['loader', 'constructor', 'webgl', 'pre-admission'] as const)('publishes the acquisition error for %s failure', async (stage) => {
    const states = vi.fn()
    const error = new Error(`${stage} failed`)
    const { controls, maps } = createControls({
      contributions: { onStateChange: states },
      ...(stage === 'loader' ? { load: async () => { throw error } } : {}),
      ...(stage === 'constructor' ? { load: async () => ({ Map: class { constructor() { throw error } } as never, addProtocol: vi.fn() }) } : {}),
      ...(stage === 'webgl' ? { webgl2: null } : {}),
    })
    const acquisition = controls.createMap(new AbortController().signal)
    const rejection = expect(acquisition).rejects.toThrow(stage === 'webgl' ? 'WebGL2' : error.message)
    if (stage === 'pre-admission') (await waitForMap(maps)).emit('error', { error })
    await rejection
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'error' })
  })

  it('keeps an ordinary acquisition abort idle', async () => {
    const states = vi.fn()
    const { controls, maps } = createControls({ contributions: { onStateChange: states } })
    const abort = new AbortController()
    const acquisition = controls.createMap(abort.signal)
    await waitForMap(maps)
    const rejected = expect(acquisition).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'idle' })
  })

  it.each(['loader rejected', new DOMException('access denied', 'SecurityError'), new DOMException('loader cancelled internally', 'AbortError')])(
    'preserves a non-Error acquisition failure message: %s', async (error) => {
      const states = vi.fn()
      const { controls } = createControls({
        contributions: { onStateChange: states },
        load: async () => { throw error },
      })
      const abort = new AbortController()
      await expect(controls.createMap(abort.signal)).rejects.toBe(error)
      expect(abort.signal.aborted).toBe(false)
      expect(states.mock.lastCall?.[0]).toMatchObject({
        status: 'error',
      })
    },
  )

  it.each([new Error('shared renderer failed'), new DOMException('renderer cancelled internally', 'AbortError')])('retains an external camera or shared-renderer failure on final map release: %s', async (error) => {
    const states = vi.fn()
    const { controls, maps } = createControls({ contributions: { onStateChange: states } })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    controls.releaseMap(admitted, error)
    controls.releaseMap(admitted)
    expect(states.mock.lastCall?.[0]).toMatchObject({ status: 'error' })
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('clears contribution layers and listeners before removing the map once', async () => {
    const states = vi.fn()
    const { controls, maps, observers } = createControls({
      contributions: { onStateChange: states },
    })
    const acquisition = controls.createMap(new AbortController().signal)
    const input: WorkspaceMapContributionSnapshot = {
      sessionIdentity: controls.sessionIdentity,
      lidar: [],
      terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
      overlays: { runtime: { getSceneSnapshot: vi.fn() }, location: { lat: 0, lon: 0 }, hoveredTargets: [], selectedTargets: [] , site: null },
    }
    controls.updateMapContributions(input)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    controls.updateMapContributions({ ...input })
    expect(maps).toHaveLength(1)
    map.remove.mockImplementation(() => {
      expect([...map.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
      expect(states.mock.lastCall?.[0].status).toBe('idle')
    })
    controls.releaseMap(admitted)
    controls.releaseMap(admitted)
    expect(map.remove).toHaveBeenCalledOnce()
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('does not add a remote source for hidden background presentation', async () => {
    const { controls, maps } = createControls({ background: hidden() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)

    map.emit('style.load')
    await expect(acquisition).resolves.toBe(map)
    await Promise.resolve()
    expect(map.addSource).not.toHaveBeenCalled()
    expect(map.addLayer).not.toHaveBeenCalled()
    expect(styleFetch).not.toHaveBeenCalled()
    expect(JSON.stringify(map.options.style)).not.toContain('openfreemap')
    expect(JSON.stringify(map.options.style)).not.toContain('google.com')
  })

  it('adds the visible contribution at style admission without waiting for tile events', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)

    map.emit('style.load')
    await expect(acquisition).resolves.toBe(map)

    expect(map.addSource).toHaveBeenCalledWith(MAPLIBRE_SATELLITE_SOURCE_ID, expect.objectContaining({
      type: 'raster',
      tiles: [GOOGLE_KEYLESS_TILES],
    }))
    // Nothing Canopi-owned is above it yet, so it is appended without an anchor.
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: MAPLIBRE_SATELLITE_LAYER_ID,
      source: MAPLIBRE_SATELLITE_SOURCE_ID,
    }), undefined)
    expect(styleFetch).not.toHaveBeenCalled()
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.4,
    )
  })

  it('applies opacity-only presentation updates without recreating the Satellite contribution', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    map.addSource.mockClear()
    map.addLayer.mockClear()
    map.removeLayer.mockClear()
    map.removeSource.mockClear()
    map.setPaintProperty.mockClear()

    controls.updateBackgroundPresentation(satelliteOn(0.75))

    expect(map.setPaintProperty).toHaveBeenCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.75,
    )
    expect(map.addSource).not.toHaveBeenCalled()
    expect(map.addLayer).not.toHaveBeenCalled()
    expect(map.removeLayer).not.toHaveBeenCalled()
    expect(map.removeSource).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizes non-finite opacity %p to zero',
    async (opacity) => {
      const { controls, maps } = createControls()
      const acquisition = controls.createMap(new AbortController().signal)
      const map = await waitForMap(maps)
      map.emit('style.load')
      await acquisition
      map.setPaintProperty.mockClear()

      controls.updateBackgroundPresentation(satelliteOn(opacity))

      expect(map.setPaintProperty).toHaveBeenCalledWith(
        MAPLIBRE_SATELLITE_LAYER_ID,
        'raster-opacity',
        0,
      )
    },
  )

  it('removes before source removal, retains hidden presentation, and restores the latest visible one', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition

    controls.updateBackgroundPresentation(hidden(1.2))
    expect(map.removeLayer.mock.invocationCallOrder[0]).toBeLessThan(
      map.removeSource.mock.invocationCallOrder[0]!,
    )
    const sourceCountWhileHidden = map.addSource.mock.calls.length
    controls.updateBackgroundPresentation(hidden(0.2))
    expect(map.addSource).toHaveBeenCalledTimes(sourceCountWhileHidden)

    controls.updateBackgroundPresentation(satelliteOn(2))
    expect(map.addSource).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_SOURCE_ID,
      expect.objectContaining({ tiles: [GOOGLE_KEYLESS_TILES] }),
    )
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      1,
    )
  })

  it('retains the latest presentation during acquisition before style admission', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    controls.updateBackgroundPresentation(hidden(0.1))

    map.emit('style.load')
    await acquisition
    expect(map.addSource).not.toHaveBeenCalled()
    expect(map.addLayer).not.toHaveBeenCalled()
  })

  it('adds Satellite imagery when a hidden attempt receives a visible presentation update', async () => {
    const { controls, maps } = createControls({ background: hidden() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    expect(map.addSource).not.toHaveBeenCalled()

    controls.updateBackgroundPresentation(satelliteOn(0.8))

    expect(map.addSource).toHaveBeenCalledWith(MAPLIBRE_SATELLITE_SOURCE_ID, expect.objectContaining({ type: 'raster' }))
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: MAPLIBRE_SATELLITE_LAYER_ID }), undefined)
  })

  it('hides and restores only the Satellite imagery while preserving local contribution identities and order', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const backgroundLayer = { id: MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID }
    const lidarSource = { type: 'raster', tiles: ['lidar'] }
    const referenceSource = { type: 'geojson' }
    const lidar = { id: 'lidar-layer', source: 'lidar-source' }
    const reference = { id: 'reference-layer', source: 'reference-source' }
    const scene = { id: MAPLIBRE_SHARED_SCENE_LAYER_ID }
    map.addLayer(backgroundLayer)
    map.layerOrder.splice(0, map.layerOrder.length,
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SATELLITE_LAYER_ID,
    )
    map.addSource('lidar-source', lidarSource)
    map.addSource('reference-source', referenceSource)
    map.addLayer(lidar)
    map.addLayer(reference)
    map.addLayer(scene)
    map.removeLayer.mockClear()
    map.removeSource.mockClear()
    map.addLayer.mockClear()
    map.addSource.mockClear()
    const expectLocalContributions = () => {
      expect(map.getSource('lidar-source')).toBe(lidarSource)
      expect(map.getSource('reference-source')).toBe(referenceSource)
      expect(map.getLayer('lidar-layer')).toBe(lidar)
      expect(map.getLayer('reference-layer')).toBe(reference)
      expect(map.getLayer(MAPLIBRE_SHARED_SCENE_LAYER_ID)).toBe(scene)
    }

    controls.updateBackgroundPresentation(hidden(0.6))

    expect(map.removeLayer).toHaveBeenCalledExactlyOnceWith(MAPLIBRE_SATELLITE_LAYER_ID)
    expect(map.removeSource).toHaveBeenCalledExactlyOnceWith(MAPLIBRE_SATELLITE_SOURCE_ID)
    expectLocalContributions()
    expect(map.layerOrder).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      'lidar-layer',
      'reference-layer',
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])

    controls.updateBackgroundPresentation(satelliteOn(0.6))

    expectLocalContributions()
    expect(map.layerOrder).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SATELLITE_LAYER_ID,
      'lidar-layer',
      'reference-layer',
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])

    controls.updateBackgroundPresentation(hidden(0.6))
    controls.updateBackgroundPresentation(satelliteOn(0.6))

    expectLocalContributions()
    expect(map.removeLayer.mock.calls).toEqual([
      [MAPLIBRE_SATELLITE_LAYER_ID],
      [MAPLIBRE_SATELLITE_LAYER_ID],
    ])
    expect(map.removeSource.mock.calls).toEqual([
      [MAPLIBRE_SATELLITE_SOURCE_ID],
      [MAPLIBRE_SATELLITE_SOURCE_ID],
    ])
    expect(map.layerOrder).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SATELLITE_LAYER_ID,
      'lidar-layer',
      'reference-layer',
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])
  })

  it('binds map construction and background to each attempt snapshot', async () => {
    const { controls, maps } = createControls()
    const snapshotA: WorkspaceMapSnapshot = {
      initialCenter: { lat: 10, lon: 20 },
      background: satelliteOn(0.2),
    }
    const snapshotB: WorkspaceMapSnapshot = {
      initialCenter: { lat: -40, lon: 70 },
      background: satelliteOn(0.8),
    }
    const first = controls.createMap(new AbortController().signal, snapshotA)
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    const mapA = maps[0]!
    mapA.emit('style.load')
    await first
    const mapAPaintBeforeRelease = mapA.setPaintProperty.mock.calls.length

    const second = controls.createMap(new AbortController().signal, snapshotB)
    await vi.waitFor(() => expect(maps).toHaveLength(2))
    const mapB = maps[1]!
    mapB.emit('style.load')
    await second

    expect(mapA.options.center).toEqual([20, 10])
    expect(mapA.options.bearing).toBe(0)
    // The released first attempt was left untouched by the second.
    expect(mapA.setPaintProperty).toHaveBeenCalledTimes(mapAPaintBeforeRelease)
    expect(mapA.setPaintProperty).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.2,
    )
    expect(mapA.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeUndefined()
    expect(mapB.options.center).toEqual([70, -40])
    expect(mapB.options.bearing).toBe(0)
    expect(mapB.setPaintProperty).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.8,
    )
    expect(mapB.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeDefined()
  })

  it('keeps the creation snapshot\'s background through admission', async () => {
    const { controls, maps } = createControls()
    const snapshot: WorkspaceMapSnapshot = {
      initialCenter: { lat: 11, lon: 22 },
      background: satelliteOn(0.25),
    }
    const acquisition = controls.createMap(new AbortController().signal, snapshot)
    const map = await waitForMap(maps)

    map.emit('style.load')
    await acquisition

    expect(map.options.center).toEqual([22, 11])
    expect(map.options.bearing).toBe(0)
    expect(map.addSource).toHaveBeenCalledWith(
      MAPLIBRE_SATELLITE_SOURCE_ID,
      expect.objectContaining({ tiles: [GOOGLE_KEYLESS_TILES] }),
    )
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.25,
    )
    expect(styleFetch).not.toHaveBeenCalled()
  })

  it('keeps the shared scene above the basemap and LiDAR when activation reconciles the layer stack', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const contribution = targetContribution(controls.sessionIdentity)
    controls.updateMapContributions({
      ...contribution,
      lidar: [lidarLayer('lidar-a'), lidarLayer('lidar-b')],
      overlays: { ...contribution.overlays, hoveredTargets: [] },
    })
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    // The scene was appended on top, and two LiDAR layers arrived above the Satellite imagery in reverse.
    map.addLayer({ id: 'lidar-b' })
    map.addLayer({ id: 'lidar-a' })
    map.addLayer({ id: MAPLIBRE_SHARED_SCENE_LAYER_ID })
    map.layerOrder.splice(0, map.layerOrder.length,
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'lidar-b',
      MAPLIBRE_SATELLITE_LAYER_ID,
      'lidar-a',
    )
    map.addLayer.mockClear()
    map.addSource.mockClear()

    controls.reconcileLayerStack(admitted)

    expect(map.layerOrder).toEqual([
      MAPLIBRE_SATELLITE_LAYER_ID,
      'lidar-a',
      'lidar-b',
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])
    expect(map.addLayer).not.toHaveBeenCalled()
    expect(map.addSource).not.toHaveBeenCalled()
  })

  it('admits the map on its first style.load and ignores a later one, logging it once', async () => {
    const logError = vi.fn()
    const { controls, maps } = createControls({ logError })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    map.addLayer({ id: MAPLIBRE_SHARED_SCENE_LAYER_ID })
    const order = map.getLayersOrder()
    const mutators = [map.addSource, map.addLayer, map.removeLayer, map.removeSource, map.moveLayer, map.setPaintProperty]
    const callsBefore = mutators.map((mutator) => mutator.mock.calls.length)
    logError.mockClear()

    map.emit('style.load')
    map.emit('style.load')
    await Promise.resolve()

    expect(mutators.map((mutator) => mutator.mock.calls.length)).toEqual(callsBefore)
    expect(map.getLayersOrder()).toEqual(order)
    expect(maps).toHaveLength(1)
    expect(map.remove).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledExactlyOnceWith('MapLibre loaded a later style; Canopi never reloads it, so it is ignored.')
  })

  it('serializes a presentation requested reentrantly by a live Satellite withdrawal', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const sourceMutationDepths: number[] = []
    let removalDepth = 0
    let reentered = false
    map.removeLayer.mockImplementation((id: string) => {
      map.layers.delete(id)
      const index = map.layerOrder.indexOf(id)
      if (index >= 0) map.layerOrder.splice(index, 1)
      if (id !== MAPLIBRE_SATELLITE_LAYER_ID || reentered) return
      reentered = true
      removalDepth += 1
      controls.updateBackgroundPresentation(satelliteOn(0.9))
      removalDepth -= 1
    })
    map.addSource.mockImplementation((id: string, source: unknown) => {
      sourceMutationDepths.push(removalDepth)
      map.sources.set(id, source)
    })

    controls.updateBackgroundPresentation(hidden(0.3))

    expect(sourceMutationDepths.length).toBeGreaterThan(0)
    expect(sourceMutationDepths.every((depth) => depth === 0)).toBe(true)
    expect(map.addSource).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_SOURCE_ID,
      expect.objectContaining({ tiles: [GOOGLE_KEYLESS_TILES] }),
    )
    expect(map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)).toBeDefined()
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(
      MAPLIBRE_SATELLITE_LAYER_ID,
      'raster-opacity',
      0.9,
    )
  })

  it('reports one live presentation mutation failure through the existing watcher', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)
    const failure = new Error('opacity rejected')
    map.setPaintProperty.mockImplementation(() => { throw failure })
    map.setPaintProperty.mockClear()

    controls.updateBackgroundPresentation(satelliteOn(0.6))
    controls.updateBackgroundPresentation(satelliteOn(0.7))

    expect(reportFailure).toHaveBeenCalledTimes(1)
    expect(reportFailure).toHaveBeenCalledWith(failure)
    expect(map.setPaintProperty).toHaveBeenCalledOnce()
  })

  it('treats a synchronous source event as passive after the local style is admitted', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    const error = new Error('tile request failed immediately')
    const event = { sourceId: MAPLIBRE_SATELLITE_SOURCE_ID, error }
    map.addSource.mockImplementation(() => map.emit('error', event))

    map.emit('style.load')

    await expect(acquisition).resolves.toBe(map)
    expect(map.remove).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'Passive MapLibre workspace basemap error:',
      `source ${MAPLIBRE_SATELLITE_SOURCE_ID} · tile request failed immediately`,
    )
    logError.mockRestore()
  })

  it('rejects a thrown basemap configuration error and releases the map', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    const error = new Error('source definition rejected')
    map.addSource.mockImplementation(() => { throw error })

    map.emit('style.load')

    await expect(acquisition).rejects.toBe(error)
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('rejects before admission for context loss and releases through the surface', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)

    map.emit('webglcontextlost')
    await expect(acquisition).rejects.toThrow('WebGL context was lost')
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('routes a loader failure to the acquisition rejection', async () => {
    const error = new Error('module unavailable')
    const { controls } = createControls({ load: async () => { throw error } })
    await expect(controls.createMap(new AbortController().signal)).rejects.toBe(error)
  })

  it('routes a MapLibre constructor failure to the acquisition rejection', async () => {
    const error = new Error('map construction failed')
    const surface = new MapLibreSurface({
      loadMapLibre: async () => ({
        Map: class {
          constructor() { throw error }
        } as never,
        addProtocol: vi.fn(),
      }),
    })
    const controls = new WorkspaceMapControls({
      container: document.createElement('div'), surface,
      canCreateWebGL2Context: () => true,
      setScreen: vi.fn(),
      contributions: {},
    })
    await expect(controls.createMap(new AbortController().signal, {
      initialCenter: { lat: 0, lon: 0 },
      background: satelliteOn(1),
    })).rejects.toBe(error)
  })

  it('rejects unavailable WebGL2 before constructing a MapLibre map', async () => {
    const canCreateWebGL2Context = vi.fn(() => false)
    const { controls, maps, observers } = createControls({ canCreateWebGL2Context })

    await expect(controls.createMap(new AbortController().signal)).rejects.toThrow(
      'WebGL2 is unavailable',
    )

    expect(canCreateWebGL2Context).toHaveBeenCalledOnce()
    expect(maps).toEqual([])
    expect(observers).toEqual([])
  })

  it('publishes the map-unavailable error state when WebGL2 is unavailable', async () => {
    const states = vi.fn()
    const { controls, maps } = createControls({
      canCreateWebGL2Context: () => false,
      contributions: { onStateChange: states },
    })

    await expect(controls.createMap(new AbortController().signal)).rejects.toThrow('WebGL2 is unavailable')

    expect(maps).toEqual([])
    expect(states).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'error' }))
  })

  it('publishes a lost context as a map error', async () => {
    const states: MapLibreCanvasSurfaceState[] = []
    const { controls, maps } = createControls({ contributions: { onStateChange: (state) => states.push(state) } })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    controls.watchFailure(admitted, (error) => controls.releaseMap(admitted, error))

    map.emit('webglcontextlost')

    expect(states.at(-1)).toMatchObject({ status: 'error' })
  })

  it('does not ask a browser without the WebGL2 interface to create a context', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const loadMapLibre = vi.fn<() => Promise<MapLibreApi>>()
    const surface = new MapLibreSurface({ loadMapLibre })
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    try {
      const controls = new WorkspaceMapControls({
        container: document.createElement('div'),
        surface,
        setScreen: vi.fn(),
        contributions: {},
      })

      await expect(controls.createMap(new AbortController().signal, {
        initialCenter: { lat: 0, lon: 0 },
        background: satelliteOn(1),
      })).rejects.toThrow('WebGL2 is unavailable')

      expect(getContext).not.toHaveBeenCalled()
      expect(loadMapLibre).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      getContext.mockRestore()
    }
  })

  it('rejects and releases when the constructed map has no public WebGL2 context', async () => {
    const { controls, maps, observers } = createControls({ webgl2: null })

    await expect(controls.createMap(new AbortController().signal)).rejects.toThrow(
      'did not expose a WebGL2 context',
    )

    expect(maps).toHaveLength(1)
    expect(maps[0]?.remove).toHaveBeenCalledOnce()
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('rejects a pre-admission MapLibre error and releases the map', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    const error = new Error('style failed')

    map.emit('error', error)
    await expect(acquisition).rejects.toBe(error)
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('never logs a Google tile key from a passive Satellite tile error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { controls, maps } = createControls()
      const acquisition = controls.createMap(new AbortController().signal)
      const map = await waitForMap(maps)
      map.emit('style.load')
      await acquisition
      const url = `https://tile.googleapis.com/v1/2dtiles/18/1/2?session=s1&key=${LEAKED_KEY}`

      map.emit('error', {
        type: 'error',
        sourceId: MAPLIBRE_SATELLITE_SOURCE_ID,
        error: Object.assign(new Error(`AJAXError: Forbidden (403): ${url}`), { status: 403, url }),
        tile: { tileID: { canonical: { z: 18, x: 1, y: 2 } }, url },
      })

      expect(logged).toHaveBeenCalled()
      expect(serializedCalls(logged.mock.calls)).not.toContain(LEAKED_KEY)
      expect(serializedCalls(logged.mock.calls)).toContain(MAPLIBRE_SATELLITE_SOURCE_ID)
    } finally {
      logged.mockRestore()
    }
  })

  it('strips a tile key from a MapLibre error before it reaches a failure watcher', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)

    map.emit('error', { error: new Error(`AJAXError: Forbidden (403): https://example.test/style.json?key=${LEAKED_KEY}`) })

    expect(reportFailure).toHaveBeenCalledOnce()
    expect(String((reportFailure.mock.calls[0]?.[0] as Error).message)).not.toContain(LEAKED_KEY)
    expect(String((reportFailure.mock.calls[0]?.[0] as Error).message)).toContain('key=<redacted>')
  })

  it('retains post-admission context loss until the coordinator registers its watcher', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition

    map.emit('webglcontextlost')
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('WebGL context was lost') }))
    map.emit('webglcontextlost')
    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('retains a generic post-admission map failure until the watcher registers', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const error = new Error('map engine failed')

    map.emit('error', { error })
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)

    expect(reportFailure).toHaveBeenCalledWith(error)
  })

  it('reports a generic map failure after the watcher registers', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)
    const error = new Error('map engine failed later')

    map.emit('error', { error })

    expect(reportFailure).toHaveBeenCalledWith(error)
  })

  it('ignores passive basemap errors after style admission', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition

    const event = {
      sourceId: MAPLIBRE_SATELLITE_SOURCE_ID,
      error: new Error('tile unavailable'),
    }
    map.emit('error', event)
    expect(map.remove).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'Passive MapLibre workspace basemap error:',
      `source ${MAPLIBRE_SATELLITE_SOURCE_ID} · tile unavailable`,
    )
    logError.mockRestore()
  })

  it('ignores passive OpenFreeMap source errors after style admission', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const reportFailure = vi.fn()
    controls.watchFailure(map as never, reportFailure)

    // A tile's failure carries the tile; a source failure without one is the TileJSON's.
    const event = { sourceId: 'ofm-openmaptiles', error: new Error('vector tile unavailable'), tile: {} }
    map.emit('error', event)

    expect(map.remove).not.toHaveBeenCalled()
    expect(reportFailure).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('Passive MapLibre workspace basemap error:', 'source ofm-openmaptiles · vector tile unavailable')
    expect(ringEntries().at(-1)).toMatchObject({ code: { kind: 'tile_source_failed', layer: 'ofm-openmaptiles' } })
    logError.mockRestore()
  })

  it('cancels module loading and style waiting without leaving a map alive', async () => {
    let resolveLoad!: (api: MapLibreApi) => void
    const loader = new Promise<MapLibreApi>((resolve) => { resolveLoad = resolve })
    const loaded = createControls({ load: () => loader })
    const loadingAbort = new AbortController()
    const loading = loaded.controls.createMap(loadingAbort.signal)
    loadingAbort.abort()
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    resolveLoad(createApi(loaded.maps))
    await Promise.resolve()
    expect(loaded.maps).toEqual([])

    const waiting = createControls()
    const styleAbort = new AbortController()
    const acquisition = waiting.controls.createMap(styleAbort.signal)
    const map = await waitForMap(waiting.maps)
    styleAbort.abort()
    await expect(acquisition).rejects.toMatchObject({ name: 'AbortError' })
    expect(map.remove).toHaveBeenCalledOnce()
    expect(map.listeners.get('style.load')?.size ?? 0).toBe(0)
    expect(waiting.observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('cancels a superseded acquisition before creating the replacement map', async () => {
    const { controls, maps } = createControls()
    const first = controls.createMap(new AbortController().signal)
    const second = controls.createMap(new AbortController().signal)

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const map = await waitForMap(maps)
    map.emit('style.load')
    await expect(second).resolves.toBe(map)
    expect(maps).toHaveLength(1)
  })

  it('releases an admitted map through the surface exactly once', async () => {
    const { controls, maps, observers } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition

    controls.releaseMap(map as never)
    controls.releaseMap(map as never)

    expect(map.remove).toHaveBeenCalledOnce()
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('leaves a released attempt inert when a later presentation arrives', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    controls.releaseMap(map as never)
    map.addSource.mockClear()
    map.addLayer.mockClear()
    map.setPaintProperty.mockClear()

    controls.updateBackgroundPresentation(basemapOn({ opacity: 0 }))
    await Promise.resolve()

    expect(map.addSource).not.toHaveBeenCalled()
    expect(map.addLayer).not.toHaveBeenCalled()
    expect(map.setPaintProperty).not.toHaveBeenCalled()
    expect(styleFetch).not.toHaveBeenCalled()
  })

  it('reads WebGL2 only from the public map canvas', async () => {
    const { controls, maps } = createControls()
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    const context = {} as WebGL2RenderingContext
    const getContext = vi.fn(() => context)
    Object.defineProperty(map.canvas, 'getContext', { value: getContext })

    expect(controls.getWebGL2Context(map as never)).toBe(context)
    expect(getContext).toHaveBeenCalledWith('webgl2')
  })
})

describe('WorkspaceMapControls OpenFreeMap basemap', () => {
  it('installs the OpenFreeMap basemap below Canopi layers', async () => {
    const { controls, maps } = createControls({ background: basemapOn({ style: 'bright', opacity: 0.5 }, 'fr') })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    map.addLayer({ id: MAPLIBRE_SHARED_SCENE_LAYER_ID })

    await vi.waitFor(() => expect(hasOpenFreeMapBasemap(map)).toBe(true))

    expect(styleFetch).toHaveBeenCalledWith(OPENFREEMAP_BASEMAPS.bright, expect.anything())
    expect(map.setGlyphs).toHaveBeenCalledWith(OPENFREEMAP_STYLE.glyphs)
    expect(map.setSprite).toHaveBeenCalledWith(OPENFREEMAP_STYLE.sprite)
    expect(map.getSource('ofm-openmaptiles')).toEqual(OPENFREEMAP_STYLE.sources.openmaptiles)
    // The row opacity and the label language are the map's global state, which the layers read.
    expect(map.setGlobalStateProperty).toHaveBeenCalledWith('canopi:basemap-opacity', 0.5)
    expect(map.setGlobalStateProperty).toHaveBeenCalledWith('canopi:basemap-locale', 'fr')
    expect(map.getLayer('ofm:water')).toMatchObject({
      source: 'ofm-openmaptiles',
      paint: { 'fill-opacity': ['*', 0.8, ['global-state', 'canopi:basemap-opacity']] },
    })
    expect(map.getLayer('ofm:place-label')).toMatchObject({
      layout: { 'text-field': ['coalesce', ['get', ['concat', 'name:', ['global-state', 'canopi:basemap-locale']]], ['get', 'name']] },
    })
    expect(map.layerOrder).toEqual([...OPENFREEMAP_LAYER_IDS, MAPLIBRE_SHARED_SCENE_LAYER_ID])
    expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeUndefined()
  })

  it('installs Satellite imagery in place of the basemap and restores the basemap when Satellite is off', async () => {
    const { controls, maps } = createControls({ background: basemapOn() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    await vi.waitFor(() => expect(hasOpenFreeMapBasemap(map)).toBe(true))

    controls.updateBackgroundPresentation(background({ visible: true }, { visible: true, opacity: 0.7 }))

    expect(hasAnyOpenFreeMapLayer(map)).toBe(false)
    expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toMatchObject({ tiles: [GOOGLE_KEYLESS_TILES] })
    expect(map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)).toBeDefined()
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(MAPLIBRE_SATELLITE_LAYER_ID, 'raster-opacity', 0.7)

    controls.updateBackgroundPresentation(basemapOn())

    expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toBeUndefined()
    expect(map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)).toBeUndefined()
    await vi.waitFor(() => expect(hasOpenFreeMapBasemap(map)).toBe(true))
  })

  it('notices a 503 basemap style with a fixed message and Retry, keeps the map, and Retry loads it', async () => {
    // A loaded style stays cached for the session, so this uses the one style no earlier test loads.
    styleFetch.mockImplementationOnce(async () => new Response('unavailable', { status: 503 }))
    const logError = vi.fn()
    const states: MapLibreCanvasSurfaceState[] = []
    const { controls, maps } = createControls({
      background: basemapOn({ style: 'dark' }),
      contributions: { onStateChange: (state) => states.push(state) },
      logError,
    })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    const reportFailure = vi.fn()
    controls.watchFailure(admitted, reportFailure)

    await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('failed'))
    expect(states.at(-1)?.status).toBe('ready')
    expect(logError).toHaveBeenCalledWith(
      'Map basemap style failed to load:',
      expect.objectContaining({ message: expect.stringContaining('503') }),
    )
    const notice = getMapNoticeReadModel({ hasDesign: true, mapVisible: true, mapSurface: states.at(-1)!, t })
    expect(notice).toMatchObject({
      visible: true,
      tone: 'error',
      statusText: 'Basemap couldn’t load. Check your connection.',
      retry: true,
    })
    expect(JSON.stringify(notice)).not.toContain('503')
    expect(hasAnyOpenFreeMapLayer(map)).toBe(false)
    expect(reportFailure).not.toHaveBeenCalled()
    expect(map.remove).not.toHaveBeenCalled()

    controls.retryBasemap()

    // Retry shows the download running and withdraws the button until it settles.
    expect(states.at(-1)?.basemapStatus).toBe('loading')
    expect(getMapNoticeReadModel({ hasDesign: true, mapVisible: true, mapSurface: states.at(-1)!, t }))
      .toMatchObject({ visible: true, tone: 'loading', retry: false })
    await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('ok'))
    expect(hasOpenFreeMapBasemap(map)).toBe(true)
    expect(getMapNoticeReadModel({ hasDesign: true, mapVisible: true, mapSurface: states.at(-1)!, t }).visible).toBe(false)
    expect(map.remove).not.toHaveBeenCalled()
  })

  /** An offline request the way MapLibre reports it: an AJAXError naming the URL it could not fetch. */
  function offlineRequest(url: string): Error {
    return Object.assign(new Error(`AJAXError: Failed to fetch (0): ${url}`), { name: 'AJAXError', status: 0, url })
  }

  it.each([
    // The style's sprite fails with no source or layer id.
    ['sprite', { type: 'error', error: offlineRequest('https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json') }],
    // The basemap source's TileJSON fails, which leaves the source empty.
    ['TileJSON', { type: 'error', sourceId: 'ofm-openmaptiles', error: offlineRequest('https://tiles.openfreemap.org/planet') }],
    // A captive portal answers the TileJSON with 200 and HTML: the JSON parse fails naming the source and no URL.
    ['TileJSON behind a captive portal', { type: 'error', sourceId: 'ofm-openmaptiles', error: new SyntaxError('JSON Parse error: Unrecognized token \'<\'') }],
    // A captive portal answers the sprite with 200 and HTML: the JSON parse fails with no URL and no source.
    ['sprite behind a captive portal', { type: 'error', error: new SyntaxError('JSON Parse error: Unrecognized token \'<\'') }],
    // The connection drops while the sprite body downloads: the body read fails with no URL and no source.
    ['sprite cut off mid-download', { type: 'error', error: new TypeError('Load failed') }],
  ])('shows the basemap notice, not a map failure, when the cached basemap style\'s %s fails offline, and Retry installs it again', async (_resource, event) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const states: MapLibreCanvasSurfaceState[] = []
      const { controls, maps } = createControls({
        background: basemapOn(),
        contributions: { onStateChange: (state) => states.push(state) },
      })
      const acquisition = controls.createMap(new AbortController().signal)
      const map = await waitForMap(maps)
      map.emit('style.load')
      const admitted = await acquisition
      controls.updateMapContributions(targetContribution(controls.sessionIdentity))
      const reportFailure = vi.fn()
      controls.watchFailure(admitted, reportFailure)
      await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('ok'))
      expect(map.setSprite).toHaveBeenCalledTimes(1)

      map.emit('error', event)

      expect(reportFailure).not.toHaveBeenCalled()
      expect(map.remove).not.toHaveBeenCalled()
      expect(states.at(-1)).toMatchObject({ status: 'ready', basemapStatus: 'failed' })
      expect(getMapNoticeReadModel({ hasDesign: true, mapVisible: true, mapSurface: states.at(-1)!, t })).toMatchObject({
        visible: true,
        tone: 'error',
        statusText: 'Basemap couldn’t load. Check your connection.',
        retry: true,
      })
      expect(serializedCalls(logged.mock.calls)).toContain('MapLibre workspace basemap resource failed to load')

      controls.retryBasemap()

      // Retry downloads the basemap's sprite and TileJSON again by installing it afresh.
      await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('ok'))
      expect(map.setSprite).toHaveBeenCalledTimes(2)
      expect(hasOpenFreeMapBasemap(map)).toBe(true)
      expect(reportFailure).not.toHaveBeenCalled()
      expect(map.remove).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps a failed basemap resource quiet until Retry: a presentation change does not download it again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const states: MapLibreCanvasSurfaceState[] = []
      const { controls, maps } = createControls({
        background: basemapOn(),
        contributions: { onStateChange: (state) => states.push(state) },
      })
      const acquisition = controls.createMap(new AbortController().signal)
      const map = await waitForMap(maps)
      map.emit('style.load')
      await acquisition
      controls.updateMapContributions(targetContribution(controls.sessionIdentity))
      await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('ok'))
      map.emit('error', { type: 'error', error: offlineRequest('https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json') })

      controls.updateBackgroundPresentation(basemapOn({ opacity: 0.7 }))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(map.setSprite).toHaveBeenCalledTimes(1)
      expect(states.at(-1)?.basemapStatus).toBe('failed')
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps a single basemap tile failure passive: no notice, the map keeps drawing', async () => {
    const logError = vi.fn()
    const states: MapLibreCanvasSurfaceState[] = []
    const { controls, maps } = createControls({
      background: basemapOn(),
      contributions: { onStateChange: (state) => states.push(state) },
      logError,
    })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    controls.updateMapContributions(targetContribution(controls.sessionIdentity))
    await vi.waitFor(() => expect(states.at(-1)?.basemapStatus).toBe('ok'))
    const reportFailure = vi.fn()
    controls.watchFailure(admitted, reportFailure)

    map.emit('error', {
      type: 'error',
      sourceId: 'ofm-openmaptiles',
      error: offlineRequest('https://tiles.openfreemap.org/planet/20250101_001001_pt/14/8299/5636.pbf'),
      tile: { tileID: { canonical: { z: 14, x: 8299, y: 5636 } } },
    })

    expect(reportFailure).not.toHaveBeenCalled()
    expect(states.at(-1)?.basemapStatus).toBe('ok')
    expect(ringEntries().at(-1)).toMatchObject({ code: { kind: 'tile_source_failed', layer: 'ofm-openmaptiles' }, surfaced: false })
  })

  it('still treats an unattributed error from outside the basemap as a map failure', async () => {
    const { controls, maps } = createControls({ background: basemapOn(), logError: vi.fn() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    await vi.waitFor(() => expect(hasOpenFreeMapBasemap(map)).toBe(true))
    const reportFailure = vi.fn()
    controls.watchFailure(admitted, reportFailure)

    map.emit('error', { type: 'error', error: offlineRequest('https://example.test/sprites/other.json') })

    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('treats a URL-less unattributed error as a map failure once the map settled after the basemap sprite loaded', async () => {
    const { controls, maps } = createControls({ background: basemapOn(), logError: vi.fn() })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    await vi.waitFor(() => expect(hasOpenFreeMapBasemap(map)).toBe(true))
    const reportFailure = vi.fn()
    controls.watchFailure(admitted, reportFailure)

    // MapLibre is idle only once the sprite request has settled.
    map.emit('idle')
    map.emit('error', { type: 'error', error: new TypeError('Load failed') })

    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('never installs a basemap that finishes loading after the map is released', async () => {
    let resolveStyle!: (response: Response) => void
    styleFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveStyle = resolve }))
    const { controls, maps } = createControls({ background: basemapOn({ style: 'positron' }) })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    const admitted = await acquisition
    await vi.waitFor(() => expect(styleFetch).toHaveBeenCalledWith(OPENFREEMAP_BASEMAPS.positron, expect.anything()))

    controls.releaseMap(admitted)
    resolveStyle(new Response(JSON.stringify(OPENFREEMAP_STYLE), { status: 200 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(hasAnyOpenFreeMapLayer(map)).toBe(false)
    expect(map.remove).toHaveBeenCalledOnce()
  })
})

describe('WorkspaceMapControls Google satellite', () => {
  /**
   * The canvas previously built a static imagery contribution, which cannot
   * serve the official Google path: that path needs a session acquired per
   * generation and an authenticated tile request. The defect this pins is that
   * a configured key was silently ignored on the main Canvas.
   */
  it('follows the official Google session path when a device key is configured', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal('fetch', (async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method })
      if (String(url).includes('createSession')) {
        return new Response(JSON.stringify({
          session: 'fake-session-token',
          expiry: '4000000000',
          tileWidth: 512,
          tileHeight: 512,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        copyright: 'Imagery ©2026 Google',
        maxZoomRects: [{ north: 90, south: -90, east: 180, west: -180, maxZoom: 20 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const { googleMapsApiKey, satelliteSource } = await import('../../app/settings/state')
    satelliteSource.value = 'google_key'
    googleMapsApiKey.value = 'fake-canvas-google-key'

    try {
      const { controls, maps } = createControls()
      const acquisition = controls.createMap(new AbortController().signal, {
        initialCenter: { lat: 48.86, lon: 2.35 },
        background: background({ visible: true }, { visible: true, opacity: 0.8 }),
      })
      const map = await waitForMap(maps)
      map.emit('style.load')
      await acquisition

      await vi.waitFor(() => expect(map.addSource).toHaveBeenCalled())
      // The published template is credential-free and unresolved: the transport
      // supplies the session for this fixed endpoint.
      expect(map.addSource).toHaveBeenLastCalledWith(
        MAPLIBRE_SATELLITE_SOURCE_ID,
        expect.objectContaining({ tiles: [GOOGLE_SESSION_TILES] }),
      )
      // The keyless endpoint would mean the configured key was silently
      // ignored, and the key itself never enters map state.
      expect(JSON.stringify([...map.sources.entries()])).not.toContain('mt1.google.com')
      expect(JSON.stringify([...map.sources.entries()])).not.toContain('fake-canvas-google-key')
      expect(JSON.stringify([...map.layers.entries()])).not.toContain('fake-canvas-google-key')
      // Satellite on hides the Basemap, so no basemap style is requested.
      expect(calls.some((call) => call.url.includes('openfreemap'))).toBe(false)

      // The request the map would make carries the live session and the key.
      const transform = map.options.transformRequest
      expect(transform, 'the canvas map must be created with the request seam').toBeTypeOf('function')
      const outgoing = transform!(
        (map.sources.get(MAPLIBRE_SATELLITE_SOURCE_ID) as { tiles: string[] }).tiles[0]!
          .split('{z}').join('14').split('{x}').join('8192').split('{y}').join('5461'),
      ) as { url: string }
      expect(outgoing.url).toContain('session=fake-session-token')
      expect(outgoing.url).toContain('key=fake-canvas-google-key')
      expect(outgoing.url).not.toContain('{session}')

      // The session request is authenticated too, and the viewport metadata
      // established the attribution the layer shows.
      expect(calls[0]?.url).toContain('createSession')
      expect(calls[0]?.url).toContain('fake-canvas-google-key')
      expect(calls.some((call) => call.url.includes('/viewport'))).toBe(true)
      // The viewport copyright is shown by the map's one attribution control.
      const attributions = [...map.controls] as FakeAttributionControl[]
      expect(attributions).toHaveLength(1)
      expect(attributions[0]?.options?.customAttribution).toBe('Imagery ©2026 Google')
      expect(JSON.stringify(attributions[0]?.options)).not.toContain('fake-canvas-google-key')
    } finally {
      googleMapsApiKey.value = null
      satelliteSource.value = 'free'
    }
  })

  it('shows Google keyless imagery without a session request when no key is set', async () => {
    const { googleMapsApiKey, satelliteSource } = await import('../../app/settings/state')
    googleMapsApiKey.value = null
    satelliteSource.value = 'free'
    const { controls, maps } = createControls({
      background: background({}, { visible: true }),
    })
    const acquisition = controls.createMap(new AbortController().signal)
    const map = await waitForMap(maps)
    map.emit('style.load')
    await acquisition
    await Promise.resolve()

    expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toMatchObject({ tiles: [GOOGLE_KEYLESS_TILES] })
    expect(map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)).toBeDefined()
    expect(styleFetch).not.toHaveBeenCalled()
    expect(map.remove).not.toHaveBeenCalled()
  })

  it('replaces keyless tiles with official session tiles when a key is saved on a live map', async () => {
    // The shared fetch stub answers Google too, so a map another test left
    // alive would show up here as a second session request.
    styleFetch.mockImplementation(async (url) => {
      if (String(url).includes('createSession')) {
        return new Response(JSON.stringify({
          session: 'fake-session-token',
          expiry: '4000000000',
          tileWidth: 256,
          tileHeight: 256,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('googleapis')) {
        return new Response(JSON.stringify({
          copyright: 'Imagery ©2026 Google',
          maxZoomRects: [{ north: 90, south: -90, east: 180, west: -180, maxZoom: 20 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return serveOpenFreeMapStyle()
    })
    const requested = () => styleFetch.mock.calls.map(([url]) => String(url))
    const { googleMapsApiKey, satelliteSource } = await import('../../app/settings/state')
    googleMapsApiKey.value = null
    satelliteSource.value = 'free'
    try {
      const { controls, maps } = createControls()
      const acquisition = controls.createMap(new AbortController().signal)
      const map = await waitForMap(maps)
      map.emit('style.load')
      await acquisition
      expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID)).toMatchObject({ tiles: [GOOGLE_KEYLESS_TILES] })

      satelliteSource.value = 'google_key'
      googleMapsApiKey.value = 'fake-canvas-google-key'

      await vi.waitFor(() => expect(map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID))
        .toMatchObject({ tiles: [GOOGLE_SESSION_TILES] }))
      expect(JSON.stringify([...map.sources.entries()])).not.toContain('fake-canvas-google-key')
      // Only this live map reacts to the saved key: one session, and no map
      // left over from another test requests a style of its own.
      expect(requested().filter((url) => url.includes('createSession'))).toHaveLength(1)
      expect(requested().some((url) => url.includes('openfreemap'))).toBe(false)
      expect(map.remove).not.toHaveBeenCalled()
    } finally {
      googleMapsApiKey.value = null
      satelliteSource.value = 'free'
    }
  })
})
