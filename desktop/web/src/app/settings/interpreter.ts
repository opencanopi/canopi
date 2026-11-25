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
import { WEB_MERCATOR_MAX_LATITUDE_DEG } from '../../generated/canopi-design-format'
import { matchLocaleOrDefault } from '../../generated/locale-registry'
import { defaultUnitSystemForRegion } from '../../generated/quantity-table'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { StoreFloor } from '../../generated/store-chain'
import { runStoreChain, type ChainResult, type ChainStep } from '../../platform/store-chain'
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

function normalizeLastViewValue(value: unknown): { ok: true; value: LastView | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false }
  const { lon, lat, zoom } = value as Record<string, unknown>
  if (typeof lon !== 'number' || typeof lat !== 'number' || typeof zoom !== 'number') return { ok: false }
  if (![lon, lat, zoom].every(Number.isFinite)) return { ok: false }
  if (lon < -180 || lon > 180 || Math.abs(lat) > WEB_MERCATOR_MAX_LATITUDE_DEG) return { ok: false }
  return { ok: true, value: { lon, lat, zoom } }
}

type FieldCheckResult = { ok: true; value: unknown } | { ok: false }

function validateFiniteNumber(
  raw: unknown,
  spec: Extract<SettingsValueKind, { readonly type: 'finite_number' }>,
): FieldCheckResult {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false }
  if (spec.exclusiveMin !== undefined && raw <= spec.exclusiveMin) return { ok: false }
  let next = raw
  if (spec.clamp) {
    if (spec.min !== undefined) next = Math.max(spec.min, next)
    if (spec.max !== undefined) next = Math.min(spec.max, next)
    return { ok: true, value: next }
  }
  if (spec.min !== undefined && next < spec.min) return { ok: false }
  if (spec.max !== undefined && next > spec.max) return { ok: false }
  return { ok: true, value: next }
}

function validateNullableU32(
  raw: unknown,
  spec: Extract<SettingsValueKind, { readonly type: 'nullable_u32' }>,
): FieldCheckResult {
  if (raw === null) return { ok: true, value: null }
  if (!isU32(raw)) return { ok: false }
  const rounded = spec.round ? Math.round(raw) : raw
  return { ok: true, value: spec.min !== undefined ? Math.max(spec.min, rounded) : rounded }
}

function validateNullableString(
  raw: unknown,
  spec: Extract<SettingsValueKind, { readonly type: 'nullable_string' }>,
): FieldCheckResult {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }
  if (spec.nonEmpty) {
    const trimmed = raw.trim()
    return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false }
  }
  return { ok: true, value: raw }
}

function validateStringArray(raw: unknown): FieldCheckResult {
  if (!Array.isArray(raw)) return { ok: false }
  const filtered: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false }
    if (!seen.has(item)) {
      seen.add(item)
      filtered.push(item)
    }
  }
  return { ok: true, value: filtered }
}

function validateFieldValue(raw: unknown, spec: SettingsValueKind): FieldCheckResult {
  switch (spec.type) {
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false }
    case 'nullable_enum':
      if (raw === null) return { ok: true, value: null }
      return typeof raw === 'string' && spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false }
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false }
    case 'nullable_boolean':
      return raw === null || typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false }
    case 'finite_number':
      return validateFiniteNumber(raw, spec)
    case 'u32':
      return isU32(raw) ? { ok: true, value: raw } : { ok: false }
    case 'nullable_u32':
      return validateNullableU32(raw, spec)
    case 'nullable_string':
      return validateNullableString(raw, spec)
    case 'last_view':
      return normalizeLastViewValue(raw)
    case 'string_array':
      return validateStringArray(raw)
  }
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
    if (checked.ok) {
      out[descriptor.key] = checked.value
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
  const out: Record<string, unknown> = {}
  for (const descriptor of SETTINGS_FIELDS) {
    const raw = input[descriptor.key]
    const fallback = resolveDefault(descriptor.defaultSpec, env, false)
    if (raw === undefined) {
      out[descriptor.key] = fallback
      continue
    }
    const checked = validateFieldValue(raw, descriptor.kind)
    out[descriptor.key] = checked.ok ? checked.value : fallback
  }
  return out as unknown as SettingsValues
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

/** Projects `SettingsValues` to the 27-field v1 wire `Settings` object (Desktop IPC until 2e-2). */
export function toV1WireSettings(values: Readonly<SettingsValues>): Settings {
  const wire: Record<string, unknown> = {}
  for (const key of SETTINGS_V1_WIRE_KEYS) {
    const value = values[key]
    wire[key] = Array.isArray(value) ? [...value] : value
  }
  return wire as unknown as Settings
}

/**
 * Builds the Problem Report `settings_summary` object strictly from fields whose
 * `privacy` column is `'reported'`. Neither `'secret'` nor `'omitted'` fields can
 * ever enter the returned object.
 */
export function buildSettingsReportSummary(values: Readonly<SettingsValues>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const descriptor of SETTINGS_FIELDS) {
    if (descriptor.privacy !== 'reported') continue
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
