import {
  DEFAULT_BUDGET_CURRENCY,
  DOCUMENT_FILE_FIELD_OWNERS as GENERATED_DOCUMENT_FILE_FIELD_OWNERS,
  KNOWN_CANOPI_KEYS,
} from '../../generated/known-canopi-keys'
import type { KnownCanopiKey } from '../../generated/known-canopi-keys'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFileV10 } from '../../generated/contracts'
import type { CanopiFile } from '../../types/design'
import { asCanopiDesignIngestionError } from './canopi-design-errors'

export { DEFAULT_BUDGET_CURRENCY }

interface DocumentFileSaveMetadata {
  name: string
  description?: string | null
}

export interface ComposeDocumentForSaveOptions {
  metadata: DocumentFileSaveMetadata
  document: CanopiFile
  canvas: CanopiFile
}

export const DOCUMENT_FILE_FIELD_OWNERS = GENERATED_DOCUMENT_FILE_FIELD_OWNERS

const DOCUMENT_FILE_KNOWN_KEYS = KNOWN_CANOPI_KEYS

const KNOWN_CANOPI_KEY_SET = new Set<string>(DOCUMENT_FILE_KNOWN_KEYS)
/** Optional sections a Design writes only when it has them (the Rust side skips them when None). */
const WRITTEN_ONLY_WHEN_PRESENT: ReadonlySet<KnownCanopiKey> = new Set(['lidar', 'map_view'])
function normalizePersistedExtra(extra: CanopiFile['extra']): Record<string, unknown> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (KNOWN_CANOPI_KEY_SET.has(key)) continue
    Object.defineProperty(normalized, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return normalized
}

export function extractDocumentExtra(raw: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CANOPI_KEY_SET.has(key)) {
      Object.defineProperty(extra, key, {
        configurable: true,
        enumerable: true,
        value: raw[key],
        writable: true,
      })
    }
  }
  return extra
}

function mergeDocumentFields<T extends object>(base: T, patch: Partial<T>): T {
  return Object.assign({}, base, patch)
}

export function normalizeLoadedDocument(file: CanopiFile): CanopiFile {
  const normalized = normalizeDocumentKnownFields(file)
  return mergeDocumentFields(normalized, {
    extra: {
      ...normalizePersistedExtra(file.extra),
      ...extractDocumentExtra(file as unknown as Record<string, unknown>),
    },
  })
}

/**
 * A new Design starts with an empty `extra`, except the keys its creator set
 * on purpose (`keepExtraKeys`: Settings › New Designs display options).
 */
export function normalizeNewDocument(file: CanopiFile, keepExtraKeys: readonly string[] = []): CanopiFile {
  const persisted = normalizePersistedExtra(file.extra)
  const extra: Record<string, unknown> = {}
  for (const key of keepExtraKeys) {
    if (Object.prototype.hasOwnProperty.call(persisted, key)) extra[key] = persisted[key]
  }
  return mergeDocumentFields(normalizeDocumentKnownFields(file), { extra })
}

export function composeDocumentForSave({
  metadata,
  document,
  canvas,
}: ComposeDocumentForSaveOptions): CanopiFile {
  const normalizedDocument = normalizeDocumentKnownFields(document)
  const normalizedCanvas = normalizeDocumentKnownFields(canvas)
  const composed = composeKnownDocumentFields(normalizedDocument, normalizedCanvas)

  return mergeDocumentFields(composed, {
    name: metadata.name,
    description: metadata.description ?? composed.description ?? null,
  })
}

function composeKnownDocumentFields(
  document: CanopiFile,
  canvas: CanopiFile,
): CanopiFile {
  const patch: Partial<Record<KnownCanopiKey, unknown>> = {}

  // `extra` is all Design Edit's, like every 'document' field: the scene owns no `extra` key (ADR 0011).
  for (const key of DOCUMENT_FILE_KNOWN_KEYS) {
    const value = ownedFieldSource(key, document, canvas)[key]
    if (WRITTEN_ONLY_WHEN_PRESENT.has(key) && value == null) continue
    patch[key] = value
  }
  const composed = mergeDocumentFields(document, patch as Partial<CanopiFile>)
  if (patch.lidar == null) delete composed.lidar
  if (patch.map_view == null) delete composed.map_view
  return composed
}

