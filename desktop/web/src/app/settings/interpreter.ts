/**
 * app/settings/interpreter.ts: Single TypeScript interpreter over `SETTINGS_FIELDS`
 * (ADR 0024, ADR 0026; 2.1-M518, 2.1-Q54, 2.1-Q120, 2.1-Q169, 2.1-Q345).
 *
 * Serves both Desktop and Web: evaluates first-run defaults, decodes raw records
 * with per-field reset, normalizes values, computes changed-field patches,
 * builds the privacy-filtered problem-report summary, and runs declarative
 * `SettingsStep` chains through `platform/store-chain.ts`.
 */
import type { LastView } from '../../generated/contracts'
import type { EditionCapabilitySet } from '../../generated/edition-capabilities'
import { WEB_MERCATOR_MAX_LATITUDE_DEG } from '../../generated/canopi-design-format'
import { matchLocaleOrDefault } from '../../generated/locale-registry'
import { defaultUnitSystemForRegion } from '../../generated/quantity-table'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { StoreFloor } from '../../generated/store-chain'
import { runStoreChain, type ChainResult, type ChainStep } from '../../platform/store-chain'
import type { SettingsPlatformAdapter } from '../../platform/settings'
import type { Settings } from '../../types/settings'
import {
  SETTINGS_FIELDS,
  SETTINGS_V1_WIRE_KEYS,
  type DefaultSpec,
  type SettingsFieldDescriptor,
  type SettingsFieldKey,
  type SettingsStep,
  type SettingsValueKind,
  type SettingsValues,
} from './field-table'

const MAX_U32 = 4_294_967_295

/** Host/browser environment inputs used to resolve dynamic `DefaultSpec` rows. */
export interface SettingsFirstRunEnv {
  readonly languages?: readonly (string | null | undefined)[]
  readonly region?: string | null
  readonly os?: string
}

export interface DecodedSettingsRecord {
  readonly values: SettingsValues
  readonly resetFields: readonly SettingsFieldKey[]
}

/** Reads browser/host languages and region from `navigator` when available. */
function detectHostEnv(): SettingsFirstRunEnv {
  const languages = typeof navigator !== 'undefined'
    ? (navigator.languages?.length ? navigator.languages : (navigator.language ? [navigator.language] : []))
    : []
  return { languages, region: regionFromLanguages(languages) }
}

/** Extracts an ISO 3166-1 alpha-2 region subtag from the first BCP-47 tag carrying one (e.g. `en-US` -> `US`). */
export function regionFromLanguages(languages: readonly (string | null | undefined)[] | undefined): string | null {
  if (!languages) return null
  for (const raw of languages) {
    if (!raw) continue
    const parts = raw.trim().split(/[-_.]/)
    for (let i = 1; i < parts.length; i += 1) {
      const part = parts[i]!
      if (/^[a-zA-Z]{2}$/.test(part)) return part.toUpperCase()
    }
  }
  return null
}

function resolveDefault(spec: DefaultSpec<unknown>, env: SettingsFirstRunEnv, isFirstRun: boolean): unknown {
  switch (spec.kind) {
    case 'static':
      return Array.isArray(spec.value) ? [...spec.value] : spec.value
    case 'first_language':
      return isFirstRun ? matchLocaleOrDefault(env.languages ?? []) : DEFAULT_SETTINGS.locale
    case 'from_region': {
      const region = env.region !== undefined ? env.region : regionFromLanguages(env.languages)
      return defaultUnitSystemForRegion(region)
    }
    case 'from_os_scroll_wheel':
      return isFirstRun && env.os === 'mac' ? 'pan' : DEFAULT_SETTINGS.scroll_wheel
  }
}

/** Evaluates only the host-dependent first-run fields (locale, unit_system, scroll_wheel). */
export function resolveHostFirstRunPatch(env: SettingsFirstRunEnv = {}): Partial<SettingsValues> {
  const patch: Partial<SettingsValues> = {}
  const target = patch as Record<string, unknown>
  for (const descriptor of SETTINGS_FIELDS) {
    if (descriptor.defaultSpec.kind === 'static') continue
    target[descriptor.key] = resolveDefault(descriptor.defaultSpec, env, true)
  }
  return patch
}

function isU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_U32
}

const BAD = Symbol()

function validateFinite(raw: unknown, spec: Extract<SettingsValueKind, { readonly type: 'finite_number' }>): unknown {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return BAD
  if (spec.exclusiveMin !== undefined && raw <= spec.exclusiveMin) return BAD
  if (spec.clamp) {
    let next = raw
    if (spec.min !== undefined) next = Math.max(spec.min, next)
    if (spec.max !== undefined) next = Math.min(spec.max, next)
    return next
  }
  return (spec.min !== undefined && raw < spec.min) || (spec.max !== undefined && raw > spec.max) ? BAD : raw
}

