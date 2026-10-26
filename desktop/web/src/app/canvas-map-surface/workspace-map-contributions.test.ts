// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDefaultScenePersistedState } from '../../canvas/runtime/scene'
import type { MapLibreApi, MapLibreMapInstance } from '../../maplibre/loader'
import { IDLE_MAPLIBRE_CANVAS_SURFACE_STATE, type MapLibreCanvasSurfaceState } from '../../maplibre/canvas-surface-state'
import type { TerrainProtocolSupport } from '../../maplibre/terrain'
import { WorkspaceMapContributions } from './workspace-map-contributions'
import { createDesktopWorkspaceMapContributionAdapter } from './desktop-workspace-map-contribution-adapter'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { designSessionStore } from '../document-session/store'
import { activePanel, selectPanel, sidePanel } from '../shell/state'
import { endSiteDataTransients, setPin, setProfileLine } from '../lidar/site-transients'
import type { CanopiFile } from '../../types/design'
import { signal } from '@preact/signals'
import { createWorkspaceRuntimeComposition } from './workspace-runtime-composition'
import { createDetachedCanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { createDetachedSceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import type { SharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import type { WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'
import type { RasterDisplay, RasterDisplayLayer } from '../../maplibre/raster-display/adapter'
import type { SiteMapOverlay } from '../../maplibre/site-overlay'
import type { UserLocationReading } from '../../maplibre/user-location-overlay'
import { setStoryPresentationHidesEditingAids } from '../story-presentation/overrides'
import type * as SiteOverlayModule from '../../maplibre/site-overlay'

// Stream C draws the pin and line; here a pin draws as one point in two layers, so the site route can be seen and broken.
vi.mock('../../maplibre/site-overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof SiteOverlayModule>()
  const { sourceId } = actual.siteMapOverlayIds()
  return {
    ...actual,
    siteMapOverlayContract: (site: SiteMapOverlay | null) => ({
      source: {
        id: sourceId, type: 'geojson',
        data: { type: 'FeatureCollection', features: site?.pin ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: site.pin }, properties: { role: 'pin' } }] : [] },
      },
      layers: ['site-pin-ring', 'site-pin-core'].map((id) => ({ id, source: sourceId, type: 'circle', filter: ['==', ['get', 'role'], 'pin'], paint: { 'circle-radius': 6 } })),
      hasRenderableFeatures: Boolean(site?.pin),
    }),
    siteHoverOverlayContract: (hover: readonly [number, number] | null) => ({
      source: {
        id: actual.siteMapOverlayIds().hover.sourceId, type: 'geojson',
        data: { type: 'FeatureCollection', features: hover ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: hover }, properties: {} }] : [] },
      },
      layers: [{ id: 'site-hover-ring', source: actual.siteMapOverlayIds().hover.sourceId, type: 'circle', paint: { 'circle-radius': 5 } }],
      hasRenderableFeatures: hover !== null,
    }),
  }
})

class ContributionMap implements MapLibreMapInstance {
  readonly sources = new Map<string, { setData(data: unknown): void }>()
  readonly order: string[] = ['basemap-background', 'basemap-raster', 'canopi-shared-scene']
  readonly listeners = new Map<string, Set<() => void>>()
  readonly jumpTo = vi.fn()
  readonly resize = vi.fn()
  readonly remove = vi.fn()
  readonly addSource = vi.fn((id: string, _source: Record<string, unknown>) => { this.sources.set(id, { setData: vi.fn() }) })
  readonly getSource = vi.fn((id: string) => this.sources.get(id))
  readonly removeSource = vi.fn((id: string) => { this.sources.delete(id) })
  readonly addLayer = vi.fn((layer: Record<string, unknown>) => { this.order.push(String(layer.id)) })
  readonly getLayer = vi.fn((id: string) => this.order.includes(id) ? { id } : undefined)
  readonly removeLayer = vi.fn((id: string) => { const i = this.order.indexOf(id); if (i >= 0) this.order.splice(i, 1) })
  readonly getLayersOrder = vi.fn(() => [...this.order])
  readonly moveLayer = vi.fn((id: string, before?: string) => {
    const i = this.order.indexOf(id)
    if (i < 0) return
    this.order.splice(i, 1)
    const target = before ? this.order.indexOf(before) : -1
    this.order.splice(target < 0 ? this.order.length : target, 0, id)
  })
  readonly setPaintProperty = vi.fn()
  on(type: string, listener: () => void) { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners) }
  off(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener) }
}

const terrainSupport: TerrainProtocolSupport = {
  sharedDemProtocolUrl: 'dem://tiles', contourProtocolUrl: () => 'contour://tiles',
}

function layer(id = 'lidar-a', overrides: Partial<RasterDisplayLayer> = {}): RasterDisplayLayer {
  return { id, name: id, opacity: 1, assets: [{ url: `asset://localhost/${id}.tif`, bbox: [1, 2, 3, 4] }], bounds: [1, 2, 3, 4], rescale: [0, 10], colormap: 'terrain', reversed: false, ...overrides }
}

