import { computed, signal } from '@preact/signals'
import type { LastView, Locale, PlantLabels, SatelliteSource, ScrollWheel, Theme } from '../../generated/contracts'
import { DEFAULT_SETTINGS } from '../../generated/settings'

export const locale = signal<Locale>(DEFAULT_SETTINGS.locale)
export const theme = signal<Theme>(DEFAULT_SETTINGS.theme)

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

/** Plant Spacing Interval in meters — app tool preference, not design data. */
export const plantSpacingIntervalM = signal<number>(DEFAULT_SETTINGS.plant_spacing_interval_m)

export const DEFAULT_SAVED_STAMPS_FRAME_HEIGHT = 220
export const MIN_FAVORITES_FRAME_HEIGHT = 120

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
