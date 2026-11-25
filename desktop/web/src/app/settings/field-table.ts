/**
 * app/settings/field-table.ts: Single declarative field table and step vocabulary
 * for device settings (ADR 0024, ADR 0026, ADR 0030; 2.1-M518, 2.1-M523, 2.1-Q120,
 * 2.1-Q164, 2.1-Q169, 2.1-Q345).
 *
 * Every settings field declares its key, slice, optional edition capability,
 * required privacy classification (`secret` | `reported` | `omitted`), default
 * spec, and value validator/normalizer kind. One TS interpreter (`interpreter.ts`)
 * derives defaults, decoding, per-field reset, normalization, equality, patch
 * diffs, and the problem-report settings summary from this table.
 */
import type {
  BasemapStyle,
  LastView,
  PlantLabels,
  SatelliteSource,
  Settings,
  Theme,
} from '../../generated/contracts'
import type { EditionCapabilityId as EditionCapability } from '../../generated/edition-capabilities'
import type { UnitSystem } from '../../generated/quantity-table'
import {
  DEFAULT_SETTINGS,
  SETTINGS_BASEMAP_STYLES,
  SETTINGS_LOCALES,
  SETTINGS_PLANT_LABELS,
  SETTINGS_SATELLITE_SOURCES,
  SETTINGS_SCROLL_WHEELS,
  SETTINGS_THEMES,
} from '../../generated/settings'

type SettingsPrivacy = 'secret' | 'reported' | 'omitted'

type SettingsSliceId =
  | 'locale'
  | 'theme'
  | 'units'
  | 'map-and-imagery'
  | 'canvas-preferences'
  | 'keyboard-shortcuts'
  | 'new-designs'
  | 'workspace'
  | 'updates'

const SETTINGS_UNIT_SYSTEMS = ['metric', 'us_customary'] as const satisfies readonly UnitSystem[]

export const DEFAULT_SAVED_STAMPS_FRAME_HEIGHT = 220
export const MIN_FAVORITES_FRAME_HEIGHT = 120
export const MIN_SIDE_PANEL_WIDTH = 320
export const MIN_PLANT_SYMBOL_SCALE = 0.5
export const MAX_PLANT_SYMBOL_SCALE = 2.0

/** Full TS settings values: the 27 v1 wire fields plus 2.1's `unit_system`, `last_open_home`, and `launch_check`. */
export interface SettingsValues extends Settings {
  unit_system: UnitSystem
  last_open_home: string | null
  launch_check: boolean
}

export type SettingsFieldKey = keyof SettingsValues

export const DEFAULT_SETTINGS_VALUES: Readonly<SettingsValues> = {
  ...DEFAULT_SETTINGS,
  used_canvas_tools: [...DEFAULT_SETTINGS.used_canvas_tools],
  unit_system: 'metric',
  last_open_home: null,
  launch_check: true,
}

export type DefaultSpec<T> =
  | { readonly kind: 'static'; readonly value: T }
  | { readonly kind: 'first_language' }
  | { readonly kind: 'from_region' }
  | { readonly kind: 'from_os_scroll_wheel' }

export type SettingsValueKind =
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'nullable_enum'; readonly values: readonly string[] }
  | { readonly type: 'boolean' }
  | { readonly type: 'nullable_boolean' }
  | {
      readonly type: 'finite_number'
      readonly min?: number
      readonly max?: number
      readonly exclusiveMin?: number
      readonly clamp?: boolean
    }
  | { readonly type: 'u32' }
  | { readonly type: 'nullable_u32'; readonly min?: number; readonly round?: boolean }
  | { readonly type: 'nullable_string'; readonly trimOnSave?: boolean; readonly nonEmpty?: boolean }
  | { readonly type: 'last_view' }
  | { readonly type: 'string_array' }

export interface SettingsFieldDescriptor<K extends SettingsFieldKey = SettingsFieldKey> {
  readonly key: K
  readonly slice: SettingsSliceId
  readonly capability?: EditionCapability
  readonly privacy: SettingsPrivacy
  readonly defaultSpec: DefaultSpec<SettingsValues[K]>
  readonly kind: SettingsValueKind
}

/** Declarative step vocabulary for the settings store chain (ADR 0026, 2.1-M518). */
export type SettingsStep =
  | { readonly kind: 'add_field'; readonly key: string; readonly defaultSpec: DefaultSpec<unknown> }
  | { readonly kind: 'rename_field'; readonly from: string; readonly to: string }
  | { readonly kind: 'drop_field'; readonly key: string }
  | {
      readonly kind: 'map_literal'
      readonly key: string
      readonly mapping: Readonly<Record<string, unknown>>
    }

function f<K extends SettingsFieldKey>(
  key: K,
  slice: SettingsSliceId,
  privacy: SettingsPrivacy,
  defaultSpec: DefaultSpec<SettingsValues[K]>,
  kind: SettingsValueKind,
  capability?: EditionCapability,
): SettingsFieldDescriptor<K> {
  return capability ? { key, slice, capability, privacy, defaultSpec, kind } : { key, slice, privacy, defaultSpec, kind }
}