function validateLastView(raw: unknown): unknown {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return BAD
  const { lon, lat, zoom } = raw as Record<string, unknown>
  return typeof lon === 'number' && typeof lat === 'number' && typeof zoom === 'number'
    && Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(zoom)
    && lon >= -180 && lon <= 180 && Math.abs(lat) <= WEB_MERCATOR_MAX_LATITUDE_DEG
    ? { lon, lat, zoom } : BAD
}

function validateStringList(raw: unknown): unknown {
  return Array.isArray(raw) && raw.every((x): x is string => typeof x === 'string') ? [...new Set(raw)] : BAD
}

const VALIDATORS: {
  readonly [K in SettingsValueKind['type']]: (raw: unknown, spec: Extract<SettingsValueKind, { readonly type: K }>) => unknown
} = {
  enum: (raw, s) => (typeof raw === 'string' && s.values.includes(raw) ? raw : BAD),
  nullable_enum: (raw, s) => (raw === null || (typeof raw === 'string' && s.values.includes(raw)) ? raw : BAD),
  boolean: (raw) => (typeof raw === 'boolean' ? raw : BAD),
  nullable_boolean: (raw) => (raw === null || typeof raw === 'boolean' ? raw : BAD),
  finite_number: validateFinite,
  u32: (raw) => (isU32(raw) ? raw : BAD),
  nullable_u32: (raw, s) => {
    if (raw === null) return null
    if (!isU32(raw)) return BAD
    const rounded = s.round ? Math.round(raw) : raw
    return s.min !== undefined ? Math.max(s.min, rounded) : rounded
  },
  nullable_string: (raw, s) => {
    if (raw === null) return null
    if (typeof raw !== 'string') return BAD
    return s.nonEmpty ? (raw.trim() || BAD) : raw
  },
  last_view: validateLastView,
  string_array: validateStringList,
}

function validateFieldValue(raw: unknown, spec: SettingsValueKind): unknown {
  return (VALIDATORS[spec.type] as (r: unknown, s: SettingsValueKind) => unknown)(raw, spec)
}

/**
 * Decodes a raw stored settings object (or `null` on first run) through `SETTINGS_FIELDS`.
 *
 * Absent fields receive their resolved default without flagging a reset.
 * Present fields with invalid values reset ONLY that field and record its key in `resetFields`.
 */
export function decodeSettingsRecord(
  raw: Readonly<Record<string, unknown>> | null,
  env: SettingsFirstRunEnv = {},
): DecodedSettingsRecord {
  const isFirstRun = raw === null
  const out: Record<string, unknown> = {}
  const resetFields: SettingsFieldKey[] = []

  for (const descriptor of SETTINGS_FIELDS) {
    const fallback = resolveDefault(descriptor.defaultSpec, env, isFirstRun)
    if (raw === null || !Object.prototype.hasOwnProperty.call(raw, descriptor.key) || raw[descriptor.key] === undefined) {
      out[descriptor.key] = fallback
      continue
    }
    const checked = validateFieldValue(raw[descriptor.key], descriptor.kind)
    if (checked !== BAD) {
      out[descriptor.key] = checked
    } else {
      out[descriptor.key] = fallback
      resetFields.push(descriptor.key)
    }
  }

  return {
    values: out as unknown as SettingsValues,
    resetFields,
  }
}

/** Normalizes a partial or full `SettingsValues` object through `SETTINGS_FIELDS`. */
export function normalizeSettingsValues(
  input: Readonly<Partial<SettingsValues>>,
  env: SettingsFirstRunEnv = {},
): SettingsValues {
  return decodeSettingsRecord(input, env).values
}

