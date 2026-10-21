import { describe, expect, it, vi } from 'vitest'
import {
  TERRAIN_CONTOUR_LAYER_IDS,
  TERRAIN_CONTOUR_SOURCE_ID,
  TERRAIN_DEM_SOURCE_ID,
  TERRAIN_HILLSHADE_LAYER_ID,
  buildContourPaints,
  buildHillshadePaint,
  createTerrainLayers,
  createTerrainSources,
} from '../maplibre/terrain'
import { TERRAIN_DATA_ATTRIBUTION } from '../canvas/contours'
import {
  applyTerrainPaintUpdates,
  classifyTerrainSync,
} from '../maplibre/terrain-sync'

const PROTOCOLS = {
  sharedDemProtocolUrl: 'canopi-terrain-shared://{z}/{x}/{y}',
  contourProtocolUrl: () => 'canopi-terrain-contours://{z}/{x}/{y}?thresholds=auto',
}

describe('maplibre terrain contract', () => {
  it('creates stable terrain source ids without widening the design layer schema', () => {
    const sources = createTerrainSources(PROTOCOLS, {
      contourIntervalMeters: 0,
      contoursVisible: true,
      contoursOpacity: 0.5,
      hillshadeVisible: true,
      hillshadeOpacity: 0.6,
      isDark: false,
    })

    expect(sources).toEqual([
      expect.objectContaining({
        id: TERRAIN_DEM_SOURCE_ID,
        source: expect.objectContaining({ type: 'raster-dem' }),
      }),
      expect.objectContaining({
        id: TERRAIN_CONTOUR_SOURCE_ID,
        source: expect.objectContaining({
          type: 'vector',
          tiles: ['canopi-terrain-contours://{z}/{x}/{y}?thresholds=auto'],
        }),
      }),
    ])
  })

  // The elevation is the AWS Terrain Tiles (Mapzen, from many public sources); the map credits name them while
  // contours or hillshading draw, through each source's MapLibre attribution, and never otherwise.
  it('credits the terrain data while contours or hillshading are on, and not otherwise', () => {
    const state = {
      contourIntervalMeters: 0,
      contoursVisible: false,
      contoursOpacity: 0.5,
      hillshadeVisible: false,
      hillshadeOpacity: 0.6,
      isDark: false,
    }
    const credits = (next: typeof state) =>
      createTerrainSources(PROTOCOLS, next).map(({ source }) => source.attribution)

    expect(TERRAIN_DATA_ATTRIBUTION).toContain('Mapzen')
    expect(TERRAIN_DATA_ATTRIBUTION).toContain('https://github.com/tilezen/joerd/blob/master/docs/attribution.md')
    expect(credits(state)).toEqual([])
    expect(credits({ ...state, contoursVisible: true })).toEqual([TERRAIN_DATA_ATTRIBUTION])
    expect(credits({ ...state, hillshadeVisible: true })).toEqual([TERRAIN_DATA_ATTRIBUTION])
    expect(credits({ ...state, contoursVisible: true, hillshadeVisible: true }))
      .toEqual([TERRAIN_DATA_ATTRIBUTION, TERRAIN_DATA_ATTRIBUTION])
  })

  // On Web a credit link followed in place would leave the app and lose unsaved view state; it opens a new tab
  // (on Desktop the navigation guard hands it to the system browser).
  it('canopi-eon8.14.5: the terrain credit link opens in a new tab without an opener or referrer', () => {
    const openingTags = TERRAIN_DATA_ATTRIBUTION.match(/<a\s[^>]*>/g) ?? []
    expect(openingTags).toHaveLength(1)
    const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(openingTags[0]!)?.[1]
    expect(attribute('target')).toBe('_blank')
    expect(attribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer'])
  })

  it('scales contour and hillshade styling from the terrain view controls', () => {
    const layers = createTerrainLayers({
      contourIntervalMeters: 10,
      contoursVisible: true,
      contoursOpacity: 0.4,
      hillshadeVisible: true,
      hillshadeOpacity: 0.25,
      isDark: true,
    })

    expect(layers.map((layer) => layer.id)).toEqual([
      TERRAIN_HILLSHADE_LAYER_ID,
      ...TERRAIN_CONTOUR_LAYER_IDS,
    ])
    expect(layers[0]).toEqual(expect.objectContaining({
      paint: expect.objectContaining({
        'hillshade-shadow-color': 'rgba(90, 74, 58, 0.25)',
      }),
    }))
    expect(layers[1]).toEqual(expect.objectContaining({
      source: TERRAIN_CONTOUR_SOURCE_ID,
      paint: expect.objectContaining({
        'line-opacity': 0.24,
      }),
    }))
    expect(layers[2]).toEqual(expect.objectContaining({
      paint: expect.objectContaining({
        'line-opacity': 0.32000000000000006,
      }),
    }))
  })

  it('classifies paint-only terrain changes separately from rebuild changes', () => {
    const previous = {
      contourIntervalMeters: 10,
      contoursVisible: true,
      contoursOpacity: 0.4,
      hillshadeVisible: true,
      hillshadeOpacity: 0.25,
      isDark: false,
    }

    expect(classifyTerrainSync(previous, {
      ...previous,
      contoursOpacity: 0.6,
    })).toBe('paint')
    expect(classifyTerrainSync(previous, {
      ...previous,
      isDark: true,
    })).toBe('paint')
    expect(classifyTerrainSync(previous, {
      ...previous,
      contourIntervalMeters: 25,
    })).toBe('rebuild')
    expect(classifyTerrainSync(previous, {
      ...previous,
      contoursVisible: false,
    })).toBe('rebuild')
    expect(classifyTerrainSync({
      ...previous,
      contoursVisible: false,
    }, {
      ...previous,
      contoursVisible: false,
      contourIntervalMeters: 25,
    })).toBe('noop')
  })

  it('applies paint-only terrain updates without recreating sources or layers', () => {
    const setPaintProperty = vi.fn()
    const map = {
      addSource: vi.fn(),
      getSource: vi.fn(),
      removeSource: vi.fn(),
      addLayer: vi.fn(),
      getLayer: (id: string) => ({ id }),
      removeLayer: vi.fn(),
      setPaintProperty,
    }
    const state = {
      contourIntervalMeters: 10,
      contoursVisible: true,
      contoursOpacity: 0.4,
      hillshadeVisible: true,
      hillshadeOpacity: 0.25,
      isDark: true,
    }

    applyTerrainPaintUpdates(map, state)

    const contourPaints = buildContourPaints(state)
    const hillshadePaint = buildHillshadePaint(state)
    expect(setPaintProperty).toHaveBeenCalledWith(
      TERRAIN_HILLSHADE_LAYER_ID,
      'hillshade-shadow-color',
      hillshadePaint['hillshade-shadow-color'],
    )
    expect(setPaintProperty).toHaveBeenCalledWith(
      TERRAIN_CONTOUR_LAYER_IDS[0],
      'line-opacity',
      contourPaints.minor['line-opacity'],
    )
    expect(map.addSource).not.toHaveBeenCalled()
    expect(map.addLayer).not.toHaveBeenCalled()
  })
})
