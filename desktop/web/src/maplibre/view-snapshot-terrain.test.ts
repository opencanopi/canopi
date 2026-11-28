// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MapLibreMapConstructorOptions } from './loader'
import type { MapBackgroundHandle, MapBackgroundPresentation } from './map-background'
import type { SceneHostLayer, SceneHostLayerOptions } from './scene-host-layer'
import { createTestSceneRendererSnapshot } from '../__tests__/support/scene-renderer-snapshot'
import type { ViewTransform } from '../geo/view/types'
import { TERRAIN_CONTOUR_LAYER_IDS } from './terrain'
import {
  createViewSnapshotMap,
  VIEW_SNAPSHOT_SCENE_LAYER_ID,
  type ViewSnapshotMapOptions,
  type ViewSnapshotRequest,
} from './view-snapshot-map'

type MapListener = (event?: unknown) => void

interface TerrainStubMap {
  readonly layerOrder: string[]
  readonly sources: Map<string, Record<string, unknown>>
}

function makeTerrainStubClass(recorded: TerrainStubMap[]) {
  return class {
    readonly listeners = new Map<string, Set<MapListener>>()
    readonly layers = new Map<string, Record<string, unknown>>()
    readonly layerOrder: string[] = []
    readonly sources = new Map<string, Record<string, unknown>>()
    readonly canvas = document.createElement('canvas')
    readonly gl = {} as WebGL2RenderingContext
    private lng = 0.03
    private lat = 48.2
    private zoomVal = 18
    private bearingVal = 0

    constructor(opts: MapLibreMapConstructorOptions) {
      recorded.push(this)
      this.canvas.width = parseInt(opts.container.style.width, 10) || 320
      this.canvas.height = parseInt(opts.container.style.height, 10) || 180
      Object.defineProperty(this.canvas, 'getContext', {
        configurable: true,
        value: (kind: string) => (kind === 'webgl2' ? this.gl : null),
      })
      opts.container.appendChild(this.canvas)
      queueMicrotask(() => this.emit('load'))
    }

    on(ev: string, fn: MapListener) {
      const set = this.listeners.get(ev) ?? new Set<MapListener>()
      set.add(fn)
      this.listeners.set(ev, set)
    }
    off(ev: string, fn: MapListener) { this.listeners.get(ev)?.delete(fn) }
    emit(ev: string, payload?: unknown) {
      for (const fn of [...(this.listeners.get(ev) ?? [])]) fn(payload)
    }
    jumpTo(p: { center: [number, number]; zoom: number; bearing?: number }) {
      ;[this.lng, this.lat] = p.center
      this.zoomVal = p.zoom
      if (p.bearing !== undefined) this.bearingVal = p.bearing
      this.emit('move')
    }
    flyTo(p: { center: [number, number]; zoom: number; bearing: number }) {
      this.jumpTo(p)
      this.emit('moveend')
    }
    stop() {}
    setTransformConstrain() {}
    resize() { this.emit('resize') }
    redraw() {}
    remove() {}
    loaded() { return true }
    isStyleLoaded() { return true }
    areTilesLoaded() { return true }
    triggerRepaint() { queueMicrotask(() => { this.emit('render'); this.emit('idle') }) }
    getCanvas() { return this.canvas }
    getPitch() { return 0 }
    getCenter() { return { lng: this.lng, lat: this.lat } }
    getZoom() { return this.zoomVal }
    getBearing() { return this.bearingVal }
    project() { return { x: 160, y: 90 } }
    unproject() { return { lng: this.lng, lat: this.lat } }
    addSource(id: string, src: Record<string, unknown>) { this.sources.set(id, src) }
    getSource(id: string) { return this.sources.get(id) }
    removeSource(id: string) { this.sources.delete(id) }
    addLayer(layer: Record<string, unknown>, beforeId?: string) {
      const id = String(layer.id)
      this.layers.set(id, layer)
      const at = beforeId ? this.layerOrder.indexOf(beforeId) : -1
      if (at >= 0) this.layerOrder.splice(at, 0, id)
      else this.layerOrder.push(id)
      ;(layer.onAdd as ((m: unknown, gl: WebGL2RenderingContext) => void) | undefined)?.(this, this.gl)
    }
    getLayer(id: string) { return this.layers.get(id) }
    removeLayer(id: string) {
      this.layers.delete(id)
      const at = this.layerOrder.indexOf(id)
      if (at >= 0) this.layerOrder.splice(at, 1)
    }
    setPaintProperty(id: string, prop: string, val: unknown) {
      const existing = this.layers.get(id)
      if (existing) existing.paint = { ...(existing.paint as Record<string, unknown> | undefined), [prop]: val }
    }
  }
}