function sameFieldValue(descriptor: SettingsFieldDescriptor, left: unknown, right: unknown): boolean {
  if (descriptor.kind.type === 'last_view') {
    const a = left as LastView | null
    const b = right as LastView | null
    if (!a || !b) return !a && !b
    return a.lon === b.lon && a.lat === b.lat && a.zoom === b.zoom
  }
  if (descriptor.kind.type === 'string_array') {
    const a = left as readonly string[]
    const b = right as readonly string[]
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  return Object.is(left, right)
}

/** Structural equality over every field in `SETTINGS_FIELDS`. */
export function settingsValuesEqual(left: Readonly<SettingsValues>, right: Readonly<SettingsValues>): boolean {
  for (const descriptor of SETTINGS_FIELDS) {
    if (!sameFieldValue(descriptor, left[descriptor.key], right[descriptor.key])) return false
  }
  return true
}

/** Computes a changed-fields patch from `before` to `after` (ADR 0026 patch writes). */
export function diffSettingsPatch(
  before: Readonly<SettingsValues>,
  after: Readonly<SettingsValues>,
): Partial<SettingsValues> {
  const patch: Partial<SettingsValues> = {}
  const target = patch as Record<string, unknown>
  for (const descriptor of SETTINGS_FIELDS) {
    const nextValue = after[descriptor.key]
    if (!sameFieldValue(descriptor, before[descriptor.key], nextValue)) {
      target[descriptor.key] = Array.isArray(nextValue) ? [...nextValue] : nextValue
    }
  }
  return patch
}

/** Projects `SettingsValues` to the 28-field v1 wire `Settings` object (Desktop IPC until 2e-2). */
function toV1WireSettings(values: Readonly<SettingsValues>): Settings {
  const wire: Record<string, unknown> = {}
  for (const key of SETTINGS_V1_WIRE_KEYS) {
    const value = values[key]
    wire[key] = Array.isArray(value) ? [...value] : value
  }
  return wire as unknown as Settings
}

const V1_EXTRA_KEYS = ['unit_system', 'launch_check'] as const

/** Bridges a v1 wire `Settings` host transport to `SettingsPlatformAdapter` through the field-table interpreter. */
export function createV1WireSettingsAdapter(deps: {
  readonly getSettings: () => Promise<Settings>
  readonly setSettings: (settings: Settings) => Promise<void>
  readonly env?: () => SettingsFirstRunEnv
}): SettingsPlatformAdapter {
  const readEnv = deps.env ?? detectHostEnv
  const cachedExtras: Record<string, unknown> = {}
  let lastResetFields: string[] = []
  const mirrorAndSave = async (source: object, full: SettingsValues) => {
    const rec = source as Record<string, unknown>
    for (const k of V1_EXTRA_KEYS) if (rec[k] !== undefined) cachedExtras[k] = rec[k]
    await deps.setSettings(toV1WireSettings(full))
  }
  return {
    load: async () => {
      const decoded = decodeSettingsRecord(
        { ...(await deps.getSettings() as unknown as Record<string, unknown>), ...cachedExtras },
        readEnv(),
      )
      lastResetFields = [...decoded.resetFields]
      return decoded.values
    },
    takeResetFields: () => lastResetFields.splice(0),
    save: (settings) => mirrorAndSave(settings, settings as SettingsValues),
    savePatch: (patch, settings) => mirrorAndSave(patch, settings as SettingsValues),
    firstRunSettings: () => resolveHostFirstRunPatch(readEnv()),
  }
}

/**
 * Builds the Problem Report `settings_summary` object strictly from fields whose
 * `privacy` column is `'reported'` and whose optional `capability` is active.
 * Neither `'secret'` nor `'omitted'` fields can ever enter the returned object.
 */
export function buildSettingsReportSummary(
  values: Readonly<SettingsValues>,
  capabilities?: EditionCapabilitySet,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const descriptor of SETTINGS_FIELDS) {
    if (descriptor.privacy !== 'reported') continue
    if (descriptor.capability && capabilities && !capabilities.has(descriptor.capability)) continue
    summary[descriptor.key] = values[descriptor.key]
  }
  return summary
}

/** Applies one declarative `SettingsStep` to a raw stored record object (pure). */
function applySettingsStep(
  record: Readonly<Record<string, unknown>>,
  step: SettingsStep,
  env: SettingsFirstRunEnv = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record }
  switch (step.kind) {
    case 'add_field':
      if (!Object.prototype.hasOwnProperty.call(next, step.key) || next[step.key] === undefined) {
        next[step.key] = resolveDefault(step.defaultSpec, env, false)
      }
      return next
    case 'rename_field':
      if (Object.prototype.hasOwnProperty.call(next, step.from)) {
        if (!Object.prototype.hasOwnProperty.call(next, step.to)) {
          next[step.to] = next[step.from]
        }
        delete next[step.from]
      }
      return next
    case 'drop_field':
      delete next[step.key]
      return next
    case 'map_literal': {
      const current = next[step.key]
      if (typeof current === 'string' && Object.prototype.hasOwnProperty.call(step.mapping, current)) {
        next[step.key] = step.mapping[current]
      }
      return next
    }
  }
}

export interface SettingsVersionStep {
  readonly from: number
  readonly operations: readonly SettingsStep[]
}

/**
 * Runs a declarative sequence of versioned `SettingsStep` operations synchronously
 * through `platform/store-chain.ts` (`StepDone` branded).
 */
export function runSettingsMigrationChain(
  floor: StoreFloor,
  version: number | null,
  record: Readonly<Record<string, unknown>>,
  versionSteps: readonly SettingsVersionStep[],
  env: SettingsFirstRunEnv = {},
): ChainResult<Record<string, unknown>> {
  const steps: ChainStep<Record<string, unknown>>[] = versionSteps.map((vs) => ({
    from: vs.from,
    run(current, done) {
      let updated = current
      for (const op of vs.operations) {
        updated = applySettingsStep(updated, op, env)
      }
      return done(updated)
    },
  }))
  return runStoreChain(floor, version, { ...record }, steps)
}
