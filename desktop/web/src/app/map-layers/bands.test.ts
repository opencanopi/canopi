import { describe, expect, it, vi } from 'vitest'
import {
  createMapLayerStackDescriptors,
  reconcileMapLayerStack,
  type MapLayerStackDescriptor,
} from './bands'
import {
  MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
  MAPLIBRE_SATELLITE_LAYER_ID,
} from '../../maplibre/config'
import { MAPLIBRE_SHARED_SCENE_LAYER_ID } from '../../maplibre/scene-host-layer'
import { siteHoverOverlayContract, siteMapOverlayContract } from '../../maplibre/site-overlay'
import { userLocationOverlayIds } from '../../maplibre/user-location-overlay'

class FakeOrderMap {
  readonly moveLayer = vi.fn((id: string, beforeId?: string) => {
    const from = this.order.indexOf(id)
    if (from < 0) throw new Error(`Missing layer ${id}`)
    this.order.splice(from, 1)
    if (beforeId == null) {
      this.order.push(id)
      return
    }
    const before = this.order.indexOf(beforeId)
    if (before < 0) throw new Error(`Missing anchor ${beforeId}`)
    this.order.splice(before, 0, id)
  })

  constructor(readonly order: string[]) {}

  getLayersOrder(): string[] { return [...this.order] }
}

function present(order: readonly string[], descriptors: readonly MapLayerStackDescriptor[]): string[] {
  const ids = new Set(descriptors.map((descriptor) => descriptor.id))
  return order.filter((id) => ids.has(id))
}

describe('Map layer stack reconciliation', () => {
  it('repairs shuffled semantic layers without disturbing unknown layer order', () => {
    const descriptors = createMapLayerStackDescriptors(['lidar-first', 'lidar-second'])
    const map = new FakeOrderMap([
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'unmanaged-a',
      'site-pin-core',
      'lidar-second',
      MAPLIBRE_SATELLITE_LAYER_ID,
      'unmanaged-b',
      'lidar-first',
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
    ])
    const expected = descriptors
      .filter((descriptor) => map.order.includes(descriptor.id))
      .map((descriptor) => descriptor.id)

    reconcileMapLayerStack(map, descriptors)

    expect(present(map.order, descriptors)).toEqual(expected)
    expect(map.order.indexOf('unmanaged-a')).toBeLessThan(map.order.indexOf('unmanaged-b'))

    map.moveLayer.mockClear()
    reconcileMapLayerStack(map, descriptors)
    expect(map.moveLayer).not.toHaveBeenCalled()
  })

  it('handles late LiDAR, reordered LiDAR, and missing optional geographic layers', () => {
    const late = new FakeOrderMap([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID, MAPLIBRE_SATELLITE_LAYER_ID, 'contour-major', MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])
    const descriptors = createMapLayerStackDescriptors(['lidar-second', 'lidar-first'])
    late.order.splice(3, 0, 'lidar-first', 'lidar-second')

    reconcileMapLayerStack(late, descriptors)

    expect(present(late.order, descriptors)).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID, MAPLIBRE_SATELLITE_LAYER_ID, 'lidar-second', 'lidar-first',
      'contour-major', MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])
  })

  it('is a no-op when the present semantic layers are already ordered', () => {
    const descriptors = createMapLayerStackDescriptors(['lidar-first'])
    const map = new FakeOrderMap([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID, MAPLIBRE_SATELLITE_LAYER_ID, 'lidar-first', 'unmanaged',
      'contour-minor', MAPLIBRE_SHARED_SCENE_LAYER_ID,
    ])

    reconcileMapLayerStack(map, descriptors)

    expect(map.moveLayer).not.toHaveBeenCalled()
  })

  it('rejects duplicate or invalid descriptors before mutating the map', () => {
    const map = new FakeOrderMap(['base', 'scene'])
    expect(() => reconcileMapLayerStack(map, [
      { id: 'base', band: 'basemap' },
      { id: 'base', band: 'shared-scene' },
    ])).toThrow('duplicate ID')
    expect(() => reconcileMapLayerStack(map, [{ id: ' ', band: 'basemap' }])).toThrow('stable non-empty')
    expect(() => reconcileMapLayerStack(map, [
      { id: 'base', band: 'not-a-band' as never },
    ])).toThrow('invalid band')
    expect(() => reconcileMapLayerStack(map, [
      { id: 'scene', band: 'shared-scene' },
      { id: 'base', band: 'basemap' },
    ])).toThrow('semantic band order')
    expect(map.moveLayer).not.toHaveBeenCalled()
  })

  it('draws the Site data line, pin and chart hover above the panel highlights, in the contracts\' order', () => {
    const descriptors = createMapLayerStackDescriptors(['lidar-first'])
    const site = siteMapOverlayContract({ pin: [2.35, 48.85], profileLine: [[2.35, 48.85], [2.36, 48.86]] })
      .layers.map((layer) => layer.id)
    const hover = siteHoverOverlayContract([2.35, 48.85]).layers.map((layer) => layer.id)
    const interaction = descriptors.filter((descriptor) => descriptor.band === 'interaction-overlay').map((descriptor) => descriptor.id)
    const location = userLocationOverlayIds().layerIds
    expect(interaction.slice(-(site.length + hover.length + location.length), -location.length)).toEqual([...site, ...hover])
    expect(descriptors.findIndex((d) => d.id === site[0]!)).toBeGreaterThan(
      descriptors.findIndex((d) => d.id === MAPLIBRE_SHARED_SCENE_LAYER_ID),
    )

    // A pin added late (below the scene) is moved back on top.
    const map = new FakeOrderMap([
      'site-pin-core',
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'site-hover-ring',
      'site-profile-line',
    ])
    reconcileMapLayerStack(map, descriptors)
    expect(map.order).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'site-profile-line',
      'site-pin-core',
      'site-hover-ring',
    ])
  })

  it('draws the user location above every other overlay, so the dot is never under a highlight or the Site data pin', () => {
    const descriptors = createMapLayerStackDescriptors([])
    const location = userLocationOverlayIds().layerIds
    const interaction = descriptors.filter((descriptor) => descriptor.band === 'interaction-overlay').map((descriptor) => descriptor.id)
    expect(interaction.slice(-location.length)).toEqual([...location])

    // A dot added before the scene layer (a rebuilt map adds the scene after its first drain) is moved back on top.
    const map = new FakeOrderMap([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      'user-location-accuracy',
      'user-location-ring',
      'user-location-core',
      MAPLIBRE_SATELLITE_LAYER_ID,
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'site-pin-core',
    ])
    reconcileMapLayerStack(map, descriptors)
    expect(map.order).toEqual([
      MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
      MAPLIBRE_SATELLITE_LAYER_ID,
      MAPLIBRE_SHARED_SCENE_LAYER_ID,
      'site-pin-core',
      'user-location-accuracy',
      'user-location-ring',
      'user-location-core',
    ])
  })
})
