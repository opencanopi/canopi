import type { SettingsPlatformAdapter } from '../app/settings/platform-adapter'
import {
  DEFAULT_SETTINGS,
  SETTINGS_BASEMAP_STYLES,
  SETTINGS_LOCALES,
  SETTINGS_PLANT_LABELS,
  SETTINGS_SATELLITE_SOURCES,
  SETTINGS_SCROLL_WHEELS,
  SETTINGS_THEMES,
} from '../generated/settings'
import type { Settings } from '../types/settings'
import {
  browserAppDataStore,
  type BrowserAppDataStore,
} from '../web/browser-app-data'
import { StoreUnreadableError } from '../failures/store-read'

type BrowserSettingsStore = Pick<BrowserAppDataStore, 'loadSettings' | 'saveSettings'>

const MAX_U32 = 4_294_967_295

export function createBrowserSettingsPlatformAdapter(
  store: BrowserSettingsStore = browserAppDataStore,
): SettingsPlatformAdapter {
  return {
    load: () => readBrowserSettings(loadStoredSettings(store)),
    save: async (settings) => {
      const result = store.saveSettings({ ...settings })
      if (!result.ok) throw result.error
    },
  }
}

export const browserSettingsPlatformAdapter = createBrowserSettingsPlatformAdapter()

/**
 * The stored record, or why it cannot be read as a typed refusal (SET-05 on Web): a record this edition cannot read
 * (the store's own refusal), or the browser refusing storage access, a SecurityError in a locked-down context.
 */
function loadStoredSettings(store: BrowserSettingsStore): Record<string, unknown> | null {
  try {
    return store.loadSettings()
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error
    throw new StoreUnreadableError('settings', { kind: 'io', io: 'permission_denied' }, { cause: error })
  }
}

function readBrowserSettings(stored: Record<string, unknown> | null): Settings {
  const value = stored ?? {}
  return {
    locale: readEnum(value.locale, SETTINGS_LOCALES, DEFAULT_SETTINGS.locale),
    theme: readEnum(value.theme, SETTINGS_THEMES, DEFAULT_SETTINGS.theme),
    snap_to_grid: readBoolean(value.snap_to_grid, DEFAULT_SETTINGS.snap_to_grid),
    side_panel_width: readNullableU32(value.side_panel_width, DEFAULT_SETTINGS.side_panel_width),
    saved_stamps_frame_height: readNullableU32(
      value.saved_stamps_frame_height,
      DEFAULT_SETTINGS.saved_stamps_frame_height,
    ),
    basemap_style: readEnum(value.basemap_style, SETTINGS_BASEMAP_STYLES, DEFAULT_SETTINGS.basemap_style),
    basemap_visible: readBoolean(value.basemap_visible, DEFAULT_SETTINGS.basemap_visible),
    basemap_opacity: readFiniteNumber(value.basemap_opacity, DEFAULT_SETTINGS.basemap_opacity),
    satellite_visible: readBoolean(value.satellite_visible, DEFAULT_SETTINGS.satellite_visible),
    satellite_opacity: readFiniteNumber(value.satellite_opacity, DEFAULT_SETTINGS.satellite_opacity),
    // Absent, null or a non-string all mean "no key": Google serves keyless tiles.
    google_maps_api_key: readNullableString(
      value.google_maps_api_key,
      DEFAULT_SETTINGS.google_maps_api_key ?? null,
    ),
    satellite_source: typeof value.satellite_source === 'string'
      && (SETTINGS_SATELLITE_SOURCES as readonly string[]).includes(value.satellite_source)
      ? value.satellite_source as Settings['satellite_source']
      : null,
    contour_visible: readBoolean(value.contour_visible, DEFAULT_SETTINGS.contour_visible),
    contour_opacity: readFiniteNumber(value.contour_opacity, DEFAULT_SETTINGS.contour_opacity),
    contour_interval: readU32(value.contour_interval, DEFAULT_SETTINGS.contour_interval),
    hillshade_visible: readBoolean(value.hillshade_visible, DEFAULT_SETTINGS.hillshade_visible),
    hillshade_opacity: readFiniteNumber(
      value.hillshade_opacity,
      DEFAULT_SETTINGS.hillshade_opacity,
    ),
    soften_background: readBoolean(value.soften_background, DEFAULT_SETTINGS.soften_background),
    plant_spacing_interval_m: readFiniteNumber(
      value.plant_spacing_interval_m,
      DEFAULT_SETTINGS.plant_spacing_interval_m,
    ),
    last_view: readLastView(value.last_view),
    used_canvas_tools: readStrings(value.used_canvas_tools),
    tool_names_visible: typeof value.tool_names_visible === 'boolean' ? value.tool_names_visible : null,
    single_key_shortcuts: readBoolean(value.single_key_shortcuts, DEFAULT_SETTINGS.single_key_shortcuts),
    scroll_wheel: readEnum(value.scroll_wheel, SETTINGS_SCROLL_WHEELS, DEFAULT_SETTINGS.scroll_wheel),
    new_design_satellite: readBoolean(value.new_design_satellite, DEFAULT_SETTINGS.new_design_satellite),
    new_design_symbol_scale: readFiniteNumber(
      value.new_design_symbol_scale,
      DEFAULT_SETTINGS.new_design_symbol_scale,
    ),
    new_design_labels: readEnum(value.new_design_labels, SETTINGS_PLANT_LABELS, DEFAULT_SETTINGS.new_design_labels),
  }
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T)
    ? value as T
    : fallback
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readU32(value: unknown, fallback: number): number {
  return isU32(value) ? value : fallback
}

function readLastView(value: unknown): Settings['last_view'] {
  if (!value || typeof value !== 'object') return null
  const { lon, lat, zoom } = value as Record<string, unknown>
  return [lon, lat, zoom].every((part) => typeof part === 'number' && Number.isFinite(part))
    ? { lon: lon as number, lat: lat as number, zoom: zoom as number }
    : null
}

function readNullableString(value: unknown, fallback: string | null): string | null {
  return value === null || typeof value === 'string' ? value : fallback
}

function readNullableU32(value: unknown, fallback: number | null): number | null {
  return value === null || isU32(value) ? value : fallback
}

function isU32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_U32
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
