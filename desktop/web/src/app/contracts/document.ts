import {
  DEFAULT_BUDGET_CURRENCY,
  DOCUMENT_FILE_FIELD_OWNERS as GENERATED_DOCUMENT_FILE_FIELD_OWNERS,
  KNOWN_CANOPI_KEYS,
} from '../../generated/known-canopi-keys'
import type { KnownCanopiKey } from '../../generated/known-canopi-keys'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import {
  asCanopiDesignIngestionError,
  CanopiDesignIngestionError,
} from './canopi-design-errors'

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
const WRITTEN_ONLY_WHEN_PRESENT: ReadonlySet<KnownCanopiKey> = new Set([
  'budget_ext',
  'site_data',
  'plant_display',
  'print_setup',
  'map_view',
])

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
    if (key !== 'extra' && !KNOWN_CANOPI_KEY_SET.has(key)) {
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

export function normalizeLoadedDocument(file: CanopiFile | Record<string, unknown>): CanopiFile {
  const rawRecord = file as Record<string, unknown>
  const normalized = normalizeDocumentKnownFields(rawRecord)
  return mergeDocumentFields(normalized, {
    extra: {
      ...normalizePersistedExtra(rawRecord.extra as CanopiFile['extra']),
      ...extractDocumentExtra(rawRecord),
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
  for (const key of WRITTEN_ONLY_WHEN_PRESENT) {
    if (patch[key] == null) delete (composed as unknown as Record<string, unknown>)[key]
  }
  return composed
}

function ownedFieldSource(
  key: KnownCanopiKey,
  document: CanopiFile,
  canvas: CanopiFile,
): CanopiFile {
  return DOCUMENT_FILE_FIELD_OWNERS[key] === 'scene' || key === 'updated_at' ? canvas : document
}

type DefaultKind = 'str' | 'null' | 'obj' | 'arr' | 'currency'

const KNOWN_FIELD_DEFAULTS: ReadonlyArray<readonly [KnownCanopiKey, DefaultKind]> = [
  ['name', 'str'],
  ['description', 'null'],
  ['plant_species_colors', 'obj'],
  ['plant_species_symbols', 'obj'],
  ['plant_species_codes', 'obj'],
  ['layers', 'arr'],
  ['plants', 'arr'],
  ['zones', 'arr'],
  ['annotations', 'arr'],
  ['measurement_guides', 'arr'],
  ['consortiums', 'arr'],
  ['groups', 'arr'],
  ['timeline', 'arr'],
  ['budget', 'arr'],
  ['budget_currency', 'currency'],
  ['views', 'arr'],
  ['stories', 'arr'],
  ['created_at', 'str'],
  ['updated_at', 'str'],
]

function createFieldDefault(kind: DefaultKind): unknown {
  if (kind === 'arr') return []
  if (kind === 'obj') return {}
  if (kind === 'null') return null
  return kind === 'currency' ? DEFAULT_BUDGET_CURRENCY : ''
}

function normalizeDocumentKnownFields<T extends Record<string, unknown>>(file: T): CanopiFile {
  const record: Record<string, unknown> = { version: file.version }
  for (const [key, kind] of KNOWN_FIELD_DEFAULTS) {
    record[key] = file[key] ?? createFieldDefault(kind)
  }
  record.extra = normalizePersistedExtra(file.extra as CanopiFile['extra'])
  for (const key of WRITTEN_ONLY_WHEN_PRESENT) {
    const value = file[key]
    if (value != null) record[key] = value
  }
  return record as unknown as ReturnType<typeof normalizeNewDocument>
}

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

/**
 * Flatten an in-memory v10 Design's `extra` bag back to root keys for JSON serialization
 * (exact inverse of `extractDocumentExtra`).
 */
export function flattenDocumentForJson(
  file: DeepReadonly<CanopiFile> | CanopiFile | { readonly version: number; readonly name: string; readonly extra?: unknown },
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
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const value = record[key]
    if (WRITTEN_ONLY_WHEN_PRESENT.has(key) && value == null) continue
    Object.defineProperty(wire, key, {
      configurable: true,
      enumerable: true,
      value,
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
    if (error instanceof SyntaxError) {
      throw new CanopiDesignIngestionError('invalid_document', `$: invalid JSON (${error.message})`)
    }
    throw asCanopiDesignIngestionError(error)
  }
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