function ownedFieldSource(
  key: KnownCanopiKey,
  document: CanopiFile,
  canvas: CanopiFile,
): CanopiFile {
  return DOCUMENT_FILE_FIELD_OWNERS[key] === 'scene' || key === 'updated_at' ? canvas : document
}

function normalizeDocumentKnownFields(file: CanopiFile): CanopiFile {
  const patch: Partial<CanopiFile> = {
    version: file.version === 9 ? CURRENT_CANOPI_FILE_VERSION : file.version,
    name: file.name,
    description: file.description ?? null,
    plant_species_colors: file.plant_species_colors,
    plant_species_symbols: file.plant_species_symbols ?? {},
    plant_species_codes: file.plant_species_codes ?? {},
    layers: file.layers,
    plants: file.plants,
    zones: file.zones,
    annotations: file.annotations ?? [],
    measurement_guides: file.measurement_guides ?? [],
    consortiums: file.consortiums ?? [],
    groups: file.groups ?? [],
    timeline: file.timeline ?? [],
    budget: file.budget ?? [],
    budget_currency: file.budget_currency ?? DEFAULT_BUDGET_CURRENCY,
    views: file.views ?? [],
    stories: file.stories ?? [],
    created_at: file.created_at,
    updated_at: file.updated_at,
    extra: normalizePersistedExtra(file.extra),
  }
  const normalized = mergeDocumentFields(file, patch)
  for (const key of Object.keys(normalized)) {
    if (!KNOWN_CANOPI_KEY_SET.has(key)) {
      delete (normalized as unknown as Record<string, unknown>)[key]
    }
  }
  if (file.lidar == null) delete normalized.lidar
  else normalized.lidar = file.lidar
  if (file.map_view == null) delete normalized.map_view
  else normalized.map_view = file.map_view
  return normalized
}

/**
 * Flatten an in-memory Design's `extra` bag back to root keys for JSON serialization
 * (exact inverse of `extractDocumentExtra`).
 */
export function flattenDocumentForJson(
  file: CanopiFile | { readonly version: number; readonly name: string; readonly extra?: unknown },
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (file.extra && typeof file.extra === 'object' && !Array.isArray(file.extra)) {
    for (const [key, value] of Object.entries(file.extra)) {
      if (!KNOWN_CANOPI_KEY_SET.has(key)) {
        Object.defineProperty(wire, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        })
      }
    }
  }
  const record = file as unknown as Record<string, unknown>
  for (const key of KNOWN_CANOPI_KEYS) {
    if (key === 'extra' || !Object.prototype.hasOwnProperty.call(record, key)) continue
    Object.defineProperty(wire, key, {
      configurable: true,
      enumerable: true,
      value: record[key],
      writable: true,
    })
  }
  return wire
}

/** Parse raw `.canopi` JSON text, wrapping syntax errors in `CanopiDesignIngestionError`. */
export function parseCanopiJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw asCanopiDesignIngestionError(error)
  }
}

/** Whether a parsed `.canopi` value has an integer root `version` above this build's current version. */
export function isSavedByNewerCanopi(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const version = (value as Record<string, unknown>).version
  return typeof version === 'number' && Number.isInteger(version) && version > CURRENT_CANOPI_FILE_VERSION
}

const REQUIRED_ARRAY_KEYS = [
  'layers',
  'plants',
  'zones',
  'annotations',
  'consortiums',
  'groups',
  'timeline',
  'budget',
] as const

