// @vitest-environment jsdom

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { effect, signal } from '@preact/signals'
import { googleMapsApiKey, satelliteSource } from '../app/settings/state'
import { readSatelliteConfig } from '../app/settings/satellite-config'
import { MAPLIBRE_SATELLITE_LAYER_ID, MAPLIBRE_SATELLITE_SOURCE_ID } from '../maplibre/config'
import { BasemapTileAuth } from '../maplibre/basemap-tile-auth'
import { mountMapBackground, type MapBackgroundMap, type MapBackgroundPresentation } from '../maplibre/map-background'
import type { VectorStyleDocument } from '../maplibre/openfreemap-basemap'
import { GOOGLE_KEYLESS_TILES } from '../maplibre/satellite-provider'

const STYLE: VectorStyleDocument = {
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [{ id: 'water', type: 'fill', source: 'openmaptiles', paint: {} }],
}

class FakeControl {
  constructor(readonly options: { compact?: boolean; customAttribution?: string }) {}
}

function createMap() {
  const sources = new Map<string, Record<string, unknown>>()
  const layers: Record<string, unknown>[] = [{ id: 'basemap-background' }, { id: 'canopi-scene' }]
  const controls: FakeControl[] = []
  // MapLibre's attribution markup, as a compact control first renders it (shown).
  const container = document.createElement('div')
  const credits = document.createElement('details')
  credits.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show'
  credits.setAttribute('open', '')
  container.append(credits)
  const map = {
    credits,
    getContainer: () => container,
    sources,
    layers,
    controls,
    isStyleLoaded: () => true,
    getLayersOrder: () => layers.map((layer) => String(layer.id)),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: Record<string, unknown>) => { sources.set(id, source) },
    removeSource: (id: string) => { sources.delete(id) },
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: (layer: Record<string, unknown>, beforeId?: string) => {
      const index = beforeId ? layers.findIndex((entry) => entry.id === beforeId) : layers.length
      layers.splice(index < 0 ? layers.length : index, 0, { ...layer })
    },
    removeLayer: (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id)
      if (index >= 0) layers.splice(index, 1)
    },
    setPaintProperty: (id: string, name: string, value: unknown) => {
      const layer = layers.find((entry) => entry.id === id) as { paint?: Record<string, unknown> }
      layer.paint = { ...layer.paint, [name]: value }
    },
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const layer = layers.find((entry) => entry.id === id) as { layout?: Record<string, unknown> }
      layer.layout = { ...layer.layout, [name]: value }
    },
    setGlyphs: vi.fn(),
    setSprite: vi.fn(),
    setGlobalStateProperty: vi.fn(),
    getZoom: () => 16,
    getBounds: () => ({ getWest: () => 2.35, getSouth: () => 48.85, getEast: () => 2.36, getNorth: () => 48.86 }),
    addControl: (control: FakeControl) => { controls.push(control) },
    removeControl: (control: FakeControl) => {
      const index = controls.indexOf(control)
      if (index >= 0) controls.splice(index, 1)
    },
  }
  return map
}

