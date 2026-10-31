// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { googleMapsApiKey, satelliteSource } from '../app/settings/state'
import { createDefaultMapLayers, mapLayers, type MapLayersState } from '../app/map-layers/state'
import { readWorkspaceBackgroundPresentation } from '../app/canvas-map-surface/workspace-activation-snapshot'
import { WorldMapSurface } from '../components/world-map/WorldMapSurface'
import { BasemapTileAuth } from '../maplibre/basemap-tile-auth'
import { MAPLIBRE_SATELLITE_SOURCE_ID } from '../maplibre/config'
import type { MapBackgroundHandle, MapBackgroundOptions } from '../maplibre/map-background'
import { GOOGLE_KEYLESS_TILES } from '../maplibre/satellite-provider'
import type { TemplateMeta } from '../types/community'
import type * as MapBackgroundModule from '../maplibre/map-background'

const maplibreMock = vi.hoisted(() => ({
  mapConstructor: vi.fn(),
  navigationControlConstructor: vi.fn(),
  markerConstructor: vi.fn(),
  boundsConstructor: vi.fn(),
  attributionControlConstructor: vi.fn(),
}))

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'test-map-worker' }))

vi.mock('maplibre-gl', () => ({
  Map: maplibreMock.mapConstructor,
  NavigationControl: maplibreMock.navigationControlConstructor,
  Marker: maplibreMock.markerConstructor,
  LngLatBounds: maplibreMock.boundsConstructor,
  AttributionControl: maplibreMock.attributionControlConstructor,
  setWorkerUrl: vi.fn(),
}))

const acceptanceHttp = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../maplibre/satellite-http.browser', () => ({
  createBrowserSatelliteHttp: () => ({ request: acceptanceHttp.request }),
}))

// The real background owner runs; the spy only records how the surface mounts
// and feeds it, so a regression to a surface-private basemap binder is caught.
const backgroundSpy = vi.hoisted(() => ({
  mounts: [] as Array<{ options: MapBackgroundOptions; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
}))
vi.mock('../maplibre/map-background', async (importOriginal) => {
  const actual = await importOriginal<typeof MapBackgroundModule>()
  return {
    ...actual,
    mountMapBackground: (options: MapBackgroundOptions): MapBackgroundHandle => {
      const handle = actual.mountMapBackground(options)
      const record = {
        options,
        update: vi.fn(handle.update),
        dispose: vi.fn(handle.dispose),
      }
      backgroundSpy.mounts.push(record)
      return { update: record.update, retry: handle.retry, claimMapError: handle.claimMapError, isApplied: handle.isApplied, setAttributionCompact: handle.setAttributionCompact, dispose: record.dispose }
    },
  }
})

/** A one-layer OpenFreeMap style served offline, so no test reaches the network. */
const OFFLINE_VECTOR_STYLE = {
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'water', type: 'fill', source: 'openmaptiles', paint: { 'fill-opacity': 1 } },
  ],
}

function setMapLayers(patch: {
  basemap?: Partial<MapLayersState['basemap']>
  satellite?: Partial<MapLayersState['satellite']>
}): void {
  const current = mapLayers.value
  mapLayers.value = {
    ...current,
    basemap: { ...current.basemap, ...patch.basemap },
    satellite: { ...current.satellite, ...patch.satellite },
  }
}

