import { computed, signal } from '@preact/signals'
import type { BasemapStyle, LastView, Locale, PlantLabels, SatelliteSource, ScrollWheel, Settings, Theme } from '../../generated/contracts'
import type { UnitSystem } from '../../generated/quantity-table'
import { DEFAULT_SETTINGS, SETTINGS_BASEMAP_STYLES } from '../../generated/settings'
import { DEFAULT_SAVED_STAMPS_FRAME_HEIGHT, MIN_FAVORITES_FRAME_HEIGHT } from './field-table'

export { MIN_FAVORITES_FRAME_HEIGHT }

export const locale = signal<Locale>(DEFAULT_SETTINGS.locale)
export const theme = signal<Theme>(DEFAULT_SETTINGS.theme)

/** Display & input unit system (metric or US customary); stamped from region at first run or upgrade (2.1-Q120, Q169). */
export const unitSystem = signal<UnitSystem>('metric')

/** Snap-to-grid tool preference — owned by settings (ADR 0024). */
export const snapToGridEnabled = signal<boolean>(DEFAULT_SETTINGS.snap_to_grid)

/**
 * Device-local Google Maps API key, or null for the keyless tile path.
 *
 * This is a browser credential: it lives in device settings only and must
 * never reach a Design, export, diagnostic bundle, log or error text.
 */
export const googleMapsApiKey = signal<string | null>(
  DEFAULT_SETTINGS.google_maps_api_key ?? null,
)

/**
 * Settings › Map and imagery: the free imagery or the device's Google key.
 * Choosing the free imagery keeps a saved key; only Remove key forgets it.
 */
export const satelliteSource = signal<SatelliteSource>('free')

/** The key the satellite provider uses: the saved key while the Google source is chosen, else none. */
export const activeGoogleMapsApiKey = computed<string | null>(() =>
  satelliteSource.value === 'google_key' ? googleMapsApiKey.value : null,
)

/** The camera view last shown on a Design; a new Design opens here. */
export const lastView = signal<LastView | null>(DEFAULT_SETTINGS.last_view ?? null)

/**
 * The home key of the last open Design (ADR 0024, 2.1-M523, A27).
 * Holds only a home key (never a filesystem path or grant id); null when closed or none.
 */
export const lastOpenHome = signal<string | null>(null)

/** Whether Desktop checks for updates at launch (2.1-Q164; capability `app-updater`). */
export const launchCheck = signal<boolean>(true)

/** Plant Spacing Interval in meters — app tool preference, not design data. */
export const plantSpacingIntervalM = signal<number>(DEFAULT_SETTINGS.plant_spacing_interval_m)

/** Saved Stamps frame height in pixels — app preference, not design data. */
export const savedStampsFrameHeight = signal<number>(
  DEFAULT_SETTINGS.saved_stamps_frame_height ?? DEFAULT_SAVED_STAMPS_FRAME_HEIGHT,
)

/** Sidebar width in pixels. null = no explicit user resize, so the shell uses the responsive first-use default. */
export const sidePanelWidth = signal<number | null>(DEFAULT_SETTINGS.side_panel_width)

/** Canvas tools used at least once on this device; the tool rail shows names until all are used. */
export const usedCanvasTools = signal<readonly string[]>(DEFAULT_SETTINGS.used_canvas_tools)

/** View › Tool names: null follows first use, a boolean is the user's choice. */
export const toolNamesVisible = signal<boolean | null>(DEFAULT_SETTINGS.tool_names_visible ?? null)

/** Settings › Keyboard: character-key shortcuts (V, P, N, Shift G, brackets) are on. */
export const singleKeyShortcuts = signal<boolean>(DEFAULT_SETTINGS.single_key_shortcuts)

/** Settings › Canvas: a plain wheel or two-finger scroll zooms or pans the map. Pinch and Ctrl wheel always zoom. */
export const scrollWheel = signal<ScrollWheel>(DEFAULT_SETTINGS.scroll_wheel)

/** Settings › New Designs: what a new Design starts with. Never applied to an existing Design. */
export interface NewDesignDefaults {
  /** Turn Satellite on when the Design is created; off keeps the last background. */
  readonly satellite: boolean
  readonly symbolScale: number
  readonly labels: PlantLabels
}

export const newDesignDefaults = signal<NewDesignDefaults>({
  satellite: DEFAULT_SETTINGS.new_design_satellite,
  symbolScale: DEFAULT_SETTINGS.new_design_symbol_scale,
  labels: DEFAULT_SETTINGS.new_design_labels,
})

/**
 * Map layers slice state (Basemap, Satellite, Contours, Hillshade, Soften background).
 * Owned by settings (ADR 0024, 2.1-M137); `app/map-layers/` holds its actions and read model.
 */
export interface MapLayersState {
  readonly basemap: {
    readonly style: BasemapStyle
    readonly visible: boolean
    readonly opacity: number
  }
  readonly satellite: {
    readonly visible: boolean
    readonly opacity: number
  }
  readonly contours: {
    readonly visible: boolean
    readonly opacity: number
    readonly intervalMeters: number
  }
  readonly hillshade: {
    readonly visible: boolean
    readonly opacity: number
  }
  /** Display on the map › Soften background: the background band is dimmed to SOFTENED_BACKGROUND_OPACITY_FACTOR. */
  readonly softenBackground: boolean
}

