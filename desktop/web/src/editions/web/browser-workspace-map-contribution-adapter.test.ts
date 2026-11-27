import { afterEach, describe, expect, it, vi } from 'vitest'
import { effect, signal } from '@preact/signals'
import { clearPanelOriginTargets, setHoveredPanelTargets } from '../../app/panel-targets/presentation'
import { createTestCanvasQuerySurface, type TestPlacement } from '../../__tests__/support/canvas-query-surface'
import { createSessionPlane, type SessionPlane } from '../../geo/session-plane'
import { createBrowserWorkspaceMapContributionAdapter } from './browser-workspace-map-contribution-adapter'
import { markCanvasPaintChanged } from '../../canvas/theme-refresh'
import { myLocation } from '../../app/my-location/session'
import { setMapBackground, setMapLayerVisible } from '../../app/map-layers/actions'
import {
  createDefaultMapLayersForTests as createDefaultMapLayers,
  mapLayers,
  theme,
} from '../../app/settings/state'
import { classifyTerrainSync } from '../../maplibre/terrain-sync'
import { setStoryPresentationOverrides } from '../../app/story-presentation/overrides'
import { getHillshadeLayerConfig } from '../../maplibre/contours'

afterEach(clearPanelOriginTargets)

function runtimeWithPlane(
  plane: SessionPlane | null,
  placement?: TestPlacement,
) {
  return createTestCanvasQuerySurface({ placement, sessionPlane: plane })
}