const s = <T>(value: T): DefaultSpec<T> => ({ kind: 'static', value })
const BOOL: SettingsValueKind = { type: 'boolean' }
const OPACITY: SettingsValueKind = { type: 'finite_number', min: 0, max: 1, clamp: true }
const D = DEFAULT_SETTINGS

/** Exhaustive ordered table of every settings field (ADR 0024, 2.1-M518). */
export const SETTINGS_FIELDS = [
  f('locale', 'locale', 'reported', { kind: 'first_language' }, { type: 'enum', values: SETTINGS_LOCALES }),
  f('theme', 'theme', 'reported', s(D.theme as Theme), { type: 'enum', values: SETTINGS_THEMES }),
  f('unit_system', 'units', 'reported', { kind: 'from_region' }, { type: 'enum', values: SETTINGS_UNIT_SYSTEMS }),
  f('snap_to_grid', 'canvas-preferences', 'reported', s(D.snap_to_grid), BOOL),
  f('side_panel_width', 'workspace', 'omitted', s(D.side_panel_width), { type: 'nullable_u32', min: MIN_SIDE_PANEL_WIDTH, round: true }),
  f('saved_stamps_frame_height', 'workspace', 'omitted', s(D.saved_stamps_frame_height), { type: 'nullable_u32', min: MIN_FAVORITES_FRAME_HEIGHT, round: true }),
  f('basemap_style', 'map-and-imagery', 'reported', s(D.basemap_style as BasemapStyle), { type: 'enum', values: SETTINGS_BASEMAP_STYLES }),
  f('basemap_visible', 'map-and-imagery', 'reported', s(D.basemap_visible), BOOL),
  f('basemap_opacity', 'map-and-imagery', 'omitted', s(D.basemap_opacity), OPACITY),
  f('satellite_visible', 'map-and-imagery', 'reported', s(D.satellite_visible), BOOL),
  f('satellite_opacity', 'map-and-imagery', 'omitted', s(D.satellite_opacity), OPACITY),
  f('google_maps_api_key', 'map-and-imagery', 'secret', s(D.google_maps_api_key), { type: 'nullable_string', trimOnSave: true }),
  f('satellite_source', 'map-and-imagery', 'reported', s(D.satellite_source as SatelliteSource | null), { type: 'nullable_enum', values: SETTINGS_SATELLITE_SOURCES }),
  f('contour_visible', 'map-and-imagery', 'reported', s(D.contour_visible), BOOL),
  f('contour_opacity', 'map-and-imagery', 'omitted', s(D.contour_opacity), OPACITY),
  f('contour_interval', 'map-and-imagery', 'omitted', s(D.contour_interval), { type: 'u32' }),
  f('hillshade_visible', 'map-and-imagery', 'reported', s(D.hillshade_visible), BOOL),
  f('hillshade_opacity', 'map-and-imagery', 'omitted', s(D.hillshade_opacity), OPACITY),
  f('soften_background', 'map-and-imagery', 'reported', s(D.soften_background), BOOL),
  f('plant_spacing_interval_m', 'canvas-preferences', 'reported', s(D.plant_spacing_interval_m), { type: 'finite_number', exclusiveMin: 0 }),
  f('last_view', 'workspace', 'omitted', s(D.last_view as LastView | null), { type: 'last_view' }),
  f('last_open_home', 'workspace', 'omitted', s(null), { type: 'nullable_string', nonEmpty: true }),
  f('used_canvas_tools', 'workspace', 'omitted', s([] as string[]), { type: 'string_array' }),
  f('tool_names_visible', 'workspace', 'omitted', s(D.tool_names_visible), { type: 'nullable_boolean' }),
  f('single_key_shortcuts', 'keyboard-shortcuts', 'reported', s(D.single_key_shortcuts), BOOL),
  f('scroll_wheel', 'canvas-preferences', 'reported', { kind: 'from_os_scroll_wheel' }, { type: 'enum', values: SETTINGS_SCROLL_WHEELS }),
  f('new_design_satellite', 'new-designs', 'reported', s(D.new_design_satellite), BOOL),
  f('new_design_symbol_scale', 'new-designs', 'reported', s(D.new_design_symbol_scale), { type: 'finite_number', min: MIN_PLANT_SYMBOL_SCALE, max: MAX_PLANT_SYMBOL_SCALE, clamp: true }),
  f('new_design_labels', 'new-designs', 'reported', s(D.new_design_labels as PlantLabels), { type: 'enum', values: SETTINGS_PLANT_LABELS }),
  f('launch_check', 'updates', 'reported', s(true), BOOL, 'app-updater'),
] as const satisfies readonly SettingsFieldDescriptor[]

/** Keys belonging to the v1 Rust `Settings` wire struct (until 2e-2 moves Desktop to opaque record 2). */
export const SETTINGS_V1_WIRE_KEYS: readonly (keyof Settings)[] = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>