class FakeWorldMap {
  readonly addControl = vi.fn()
  readonly removeControl = vi.fn()
  readonly container = document.createElement('div')
  readonly remove = vi.fn()
  readonly resize = vi.fn()
  readonly fitBounds = vi.fn()
  readonly flyTo = vi.fn()
  // MapLibre's keyboard handler: Shift+arrows turn and tilt the map unless
  // its rotation is disabled; arrows pan and +/- zoom either way.
  readonly keyboard = {
    rotationDisabled: false,
    disableRotation: vi.fn(() => {
      this.keyboard.rotationDisabled = true
    }),
  }
  // MapLibre's two-finger handler: a pinch zooms, and a twist turns the map unless its rotation is disabled.
  readonly touchZoomRotate = {
    rotationDisabled: false,
    disableRotation: vi.fn(() => {
      this.touchZoomRotate.rotationDisabled = true
    }),
  }
  // The background owner installs the Basemap's vector sources and layers and
  // the Satellite raster on the live map, so a faithful fake implements that
  // narrow surface. A map that cannot be reconciled is not a map this surface
  // can run against.
  readonly sources = new Map<string, Record<string, unknown>>()
  readonly layers = new Map<string, Record<string, unknown>>()
  readonly setLayoutProperty = vi.fn((id: string, name: string, value: unknown) => {
    const layer = this.layers.get(id)
    if (layer && name === 'visibility') {
      layer.layout = { ...(layer.layout as Record<string, unknown>), visibility: value }
    }
  })
  center = { lng: 0, lat: 14 }
  zoom = 1.15
  // A real map exposes its event surface; the provider binding registers a
  // style-ready listener on it, so a fake without one is not a map this surface
  // can run against.
  readonly listeners = new Map<string, Set<(event?: unknown) => void>>()

  constructor(readonly options: Record<string, unknown>) {}