/** Records what the contributions ask of the renderer; adds map layers on demand like the engine. */
class FakeRasterDisplay implements RasterDisplay {
  readonly syncs: { ids: string[]; beforeId: string | undefined }[] = []
  disposed = false
  disposeCalls = 0
  added: string[] = []
  syncError: Error | null = null
  constructor(readonly map: ContributionMap, readonly onLayersChanged: () => void) {}
  sync(layers: readonly RasterDisplayLayer[], beforeId: string | undefined) {
    if (this.syncError) throw this.syncError
    this.syncs.push({ ids: layers.map((candidate) => candidate.id), beforeId })
  }
  /** Simulate the engine adding a layer after its header loaded (drawn on top). */
  arrive(id: string) {
    this.map.order.push(id)
    this.added.push(id)
    this.onLayersChanged()
  }
  layerIds() { return this.added.filter((id) => this.map.order.includes(id)) }
  dispose() { this.disposed = true; this.disposeCalls += 1 }
}

function snapshot(identity: object, overrides: Partial<WorkspaceMapContributionSnapshot> = {}): WorkspaceMapContributionSnapshot {
  const scene = createDefaultScenePersistedState()
  scene.zones = [{ kind: 'zone', locked: false, id: 'plot', name: 'plot', zoneType: 'polygon', rotationDeg: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], fillColor: null, notes: null }]
  return {
    sessionIdentity: identity,
    lidar: [layer()],
    terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
    overlays: { runtime: { getSceneSnapshot: () => scene }, location: { lat: 48, lon: 2 }, hoveredTargets: [{ kind: 'zone', zone_id: 'plot' }], selectedTargets: [], site: null },
    ...overrides,
  }
}