function presentation(overrides: Partial<{
  basemapVisible: boolean
  satelliteVisible: boolean
}> = {}): MapBackgroundPresentation {
  return {
    basemap: { style: 'liberty', visible: overrides.basemapVisible ?? true, opacity: 1 },
    satellite: { visible: overrides.satelliteVisible ?? false, opacity: 0.7 },
    locale: 'en',
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(map = createMap()) {
  const background = mountMapBackground({
    map,
    maplibre: { AttributionControl: FakeControl },
    tileAuth: new BasemapTileAuth(),
    readSatelliteConfig,
    lifetime: { on: () => {}, off: () => {} },
    loadStyle: async () => STYLE,
  })
  return { map, background }
}

const ids = (map: ReturnType<typeof createMap>) => map.layers.map((layer) => String(layer.id))

afterEach(() => {
  googleMapsApiKey.value = null
  satelliteSource.value = 'free'
  vi.unstubAllGlobals()
})

describe('map background band', () => {
  // Every surface hands the band a MapLibre map; the band calls the methods it adds to the Basemap's and Satellite's own
  // with no fallback for a missing one.
  it('calls only methods a MapLibre map has', async () => {
    type BandMethods = 'getLayersOrder' | 'setPaintProperty' | 'isStyleLoaded' | 'getBounds' | 'getZoom' | 'addControl' | 'removeControl' | 'getContainer'
    expectTypeOf<MapLibreMap>().toExtend<Pick<MapBackgroundMap, BandMethods>>()
    // And the Map class MapLibre ships has each of them at run time.
    const { Map: MapLibreClass } = await import('maplibre-gl')
    const methods: readonly BandMethods[] = ['getLayersOrder', 'setPaintProperty', 'isStyleLoaded', 'getBounds', 'getZoom', 'addControl', 'removeControl', 'getContainer']
    expect(methods.filter((method) => typeof MapLibreClass.prototype[method] !== 'function')).toEqual([])
  })

  it('installs the OpenFreeMap basemap beneath Canopi layers with one attribution control', async () => {
    const { map, background } = mount()
    background.update(presentation())
    await settle()
    expect(ids(map)).toEqual(['basemap-background', 'ofm:water', 'canopi-scene'])
    expect(map.controls).toHaveLength(1)
    background.dispose()
    expect(map.controls).toHaveLength(0)
    expect(ids(map)).toEqual(['basemap-background', 'canopi-scene'])
  })

  it('hides the Basemap while Satellite is on and restores it when Satellite is off', async () => {
    const { map, background } = mount()
    background.update(presentation())
    await settle()
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(ids(map)).toEqual(['basemap-background', MAPLIBRE_SATELLITE_LAYER_ID, 'canopi-scene'])
    expect(map.sources.get(MAPLIBRE_SATELLITE_SOURCE_ID)?.tiles).toEqual([GOOGLE_KEYLESS_TILES])
    expect((map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID) as { paint: Record<string, unknown> }).paint['raster-opacity']).toBe(0.7)
    background.update(presentation())
    await settle()
    expect(ids(map)).toEqual(['basemap-background', 'ofm:water', 'canopi-scene'])
    expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(false)
  })

  it('serves Google keyless tiles with Google credit when no device key is set', async () => {
    const { map, background } = mount()
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(map.sources.get(MAPLIBRE_SATELLITE_SOURCE_ID)?.tiles).toEqual([GOOGLE_KEYLESS_TILES])
    expect(ids(map)).toEqual(['basemap-background', MAPLIBRE_SATELLITE_LAYER_ID, 'canopi-scene'])
    expect(String(map.controls[0]!.options.customAttribution ?? '')).toContain('Google')
  })

  it('withdraws keyless tiles when a device key is saved while Satellite is on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    const { map, background } = mount()
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(map.sources.get(MAPLIBRE_SATELLITE_SOURCE_ID)?.tiles).toEqual([GOOGLE_KEYLESS_TILES])

    // The key reaches the live mount through its settings observer, with no
    // presentation change and no map recreation.
    satelliteSource.value = 'google_key'
    googleMapsApiKey.value = 'SECRET-KEY'
    await settle()
    expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(false)
    background.dispose()
  })

  // A surface applies its presentation inside its own effect (WorldMapSurface); the band reads the Google key while it
  // starts Satellite, and that read must not subscribe the surface: only the band's settings observer follows the key.
  it('does not subscribe the effect that applies a presentation to the Google key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    const { background } = mount()
    let runs = 0
    const stop = effect(() => {
      runs += 1
      background.update(presentation({ satelliteVisible: true }))
    })
    await settle()
    satelliteSource.value = 'google_key'
    googleMapsApiKey.value = 'SECRET-KEY'
    await settle()
    expect(runs).toBe(1)
    stop()
    background.dispose()
  })

  it('keeps the free imagery while a saved key is not the chosen source, and switches on choosing it', async () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 403 }))
    vi.stubGlobal('fetch', fetchStub)
    satelliteSource.value = 'free'
    googleMapsApiKey.value = 'SECRET-KEY'
    const { map, background } = mount()
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(map.sources.get(MAPLIBRE_SATELLITE_SOURCE_ID)?.tiles).toEqual([GOOGLE_KEYLESS_TILES])
    expect(fetchStub).not.toHaveBeenCalled()

    satelliteSource.value = 'google_key'
    await settle()
    expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(false)
    expect(fetchStub).toHaveBeenCalled()
    background.dispose()
  })

  it('reports whether the latest presentation is on the map', async () => {
    const { map, background } = mount()
    expect(background.isApplied()).toBe(false)
    background.update(presentation())
    expect(background.isApplied()).toBe(false)
    await settle()
    expect(background.isApplied()).toBe(true)
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(background.isApplied()).toBe(true)
    map.removeLayer(MAPLIBRE_SATELLITE_LAYER_ID)
    expect(background.isApplied()).toBe(false)
    background.update(presentation({ basemapVisible: false }))
    await settle()
    expect(background.isApplied()).toBe(true)
    background.dispose()
    expect(background.isApplied()).toBe(false)
  })

  it('keeps the credits expanded: the attribution control collapses only on a narrow map', async () => {
    const { map, background } = mount()
    background.update(presentation())
    await settle()
    // compact: true would fold the credits into an (i) after the first drag;
    // left unset, MapLibre folds them only when the map is 640 px or narrower.
    expect(map.controls[0]!.options.compact).toBeUndefined()
    background.dispose()
  })

  it('folds the credits into the (i) button when the workspace asks, and unfolds them again', async () => {
    const { map, background } = mount()
    background.update(presentation())
    await settle()
    background.setAttributionCompact(true)
    expect(map.controls).toHaveLength(1)
    expect(map.controls[0]!.options.compact).toBe(true)
    // Folded, not merely compact: the credits wait behind the button.
    expect(map.credits.classList.contains('maplibregl-compact-show')).toBe(false)

    background.setAttributionCompact(true)
    expect(map.controls).toHaveLength(1)
    background.setAttributionCompact(false)
    expect(map.controls).toHaveLength(1)
    expect(map.controls[0]!.options.compact).toBe(false)

    // A Google credit remounts the control; it keeps the fold.
    background.setAttributionCompact(true)
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(map.controls[0]!.options).toMatchObject({ compact: true, customAttribution: '&copy; Google' })
    background.dispose()
  })

  it('folds the credits once MapLibre makes them compact, when the first credits arrive after mounting', async () => {
    const map = createMap()
    map.credits.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-attrib-empty'
    const { background } = mount(map)
    background.setAttributionCompact(true)
    map.credits.classList.add('maplibregl-compact', 'maplibregl-compact-show')
    await settle()
    expect(map.credits.classList.contains('maplibregl-compact')).toBe(true)
    expect(map.credits.classList.contains('maplibregl-compact-show')).toBe(false)
    // After that the (i) button is the user's: showing the credits sticks.
    map.credits.classList.add('maplibregl-compact-show')
    await settle()
    expect(map.credits.classList.contains('maplibregl-compact-show')).toBe(true)
    background.dispose()
  })

  it('reports a Basemap that failed to load until Satellite hides it', async () => {
    const statuses: string[] = []
    const background = mountMapBackground({
      map: createMap(),
      maplibre: { AttributionControl: FakeControl },
      tileAuth: new BasemapTileAuth(),
      readSatelliteConfig,
      lifetime: { on: () => {}, off: () => {} },
      loadStyle: async () => { throw new Error('Basemap style request failed (503).') },
      onBasemapStatus: (status) => statuses.push(status),
    })
    background.update(presentation())
    await settle()
    expect(statuses).toEqual(['loading', 'failed'])

    // Satellite's free imagery is ready at once: its status replaces the Basemap's failure.
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(statuses).toEqual(['loading', 'failed', 'ok'])
    background.dispose()
  })

  // The workspace sends its presentation again whenever the view or the visible map area changes; offline, each resend
  // downloaded the style again and flickered the notice between loading and failed (ADR 0004: only Retry downloads).
  it('downloads nothing again for the same presentation after a failed Basemap; Retry downloads it again', async () => {
    const statuses: string[] = []
    const loadStyle = vi.fn(async () => { throw new Error('Basemap style request failed (503).') })
    const background = mountMapBackground({
      map: createMap(),
      maplibre: { AttributionControl: FakeControl },
      tileAuth: new BasemapTileAuth(),
      readSatelliteConfig,
      lifetime: { on: () => {}, off: () => {} },
      loadStyle,
      onBasemapStatus: (status) => statuses.push(status),
    })
    background.update(presentation())
    await settle()
    background.update(presentation())
    background.update(presentation())
    await settle()
    expect(loadStyle).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['loading', 'failed'])

    background.retry(presentation())
    await settle()
    expect(loadStyle).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['loading', 'failed', 'loading', 'failed'])
    background.dispose()
  })

  describe('Satellite with a Google key (canopi-k94s)', () => {
    const VIEWPORT_ANSWER = { copyright: 'Imagery ©2026 Google', maxZoomRects: [{ maxZoom: 21, north: 90, south: -90, east: 180, west: -180 }] }

    /** The band with a status log, Satellite on the device key, and a Google that answers with `respond`. */
    function mountKeyed(respond: (url: string) => Response) {
      satelliteSource.value = 'google_key'
      googleMapsApiKey.value = 'SECRET-KEY'
      const requests: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requests.push(url)
        return respond(url)
      }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const statuses: string[] = []
      const map = createMap()
      const background = mountMapBackground({
        map,
        maplibre: { AttributionControl: FakeControl },
        tileAuth: new BasemapTileAuth(),
        readSatelliteConfig,
        lifetime: { on: () => {}, off: () => {} },
        loadStyle: async () => STYLE,
        onBasemapStatus: (status) => statuses.push(status),
      })
      return { map, background, statuses, requests }
    }
    const rejected = () => new Response('{}', { status: 403 })
    const sessions = (url: string) => url.includes('createSession')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const google = (url: string) => sessions(url)
      ? json({ session: 'S', expiry: '9999999999', tileWidth: 256 })
      : json(VIEWPORT_ANSWER)

    afterEach(() => { vi.restoreAllMocks() })

    it('reports a rejected key as a failed background, loading first, and never the hidden Basemap\'s idle', async () => {
      const { background, statuses } = mountKeyed(rejected)
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('failed'))
      expect(statuses).toEqual(['loading', 'failed'])
      background.dispose()
    })

    it('keeps the failure through an opacity change, which downloads nothing', async () => {
      const { background, statuses, requests } = mountKeyed(rejected)
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('failed'))
      const asked = requests.length
      background.update({ ...presentation({ satelliteVisible: true }), satellite: { visible: true, opacity: 0.4 } })
      await settle()
      expect(statuses).toEqual(['loading', 'failed'])
      expect(requests).toHaveLength(asked)
      background.dispose()
    })

    it('Retry opens a new Google session and the imagery comes back', async () => {
      let answer = rejected as (url: string) => Response
      const { map, background, statuses, requests } = mountKeyed((url) => answer(url))
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('failed'))
      answer = google
      background.retry(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('ok'))
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ok'])
      expect(requests.filter(sessions)).toHaveLength(2)
      expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(true)
      background.dispose()
    })

    // A saved-view capture calls retry() on every frame: imagery that is showing must not blank while a new session opens.
    it('Retry leaves Satellite imagery that is showing alone', async () => {
      const { background, statuses, requests } = mountKeyed(google)
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('ok'))
      const asked = requests.length
      background.retry(presentation({ satelliteVisible: true }))
      await settle()
      expect(statuses).toEqual(['loading', 'ok'])
      expect(requests).toHaveLength(asked)
      background.dispose()
    })

    // A saved-view capture waits for isApplied(): a hidden layer while a new Google session opens is no imagery yet.
    it('is not applied while Satellite loads, even with its layer still installed (hidden)', async () => {
      let answer: (url: string) => Promise<Response> = async (url) => google(url)
      const { map, background, statuses } = mountKeyed((url) => answer(url) as unknown as Response)
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('ok'))
      expect(background.isApplied()).toBe(true)
      // Google holds every answer until released.
      let open = () => {}
      const opened = new Promise<void>((resolve) => { open = resolve })
      answer = async (url) => {
        await opened
        return google(url)
      }
      googleMapsApiKey.value = 'OTHER-KEY'
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('loading'))
      expect(map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)).toBeDefined()
      expect(background.isApplied()).toBe(false)
      open()
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('ok'))
      expect(background.isApplied()).toBe(true)
      background.dispose()
    })

    it('gives the Basemap\'s status back when Satellite is turned off', async () => {
      const { background, statuses } = mountKeyed(rejected)
      background.update(presentation({ satelliteVisible: true }))
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('failed'))
      background.update(presentation())
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('ok'))
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ok'])
      background.dispose()
    })
  })

  it('adds no remote source when every background row is hidden', async () => {
    const { map, background } = mount()
    background.update(presentation({ basemapVisible: false }))
    await settle()
    expect(map.sources.size).toBe(0)
  })

  it('credits Google through the single attribution control', async () => {
    const { map, background } = mount()
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    expect(map.controls).toHaveLength(1)
    expect(map.controls[0]!.options.customAttribution).toBe('&copy; Google')
    background.update(presentation())
    await settle()
    expect(map.controls).toHaveLength(1)
    expect(map.controls[0]!.options.customAttribution).toBeUndefined()
  })

  it('never puts the Google key into map state', async () => {
    satelliteSource.value = 'google_key'
    googleMapsApiKey.value = 'SECRET-KEY'
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ session: 'S', expiry: '9999999999' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { map, background } = mount()
    const seen = signal('')
    background.update(presentation({ satelliteVisible: true }))
    await settle()
    seen.value = JSON.stringify([...map.sources.entries(), map.layers, map.controls.map((control) => control.options)])
    expect(seen.value).not.toContain('SECRET-KEY')
    background.dispose()
  })
})
