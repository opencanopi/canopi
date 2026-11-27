import { describe, expect, it, vi } from 'vitest'
import { siteMapOverlayContract, siteMapOverlayIds } from './site-overlay'
import { clearMapOverlay, syncMapOverlay } from './panel-target-overlay-sync'

function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Set<string>()
  return {
    sources,
    addSource: vi.fn((id: string) => { sources.set(id, { setData: vi.fn() }) }),
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id) },
    addLayer: vi.fn((layer: { id: string }) => { layers.add(layer.id) }),
    getLayer: (id: string) => (layers.has(id) ? {} : undefined),
    setPaintProperty: vi.fn(),
    removeLayer: (id: string) => { layers.delete(id) },
  }
}

function overlayAt(lon: number, lat: number) {
  return siteMapOverlayContract({
    pin: [lon, lat],
    profileLine: [[lon, lat], [lon + 0.001, lat]],
  })
}

describe('map overlay sync data', () => {
  it('sets an overlay source\'s data only when the projected data changed', () => {
    const map = fakeMap()
    const ids = siteMapOverlayIds()
    syncMapOverlay(map as never, overlayAt(1.5, 43.6))
    const source = map.sources.get(ids.sourceId)!

    // A re-sync with the same ground (a settled camera, a repaint) leaves the source alone.
    syncMapOverlay(map as never, overlayAt(1.5, 43.6))
    syncMapOverlay(map as never, overlayAt(1.5, 43.6))
    expect(source.setData).not.toHaveBeenCalled()

    // Moved coordinates change the data: it is set once.
    const moved = overlayAt(1.51, 43.6)
    syncMapOverlay(map as never, moved)
    syncMapOverlay(map as never, overlayAt(1.51, 43.6))
    expect(source.setData).toHaveBeenCalledOnce()
    expect(source.setData).toHaveBeenCalledWith(moved.source.data)

    // A cleared overlay starts again from its added source.
    clearMapOverlay(map as never, ids)
    syncMapOverlay(map as never, overlayAt(1.51, 43.6))
    expect(map.addSource).toHaveBeenCalledTimes(2)
    expect(map.sources.get(ids.sourceId)!.setData).not.toHaveBeenCalled()
  })
})