/** Lightweight structural guard for a supported Canopi 2.x (v9 or v10) Design record. */
export function isCurrentCanopiDocument(value: unknown): value is CanopiFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'extra')) return false
  if (
    (record.version !== CURRENT_CANOPI_FILE_VERSION && record.version !== 9)
    || typeof record.name !== 'string'
    || typeof record.created_at !== 'string'
    || typeof record.updated_at !== 'string'
  ) {
    return false
  }
  return REQUIRED_ARRAY_KEYS.every((key) => Array.isArray(record[key]))
}

const V10_MAPPED_ROOT_KEYS = new Set<string>(['site_data', 'plant_display'])

function projectV10PlantToSession(plant: Record<string, unknown>): Record<string, unknown> {
  const { canopy_spread_m, ...rest } = plant
  return { ...rest, scale: canopy_spread_m ?? null }
}

function projectV10BudgetToSession(
  budget: readonly Record<string, unknown>[],
  defaultCurrency: string,
): Record<string, unknown>[] {
  return budget.map((line) => {
    const ext = line.ext && typeof line.ext === 'object' && !Array.isArray(line.ext)
      ? line.ext as Record<string, unknown>
      : null
    return {
      ...line,
      category: typeof line.category === 'string' ? line.category : (typeof ext?.category === 'string' ? ext.category : ''),
      description: typeof line.description === 'string' ? line.description : (typeof ext?.description === 'string' ? ext.description : ''),
      quantity: typeof line.quantity === 'number' ? line.quantity : (typeof ext?.quantity === 'number' ? ext.quantity : 1),
      currency: typeof line.currency === 'string' ? line.currency : (typeof ext?.currency === 'string' ? ext.currency : defaultCurrency),
    }
  })
}

function v10ListsToRecord(v10: CanopiFileV10, defaultCurrency: string): Record<string, unknown> {
  return {
    layers: v10.layers ?? [],
    plants: (v10.plants ?? []).map((plant) => projectV10PlantToSession(plant as unknown as Record<string, unknown>)),
    zones: v10.zones ?? [],
    annotations: v10.annotations ?? [],
    measurement_guides: v10.measurement_guides ?? [],
    consortiums: v10.consortiums ?? [],
    groups: v10.groups ?? [],
    timeline: v10.timeline ?? [],
    budget: projectV10BudgetToSession(v10.budget as unknown as readonly Record<string, unknown>[], defaultCurrency),
    views: v10.views ?? [],
    stories: v10.stories ?? [],
  }
}

/**
 * Project a `canopi-format`-decoded v10 Design (`CanopiFileV10`) onto the session's current
 * in-memory `CanopiFile` shape until `2c-3`/`2c-4` switch UI panels directly to v10 fields.
 */
export function v10ToSessionCanopiFile(v10: CanopiFileV10): CanopiFile {
  const rawExtra = extractDocumentExtra(v10)
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawExtra)) {
    if (!V10_MAPPED_ROOT_KEYS.has(key)) {
      Object.defineProperty(extra, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
    }
  }
  if (v10.plant_display != null) extra.plant_display = v10.plant_display
  const budgetCurrency = v10.budget_currency ?? DEFAULT_BUDGET_CURRENCY
  const projected: Record<string, unknown> = {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: v10.name,
    description: v10.description ?? null,
    plant_species_colors: v10.plant_species_colors ?? {},
    plant_species_symbols: v10.plant_species_symbols ?? {},
    plant_species_codes: v10.plant_species_codes ?? {},
    budget_currency: budgetCurrency,
    created_at: v10.created_at,
    updated_at: v10.updated_at,
    ...v10ListsToRecord(v10, budgetCurrency),
  }
  if (v10.site_data != null) projected.lidar = v10.site_data
  if (v10.map_view != null) projected.map_view = v10.map_view
  if (!isCurrentCanopiDocument(projected)) {
    throw asCanopiDesignIngestionError(new Error('Format Core returned an invalid Design projection'))
  }
  return mergeDocumentFields(normalizeLoadedDocument(projected), { extra })
}

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

