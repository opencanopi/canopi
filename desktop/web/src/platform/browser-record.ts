// platform/browser-record.ts: the browser records' owner (contracts §11 "Browser records"; Step 2.0.4 R3, finding F8;
// canopi-f47t.52.272), F10's target owner of raw `localStorage` and `sessionStorage` (ast-grep
// `web-storage-only-in-adapters`, 2b). It holds no raw Storage use yet: its reads take the `BrowserStorage` their
// caller passes, and the page's Storage adapters stay in web/browser-app-data.ts, counted in
// policy/ratchets/web-storage-only-in-adapters.json, until 2b moves them here with the records' write half. It holds
// the read half of the 2.1 records the reader release reads and never writes: settings record 2 and the species-list
// record 1, each under its own 2.1 key (2.1-M486, 2.1-Q320). The frozen keys and versions stay private until a consumer
// imports them (2b, 2e, N2 export what they import); the record runner, the quota mapping and the `storage`-event
// change come with the write half (2b).

/** The 2.1 Web settings record's key; the 2.0 record stays under the v3 key for 2.0 tabs (ADR 0026 Rollback). */
const SETTINGS_RECORD_KEY = 'canopi:web-app-data:v4:settings'
/** The settings record version 2.1 writes there (a 2.0 record has no version and reads as 1). */
const SETTINGS_RECORD_VERSION = 2
/** The 2.1 Web species-list record's key (favourites and recently viewed, contracts §19 ED-25). */
const SPECIES_LIST_RECORD_KEY = 'canopi:web-app-data:v4:species'
/** The species-list record version 2.1 writes there. */
const SPECIES_LIST_RECORD_VERSION = 1
/** At most this many entries in each species list. */
const SPECIES_LIST_CAP = 50

/** The part of Web Storage a record reads and writes; a test passes its own. */
export interface BrowserStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * A read of a versioned record: none stored, the frozen version, a later version (read for the fields this release
 * knows, never written or moved aside), or unreadable (not JSON, no object, no version this key can hold).
 */
export type RecordRead<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'current', readonly record: T }
  | { readonly state: 'newer', readonly version: number, readonly record: T }
  | { readonly state: 'unreadable', readonly raw: string }

/** One entry of a species list: the species and when it was starred or viewed (an ISO 8601 instant). */
export interface SpeciesListEntry {
  readonly canonical_name: string
  readonly at: string
}

/** The species-list record's known fields; a list that does not read is empty, and a bad entry is left out. */
export interface SpeciesListRecord {
  readonly version: number
  readonly favorites: readonly SpeciesListEntry[]
  readonly recently_viewed: readonly SpeciesListEntry[]
}

/**
 * The settings record 2 as stored: its fields beside a top-level `version`, for the settings field table to apply
 * field by field (`platform/settings.browser.ts`); this reads it, never a field's meaning.
 */
export type SettingsRecord = Readonly<Record<string, unknown>> & { readonly version: number }

/** Reads the 2.1 settings record; writes nothing. */
export function readSettingsRecord(storage: BrowserStorage): RecordRead<SettingsRecord> {
  return readVersioned(storage, SETTINGS_RECORD_KEY, SETTINGS_RECORD_VERSION, (value, version) => ({ ...value, version }))
}

/** Reads the 2.1 species-list record; writes nothing. */
export function readSpeciesListRecord(storage: BrowserStorage): RecordRead<SpeciesListRecord> {
  return readVersioned(storage, SPECIES_LIST_RECORD_KEY, SPECIES_LIST_RECORD_VERSION, (value, version) => ({
    version,
    favorites: speciesEntries(value.favorites),
    recently_viewed: speciesEntries(value.recently_viewed),
  }))
}

function readVersioned<T>(
  storage: BrowserStorage,
  key: string,
  frozen: number,
  decode: (value: Record<string, unknown>, version: number) => T,
): RecordRead<T> {
  const raw = storage.getItem(key)
  if (raw === null) return { state: 'absent' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // Not JSON: the caller reports the record unreadable, and it stays where it is.
    return { state: 'unreadable', raw }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unreadable', raw }
  const { version } = value as Record<string, unknown>
  // A version below the frozen one was never written under this key.
  if (typeof version !== 'number' || !Number.isInteger(version) || version < frozen) return { state: 'unreadable', raw }
  const record = decode(value as Record<string, unknown>, version)
  return version === frozen ? { state: 'current', record } : { state: 'newer', version, record }
}

function speciesEntries(value: unknown): SpeciesListEntry[] {
  if (!Array.isArray(value)) return []
  const entries: SpeciesListEntry[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { canonical_name, at } = item as Record<string, unknown>
    if (typeof canonical_name !== 'string' || canonical_name === '' || typeof at !== 'string') continue
    entries.push({ canonical_name, at })
    if (entries.length === SPECIES_LIST_CAP) break
  }
  return entries
}