/** A composition feed: the latest value, pushed to the attached contributions outside the drain. */
function feed<T>(initial: T) {
  let current = initial
  const listeners = new Set<(value: T) => void>()
  return {
    current: () => current,
    subscribe(listener: (value: T) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(value: T) {
      current = value
      for (const listener of listeners) listener(value)
    },
    listeners,
  }
}

/** The composition's hover feed: the chart cursor's ground point, pushed at scrub rate. */
function hoverFeed() {
  return feed<readonly [number, number] | null>(null)
}

/** The composition's user location feed: the session's reading, hidden during a story presentation. */
function locationFeed() {
  return feed<UserLocationReading | null>(null)
}

function fixture(loadTerrainSupport = vi.fn(async () => terrainSupport), siteHover = hoverFeed(), userLocation = locationFeed()) {
  const identity = {}
  const map = new ContributionMap()
  const states: MapLibreCanvasSurfaceState[] = []
  const logError = vi.fn()
  const failure = vi.fn()
  let active = true
  let raster!: FakeRasterDisplay
  const manager = new WorkspaceMapContributions({
    onFailure: failure, loadTerrainSupport, onStateChange: (state) => states.push(state), logError, siteHover, userLocation,
    createRasterDisplay: (_map, options) => { raster = new FakeRasterDisplay(map, options.onLayersChanged!); return raster },
  })
  manager.attach({ map, maplibre: {} as MapLibreApi, lifetime: { on() {}, off() {}, addCleanup() {} }, isCurrent: () => active })
  return { identity, map, states, failure, manager, loadTerrainSupport, logError, raster, siteHover, userLocation, expire: () => { active = false } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function withSite(input: WorkspaceMapContributionSnapshot, pin: readonly [number, number] | null): WorkspaceMapContributionSnapshot {
  return { ...input, overlays: { ...input.overlays, site: { pin, profileLine: null } } }
}

async function flush() { await Promise.resolve(); await Promise.resolve() }

describe('WorkspaceMapContributions', () => {
  it.each([
    ['rebuild', 'removeLayer'], ['rebuild', 'removeSource'],
    ['source error', 'removeLayer'], ['source error', 'removeSource'],
  ] as const)('fails hard when terrain %s rollback cannot %s', async (reason, removeMethod) => {
    const f = fixture()
    const input = snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } })
    f.manager.update(input)
    if (reason === 'source error') {
      f.manager.admitStyle()
      await flush()
    } else {
      const add = f.map.addLayer.getMockImplementation()!
      f.map.addLayer.mockImplementation((candidate) => {
        add(candidate)
        if (candidate.id === 'hillshade-layer') throw new Error('partial terrain add')
      })
    }
    const cleanup = new Error(`terrain ${removeMethod} failed`)
    const remove = f.map[removeMethod].getMockImplementation()!
    f.map[removeMethod].mockImplementation((id) => {
      if (id === 'hillshade-layer' || id === 'terrain-dem') throw cleanup
      remove(id)
    })
    if (reason === 'rebuild') f.manager.admitStyle()
    else f.manager.handleMapError({ sourceId: 'terrain-dem', error: new Error('terrain tile failed') })
    await flush()
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(cleanup)
    expect(f.states.at(-1)).toMatchObject({ status: 'error', terrainStatus: 'idle' })
    const mutations = f.map.addSource.mock.calls.length
    f.manager.update(input)
    f.manager.admitStyle()
    await flush()
    expect(f.map.addSource).toHaveBeenCalledTimes(mutations)
    expect(f.failure).toHaveBeenCalledOnce()
  })

  it.each([
    ['order', 'initial'], ['order', 'live'],
  ] as const)('fails once for %s failure during %s work and fences subsequent updates', (kind, phase) => {
    const f = fixture()
    const input = snapshot(f.identity)
    // The renderer already drew its layer on top; the band must be reordered.
    f.raster.added.push('lidar-a')
    f.map.order.push('lidar-a')
    f.manager.update(input)
    if (phase === 'live') f.manager.admitStyle()
    const error = new Error(`${kind} failed`)
    f.map.moveLayer.mockImplementation(() => { throw error })
    if (phase === 'live') f.map.order.reverse()
    if (phase === 'live') f.manager.update(input)
    else f.manager.admitStyle()
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(f.states.at(-1)).toMatchObject({ status: 'error', terrainStatus: 'idle' })
    expect(f.map.sources.size).toBe(0)
    const mutations = f.map.addSource.mock.calls.length
    f.manager.update(input)
    f.manager.admitStyle()
    f.manager.dispose()
    expect(f.failure).toHaveBeenCalledOnce()
    expect(f.map.addSource).toHaveBeenCalledTimes(mutations)
    expect(f.states.at(-1)?.status).toBe('error')
  })

  it('treats ordering after an async terrain rebuild as a hard failure', async () => {
    const pending = deferred<TerrainProtocolSupport>()
    const f = fixture(vi.fn(() => pending.promise))
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    const error = new Error('terrain ordering failed')
    f.map.moveLayer.mockImplementation(() => { throw error })
    pending.resolve(terrainSupport)
    await flush()
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(f.states.at(-1)).toMatchObject({ status: 'error', terrainStatus: 'idle' })
  })

  it('keeps terrain source construction failures passive', async () => {
    const f = fixture()
    const add = f.map.addSource.getMockImplementation()!
    f.map.addSource.mockImplementation((id, source) => {
      if (id === 'terrain-dem') throw new Error('terrain source failed')
      add(id, source)
    })
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    await flush()
    expect(f.failure).not.toHaveBeenCalled()
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', terrainStatus: 'error' })
  })

  it('hands the latest immutable band to the renderer only once the style is ready, beneath the scene', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity, { lidar: [layer('lidar-b'), layer('lidar-a')] }))
    expect(f.raster.syncs).toEqual([])
    f.manager.admitStyle()
    expect(f.raster.syncs.at(-1)).toEqual({ ids: ['lidar-b', 'lidar-a'], beforeId: 'canopi-shared-scene' })
    expect(f.states.at(-1)?.status).toBe('ready')
  })

  it('reorders renderer layers that arrive asynchronously into the band below the scene', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity, { lidar: [layer('lidar-b'), layer('lidar-a')] }))
    f.manager.admitStyle()
    f.raster.arrive('lidar-a')
    f.raster.arrive('lidar-b')
    expect(f.map.order.indexOf('basemap-raster')).toBeLessThan(f.map.order.indexOf('lidar-b'))
    expect(f.map.order.indexOf('lidar-b')).toBeLessThan(f.map.order.indexOf('lidar-a'))
    expect(f.map.order.indexOf('lidar-a')).toBeLessThan(f.map.order.indexOf('canopi-shared-scene'))
    expect(f.map.order.indexOf('canopi-shared-scene')).toBeLessThan(f.map.order.indexOf('panel-target-hover-zones-fill'))
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('treats ordering failure after an asynchronous renderer change as a hard failure', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity))
    f.manager.admitStyle()
    const error = new Error('raster ordering failed')
    f.map.moveLayer.mockImplementation(() => { throw error })
    f.raster.arrive('lidar-a')
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(f.raster.disposed).toBe(true)
  })

  it('keeps a renderer failure passive for editing and the other contributions', () => {
    const f = fixture()
    f.raster.syncError = new Error('renderer rejected the band')
    f.manager.update(snapshot(f.identity))
    f.manager.admitStyle()
    expect(f.failure).not.toHaveBeenCalled()
    expect(f.states.at(-1)?.status).toBe('ready')
    expect(f.map.getLayer('panel-target-hover-zones-fill')).toBeTruthy()
    expect(f.logError).toHaveBeenCalled()
    expect(f.manager.handleMapError({ sourceId: 'mlrcog0-src-lidar-a', error: new Error('tile') })).toBe(true)
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('clears the band for a disconnected Design and ignores the renderer after disposal', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity))
    f.manager.admitStyle()
    f.manager.update(null)
    expect(f.raster.syncs.at(-1)?.ids).toEqual([])
    f.manager.dispose()
    f.manager.dispose()
    expect(f.raster.disposeCalls).toBe(1)
    f.map.moveLayer.mockClear()
    f.raster.arrive('lidar-late')
    expect(f.map.moveLayer).not.toHaveBeenCalled()
  })

  it('the latest terrain generation wins when async loads settle out of order', async () => {
    const first = deferred<TerrainProtocolSupport>()
    const second = deferred<TerrainProtocolSupport>()
    const third = deferred<TerrainProtocolSupport>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const f = fixture(load)
    const enabled = { ...snapshot(f.identity).terrain, contoursVisible: true }
    f.manager.update(snapshot(f.identity, { terrain: enabled }))
    f.manager.admitStyle()
    f.manager.update(snapshot(f.identity, { terrain: { ...enabled, contourIntervalMeters: 10 } }))
    f.manager.update(snapshot(f.identity, { terrain: { ...enabled, contourIntervalMeters: 5 } }))
    third.resolve(terrainSupport)
    await flush()
    const sourceCount = f.map.addSource.mock.calls.length
    first.resolve(terrainSupport)
    second.resolve(terrainSupport)
    await flush()
    expect(f.map.addSource).toHaveBeenCalledTimes(sourceCount)
    expect(f.states.at(-1)?.terrainStatus).toBe('ready')
  })

  it.each(['null', 'disposed', 'expired'] as const)('fences pending terrain after %s', async (reason) => {
    const pending = deferred<TerrainProtocolSupport>()
    const f = fixture(vi.fn(() => pending.promise))
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    if (reason === 'null') f.manager.update(null)
    else if (reason === 'disposed') f.manager.dispose()
    else f.expire()
    f.map.addSource.mockClear()
    pending.resolve(terrainSupport)
    await flush()
    expect(f.map.addSource).not.toHaveBeenCalled()
  })

  it('fences reentrant disposal during a source mutation before another layer can be added', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity))
    f.map.addSource.mockImplementationOnce((id) => {
      f.map.sources.set(id, { setData: vi.fn() })
      f.manager.dispose()
    })
    f.manager.admitStyle()
    expect(f.map.addLayer).not.toHaveBeenCalled()
    expect(f.map.sources.size).toBe(0)
    expect(f.states.at(-1)?.status).toBe('idle')
  })

  it('clears partial terrain if a source mutation synchronously disables terrain', async () => {
    const f = fixture()
    const original = f.map.addSource.getMockImplementation()!
    f.map.addSource.mockImplementation((id, source) => {
      original(id, source)
      if (id === 'terrain-dem') f.manager.update(snapshot(f.identity))
    })
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    await flush()
    expect(f.map.getSource('terrain-dem')).toBeUndefined()
    expect(f.map.getLayer('hillshade-layer')).toBeUndefined()
    expect(f.states.at(-1)?.terrainStatus).toBe('idle')
  })

  it('publishes terrain failure without disabling editing or other contributions', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('terrain offline') }))
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    await flush()
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', terrainStatus: 'error' })
    // The notice is a fixed sentence; engine text stays in the log, not in the state.
    expect(f.states.at(-1)).not.toHaveProperty('terrainErrorMessage')
    expect(f.raster.syncs.at(-1)?.ids).toEqual(['lidar-a'])
    expect(f.map.getLayer('panel-target-hover-zones-fill')).toBeTruthy()
  })

  it('publishes no engine text, so a terrain tile error with new text publishes no new state', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('terrain offline') }))
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    await flush()
    expect(f.states.at(-1)?.terrainStatus).toBe('error')
    const published = f.states.length
    // Each tile error carries its own engine text; the notice is the same fixed sentence.
    f.manager.handleMapError({ sourceId: 'terrain-dem', error: new Error('tile 12/3/4 failed') })
    f.manager.handleMapError({ sourceId: 'terrain-dem', error: new Error('tile 12/3/5 failed') })
    expect(f.states).toHaveLength(published)
    f.map.moveLayer.mockImplementation(() => { throw new Error('order failed at https://tiles.example/?key=secret') })
    f.raster.added.push('lidar-a')
    f.map.order.push('lidar-a')
    f.manager.update(snapshot(f.identity))
    expect(f.states.at(-1)?.status).toBe('error')
    expect(JSON.stringify(f.states)).not.toMatch(/terrain offline|tile 12|order failed|secret/)
  })

  it('ignores delayed source errors after contributions are disconnected', () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity))
    f.manager.admitStyle()
    f.manager.update(null)
    const published = f.states.length
    expect(f.manager.handleMapError({ sourceId: 'mlrcog0-src-lidar-a' })).toBe(true)
    expect(f.manager.handleMapError({ sourceId: 'terrain-dem' })).toBe(true)
    expect(f.states).toHaveLength(published)
    expect(f.states.at(-1)?.status).toBe('idle')
  })

  it('disposes overlays, terrain, rasters and listeners once with idle state', async () => {
    const f = fixture()
    f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
    f.manager.admitStyle()
    await flush()
    expect(f.states.at(-1)?.status).toBe('ready')
    f.manager.dispose()
    const mutations = f.map.removeSource.mock.calls.length
    f.manager.dispose()
    f.manager.admitStyle()
    f.manager.update(snapshot(f.identity))
    expect(f.map.removeSource).toHaveBeenCalledTimes(mutations)
    expect(f.map.sources.size).toBe(0)
    expect([...f.map.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
    expect(f.states.at(-1)).toEqual(IDLE_MAPLIBRE_CANVAS_SURFACE_STATE)
  })

  describe('optional overlay failures', () => {
    it.each(['initial', 'live'] as const)('keeps the map ready when the overlay fails during %s work', (phase) => {
      const f = fixture()
      const input = snapshot(f.identity)
      f.manager.update(input)
      if (phase === 'live') f.manager.admitStyle()
      const error = new Error('overlay failed')
      const add = f.map.addLayer.getMockImplementation()!
      f.map.addLayer.mockImplementation((candidate) => {
        if (String(candidate.id).startsWith('panel-target-')) throw error
        add(candidate)
      })
      if (phase === 'live') {
        // A new selection adds the selection overlay on the live map.
        f.manager.update({ ...input, overlays: { ...input.overlays, selectedTargets: [{ kind: 'zone', zone_id: 'plot' }] } })
      } else f.manager.admitStyle()
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: true })
      expect(f.map.sources.has('panel-target-hover-source')).toBe(false)
      expect(f.raster.disposed).toBe(false)
    })

    it.each(['addSource', 'addLayer'] as const)('skips the Target overlay when %s throws and keeps the map ready', (method) => {
      const f = fixture()
      const error = new Error(`overlay ${method} failed`)
      const original = f.map[method].getMockImplementation()! as (...args: unknown[]) => void
      ;(f.map[method] as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
        const id = typeof args[0] === 'string' ? args[0] : String((args[0] as { id?: unknown }).id)
        if (id.startsWith('panel-target-')) throw error
        original(...args)
      })
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: true })
      expect(f.map.getSource('panel-target-hover-source')).toBeUndefined()
      expect(f.map.order.some((id) => id.startsWith('panel-target-'))).toBe(false)
      expect(f.logError).toHaveBeenCalledWith(expect.stringContaining('overlay'), error)
      // The other contributions are untouched.
      expect(f.raster.syncs.at(-1)?.ids).toEqual(['lidar-a'])
    })

    it('does not retry the same failing Targets until they change, then clears the notice', () => {
      const f = fixture()
      const add = f.map.addSource.getMockImplementation()!
      let broken = true
      f.map.addSource.mockImplementation((id, source) => {
        if (broken && id.startsWith('panel-target-')) throw new Error('overlay rejected')
        add(id, source)
      })
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      const attempts = f.map.addSource.mock.calls.length
      f.manager.update(snapshot(f.identity))
      expect(f.map.addSource).toHaveBeenCalledTimes(attempts)
      expect(f.logError).toHaveBeenCalledOnce()
      broken = false
      const next = snapshot(f.identity)
      f.manager.update({ ...next, overlays: { ...next.overlays, selectedTargets: [{ kind: 'zone', zone_id: 'plot' }] } })
      expect(f.map.getSource('panel-target-hover-source')).toBeTruthy()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: false })
    })

    it('skips the overlay on a MapLibre validation event that names its source', () => {
      const f = fixture()
      const add = f.map.addSource.getMockImplementation()!
      f.map.addSource.mockImplementation((id, source) => {
        if (id.startsWith('panel-target-')) {
          // MapLibre validates without throwing: it emits and does not add.
          expect(f.manager.handleMapError({ error: new Error(`sources.${id}: unknown property "id"`) })).toBe(true)
          return
        }
        add(id, source)
      })
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: true })
      expect(f.map.order.some((id) => id.startsWith('panel-target-'))).toBe(false)
    })

    it('treats a failed overlay rollback as a hard failure', () => {
      const f = fixture()
      const addLayer = f.map.addLayer.getMockImplementation()!
      f.map.addLayer.mockImplementation((candidate) => {
        addLayer(candidate)
        if (String(candidate.id).startsWith('panel-target-')) throw new Error('partial overlay')
      })
      const cleanup = new Error('overlay rollback failed')
      f.map.removeLayer.mockImplementation(() => { throw cleanup })
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      expect(f.failure).toHaveBeenCalledExactlyOnceWith(cleanup)
    })

    it('routes terrain layer and style events to terrain without failing the map', async () => {
      const f = fixture()
      f.manager.update(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }))
      f.manager.admitStyle()
      await flush()
      expect(f.manager.handleMapError({ error: new Error('layers.hillshade-layer.paint.hillshade-exaggeration: number expected') })).toBe(true)
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', terrainStatus: 'error' })
    })

    it('draws the Site data pin above the panel Targets in the interaction-overlay band', () => {
      const f = fixture()
      f.manager.update(withSite(snapshot(f.identity), [2.001, 48.001]))
      f.manager.admitStyle()
      expect(f.map.getSource('site-overlay-source')).toBeTruthy()
      expect(f.map.order.indexOf('panel-target-hover-plants')).toBeLessThan(f.map.order.indexOf('site-pin-ring'))
      expect(f.map.order.indexOf('site-pin-ring')).toBeLessThan(f.map.order.indexOf('site-pin-core'))
      f.manager.update(withSite(snapshot(f.identity), null))
      expect(f.map.getSource('site-overlay-source')).toBeUndefined()
      expect(f.map.order.some((id) => id.startsWith('site-'))).toBe(false)
    })

    it('skips a failing site overlay on its own key: the selection highlight stays, and the pin is retried only when it moves', () => {
      const f = fixture()
      const add = f.map.addLayer.getMockImplementation()!
      let broken = true
      f.map.addLayer.mockImplementation((candidate) => {
        if (broken && String(candidate.id).startsWith('site-')) throw new Error('site layer rejected')
        add(candidate)
      })
      const selected = snapshot(f.identity)
      const input = withSite({ ...selected, overlays: { ...selected.overlays, selectedTargets: [{ kind: 'zone', zone_id: 'plot' }] } }, [2.001, 48.001])
      f.manager.update(input)
      f.manager.admitStyle()
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.map.getLayer('panel-target-selection-zones-line')).toBeTruthy()
      expect(f.map.order.some((id) => id.startsWith('site-'))).toBe(false)
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: true })
      const attempts = f.map.addLayer.mock.calls.length
      // A new panel hover is a new Target set but the same pin: the panel overlay redraws, the site is not retried.
      f.manager.update({ ...input, overlays: { ...input.overlays, hoveredTargets: [] } })
      expect(f.map.addLayer.mock.calls.slice(attempts).some(([candidate]) => String(candidate.id).startsWith('site-'))).toBe(false)
      expect(f.map.getLayer('panel-target-selection-zones-line')).toBeTruthy()
      expect(f.logError).toHaveBeenCalledOnce()
      broken = false
      f.manager.update(withSite(input, [2.002, 48.001]))
      expect(f.map.getLayer('site-pin-core')).toBeTruthy()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: false })
    })

    it('routes a MapLibre error naming a site layer to the site key, leaving the selection highlight drawn', () => {
      const f = fixture()
      const selected = snapshot(f.identity)
      f.manager.update(withSite({ ...selected, overlays: { ...selected.overlays, selectedTargets: [{ kind: 'zone', zone_id: 'plot' }] } }, [2.001, 48.001]))
      f.manager.admitStyle()
      expect(f.manager.handleMapError({ layer: { id: 'site-pin-core' }, error: new Error('site paint rejected') })).toBe(true)
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.map.order.some((id) => id.startsWith('site-'))).toBe(false)
      expect(f.map.getLayer('panel-target-selection-zones-line')).toBeTruthy()
      expect(f.states.at(-1)).toMatchObject({ status: 'ready', layerSkipped: true })
      // A late error from a site layer already removed stays passive.
      f.manager.dispose()
      expect(f.manager.handleMapError({ sourceId: 'site-overlay-source', error: new Error('late') })).toBe(true)
    })

    it('leaves unowned and shared scene errors to the map owner', () => {
      const f = fixture()
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      expect(f.manager.handleMapError({ error: new Error('map engine failed') })).toBe(false)
      expect(f.manager.handleMapError({ layer: { id: 'canopi-shared-scene' }, error: new Error('scene draw failed') })).toBe(false)
    })
  })

  describe('the profile chart hover (one setData, never the drain)', () => {
    it('moves the hover ring without re-running the raster sync, the panel overlays or the order, and without a new revision', async () => {
      const terrain = deferred<TerrainProtocolSupport>()
      const f = fixture(vi.fn(() => terrain.promise))
      const input = withSite(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }), [2.001, 48.001])
      f.manager.update(input)
      f.manager.admitStyle()
      const rasterSyncs = f.raster.syncs.length
      const orderReads = f.map.getLayersOrder.mock.calls.length
      const panelSource = f.map.getSource('panel-target-hover-source')!
      f.siteHover.push([2.0015, 48.001])
      const hoverSource = f.map.getSource('site-hover-source')!
      expect(hoverSource).toBeTruthy()
      expect(f.map.getLayer('site-hover-ring')).toBeTruthy()
      f.siteHover.push([2.0016, 48.001])
      f.siteHover.push([2.0017, 48.001])
      expect(hoverSource.setData).toHaveBeenCalledTimes(2)
      expect(f.raster.syncs).toHaveLength(rasterSyncs)
      expect(f.map.getLayersOrder).toHaveBeenCalledTimes(orderReads)
      expect(panelSource.setData).not.toHaveBeenCalled()
      // The terrain rebuild the drain started is still current: the hover moved no revision.
      terrain.resolve(terrainSupport)
      await flush()
      expect(f.states.at(-1)).toMatchObject({ terrainStatus: 'ready' })
      f.siteHover.push(null)
      expect(f.map.getSource('site-hover-source')).toBeUndefined()
    })

    it('draws no hover ring without a pin or profile line, and re-applies it after the drain repaints the site', () => {
      const f = fixture()
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      f.siteHover.push([2.0015, 48.001])
      expect(f.map.getSource('site-hover-source')).toBeUndefined()
      f.manager.update(withSite(snapshot(f.identity), [2.001, 48.001]))
      expect(f.map.getSource('site-hover-source')).toBeTruthy()
      expect(f.map.order.indexOf('site-pin-core')).toBeLessThan(f.map.order.indexOf('site-hover-ring'))
    })

    it('reaches the map from the composition\'s own effect, never through the contributions read', async () => {
      const hover = signal<readonly [number, number] | null>(null)
      const read = vi.fn(() => null)
      const surfaces = createTestCanvasRuntimeSurfaces()
      let feed: Parameters<typeof fixture>[1] | undefined
      const composition = createWorkspaceRuntimeComposition({
        container: document.createElement('div'),
        appAdapter: createDetachedCanvasRuntimeAppAdapter(),
        targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
        mapContributions: { read, readSiteHover: () => hover.value },
        readSnapshot: () => null,
      }, {
        createRendererComposition: () => ({}) as SharedMapSceneRendererComposition,
        createRuntime: () => ({
          cameraHost: {} as never, commandSurface: surfaces.commands, querySurface: surfaces.queries,
          documentSurface: surfaces.documents, init: vi.fn(), unmountRenderer: vi.fn(), remountRenderer: vi.fn(),
          destroy: vi.fn(), connectRenderTarget: vi.fn(() => () => {}),
        }) as never,
        createControls: (options) => {
          feed = options.contributions.siteHover as typeof feed
          return { setAttributionCompact: vi.fn() } as never
        },
        createWorkspace: () => ({
          requestGenerationDisconnect: vi.fn(async () => {}), activate: vi.fn(), teardown: vi.fn(async () => {}),
          retry: vi.fn(() => false), canRetry: vi.fn(() => false), updateMapContributions: vi.fn(), updateBackgroundPresentation: vi.fn(),
        }),
      })
      await composition.start()
      const f = fixture(undefined, feed!)
      f.manager.update(withSite(snapshot(f.identity), [2.001, 48.001]))
      f.manager.admitStyle()
      const reads = read.mock.calls.length
      hover.value = [2.0015, 48.001]
      expect(f.map.getSource('site-hover-source')).toBeTruthy()
      expect(read).toHaveBeenCalledTimes(reads)
      await composition.dispose()
      hover.value = null
      expect(f.map.getSource('site-hover-source')).toBeTruthy()
    })

    it('survives Retry: the next map\'s contributions draw the current hover, and a disposed one stops listening', () => {
      const feed = hoverFeed()
      const first = fixture(undefined, feed)
      first.manager.update(withSite(snapshot(first.identity), [2.001, 48.001]))
      first.manager.admitStyle()
      feed.push([2.0015, 48.001])
      first.manager.dispose()
      expect(feed.listeners.size).toBe(0)
      const retried = fixture(undefined, feed)
      retried.manager.update(withSite(snapshot(retried.identity), [2.001, 48.001]))
      retried.manager.admitStyle()
      expect(retried.map.getSource('site-hover-source')).toBeTruthy()
    })

    it('a hover failure skips the site layers until the pin or line changes, and keeps the panel highlights', () => {
      const f = fixture()
      f.manager.update(withSite(snapshot(f.identity), [2.001, 48.001]))
      f.manager.admitStyle()
      const add = f.map.addSource.getMockImplementation()!
      f.map.addSource.mockImplementation((id, source) => {
        if (id === 'site-hover-source') throw new Error('hover source rejected')
        add(id, source)
      })
      f.siteHover.push([2.0015, 48.001])
      f.siteHover.push([2.0016, 48.001])
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.logError).toHaveBeenCalledOnce()
      expect(f.map.order.some((id) => id.startsWith('site-'))).toBe(false)
      expect(f.map.getLayer('panel-target-hover-zones-fill')).toBeTruthy()
    })
  })

  describe('the user location (one setData from its feed, never the drain)', () => {
    const FIX: UserLocationReading = { lon: 2.0012345, lat: 48.0012345, accuracy: 20, timestamp: 1_760_000_000_000, stale: false }
    const MOVED: UserLocationReading = { ...FIX, lon: 2.0022345 }

    it('draws the dot on its own source at the top of the band, moves it with one setData and clears it on null', async () => {
      const terrain = deferred<TerrainProtocolSupport>()
      const f = fixture(vi.fn(() => terrain.promise))
      f.manager.update(withSite(snapshot(f.identity, { terrain: { ...snapshot(f.identity).terrain, hillshadeVisible: true } }), [2.001, 48.001]))
      f.manager.admitStyle()
      const rasterSyncs = f.raster.syncs.length
      const orderReads = f.map.getLayersOrder.mock.calls.length
      f.userLocation.push(FIX)
      const source = f.map.getSource('user-location-source')!
      expect(source).toBeTruthy()
      expect(f.map.order.slice(-3)).toEqual(['user-location-accuracy', 'user-location-ring', 'user-location-core'])
      f.userLocation.push(MOVED)
      f.userLocation.push({ ...MOVED, stale: true })
      expect(source.setData).toHaveBeenCalledTimes(1)
      expect(f.map.setPaintProperty).toHaveBeenCalledWith('user-location-core', 'circle-opacity', 0)
      expect(f.raster.syncs).toHaveLength(rasterSyncs)
      expect(f.map.getLayersOrder).toHaveBeenCalledTimes(orderReads)
      // The terrain rebuild the drain started is still current: the reading moved no revision.
      terrain.resolve(terrainSupport)
      await flush()
      expect(f.states.at(-1)).toMatchObject({ terrainStatus: 'ready' })
      f.userLocation.push(null)
      expect(f.map.getSource('user-location-source')).toBeUndefined()
      expect(f.map.order.some((id) => id.startsWith('user-location-'))).toBe(false)
    })

    it('draws the reading the feed already holds once the style is in, keeps it through a drain, and none without a Design', () => {
      const f = fixture()
      f.userLocation.push(FIX)
      f.manager.update(snapshot(f.identity))
      expect(f.map.getSource('user-location-source')).toBeUndefined()
      f.manager.admitStyle()
      expect(f.map.getSource('user-location-source')).toBeTruthy()
      f.manager.update(withSite(snapshot(f.identity), [2.001, 48.001]))
      expect(f.map.order.indexOf('site-pin-core')).toBeLessThan(f.map.order.indexOf('user-location-core'))
      f.manager.update(null)
      expect(f.map.getSource('user-location-source')).toBeUndefined()
      f.userLocation.push(MOVED)
      expect(f.map.getSource('user-location-source')).toBeUndefined()
    })

    it('survives Retry: the next map draws the current reading, and a disposed one stops listening and clears it', () => {
      const location = locationFeed()
      const first = fixture(undefined, undefined, location)
      first.manager.update(snapshot(first.identity))
      first.manager.admitStyle()
      location.push(FIX)
      first.manager.dispose()
      expect(location.listeners.size).toBe(0)
      expect(first.map.getSource('user-location-source')).toBeUndefined()
      const retried = fixture(undefined, undefined, location)
      retried.manager.update(snapshot(retried.identity))
      retried.manager.admitStyle()
      expect(retried.map.getSource('user-location-source')).toBeTruthy()
    })

    it('a failing write keeps the map and the other overlays, logs once without the error (it can echo the reading), and retries on the next fix', () => {
      const f = fixture()
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      const add = f.map.addSource.getMockImplementation()!
      let broken = true
      f.map.addSource.mockImplementation((id, source) => {
        if (broken && id === 'user-location-source') throw new Error(`addSource rejected ${JSON.stringify(source)}`)
        add(id, source)
      })
      f.userLocation.push(FIX)
      f.userLocation.push(MOVED)
      expect(f.failure).not.toHaveBeenCalled()
      expect(f.logError).toHaveBeenCalledOnce()
      expect(JSON.stringify(f.logError.mock.calls)).not.toContain('2.00')
      expect(f.logError.mock.calls[0]).toHaveLength(1)
      expect(f.map.order.some((id) => id.startsWith('user-location-'))).toBe(false)
      expect(f.map.getLayer('panel-target-hover-zones-fill')).toBeTruthy()
      broken = false
      f.userLocation.push(FIX)
      expect(f.map.getSource('user-location-source')).toBeTruthy()
    })

    it('reaches the map from the composition\'s own effect, never the contributions read, and hides during a story presentation (Q12)', async () => {
      const reading = signal<UserLocationReading | null>(null)
      const read = vi.fn(() => null)
      const surfaces = createTestCanvasRuntimeSurfaces()
      let feed: Parameters<typeof fixture>[2] | undefined
      const composition = createWorkspaceRuntimeComposition({
        container: document.createElement('div'),
        appAdapter: createDetachedCanvasRuntimeAppAdapter(),
        targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
        mapContributions: { read, readUserLocation: () => reading.value },
        readSnapshot: () => null,
      }, {
        createRendererComposition: () => ({}) as SharedMapSceneRendererComposition,
        createRuntime: () => ({
          cameraHost: {} as never, commandSurface: surfaces.commands, querySurface: surfaces.queries,
          documentSurface: surfaces.documents, init: vi.fn(), unmountRenderer: vi.fn(), remountRenderer: vi.fn(),
          destroy: vi.fn(), connectRenderTarget: vi.fn(() => () => {}),
        }) as never,
        createControls: (options) => {
          expect(options.contributions.siteHover, 'Web has no chart hover').toBeUndefined()
          feed = options.contributions.userLocation as typeof feed
          return { setAttributionCompact: vi.fn() } as never
        },
        createWorkspace: () => ({
          requestGenerationDisconnect: vi.fn(async () => {}), activate: vi.fn(), teardown: vi.fn(async () => {}),
          retry: vi.fn(() => false), canRetry: vi.fn(() => false), updateMapContributions: vi.fn(), updateBackgroundPresentation: vi.fn(),
        }),
      })
      await composition.start()
      const f = fixture(undefined, undefined, feed!)
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      const reads = read.mock.calls.length
      reading.value = FIX
      expect(f.map.getSource('user-location-source')).toBeTruthy()
      expect(read).toHaveBeenCalledTimes(reads)
      try {
        setStoryPresentationHidesEditingAids(true)
        expect(f.map.getSource('user-location-source')).toBeUndefined()
        reading.value = MOVED
        expect(f.map.getSource('user-location-source')).toBeUndefined()
      } finally {
        setStoryPresentationHidesEditingAids(false)
      }
      expect(f.map.getSource('user-location-source')).toBeTruthy()
      await composition.dispose()
      reading.value = null
      expect(f.map.getSource('user-location-source')).toBeTruthy()
    })

    it('owns a MapLibre error naming its source or layers: it never logs the event, which can carry the reading, and clears the dot', () => {
      const f = fixture()
      f.manager.update(snapshot(f.identity))
      f.manager.admitStyle()
      f.userLocation.push(FIX)
      const event = { sourceId: 'user-location-source', error: new Error(`geojson rejected ${JSON.stringify(FIX)}`) }
      expect(f.manager.handleMapError(event)).toBe(true)
      expect(f.manager.handleMapError({ layer: { id: 'user-location-core' }, error: new Error('bad paint') })).toBe(true)
      expect(f.failure).not.toHaveBeenCalled()
      expect(JSON.stringify(f.logError.mock.calls)).not.toContain('2.00')
      expect(f.map.getSource('user-location-source')).toBeUndefined()
      f.manager.dispose()
      expect(f.manager.handleMapError(event), 'a late error from a removed dot stays passive').toBe(true)
    })
  })

  it('reads the Desktop pin and profile line into the snapshot in [lon, lat], and none in overview', () => {
    designSessionStore.replaceCurrentDesignState({ name: 'Orchard' } as CanopiFile, null, 'Orchard')
    selectPanel('site-data')
    try {
      const adapter = createDesktopWorkspaceMapContributionAdapter()
      const runtime = createTestCanvasQuerySurface()
      expect(adapter.read(runtime)?.overlays.site).toBeNull()
      setPin({ lon: 2.35, lat: 48.85 })
      setProfileLine([{ lon: 2.35, lat: 48.85 }, { lon: 2.36, lat: 48.86 }])
      expect(adapter.read(runtime)?.overlays.site).toEqual({ pin: [2.35, 48.85], profileLine: [[2.35, 48.85], [2.36, 48.86]] })
      runtime.setPlacement({ x: 0, y: 0, scale: 0.01 })
      expect(adapter.read(runtime)?.overlays.site).toBeNull()
    } finally {
      endSiteDataTransients()
      sidePanel.value = null
      activePanel.value = 'canvas'
    }
  })
})
