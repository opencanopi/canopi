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
import type { Settings } from '../../generated/contracts'
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
const MIN_SIDE_PANEL_WIDTH = 320
const MIN_PLANT_SYMBOL_SCALE = 0.5
const MAX_PLANT_SYMBOL_SCALE = 2.0

/** Full TS settings values: the 28 v1 wire fields (including `last_open_home`) plus `unit_system` and `launch_check`. */
export interface SettingsValues extends Omit<Settings, 'last_open_home'> {
  unit_system: UnitSystem
  last_open_home: string | null
  launch_check: boolean
}

export type SettingsFieldKey = keyof SettingsValues

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
  kind: SettingsValueKind,
  defaultSpec?: DefaultSpec<SettingsValues[K]>,
  capability?: EditionCapability,
): SettingsFieldDescriptor<K> {
  const def =
    defaultSpec ??
    ({ kind: 'static', value: DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS] } as DefaultSpec<SettingsValues[K]>)
  return capability ? { key, slice, capability, privacy, defaultSpec: def, kind } : { key, slice, privacy, defaultSpec: def, kind }
}

const s = <T>(value: T): DefaultSpec<T> => ({ kind: 'static', value })
const en = (values: readonly string[]): SettingsValueKind => ({ type: 'enum', values })
const nu32 = (min: number): SettingsValueKind => ({ type: 'nullable_u32', min, round: true })
const BOOL: SettingsValueKind = { type: 'boolean' }
const OPACITY: SettingsValueKind = { type: 'finite_number', min: 0, max: 1, clamp: true }
const R: SettingsPrivacy = 'reported'
const O: SettingsPrivacy = 'omitted'
const M: SettingsSliceId = 'map-and-imagery'
const W: SettingsSliceId = 'workspace'
const C: SettingsSliceId = 'canvas-preferences'
const N: SettingsSliceId = 'new-designs'

/** Exhaustive ordered table of every settings field (ADR 0024, 2.1-M518). */
export const SETTINGS_FIELDS = [
  f('locale', 'locale', R, en(SETTINGS_LOCALES), { kind: 'first_language' }),
  f('theme', 'theme', R, en(SETTINGS_THEMES)),
  f('unit_system', 'units', R, en(SETTINGS_UNIT_SYSTEMS), { kind: 'from_region' }),
  f('snap_to_grid', C, R, BOOL),
  f('side_panel_width', W, O, nu32(MIN_SIDE_PANEL_WIDTH)),
  f('saved_stamps_frame_height', W, O, nu32(MIN_FAVORITES_FRAME_HEIGHT)),
  f('basemap_style', M, R, en(SETTINGS_BASEMAP_STYLES)),
  f('basemap_visible', M, R, BOOL),
  f('basemap_opacity', M, O, OPACITY),
  f('satellite_visible', M, R, BOOL),
  f('satellite_opacity', M, O, OPACITY),
  f('google_maps_api_key', M, 'secret', { type: 'nullable_string', trimOnSave: true }),
  f('satellite_source', M, R, { type: 'nullable_enum', values: SETTINGS_SATELLITE_SOURCES }),
  f('contour_visible', M, R, BOOL),
  f('contour_opacity', M, O, OPACITY),
  f('contour_interval', M, O, { type: 'u32' }),
  f('hillshade_visible', M, R, BOOL),
  f('hillshade_opacity', M, O, OPACITY),
  f('soften_background', M, R, BOOL),
  f('plant_spacing_interval_m', C, R, { type: 'finite_number', exclusiveMin: 0 }),
  f('last_view', W, O, { type: 'last_view' }),
  f('last_open_home', W, O, { type: 'nullable_string', nonEmpty: true }, s(null)),
  f('used_canvas_tools', W, O, { type: 'string_array' }, s([] as string[])),
  f('tool_names_visible', W, O, { type: 'nullable_boolean' }),
  f('single_key_shortcuts', 'keyboard-shortcuts', R, BOOL),
  f('scroll_wheel', C, R, en(SETTINGS_SCROLL_WHEELS), { kind: 'from_os_scroll_wheel' }),
  f('new_design_satellite', N, R, BOOL),
  f('new_design_symbol_scale', N, R, { type: 'finite_number', min: MIN_PLANT_SYMBOL_SCALE, max: MAX_PLANT_SYMBOL_SCALE, clamp: true }),
  f('new_design_labels', N, R, en(SETTINGS_PLANT_LABELS)),
  f('launch_check', 'updates', R, BOOL, s(true), 'app-updater'),
] as const satisfies readonly SettingsFieldDescriptor[]