function unitInterval(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

export function normalizeMapLayers(state: MapLayersState): MapLayersState {
  return Object.freeze({
    basemap: Object.freeze({
      style: SETTINGS_BASEMAP_STYLES.includes(state.basemap.style)
        ? state.basemap.style
        : DEFAULT_SETTINGS.basemap_style,
      visible: state.basemap.visible === true,
      opacity: unitInterval(state.basemap.opacity, 1),
    }),
    satellite: Object.freeze({
      visible: state.satellite.visible === true,
      opacity: unitInterval(state.satellite.opacity, 1),
    }),
    contours: Object.freeze({
      visible: state.contours.visible === true,
      opacity: unitInterval(state.contours.opacity, 1),
      intervalMeters: Number.isFinite(state.contours.intervalMeters) && state.contours.intervalMeters >= 0
        ? Math.round(state.contours.intervalMeters)
        : 0,
    }),
    hillshade: Object.freeze({
      visible: state.hillshade.visible === true,
      opacity: unitInterval(state.hillshade.opacity, DEFAULT_SETTINGS.hillshade_opacity),
    }),
    softenBackground: state.softenBackground === true,
  })
}

type MapLayerSettingsFields = Pick<
  Settings,
  | 'basemap_style'
  | 'basemap_visible'
  | 'basemap_opacity'
  | 'satellite_visible'
  | 'satellite_opacity'
  | 'contour_visible'
  | 'contour_opacity'
  | 'contour_interval'
  | 'hillshade_visible'
  | 'hillshade_opacity'
  | 'soften_background'
>

/** Projects flat settings fields into the normalised map-layers slice (2.1-M137). */
export function mapLayersFromSettings(v: MapLayerSettingsFields): MapLayersState {
  return normalizeMapLayers({
    basemap: { style: v.basemap_style, visible: v.basemap_visible, opacity: v.basemap_opacity },
    satellite: { visible: v.satellite_visible, opacity: v.satellite_opacity },
    contours: { visible: v.contour_visible, opacity: v.contour_opacity, intervalMeters: v.contour_interval },
    hillshade: { visible: v.hillshade_visible, opacity: v.hillshade_opacity },
    softenBackground: v.soften_background,
  })
}

/** Projects the map-layers slice back into flat settings fields (2.1-M137). */
export function mapLayersToSettingsFields(layers: MapLayersState): MapLayerSettingsFields {
  return {
    basemap_style: layers.basemap.style,
    basemap_visible: layers.basemap.visible,
    basemap_opacity: layers.basemap.opacity,
    satellite_visible: layers.satellite.visible,
    satellite_opacity: layers.satellite.opacity,
    contour_visible: layers.contours.visible,
    contour_opacity: layers.contours.opacity,
    contour_interval: layers.contours.intervalMeters,
    hillshade_visible: layers.hillshade.visible,
    hillshade_opacity: layers.hillshade.opacity,
    soften_background: layers.softenBackground,
  }
}

/** @testonly */ export function createDefaultMapLayersForTests(): MapLayersState {
  return mapLayersFromSettings(DEFAULT_SETTINGS)
}

export const mapLayers = signal<MapLayersState>(mapLayersFromSettings(DEFAULT_SETTINGS))

const SOFTENED_BACKGROUND_OPACITY_FACTOR = 0.4

/** The opacity the background band is drawn with: its own, dimmed when softened. */
export function effectiveBackgroundOpacity(state: MapLayersState, layer: 'basemap' | 'satellite'): number {
  return state[layer].opacity * (state.softenBackground ? SOFTENED_BACKGROUND_OPACITY_FACTOR : 1)
}

/** Which layer paints the background band: Satellite hides the Basemap. */
export type MapBackground = 'satellite' | 'basemap' | 'none'

export function mapBackgroundOf(state: MapLayersState): MapBackground {
  if (state.satellite.visible) return 'satellite'
  return state.basemap.visible ? 'basemap' : 'none'
}

export function hasVisibleMapLayer(state: MapLayersState): boolean {
  return mapBackgroundOf(state) !== 'none' || state.contours.visible || state.hillshade.visible
}

/** Below half opacity a background mostly lets the map's light paper through. */
const BACKDROP_OPACITY_THRESHOLD = 0.5

/**
 * The map backdrop under the Design and contours (contracts §6: never the UI theme).
 */
export function mapBackdropOf(state: MapLayersState): 'paper' | 'basemap' | 'dark-basemap' | 'satellite' {
  switch (mapBackgroundOf(state)) {
    case 'satellite':
      return effectiveBackgroundOpacity(state, 'satellite') < BACKDROP_OPACITY_THRESHOLD ? 'paper' : 'satellite'
    case 'basemap':
      if (effectiveBackgroundOpacity(state, 'basemap') < BACKDROP_OPACITY_THRESHOLD) return 'paper'
      return state.basemap.style === 'dark' ? 'dark-basemap' : 'basemap'
    case 'none':
      return 'paper'
  }
}

/** Whether the map backdrop is dark (satellite imagery or dark basemap; contracts §6). */
export function isDarkMapBackdrop(state: MapLayersState): boolean {
  const backdrop = mapBackdropOf(state)
  return backdrop === 'satellite' || backdrop === 'dark-basemap'
}

/** Contours and Hillshade in the shape the terrain contribution consumes. */
export function mapTerrainStateOf(state: MapLayersState) {
  return {
    contoursVisible: state.contours.visible,
    contoursOpacity: state.contours.opacity,
    contourIntervalMeters: state.contours.intervalMeters,
    hillshadeVisible: state.hillshade.visible,
    hillshadeOpacity: state.hillshade.opacity,
  }
}