describe('browser workspace map contribution adapter', () => {
  it('returns null without querying scene when no Design exists, and exposes Web terrain support (2.1-Q25)', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({ sessionIdentity: signal({}), hasCurrentDesign: () => false })
    const runtime = runtimeWithPlane(createSessionPlane({ lat: 48, lon: 2 }))
    vi.spyOn(runtime, 'getSceneSnapshot')
    expect(adapter.read(runtime)).toBeNull()
    expect(runtime.getSceneSnapshot).not.toHaveBeenCalled()
    expect(adapter.loadTerrainSupport).toBeTypeOf('function')
  })

  it('returns null until the runtime has a session plane', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({ sessionIdentity: signal({}), hasCurrentDesign: () => true })
    expect(adapter.read(runtimeWithPlane(null))).toBeNull()
  })

  it('captures session-bound targets at the session plane origin with explicitly empty LiDAR and terrain', () => {
    const identity = {}
    const adapter = createBrowserWorkspaceMapContributionAdapter({
      sessionIdentity: signal(identity), hasCurrentDesign: () => true,
    })
    setHoveredPanelTargets([{ kind: 'zone', zone_id: 'plot' }])
    const snapshot = adapter.read(runtimeWithPlane(createSessionPlane({ lat: 48, lon: 2 })))!
    expect(snapshot.sessionIdentity).toBe(identity)
    expect(snapshot.lidar).toEqual([])
    expect(snapshot.terrain).toMatchObject({ contoursVisible: false, hillshadeVisible: false })
    expect(snapshot.overlays.location).toEqual({ lat: 48, lon: 2 })
    expect(snapshot.overlays.hoveredTargets).toEqual([{ kind: 'zone', zone_id: 'plot' }])
    expect(snapshot).not.toHaveProperty('designExtentMeters')
    clearPanelOriginTargets()
    expect(snapshot.overlays.hoveredTargets).toHaveLength(1)
  })

  it('suppresses panel Target overlays in overview without changing their authority', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({
      sessionIdentity: signal({}), hasCurrentDesign: () => true,
    })
    setHoveredPanelTargets([{ kind: 'zone', zone_id: 'plot' }])

    const snapshot = adapter.read(runtimeWithPlane(
      createSessionPlane({ lat: 23, lon: 13 }),
      { x: 0, y: 0, scale: 0.01 },
    ))!

    expect(snapshot.overlays.hoveredTargets).toEqual([])
    clearPanelOriginTargets()
    expect(snapshot.overlays.hoveredTargets).toEqual([])
  })

  it('reads again when the canvas paint changes, so overlays already on the map repaint', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({
      sessionIdentity: signal({}), hasCurrentDesign: () => true,
    })
    const runtime = runtimeWithPlane(createSessionPlane({ lat: 48, lon: 2 }))
    let reads = 0
    const stop = effect(() => {
      adapter.read(runtime)
      reads += 1
    })
    try {
      markCanvasPaintChanged()
      expect(reads).toBe(2)
    } finally {
      stop()
    }
  })

  it('feeds the map the location session\'s reading, outside the contributions read (canopi-f47t.53)', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({ sessionIdentity: signal({}), hasCurrentDesign: () => true })
    expect(adapter.readUserLocation?.()).toBeNull()
    let success!: PositionCallback
    const geolocation = { watchPosition: vi.fn((onFix: PositionCallback) => { success = onFix; return 1 }), clearWatch: vi.fn() }
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation })
    try {
      myLocation.press()
      success({ coords: { longitude: 2.35, latitude: 48.85, accuracy: 12 }, timestamp: 1 } as GeolocationPosition)
      expect(adapter.readUserLocation?.()).toEqual({ lon: 2.35, lat: 48.85, accuracy: 12, timestamp: 1, stale: false })
      const snapshot = adapter.read(runtimeWithPlane(createSessionPlane({ lat: 48, lon: 2 })))
      expect(JSON.stringify(snapshot?.overlays.location)).not.toContain('2.35')
      myLocation.press()
      expect(adapter.readUserLocation?.()).toBeNull()
      expect(geolocation.clearWatch).toHaveBeenCalledOnce()
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'geolocation', descriptor)
      else delete (navigator as unknown as Record<string, unknown>).geolocation
    }
  })

  it('applies story step terrain overrides to Web rendering and follows map backdrop rather than UI theme (2.1-Q25, 2.1-Q45, 2.1-Q57)', () => {
    const adapter = createBrowserWorkspaceMapContributionAdapter({ sessionIdentity: signal({}), hasCurrentDesign: () => true })
    const runtime = runtimeWithPlane(createSessionPlane({ lat: 48, lon: 2 }))
    const prevTheme = theme.value
    const prevMapLayers = mapLayers.value
    try {
      setMapBackground('basemap')
      setMapLayerVisible('contours', false)
      setMapLayerVisible('hillshade', false)
      theme.value = 'dark'

      const before = adapter.read(runtime)!
      expect(before.terrain.contoursVisible).toBe(false)
      expect(before.terrain.isDark).toBe(false)

      const defaults = createDefaultMapLayers()
      setStoryPresentationOverrides({
        mapLayers: {
          ...defaults,
          basemap: { ...defaults.basemap, visible: false },
          satellite: { ...defaults.satellite, visible: true },
          contours: { ...defaults.contours, visible: true },
          hillshade: { ...defaults.hillshade, visible: true },
        },
        siteDataIds: new Set(),
        plantLabels: 'names',
        targets: [],
      })
      theme.value = 'light'
      const during = adapter.read(runtime)!
      expect(during.terrain.contoursVisible).toBe(true)
      expect(during.terrain.hillshadeVisible).toBe(true)
      expect(during.terrain.isDark).toBe(true)
      // Story step terrain override triggers an actual terrain rebuild in Web rendering.
      expect(classifyTerrainSync(before.terrain, during.terrain)).toBe('rebuild')

      const hillshade = getHillshadeLayerConfig(0.6)
      expect(hillshade.paint['hillshade-illumination-direction']).toBe(315)
      expect(hillshade.paint['hillshade-illumination-anchor']).toBe('map')
    } finally {
      setStoryPresentationOverrides(null)
      theme.value = prevTheme
      mapLayers.value = prevMapLayers
    }
  })
})
