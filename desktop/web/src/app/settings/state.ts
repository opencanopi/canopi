import { computed, signal } from '@preact/signals'
import type { BasemapStyle, LastView, Locale, PlantLabels, SatelliteSource, ScrollWheel, Theme } from '../../generated/contracts'
import type { UnitSystem } from '../../generated/quantity-table'
import { DEFAULT_SETTINGS, SETTINGS_BASEMAP_STYLES } from '../../generated/settings'

const DEFAULT_SAVED_STAMPS_FRAME_HEIGHT = 220
export const MIN_FAVORITES_FRAME_HEIGHT = 120

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
 * Owned by settings (ADR 0024); `app/map-layers/state.ts` re-exports this slice and its read helpers.
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

export function createDefaultMapLayers(): MapLayersState {
  return normalizeMapLayers({
    basemap: {
      style: DEFAULT_SETTINGS.basemap_style,
      visible: DEFAULT_SETTINGS.basemap_visible,
      opacity: DEFAULT_SETTINGS.basemap_opacity,
    },
    satellite: {
      visible: DEFAULT_SETTINGS.satellite_visible,
      opacity: DEFAULT_SETTINGS.satellite_opacity,
    },
    contours: {
      visible: DEFAULT_SETTINGS.contour_visible,
      opacity: DEFAULT_SETTINGS.contour_opacity,
      intervalMeters: DEFAULT_SETTINGS.contour_interval,
    },
    hillshade: {
      visible: DEFAULT_SETTINGS.hillshade_visible,
      opacity: DEFAULT_SETTINGS.hillshade_opacity,
    },
    softenBackground: DEFAULT_SETTINGS.soften_background,
  })
}

export function mapLayersEqual(left: MapLayersState, right: MapLayersState): boolean {
  return left.basemap.style === right.basemap.style
    && left.basemap.visible === right.basemap.visible
    && left.basemap.opacity === right.basemap.opacity
    && left.satellite.visible === right.satellite.visible
    && left.satellite.opacity === right.satellite.opacity
    && left.contours.visible === right.contours.visible
    && left.contours.opacity === right.contours.opacity
    && left.contours.intervalMeters === right.contours.intervalMeters
    && left.hillshade.visible === right.hillshade.visible
    && left.hillshade.opacity === right.hillshade.opacity
    && left.softenBackground === right.softenBackground
}

export const mapLayers = signal<MapLayersState>(createDefaultMapLayers())
