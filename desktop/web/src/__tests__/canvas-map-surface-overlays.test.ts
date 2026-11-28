import { describe, expect, it, vi } from 'vitest'
import {
  syncCanvasMapSurfaceSiteHover,
  syncCanvasMapSurfaceSiteOverlay,
} from '../app/canvas-map-surface/overlays'
import { getMapBackdropInk, readCanvasPaintTokens } from '../canvas/runtime/scene-visuals'
import type { MapLibreOverlayMap } from '../maplibre/panel-target-overlay-sync'
import { siteMapOverlayIds } from '../maplibre/site-overlay'

class FakeOverlayMap implements MapLibreOverlayMap {
  readonly addSource = vi.fn((id: string, source: Record<string, unknown>) => {
    this.sources.set(id, { source, setData: vi.fn() })
  })
  readonly getSource = vi.fn((id: string) => this.sources.get(id))
  readonly removeSource = vi.fn((id: string) => {
    this.sources.delete(id)
  })
  readonly addLayer = vi.fn((layer: Record<string, unknown>) => {
    if (typeof layer.id === 'string') this.layers.add(layer.id)
  })
  readonly getLayer = vi.fn((id: string) => (this.layers.has(id) ? { id } : undefined))
  readonly removeLayer = vi.fn((id: string) => {
    this.layers.delete(id)
  })
  readonly setPaintProperty = vi.fn()

  readonly sources = new Map<string, { source: Record<string, unknown>; setData(data: unknown): void }>()
  readonly layers = new Set<string>()
}

describe('canvas map surface overlay sync', () => {
  it('paints the Site data pin and line through their contract, again on the map a Retry rebuilds, and clears with neither', () => {
    const ids = siteMapOverlayIds()
    const site = { pin: [2.35, 48.85] as const, profileLine: [[2.35, 48.85], [2.36, 48.86]] as const }
    const map = new FakeOverlayMap()
    syncCanvasMapSurfaceSiteOverlay(map, site)
    syncCanvasMapSurfaceSiteHover(map, [2.355, 48.855])

    expect([...map.layers]).toEqual([...ids.layerIds, ...ids.hover.layerIds])
    expect(map.sources.get(ids.sourceId)?.source).toMatchObject({ type: 'geojson' })
    // The same pin again changes nothing on the map.
    map.addLayer.mockClear()
    syncCanvasMapSurfaceSiteOverlay(map, site)
    expect(map.addLayer).not.toHaveBeenCalled()
    expect(map.sources.get(ids.sourceId)?.setData).not.toHaveBeenCalled()

    // Retry builds a new map: the next drain paints the same pin there.
    const rebuilt = new FakeOverlayMap()
    syncCanvasMapSurfaceSiteOverlay(rebuilt, site)
    expect([...rebuilt.layers]).toEqual([...ids.layerIds])

    syncCanvasMapSurfaceSiteOverlay(map, { pin: null, profileLine: null })
    expect(map.layers.size).toBe(0)
    expect(map.sources.size).toBe(0)
  })

  it('uses the active map backdrop ink for site hover and snapshot paint tokens for the profile guide', () => {
    const ids = siteMapOverlayIds()
    const site = { pin: [2.35, 48.85] as const, profileLine: [[2.35, 48.85], [2.36, 48.86]] as const }
    const customTokens = { ...readCanvasPaintTokens(), 'guide-line': '#123456', 'overlay-casing': '#654321' }
    const map = new FakeOverlayMap()

    syncCanvasMapSurfaceSiteOverlay(map, site, customTokens)
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: ids.layerIds[1],
      paint: expect.objectContaining({ 'line-color': '#123456' }),
    }))
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: ids.layerIds[0],
      paint: expect.objectContaining({ 'line-color': '#654321' }),
    }))

    syncCanvasMapSurfaceSiteHover(map, [2.355, 48.855], 'basemap')
    const lightInk = getMapBackdropInk('basemap')
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: ids.hover.layerIds[0],
      paint: expect.objectContaining({ 'circle-stroke-color': lightInk.text }),
    }))

    // Switching to satellite updates the hover ring ink on the live layer.
    const darkInk = getMapBackdropInk('satellite')
    expect(darkInk.text).not.toBe(lightInk.text)
    syncCanvasMapSurfaceSiteHover(map, [2.355, 48.855], 'satellite')
    expect(map.setPaintProperty).toHaveBeenCalledWith(ids.hover.layerIds[0], 'circle-stroke-color', darkInk.text)
  })
})
