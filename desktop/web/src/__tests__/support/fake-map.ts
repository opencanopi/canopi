// __tests__/support/fake-map.ts
// Shared MapLibre fake implementing the union of consumer Pick<> ports (contracts §6, ADR 0022 L7):
// style load/reload events, sources, layers, getZoom, getBounds, getCanvas, triggerRepaint.

import { vi } from 'vitest'
import type { SceneHostMap } from '../../maplibre/scene-host-layer'

export interface FakeMapOptions {
  readonly width?: number
  readonly height?: number
  readonly dpr?: number
  readonly zoom?: number
  readonly bounds?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
  readonly styleLoaded?: boolean
}

export interface FakeMap extends SceneHostMap {
  readonly sources: Map<string, unknown>
  readonly layers: Map<string, { readonly id: string; [key: string]: unknown }>
  readonly repaints: number
  readonly triggerRepaint: ReturnType<typeof vi.fn<() => void>>
  readonly project: ReturnType<typeof vi.fn<() => { x: number; y: number }>>
  readonly getPitch: ReturnType<typeof vi.fn<() => number>>
  isStyleLoaded(): boolean
  getZoom(): number
  setZoom(zoom: number): void
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }
  addSource(id: string, spec: unknown): void
  getSource(id: string): unknown
  removeSource(id: string): void
  addLayer(layer: { readonly id: string; [key: string]: unknown }, beforeId?: string): void
  getLayer(id: string): { readonly id: string; [key: string]: unknown } | undefined
  removeLayer(id: string): void
  getLayersOrder(): string[]
  emit(type: string, event?: unknown): void
  emitRender(): void
  emitStyleLoad(): void
}

function createFakeCanvas(width: number, height: number, dpr: number): HTMLCanvasElement {
  const backingWidth = Math.round(width * dpr)
  const backingHeight = Math.round(height * dpr)
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      clientWidth: { value: width, writable: true, configurable: true },
      clientHeight: { value: height, writable: true, configurable: true },
      width: { value: backingWidth, writable: true, configurable: true },
      height: { value: backingHeight, writable: true, configurable: true },
    })
    return canvas
  }
  return {
    clientWidth: width,
    clientHeight: height,
    width: backingWidth,
    height: backingHeight,
  } as unknown as HTMLCanvasElement
}

export function createFakeMap(options: FakeMapOptions = {}): FakeMap {
  const canvas = createFakeCanvas(options.width ?? 800, options.height ?? 600, options.dpr ?? 1)
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const sources = new Map<string, unknown>()
  const layers = new Map<string, { readonly id: string; [key: string]: unknown }>()
  const layerOrder: string[] = []
  let zoom = options.zoom ?? 15
  let styleLoaded = options.styleLoaded ?? true
  let repaints = 0
  const bounds = options.bounds ?? { west: -1.6, south: 47.2, east: -1.5, north: 47.3 }

  const triggerRepaint = vi.fn<() => void>(() => {
    repaints += 1
  })
  const project = vi.fn(() => ({ x: 0, y: 0 }))
  const getPitch = vi.fn(() => 0)

  const emit = (type: string, event?: unknown): void => {
    const set = listeners.get(type)
    if (!set) return
    for (const listener of [...set]) listener(event)
  }

  return {
    sources,
    layers,
    get repaints() { return repaints },
    getCanvas: () => canvas,
    triggerRepaint,
    project,
    getPitch,
    isStyleLoaded: () => styleLoaded,
    getZoom: () => zoom,
    setZoom(next: number) { zoom = next },
    getBounds: () => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    }),
    addSource(id, spec) { sources.set(id, spec) },
    getSource(id) { return sources.get(id) },
    removeSource(id) { sources.delete(id) },
    addLayer(layer, beforeId) {
      layers.set(layer.id, layer)
      const existing = layerOrder.indexOf(layer.id)
      if (existing >= 0) layerOrder.splice(existing, 1)
      if (beforeId) {
        const idx = layerOrder.indexOf(beforeId)
        if (idx >= 0) {
          layerOrder.splice(idx, 0, layer.id)
          return
        }
      }
      layerOrder.push(layer.id)
    },
    getLayer(id) { return layers.get(id) },
    removeLayer(id) {
      layers.delete(id)
      const idx = layerOrder.indexOf(id)
      if (idx >= 0) layerOrder.splice(idx, 1)
    },
    getLayersOrder: () => [...layerOrder],
    on(type: string, listener: (event?: unknown) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
    },
    off(type: string, listener: (event?: unknown) => void) {
      listeners.get(type)?.delete(listener)
    },
    emit,
    emitRender() { emit('render') },
    emitStyleLoad() {
      styleLoaded = true
      emit('style.load')
    },
  }
}