  on(type: string, listener: (event?: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  off(type: string, listener: (event?: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  isStyleLoaded() {
    return true
  }

  getContainer() {
    return this.container
  }

  getBounds() {
    return {
      getWest: () => this.center.lng - 1,
      getEast: () => this.center.lng + 1,
      getSouth: () => this.center.lat - 1,
      getNorth: () => this.center.lat + 1,
    }
  }

  getCenter() {
    return this.center
  }

  getZoom() {
    return this.zoom
  }

  addSource(id: string, source: Record<string, unknown>) {
    this.sources.set(id, source)
  }

  getSource(id: string) {
    return this.sources.get(id)
  }

  removeSource(id: string) {
    this.sources.delete(id)
  }

  addLayer(layer: Record<string, unknown>) {
    this.layers.set(String(layer.id), layer)
  }

  getLayersOrder(): string[] {
    return [...this.layers.keys()]
  }

  readonly setPaintProperty = vi.fn()
  readonly setGlyphs = vi.fn()
  readonly setSprite = vi.fn()
  readonly setGlobalStateProperty = vi.fn()

  getLayer(id: string) {
    return this.layers.get(id)
  }

  removeLayer(id: string) {
    this.layers.delete(id)
  }
}

class FakeMarker {
  readonly remove = vi.fn()
  readonly setLngLat = vi.fn((lngLat: [number, number]) => {
    this.lngLat = lngLat
    return this
  })
  readonly addTo = vi.fn((map: FakeWorldMap) => {
    this.map = map
    return this
  })
  lngLat: [number, number] | null = null
  map: FakeWorldMap | null = null

  constructor(readonly options: { element: HTMLElement }) {}

  getElement(): HTMLElement {
    return this.options.element
  }
}

class FakeBounds {
  readonly points: Array<[number, number]> = []

  extend(lngLat: [number, number]): void {
    this.points.push(lngLat)
  }

  isEmpty(): boolean {
    return this.points.length === 0
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
}

function template(id: string, lon: number, lat: number): TemplateMeta {
  return {
    id,
    title: `Template ${id}`,
    author: 'Canopi',
    description: '',
    location: { lon, lat },
    plant_count: 12,
    climate_zone: 'temperate',
    tags: [],
    screenshot_url: null,
    download_url: `/templates/${id}.canopi`,
  }
}

async function renderWorldMap(
  container: HTMLElement,
  props: {
    templates: TemplateMeta[]
    selectedId: string | null
    onSelect: (template: TemplateMeta) => void
  },
): Promise<void> {
  await act(async () => {
    render(<WorldMapSurface {...props} />, container)
  })
}

describe('WorldMapSurface', () => {
  let container: HTMLDivElement
  let maps: FakeWorldMap[]
  let markers: FakeMarker[]

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver
    FakeResizeObserver.instances = []
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    mapLayers.value = createDefaultMapLayers()
    backgroundSpy.mounts.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(OFFLINE_VECTOR_STYLE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    maps = []
    markers = []
    maplibreMock.mapConstructor.mockReset()
    maplibreMock.navigationControlConstructor.mockReset()
    maplibreMock.markerConstructor.mockReset()
    maplibreMock.boundsConstructor.mockReset()
    maplibreMock.attributionControlConstructor.mockReset()
    maplibreMock.attributionControlConstructor.mockImplementation(function (options: unknown) {
      return { options }
    })
    maplibreMock.mapConstructor.mockImplementation(function (options: Record<string, unknown>) {
      const map = new FakeWorldMap(options)
      maps.push(map)
      return map
    })
    maplibreMock.navigationControlConstructor.mockImplementation(function () {
      return {}
    })
    maplibreMock.markerConstructor.mockImplementation(function (options: { element: HTMLElement }) {
      const marker = new FakeMarker(options)
      markers.push(marker)
      return marker
    })
    maplibreMock.boundsConstructor.mockImplementation(function () {
      return new FakeBounds()
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    mapLayers.value = createDefaultMapLayers()
    vi.unstubAllGlobals()
  })

  it('mounts one map background fed by the map layer store and disposes it with the map', async () => {
    await renderWorldMap(container, { templates: [], selectedId: null, onSelect: vi.fn() })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    await vi.waitFor(() => expect(backgroundSpy.mounts).toHaveLength(1))
    const mount = backgroundSpy.mounts[0]!
    expect(mount.options.map).toBe(maps[0])
    // The credential owner is the one the map was created with, so Google
    // sessions authenticate through this map's own request transform.
    expect(mount.options.tileAuth).toBeInstanceOf(BasemapTileAuth)
    expect(maps[0]!.options.transformRequest).toBe(mount.options.tileAuth.transformRequest)
    expect(mount.update).toHaveBeenLastCalledWith(readWorkspaceBackgroundPresentation())

    act(() => {
      setMapLayers({ basemap: { style: 'dark', opacity: 0.5 } })
    })
    expect(mount.update).toHaveBeenLastCalledWith(readWorkspaceBackgroundPresentation())
    expect(mount.update.mock.lastCall?.[0]).toMatchObject({
      basemap: { style: 'dark', visible: true, opacity: 0.5 },
    })

    act(() => {
      render(null, container)
    })
    expect(mount.dispose).toHaveBeenCalledTimes(1)
    // A disposed background is not fed further store changes.
    const calls = mount.update.mock.calls.length
    act(() => {
      setMapLayers({ basemap: { style: 'positron' } })
    })
    expect(mount.update.mock.calls.length).toBe(calls)
    expect(backgroundSpy.mounts).toHaveLength(1)
  })


  it('handles map errors itself so MapLibre never prints a failed official tile URL with the key', async () => {
    await renderWorldMap(container, { templates: [], selectedId: null, onSelect: vi.fn() })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    // MapLibre prints an error event with no listener through console.error.
    const listeners = [...(maps[0]!.listeners.get('error') ?? [])]
    expect(listeners.length).toBeGreaterThan(0)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const url = 'https://tile.googleapis.com/v1/2dtiles/12/2048/1361?session=SESSIONTOKEN123&key=AIzaSECRETKEY'
    const error = Object.assign(new Error(`AJAXError: Too Many Requests (429): ${url}`), { status: 429, url })
    try {
      for (const listener of listeners) listener({ type: 'error', error, sourceId: 'satellite' })
      const printed = JSON.stringify(consoleError.mock.calls.map((call) => call.map(String)))
      expect(printed).not.toContain('AIzaSECRETKEY')
      expect(printed).not.toContain('SESSIONTOKEN123')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('acceptance: movement refreshes official metadata through the mounted WorldMap caller', async () => {
    const requests: string[] = []
    acceptanceHttp.request.mockImplementation(async (input: { url: string }) => {
      requests.push(input.url)
      const moving = requests.filter(url => url.includes('viewport')).length > 1
      return { ok: true, status: 200, json: input.url.includes('createSession')
        ? { session: 'test-session', expiry: '4000000000', tileWidth: 256, tileHeight: 256 }
        : { copyright: moving ? 'Moved credit' : 'Initial credit', maxZoomRects: [
          { north: 90, south: -90, west: -180, east: 180, maxZoom: moving ? 16 : 18 },
        ] } }
    })
    satelliteSource.value = 'google_key'
    googleMapsApiKey.value = 'synthetic-test-key'
    setMapLayers({ satellite: { visible: true } })
    try {
      await renderWorldMap(container, { templates: [], selectedId: null, onSelect: vi.fn() })
      await vi.waitFor(() => expect(maps).toHaveLength(1))
      const activeMap = maps[0]!
      const readSource = () => activeMap.getSource(MAPLIBRE_SATELLITE_SOURCE_ID) as { maxzoom: number } | undefined
      const readCredit = () => {
        const options = maplibreMock.attributionControlConstructor.mock.lastCall?.[0] as
          | { customAttribution?: string }
          | undefined
        return options?.customAttribution
      }
      // Healthy control: the real provider/session/binding have installed the initial metadata.
      await vi.waitFor(() => expect(readSource()?.maxzoom).toBe(18))
      expect(readCredit()).toBe('Initial credit')
      const before = requests.filter(url => url.includes('viewport')).length
      activeMap.center = { lng: 22, lat: 30 }
      activeMap.zoom = 12
      activeMap.listeners.get('moveend')?.forEach(listener => listener())
      await vi.waitFor(() => expect(requests.filter(url => url.includes('viewport')).length).toBeGreaterThan(before))
      await vi.waitFor(() => expect(readSource()?.maxzoom).toBe(16))
      // The viewport copyright lives on the map's one attribution control, not
      // on the tile source, and it follows the move.
      expect(readCredit()).toBe('Moved credit')
      // The key and session reach tile requests through the transport only.
      expect(JSON.stringify(readSource())).not.toContain('synthetic-test-key')
      expect(JSON.stringify(readSource())).not.toContain('test-session')
      expect(maplibreMock.mapConstructor).toHaveBeenCalledTimes(1)
    } finally {
      render(null, container)
      googleMapsApiKey.value = null
      satelliteSource.value = 'free'
    }
  })

  it('renders template markers, fits their bounds, selects markers, flies to selection, and resizes through the host', async () => {
    const first = template('forest', 2.35, 48.85)
    const second = template('orchard', 13.4, 52.52)
    const onSelect = vi.fn()

    await renderWorldMap(container, {
      templates: [first, second],
      selectedId: null,
      onSelect,
    })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    await vi.waitFor(() => expect(markers).toHaveLength(2))

    expect(maps[0]!.options).toMatchObject({
      pitchWithRotate: false,
      dragRotate: false,
      // Shift+drag pans like any drag: no box zoom (spec §4.17).
      boxZoom: false,
    })
    expect(maplibreMock.navigationControlConstructor).toHaveBeenCalledWith({
      visualizePitch: false,
      showCompass: false,
      showZoom: true,
    })
    expect(markers[0]!.lngLat).toEqual([2.35, 48.85])
    expect(markers[1]!.lngLat).toEqual([13.4, 52.52])
    expect(maps[0]!.fitBounds).toHaveBeenCalledWith(
      expect.objectContaining({ points: [[2.35, 48.85], [13.4, 52.52]] }),
      { padding: 48, maxZoom: 4.5, duration: 0 },
    )

    markers[1]!.getElement().click()
    expect(onSelect).toHaveBeenCalledWith(second)

    await renderWorldMap(container, {
      templates: [first, second],
      selectedId: 'orchard',
      onSelect,
    })
    await vi.waitFor(() => expect(markers).toHaveLength(4))
    const latestMarkers = markers.slice(-2)
    expect(latestMarkers[1]!.getElement().className).not.toBe(latestMarkers[0]!.getElement().className)
    expect(maps[0]!.flyTo).toHaveBeenCalledWith(expect.objectContaining({
      center: [13.4, 52.52],
      zoom: 4.5,
    }))

    maps[0]!.resize.mockClear()
    act(() => {
      FakeResizeObserver.instances[0]?.callback([], {} as ResizeObserver)
    })
    expect(maps[0]!.resize).toHaveBeenCalled()
  })

  it('selecting a template flies to it, from the fixed world view the map always starts at', async () => {
    const first = template('forest', 2.35, 48.85)
    const second = template('orchard', 13.4, 52.52)

    // A template selected before the map exists: the new map starts at the world view and flies to it.
    await renderWorldMap(container, { templates: [first, second], selectedId: 'forest', onSelect: vi.fn() })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    await vi.waitFor(() => expect(maps[0]!.flyTo).toHaveBeenCalled())
    expect(maps[0]!.options).toMatchObject({ center: [0, 14], zoom: 1.15 })
    expect(maps[0]!.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [2.35, 48.85], zoom: 4.5 }))

    await renderWorldMap(container, { templates: [first, second], selectedId: 'orchard', onSelect: vi.fn() })
    expect(maps[0]!.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [13.4, 52.52], zoom: 4.5 }))
    expect(maps).toHaveLength(1)
  })

  it('Shift+arrow keys do not turn or tilt the World map', async () => {
    await renderWorldMap(container, { templates: [], selectedId: null, onSelect: vi.fn() })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    // The keyboard handler stays on for arrow pans and +/- zoom; only its
    // Shift+arrow turn and tilt are off, so the World map stays north-up.
    expect(maps[0]!.options.keyboard).not.toBe(false)
    expect(maps[0]!.keyboard.rotationDisabled).toBe(true)
  })

  it('a pinch zooms the World map, which a twist never turns and two fingers never tilt', async () => {
    await renderWorldMap(container, { templates: [], selectedId: null, onSelect: vi.fn() })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    // On a phone a pinch over the map zooms the map, not the page; the map stays north-up (spec §4.17).
    expect(maps[0]!.options.touchZoomRotate).not.toBe(false)
    expect(maps[0]!.touchZoomRotate.rotationDisabled).toBe(true)
    // Two fingers sliding up together would tilt it, and nothing on the World map resets a tilt.
    expect(maps[0]!.options).toMatchObject({ touchPitch: false })
  })

  it('switches between Basemap and Satellite on the live map instead of rebuilding it', async () => {
    const templates = [template('forest', 2.35, 48.85)]

    await renderWorldMap(container, {
      templates,
      selectedId: null,
      onSelect: vi.fn(),
    })
    await vi.waitFor(() => expect(maps).toHaveLength(1))
    const markersBefore = markers.length
    const map = maps[0]!
    // The default Basemap is the OpenFreeMap vector style, installed onto the
    // live map rather than through `setStyle()`.
    await vi.waitFor(() => expect(map.sources.has('ofm-openmaptiles')).toBe(true))
    expect(map.layers.has('ofm:water')).toBe(true)
    map.center = { lng: -74.006, lat: 40.7128 }
    map.zoom = 6

    act(() => {
      setMapLayers({ satellite: { visible: true } })
    })

    // Satellite on hides the Basemap and shows keyless Google imagery. The
    // product contract forbids `setStyle()` and map recreation on a layer
    // change, so the map, camera and markers stay exactly as they were.
    await vi.waitFor(() => expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(true))
    expect((map.getSource(MAPLIBRE_SATELLITE_SOURCE_ID) as { tiles: string[] }).tiles)
      .toEqual([GOOGLE_KEYLESS_TILES])
    expect(map.sources.has('ofm-openmaptiles')).toBe(false)
    expect(map.layers.has('ofm:water')).toBe(false)

    // Satellite off restores the Basemap.
    act(() => {
      setMapLayers({ satellite: { visible: false } })
    })
    await vi.waitFor(() => expect(map.sources.has('ofm-openmaptiles')).toBe(true))

    expect(maps).toHaveLength(1)
    expect(maplibreMock.mapConstructor).toHaveBeenCalledTimes(1)
    expect(map.remove).not.toHaveBeenCalled()
    expect(map.getCenter()).toEqual({ lng: -74.006, lat: 40.7128 })
    expect(map.getZoom()).toBe(6)
    expect(markers).toHaveLength(markersBefore)
  })
})