function stubSceneLayer(opts: Omit<SceneHostLayerOptions<unknown, never>, 'painter'>): SceneHostLayer<unknown, never> {
  let done: (() => void) | null = null
  let current: ViewTransform | null = null
  let pending: ViewTransform | null = null
  return {
    phase: 'attached',
    layer: { id: opts.id, type: 'custom', render: () => undefined },
    initialize: async () => undefined,
    setSnapshot() { current = pending; done?.(); done = null },
    setDraft() {},
    requestRender() {},
    presentFor(v) { pending = v; current = null; return new Promise<void>((r) => { done = r }) },
    hasPresented: (v) => current === v,
    dispose: async () => undefined,
  }
}

const noopBg = (): MapBackgroundHandle => ({
  update() {},
  retry() {},
  claimMapError: () => false,
  isApplied: () => true,
  setAttributionCompact() {},
  dispose() {},
})

const BASEMAP: MapBackgroundPresentation = {
  basemap: { style: 'liberty', visible: true, opacity: 1 },
  satellite: { visible: false, opacity: 1 },
  locale: 'en',
}

function terrainSnapshotRequest(
  overrides: Partial<ViewSnapshotRequest> = {},
): ViewSnapshotRequest {
  return {
    camera: { lon: 0.03, lat: 48.2, zoom: 18, bearing: 0 },
    width: 320,
    height: 180,
    pixelRatio: 1,
    background: BASEMAP,
    scene: { origin: { lon: 0.03, lat: 48.2 }, build: () => createTestSceneRendererSnapshot() },
    timeoutMs: 2_000,
    terrain: {
      contoursVisible: true,
      contoursOpacity: 0.8,
      contourIntervalMeters: 10,
      hillshadeVisible: false,
      hillshadeOpacity: 0.4,
      isDark: false,
    },
    ...overrides,
  }
}

function makeSnapshotOwner(
  maps: TerrainStubMap[],
  extra: Partial<ViewSnapshotMapOptions> = {},
) {
  const StubMap = makeTerrainStubClass(maps)
  return createViewSnapshotMap({
    readSatelliteConfig: () => ({ googleMapsApiKey: null, locale: 'en' }),
    loadMapLibre: async () => ({
      Map: StubMap as unknown as new (options: MapLibreMapConstructorOptions) => unknown,
      addProtocol() {},
    }),
    mountBackground: noopBg,
    createSceneLayer: stubSceneLayer,
    readFrame: (c) => ({
      width: c.width,
      height: c.height,
      encode: async (mime) => new Blob(['ok'], { type: mime }),
    }),
    ...extra,
  })
}

describe('view snapshot terrain', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('draws contour layers below the snapshot scene layer when terrain contours are on (contracts §6)', async () => {
    const maps: TerrainStubMap[] = []
    const owner = makeSnapshotOwner(maps, {
      loadTerrainSupport: async () => ({
        sharedDemProtocolUrl: 'dem://{z}/{x}/{y}',
        contourProtocolUrl: () => 'contour://{z}/{x}/{y}',
      }),
    })
    const result = await owner.capture(terrainSnapshotRequest())
    expect(result.missingTiles).toBe(false)
    const sceneIdx = maps[0]!.layerOrder.indexOf(VIEW_SNAPSHOT_SCENE_LAYER_ID)
    const minorIdx = maps[0]!.layerOrder.indexOf(TERRAIN_CONTOUR_LAYER_IDS[0])
    const majorIdx = maps[0]!.layerOrder.indexOf(TERRAIN_CONTOUR_LAYER_IDS[1])
    expect(minorIdx).toBeGreaterThanOrEqual(0)
    expect(majorIdx).toBeGreaterThanOrEqual(0)
    expect(minorIdx).toBeLessThan(sceneIdx)
    expect(majorIdx).toBeLessThan(sceneIdx)
    await owner.dispose()
  })

  it('skips terrain and marks missingTiles when loadTerrainSupport fails instead of dropping the thumbnail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const maps: TerrainStubMap[] = []
    const owner = makeSnapshotOwner(maps, {
      loadTerrainSupport: async () => { throw new Error('terrain chunk offline') },
    })
    const result = await owner.capture(terrainSnapshotRequest())
    expect(result.missingTiles).toBe(true)
    expect(result.width).toBe(320)
    expect(consoleError).toHaveBeenCalled()
    await owner.dispose()
  })

  it('does not rebuild terrain on a removed map when disposed while loadTerrainSupport is pending', async () => {
    const maps: TerrainStubMap[] = []
    let resolveSupport: ((v: { sharedDemProtocolUrl: string; contourProtocolUrl: () => string }) => void) | null = null
    const owner = makeSnapshotOwner(maps, {
      loadTerrainSupport: () => new Promise((resolve) => { resolveSupport = resolve }),
    })
    const pending = owner.capture(terrainSnapshotRequest())
    await vi.waitFor(() => expect(resolveSupport).not.toBeNull())
    const disposing = owner.dispose()
    resolveSupport!({
      sharedDemProtocolUrl: 'dem://{z}/{x}/{y}',
      contourProtocolUrl: () => 'contour://{z}/{x}/{y}',
    })
    await expect(pending).rejects.toThrow(/released|disposed/i)
    await disposing
    expect(maps[0]!.sources.size).toBe(0)
  })
})
