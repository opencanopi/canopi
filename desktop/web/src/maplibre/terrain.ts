import {
  DEM_ENCODING,
  DEM_MAX_ZOOM,
  TERRAIN_DATA_ATTRIBUTION,
  type DemSource,
  getContourLayerConfigs,
  getContourSourceConfig,
  getHillshadeLayerConfig,
} from './contours'

export const TERRAIN_DEM_SOURCE_ID = 'terrain-dem'
export const TERRAIN_CONTOUR_SOURCE_ID = 'terrain-contour-source'
export const TERRAIN_HILLSHADE_LAYER_ID = 'hillshade-layer'
export const TERRAIN_CONTOUR_LAYER_IDS = [
  'contour-minor',
  'contour-major',
] as const

/** What the terrain layers read from the DemSource once it is set up on MapLibre. */
export type TerrainProtocolSupport = Pick<DemSource, 'sharedDemProtocolUrl' | 'contourProtocolUrl'>

export interface TerrainLayerState {
  readonly contourIntervalMeters: number
  readonly contoursVisible: boolean
  readonly contoursOpacity: number
  readonly hillshadeVisible: boolean
  readonly hillshadeOpacity: number
  readonly isDark: boolean
}

function withAlpha(hex: string, opacity: number): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return hex
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, opacity))})`
}

export function buildHillshadePaint(state: TerrainLayerState): Record<string, unknown> {
  const hillshade = getHillshadeLayerConfig(0.6)
  return {
    ...hillshade.paint,
    'hillshade-shadow-color': withAlpha('#5a4a3a', state.hillshadeOpacity),
    'hillshade-highlight-color': withAlpha('#faf7f2', state.hillshadeOpacity),
    'hillshade-accent-color': withAlpha('#8b7355', state.hillshadeOpacity),
  }
}

export function buildContourPaints(
  state: TerrainLayerState,
): { minor: Record<string, unknown>; major: Record<string, unknown> } {
  const contourLayers = getContourLayerConfigs(state.isDark)
  const minorOpacity = Number(contourLayers.minor.paint['line-opacity'] ?? 1) * state.contoursOpacity
  const majorOpacity = Number(contourLayers.major.paint['line-opacity'] ?? 1) * state.contoursOpacity
  return {
    minor: {
      ...contourLayers.minor.paint,
      'line-opacity': minorOpacity,
    },
    major: {
      ...contourLayers.major.paint,
      'line-opacity': majorOpacity,
    },
  }
}

export function createTerrainSources(
  protocols: TerrainProtocolSupport,
  state: TerrainLayerState,
): Array<{ id: string; source: Record<string, unknown> }> {
  const sources: Array<{ id: string; source: Record<string, unknown> }> = []

  if (state.hillshadeVisible) {
    sources.push({
      id: TERRAIN_DEM_SOURCE_ID,
      source: {
        type: 'raster-dem',
        tiles: [protocols.sharedDemProtocolUrl],
        maxzoom: DEM_MAX_ZOOM,
        tileSize: 256,
        encoding: DEM_ENCODING,
        attribution: TERRAIN_DATA_ATTRIBUTION,
      },
    })
  }

  if (state.contoursVisible) {
    sources.push({
      id: TERRAIN_CONTOUR_SOURCE_ID,
      source: getContourSourceConfig(protocols.contourProtocolUrl, state.contourIntervalMeters),
    })
  }

  return sources
}

export function createTerrainLayers(
  state: TerrainLayerState,
): Array<Record<string, unknown>> {
  const layers: Array<Record<string, unknown>> = []

  if (state.hillshadeVisible) {
    const hillshade = getHillshadeLayerConfig(0.6)
    layers.push({
      ...hillshade,
      source: TERRAIN_DEM_SOURCE_ID,
      paint: buildHillshadePaint(state),
    })
  }

  if (state.contoursVisible) {
    const contourLayers = getContourLayerConfigs(state.isDark)
    const paints = buildContourPaints(state)
    layers.push({
      ...contourLayers.minor,
      source: TERRAIN_CONTOUR_SOURCE_ID,
      paint: paints.minor,
    })
    layers.push({
      ...contourLayers.major,
      source: TERRAIN_CONTOUR_SOURCE_ID,
      paint: paints.major,
    })
  }

  return layers
}
