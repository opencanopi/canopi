import {
  DEFAULT_BUDGET_CURRENCY,
  DOCUMENT_FILE_FIELD_OWNERS as GENERATED_DOCUMENT_FILE_FIELD_OWNERS,
  KNOWN_CANOPI_KEYS,
} from '../../generated/known-canopi-keys'
import type { KnownCanopiKey } from '../../generated/known-canopi-keys'
import type { CanopiFile } from '../../types/design'

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

export function normalizeLoadedDocument(file: CanopiFile): CanopiFile {
  return {
    ...normalizeDocumentKnownFields(file),
    extra: {
      ...normalizePersistedExtra(file.extra),
      ...extractDocumentExtra(file as unknown as Record<string, unknown>),
    },
  }
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
  return {
    ...normalizeDocumentKnownFields(file),
    extra,
  }
}

export function composeDocumentForSave({
  metadata,
  document,
  canvas,
}: ComposeDocumentForSaveOptions): CanopiFile {
  const normalizedDocument = normalizeDocumentKnownFields(document)
  const normalizedCanvas = normalizeDocumentKnownFields(canvas)
  const composed = composeKnownDocumentFields(normalizedDocument, normalizedCanvas)

  return {
    ...composed,
    name: metadata.name,
    description: metadata.description ?? composed.description ?? null,
  }
}

function composeKnownDocumentFields(
  document: CanopiFile,
  canvas: CanopiFile,
): CanopiFile {
  const output: Partial<Record<KnownCanopiKey, unknown>> = {}

  // `extra` is all Design Edit's, like every 'document' field: the scene owns no `extra` key (ADR 0011).
  for (const key of DOCUMENT_FILE_KNOWN_KEYS) {
    const value = ownedFieldSource(key, document, canvas)[key]
    if (WRITTEN_ONLY_WHEN_PRESENT.has(key) && value == null) continue
    output[key] = value
  }
  return output as CanopiFile
}

function ownedFieldSource(
  key: KnownCanopiKey,
  document: CanopiFile,
  canvas: CanopiFile,
): CanopiFile {
  return DOCUMENT_FILE_FIELD_OWNERS[key] === 'scene' || key === 'updated_at' ? canvas : document
}

function normalizeDocumentKnownFields(file: CanopiFile): CanopiFile {
  return {
    version: file.version,
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
    ...(file.lidar == null ? {} : { lidar: file.lidar }),
    views: file.views ?? [],
    stories: file.stories ?? [],
    ...(file.map_view == null ? {} : { map_view: file.map_view }),
    created_at: file.created_at,
    updated_at: file.updated_at,
    extra: normalizePersistedExtra(file.extra),
  }
}