function mapSessionPlantsToV10(
  plants: readonly unknown[],
): Record<string, unknown>[] {
  return plants.map((plant) => {
    const next: Record<string, unknown> = { ...(plant as Record<string, unknown>) }
    const spread = next.scale !== undefined ? next.scale : (next.canopy_spread_m ?? null)
    delete next.scale
    next.canopy_spread_m = spread
    return next
  })
}

function mapSessionBudgetToV10(
  budget: readonly unknown[],
): { readonly plantLines: Record<string, unknown>[]; readonly legacyLines: Record<string, unknown>[] } {
  const plantLines: Record<string, unknown>[] = []
  const legacyLines: Record<string, unknown>[] = []
  for (const item of budget) {
    const rawLine = item as Record<string, unknown>
    const target = rawLine.target as { readonly kind?: string } | undefined
    if (target?.kind === 'species') {
      const { category, description, quantity, currency, ext, ...rest } = rawLine
      const nextExt: Record<string, unknown> = ext && typeof ext === 'object' && !Array.isArray(ext)
        ? { ...(ext as Record<string, unknown>) }
        : {}
      if (category !== undefined) nextExt.category = category
      if (description !== undefined) nextExt.description = description
      if (quantity !== undefined) nextExt.quantity = quantity
      if (currency !== undefined) nextExt.currency = currency
      plantLines.push(Object.keys(nextExt).length > 0 ? { ...rest, ext: nextExt } : rest)
    } else {
      legacyLines.push(rawLine)
    }
  }
  return { plantLines, legacyLines }
}

function mapSessionLidarToV10(rawLidar: unknown): Record<string, unknown> {
  const lidar = rawLidar as { readonly entries?: readonly Record<string, unknown>[]; [key: string]: unknown }
  const { entries, ...restSiteData } = lidar
  return {
    ...restSiteData,
    entries: (entries ?? []).map((entry) => {
      const { kind: _kind, ...restEntry } = entry
      return restEntry
    }),
  }
}

function copyExtraToWire(extraValue: unknown, wire: Record<string, unknown>): void {
  if (!extraValue || typeof extraValue !== 'object' || Array.isArray(extraValue)) return
  for (const [key, value] of Object.entries(extraValue as Record<string, unknown>)) {
    if (KNOWN_CANOPI_KEY_SET.has(key) || key === 'site_data' || key === 'extra') continue
    wire[key] = value
  }
}

/**
 * Inverse of `v10ToSessionCanopiFile`: map the session's in-memory `CanopiFile` onto a
 * canonical v10 object ready for `DesignCore.encode` (2b-5, B1).
 */
export function sessionCanopiFileToV10(
  file: DeepReadonly<CanopiFile> | CanopiFile,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  copyExtraToWire(file.extra, wire)
  const { plantLines, legacyLines } = mapSessionBudgetToV10(file.budget ?? [])
  wire.version = CURRENT_CANOPI_FILE_VERSION
  wire.name = file.name
  wire.description = file.description ?? null
  wire.plant_species_colors = file.plant_species_colors
  wire.plant_species_symbols = file.plant_species_symbols ?? {}
  wire.plant_species_codes = file.plant_species_codes ?? {}
  wire.layers = file.layers
  wire.plants = mapSessionPlantsToV10(file.plants)
  wire.zones = file.zones
  wire.annotations = file.annotations ?? []
  wire.measurement_guides = file.measurement_guides ?? []
  wire.consortiums = file.consortiums ?? []
  wire.groups = file.groups ?? []
  wire.timeline = file.timeline ?? []
  wire.budget = plantLines
  wire.budget_currency = file.budget_currency ?? DEFAULT_BUDGET_CURRENCY
  if (legacyLines.length > 0) wire.budget_ext = { legacy_non_plant_lines: legacyLines }
  if (file.lidar != null) wire.site_data = mapSessionLidarToV10(file.lidar)
  wire.views = file.views ?? []
  wire.stories = file.stories ?? []
  if (file.map_view != null) wire.map_view = file.map_view
  wire.created_at = file.created_at
  wire.updated_at = file.updated_at
  return wire
}
