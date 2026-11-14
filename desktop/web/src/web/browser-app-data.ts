import { encodeCanopiDesign } from "../app/contracts/canopi-design-wire";
import { decodeCanopiDesign } from "../app/contracts/design-ingestion";
import type { CanopiFile } from "../types/design";
import { keepUnreadableRecord, StoreRefusedError, StoreUnreadableError } from "../failures/store-read";
import { writeStoreHealth } from "../failures/health";
import type { StoreId } from "../generated/contracts";
import type { RecordRead, SpeciesListEntry, SpeciesListRecord } from "../platform/browser-record";

// Canopi 2.0 keeps its records under the `v3` keys and migrates nothing
// (ADR 0021). Web Edition 1.x wrote the `v1` document and then moved it into
// the `v2:*` keys (1.0.1 to 1.2.0); 2.0 never reads, writes or deletes any of
// them, so 1.x still opens them. It only checks whether one exists, to tell the
// user once that they were not opened. After a rollback from 2.1 the species lists 2.1 keeps under its own key are read
// in place of these (2.1-M486), never written, moved or copied (2.1-Q320, M483): the store then reads as saved by a
// newer Canopi and refuses writes. platform/ passes the reader in (openSpeciesLists), so web/ imports no platform/ code.
const RECORD_VERSION = 3 as const;
const EARLIER_KEYS: readonly string[] = [
  "canopi:web-app-data:v1",
  "canopi:web-app-data:v2:drafts",
  "canopi:web-app-data:v2:settings",
  "canopi:web-app-data:v2:species",
  "canopi:web-app-data:v2:saved-object-stamps",
  "canopi:web-app-data:v2:authority",
  "canopi:web-app-data:v2:migration-progress",
  "canopi:web-app-data:v2:authority-reservation",
];
/** Set once the user has been told that the 1.x data was left in place. */
const KEPT_IN_PLACE_NOTICE_KEY = "canopi:web-app-data:before-2.0-kept-in-place-notice";
const STORAGE_KEYS = {
  drafts: "canopi:web-app-data:v3:drafts",
  settings: "canopi:web-app-data:v3:settings",
  species: "canopi:web-app-data:v3:species",
  stamps: "canopi:web-app-data:v3:saved-object-stamps",
} as const;
/**
 * The Draft this tab had open when it reloaded for a new release (2.1-Q189): per-tab session state in sessionStorage,
 * read once by the next launch. It holds only a Draft id and is no user-work store, so it has no record version.
 */
const RELOAD_HOME_KEY = "canopi:web-session:reload-home";

/** What a tab had open at its release reload: its Draft's id, or null for none (the start screen). */
interface BrowserReloadHome {
  readonly draft: string | null;
}

export interface BrowserStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads 2.1's species-list record (platform/browser-record.ts `readSpeciesListRecord`). */
type SpeciesListReader = (storage: BrowserStorageAdapter) => RecordRead<SpeciesListRecord>;
interface NewerRecordReaders { species?: SpeciesListReader }

export type BrowserAppDataWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface BrowserDraftSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

interface BrowserSavedObjectStampRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
}

interface BrowserDraftsRecord {
  readonly version: typeof RECORD_VERSION;
  readonly drafts: readonly BrowserDraftSummary[];
  readonly draftFiles: Record<string, CanopiFile>;
  /**
   * Drafts this Canopi refuses to open (a damaged, newer or older Design), kept as their stored values so a write of another
   * Draft never erases them.
   */
  readonly refused: RefusedDrafts;
}

interface RefusedDrafts {
  readonly summaries: readonly unknown[];
  readonly files: Record<string, unknown>;
}

interface BrowserSettingsRecord {
  readonly version: typeof RECORD_VERSION;
  readonly settings: Record<string, unknown> | null;
}

interface BrowserSpeciesRecord {
  readonly version: typeof RECORD_VERSION;
  readonly favoriteSpecies: readonly string[];
  readonly recentlyViewedSpecies: readonly string[];
}

interface BrowserSavedObjectStampsRecord {
  readonly version: typeof RECORD_VERSION;
  readonly savedObjectStamps: readonly BrowserSavedObjectStampRecord[];
}

/** One independently stored record. A missing or unreadable record reads as empty, kept first if it has a `store`. */
interface BrowserStoragePartition<TRecord> {
  readonly key: string;
  readonly store?: StoreId;
  accepts(value: unknown): boolean;
  normalize(value: unknown): TRecord;
  /** Storage form of a record; defaults to the record itself. */
  encode?(record: TRecord): unknown;
  /** The record 2.1 keeps for this store under its own key, read in place of this one whenever it is there. */
  successor?(storage: BrowserStorageAdapter, readers: NewerRecordReaders): RecordRead<TRecord> | undefined;
}

const PARTITIONS = {
  drafts: {
    key: STORAGE_KEYS.drafts,
    store: "web_drafts",
    accepts: isSupportedDraftsRecord,
    normalize: normalizeDraftsRecord,
    // Draft files are stored in the .canopi wire form, like every other
    // persisted Design, so they decode through the same admission.
    encode: encodeDraftsRecord,
  },
  settings: {
    key: STORAGE_KEYS.settings,
    accepts: isSupportedSettingsRecord,
    normalize: normalizeSettingsRecord,
  },
  species: {
    key: STORAGE_KEYS.species,
    store: "web_species_lists",
    accepts: isSupportedSpeciesRecord,
    normalize: normalizeSpeciesRecord,
    successor: readSpeciesSuccessor,
  },
  stamps: {
    key: STORAGE_KEYS.stamps,
    accepts: isSupportedStampsRecord,
    normalize: normalizeStampsRecord,
  },
} as const;

interface SaveDraftOptions {
  readonly id?: string;
  readonly file: CanopiFile;
  readonly now: string;
  /**
   * The `updatedAt` this writer last read or wrote for the Draft (null: it
   * never saw one). When another browser tab has since written the Draft, the
   * save is refused with `BrowserDraftChangedError` instead of replacing it.
   * Omitted: overwrite unconditionally.
   */
  readonly expectedUpdatedAt?: string | null;
}

/** Another browser tab wrote the Draft after this writer last read or wrote it. */
export class BrowserDraftChangedError extends Error {
  constructor(readonly draftId: string) {
    super("The Draft was changed in another browser tab");
    this.name = "BrowserDraftChangedError";
  }
}

/** A stored record's value, or undefined when it is not JSON. */
function parseRecord(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the caller keeps the raw record as damaged.
    return undefined;
  }
}

interface BrowserAppDataStoreOptions {
  readonly storage?: BrowserStorageAdapter;
  /** This tab's session storage, for the reload record (2.1-Q189). */
  readonly session?: BrowserStorageAdapter;
  /** The time a damaged record is moved aside at, which names its key. */
  readonly now?: () => string;
}

export interface BrowserAppDataStore {
  saveDraft(options: SaveDraftOptions): BrowserAppDataWriteResult<BrowserDraftSummary>;
  listDrafts(): readonly BrowserDraftSummary[];
  loadDraft(id: string): CanopiFile | null;
  deleteDraft(id: string): BrowserAppDataWriteResult<null>;
  saveSettings(settings: Record<string, unknown>): BrowserAppDataWriteResult<Record<string, unknown>>;
  loadSettings(): Record<string, unknown> | null;
  setFavoriteSpecies(canonicalNames: readonly string[]): BrowserAppDataWriteResult<readonly string[]>;
  listFavoriteSpecies(): readonly string[];
  recordRecentlyViewedSpecies(canonicalName: string, limit?: number): BrowserAppDataWriteResult<readonly string[]>;
  listRecentlyViewedSpecies(): readonly string[];
  saveSavedObjectStamps(records: readonly BrowserSavedObjectStampRecord[]): BrowserAppDataWriteResult<readonly BrowserSavedObjectStampRecord[]>;
  listSavedObjectStamps(): readonly BrowserSavedObjectStampRecord[];
  /**
   * True when the user should now be told that browser data from before
   * Canopi 2.0 was not opened: the first start that finds any 1.x key
   * (U59). Nothing but the
   * notice marker is written; when even that does not fit, the notice repeats
   * on later starts.
   */
  takeEarlierDataNotice(now: string): boolean;
  /** Notes what this tab has open before it reloads for a new release (2.1-Q189): its Draft, or none; best effort. */
  noteReloadHome(draftId: string | null): void;
  /** What this tab had open before its release reload, once; null when nothing was noted or it cannot be read. */
  takeReloadHome(): BrowserReloadHome | null;
  /**
   * Reads the species lists at launch, 2.1's key through `read` from now on, so lists a newer Canopi saved, or damaged
   * ones, say so once, then (2.1-Q319).
   */
  openSpeciesLists(read: SpeciesListReader): void;
  /** Runs a browser-record read over this store's storage (platform/browser-record.ts); it throws as the storage does. */
  readRecord<T>(read: (storage: BrowserStorageAdapter) => T): T;
}

export function createBrowserAppDataStore({
  storage = browserLocalStorageAdapter(),
  session = browserSessionStorageAdapter(),
  now = () => new Date().toISOString(),
}: BrowserAppDataStoreOptions = {}): BrowserAppDataStore {
  // The stores that refuse writes for this session: a damaged record that could not be moved aside, or a newer one.
  const refused = new Set<StoreId>();
  const readers: NewerRecordReaders = {};

  function readPartition<TRecord>(partition: BrowserStoragePartition<TRecord>): TRecord {
    const { store, key } = partition;
    let raw: string | null;
    let successor: RecordRead<TRecord> | undefined;
    try {
      successor = partition.successor?.(storage, readers);
      raw = storage.getItem(key);
    } catch {
      return partition.normalize(null);
    }
    if (successor !== undefined && successor.state !== "absent") {
      // 2.1's record, never moved aside (design check R3-4): read when it reads, unavailable when not; never written.
      const readable = successor.state === "unreadable" ? null : successor;
      const status = readable ? { kind: "newer_read_only" as const } : { kind: "unavailable" as const, code: { kind: "invalid" as const } };
      if (store && !refused.has(store)) writeStoreHealth(store, { status, notice: null });
      if (store) refused.add(store);
      return readable ? readable.record : partition.normalize(null);
    }
    if (raw === null) return partition.normalize(null);
    const value = parseRecord(raw);
    if (partition.accepts(value)) return partition.normalize(value);
    // The user's data, never written over (2.1-M438): kept, then its store reads as empty.
    const newer = isRecord(value) && typeof value.version === "number" && value.version > RECORD_VERSION;
    if (store && !refused.has(store) && keepUnreadableRecord(storage, { store, key, raw, newer, at: now() })) refused.add(store);
    return partition.normalize(null);
  }

  function writePartition<TRecord, TValue>(
    partition: BrowserStoragePartition<TRecord>,
    mutate: (current: TRecord) => { next: TRecord; value: TValue },
  ): BrowserAppDataWriteResult<TValue> {
    // Read first: the read is what finds a damaged record and decides whether its store refuses writes.
    const current = readPartition(partition);
    if (partition.store && refused.has(partition.store)) {
      return { ok: false, error: new StoreRefusedError(partition.store) };
    }
    try {
      const mutation = mutate(current);
      storage.setItem(partition.key, JSON.stringify(partition.encode ? partition.encode(mutation.next) : mutation.next));
      return { ok: true, value: mutation.value };
    } catch (error) {
      return { ok: false, error };
    }
  }

  return {
    saveDraft({ id: requestedId, file, now, expectedUpdatedAt }) {
      return writePartition(PARTITIONS.drafts, (current) => {
        const id = normalizeDraftId(requestedId, file.name);
        if (expectedUpdatedAt !== undefined) {
          // A Draft deleted meanwhile is written again rather than lost.
          const stored = current.drafts.find((draft) => draft.id === id);
          if (stored && stored.updatedAt !== expectedUpdatedAt) throw new BrowserDraftChangedError(id);
        }
        const summary = { id, name: file.name || "Untitled", updatedAt: now };
        const drafts = [summary, ...current.drafts.filter((draft) => draft.id !== summary.id)];
        const draftFiles = { ...current.draftFiles, [summary.id]: file };
        const refused = withoutRefusedDraft(current.refused, summary.id);
        return { next: { version: RECORD_VERSION, drafts, draftFiles, refused }, value: summary };
      });
    },

    listDrafts() {
      return readPartition(PARTITIONS.drafts).drafts;
    },

    loadDraft(id) {
      const draftFiles = readPartition(PARTITIONS.drafts).draftFiles;
      return Object.prototype.hasOwnProperty.call(draftFiles, id) ? draftFiles[id] ?? null : null;
    },

    deleteDraft(id) {
      return writePartition(PARTITIONS.drafts, (current) => {
        const { [id]: _removed, ...draftFiles } = current.draftFiles;
        const drafts = current.drafts.filter((draft) => draft.id !== id);
        return { next: { version: RECORD_VERSION, drafts, draftFiles, refused: withoutRefusedDraft(current.refused, id) }, value: null };
      });
    },

    saveSettings(settings) {
      return writePartition(PARTITIONS.settings, () => ({ next: { version: RECORD_VERSION, settings: { ...settings } }, value: { ...settings } }));
    },

    loadSettings() {
      // Strict, unlike the other reads: an unreadable record makes settings unavailable, never read as defaults that
      // a later save would write over it (SET-05, 2.1-Q67). A refused storage access throws as it was thrown.
      const raw = storage.getItem(PARTITIONS.settings.key);
      if (raw === null) return null;
      const value = parseRecord(raw);
      if (!PARTITIONS.settings.accepts(value)) throw new StoreUnreadableError("settings", { kind: "invalid" });
      return PARTITIONS.settings.normalize(value).settings;
    },

    setFavoriteSpecies(canonicalNames) {
      const favorites = uniqueStrings(canonicalNames);
      return writePartition(PARTITIONS.species, (current) => ({ next: { ...current, favoriteSpecies: favorites }, value: favorites }));
    },

    listFavoriteSpecies() {
      return readPartition(PARTITIONS.species).favoriteSpecies;
    },

    recordRecentlyViewedSpecies(canonicalName, limit = 50) {
      const normalized = canonicalName.trim();
      return writePartition(PARTITIONS.species, (current) => {
        const recentlyViewedSpecies = normalized.length === 0
          ? current.recentlyViewedSpecies
          : [normalized, ...current.recentlyViewedSpecies.filter((name) => name !== normalized)].slice(0, Math.max(0, limit));
        return { next: { ...current, recentlyViewedSpecies }, value: recentlyViewedSpecies };
      });
    },

    listRecentlyViewedSpecies() {
      return readPartition(PARTITIONS.species).recentlyViewedSpecies;
    },

    saveSavedObjectStamps(records) {
      const savedObjectStamps = records.map((record) => ({ ...record }));
      return writePartition(PARTITIONS.stamps, () => ({ next: { version: RECORD_VERSION, savedObjectStamps }, value: savedObjectStamps }));
    },

    listSavedObjectStamps() {
      return readPartition(PARTITIONS.stamps).savedObjectStamps;
    },

    takeEarlierDataNotice(now) {
      let found: boolean;
      try {
        found = EARLIER_KEYS.some((key) => storage.getItem(key) !== null);
      } catch {
        return false;
      }
      return noteKeptInPlace(storage, found, now);
    },

    noteReloadHome(draftId) {
      try {
        session.setItem(RELOAD_HOME_KEY, JSON.stringify({ draft: draftId }));
      } catch {
        // No session storage: the reload reopens the newest Draft, as a launch does.
      }
    },

    takeReloadHome() {
      let text: string | null;
      try {
        text = session.getItem(RELOAD_HOME_KEY);
        if (text !== null) session.removeItem(RELOAD_HOME_KEY);
      } catch {
        return null;
      }
      return text === null ? null : parseReloadHome(text);
    },

    openSpeciesLists(read) {
      readers.species = read;
      readPartition(PARTITIONS.species);
    },

    readRecord(read) {
      return read(storage);
    },
  };
}

/** A tab record this edition wrote, else null (read as no record). */
function parseReloadHome(text: string): BrowserReloadHome | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("draft" in value)) return null;
    const { draft } = value as { readonly draft: unknown };
    if (draft === null || (typeof draft === "string" && draft.length > 0)) return { draft };
  } catch {
    // Not this edition's record.
  }
  return null;
}

/**
 * True when the user should now be told that earlier data stays in place:
 * the first time it is found. The marker is cleared once nothing is found,
 * and when it cannot be written the user is told again on the next start.
 */
function noteKeptInPlace(storage: BrowserStorageAdapter, found: boolean, now: string): boolean {
  try {
    const told = storage.getItem(KEPT_IN_PLACE_NOTICE_KEY) !== null;
    if (!found) {
      if (told) storage.removeItem(KEPT_IN_PLACE_NOTICE_KEY);
      return false;
    }
    if (told) return false;
  } catch {
    return found;
  }
  try {
    storage.setItem(KEPT_IN_PLACE_NOTICE_KEY, now);
  } catch {
    // No room even for the marker: the notice repeats until there is.
  }
  return true;
}

export const browserAppDataStore = createBrowserAppDataStore();

function browserLocalStorageAdapter(): BrowserStorageAdapter {
  return {
    getItem: (key) => globalThis.localStorage.getItem(key),
    setItem: (key, value) => globalThis.localStorage.setItem(key, value),
    removeItem: (key) => globalThis.localStorage.removeItem(key),
  };
}

function browserSessionStorageAdapter(): BrowserStorageAdapter {
  return {
    getItem: (key) => globalThis.sessionStorage.getItem(key),
    setItem: (key, value) => globalThis.sessionStorage.setItem(key, value),
    removeItem: (key) => globalThis.sessionStorage.removeItem(key),
  };
}

function isSupportedDraftsRecord(value: unknown): boolean {
  return isCurrentRecord(value) && Array.isArray(value.drafts) && isRecord(value.draftFiles);
}

function isSupportedSettingsRecord(value: unknown): boolean {
  return isCurrentRecord(value) && (value.settings === null || isRecord(value.settings));
}

function isSupportedSpeciesRecord(value: unknown): boolean {
  return isCurrentRecord(value) && Array.isArray(value.favoriteSpecies) && Array.isArray(value.recentlyViewedSpecies);
}

function isSupportedStampsRecord(value: unknown): boolean {
  return isCurrentRecord(value) && Array.isArray(value.savedObjectStamps);
}

function normalizeDraftsRecord(value: unknown): BrowserDraftsRecord {
  if (!isCurrentRecord(value)) return emptyDraftsRecord();
  const { decoded: draftFiles, refused: refusedFiles } = decodeDraftFiles(value.draftFiles);
  const validDraftIds = new Set(Object.keys(draftFiles));
  const summaries: readonly unknown[] = Array.isArray(value.drafts) ? value.drafts : [];
  return {
    version: RECORD_VERSION,
    drafts: summaries.filter((draft): draft is BrowserDraftSummary => (
      isDraftSummary(draft) && validDraftIds.has(draft.id)
    )),
    draftFiles,
    refused: {
      summaries: summaries.filter((draft) => (
        isRecord(draft)
        && typeof draft.id === "string"
        && Object.prototype.hasOwnProperty.call(refusedFiles, draft.id)
      )),
      files: refusedFiles,
    },
  };
}

function normalizeSettingsRecord(value: unknown): BrowserSettingsRecord {
  if (!isCurrentRecord(value)) return emptySettingsRecord();
  return { version: RECORD_VERSION, settings: isRecord(value.settings) ? { ...value.settings } : null };
}

function normalizeSpeciesRecord(value: unknown): BrowserSpeciesRecord {
  if (!isCurrentRecord(value)) return emptySpeciesRecord();
  return {
    version: RECORD_VERSION,
    favoriteSpecies: Array.isArray(value.favoriteSpecies) ? uniqueStrings(value.favoriteSpecies) : [],
    recentlyViewedSpecies: Array.isArray(value.recentlyViewedSpecies) ? uniqueStrings(value.recentlyViewedSpecies) : [],
  };
}

function normalizeStampsRecord(value: unknown): BrowserSavedObjectStampsRecord {
  if (!isCurrentRecord(value)) return emptyStampsRecord();
  const savedObjectStamps = Array.isArray(value.savedObjectStamps) ? value.savedObjectStamps.filter(isSavedObjectStampRecord) : [];
  return { version: RECORD_VERSION, savedObjectStamps };
}

function emptyDraftsRecord(): BrowserDraftsRecord {
  return { version: RECORD_VERSION, drafts: [], draftFiles: {}, refused: { summaries: [], files: {} } };
}

function emptySettingsRecord(): BrowserSettingsRecord {
  return { version: RECORD_VERSION, settings: null };
}

function emptySpeciesRecord(): BrowserSpeciesRecord {
  return { version: RECORD_VERSION, favoriteSpecies: [], recentlyViewedSpecies: [] };
}

/** 2.1's species lists as this record: the names, newest first, as 2.1 keeps them (contracts §19 ED-25). */
function readSpeciesSuccessor(storage: BrowserStorageAdapter, { species }: NewerRecordReaders): RecordRead<BrowserSpeciesRecord> | undefined {
  const read = species?.(storage);
  if (read === undefined) return undefined;
  if (read.state === "absent" || read.state === "unreadable") return read;
  const names = (entries: readonly SpeciesListEntry[]) => uniqueStrings(entries.map((entry) => entry.canonical_name));
  const { favorites, recently_viewed } = read.record;
  return { ...read, record: { version: RECORD_VERSION, favoriteSpecies: names(favorites), recentlyViewedSpecies: names(recently_viewed) } };
}

function emptyStampsRecord(): BrowserSavedObjectStampsRecord {
  return { version: RECORD_VERSION, savedObjectStamps: [] };
}

function isCurrentRecord(value: unknown): value is Record<string, unknown> & { version: typeof RECORD_VERSION } {
  return isRecord(value) && value.version === RECORD_VERSION;
}

function encodeDraftsRecord(record: BrowserDraftsRecord): unknown {
  const draftFiles: Record<string, unknown> = {};
  for (const [id, file] of Object.entries(record.refused.files)) {
    defineOwn(draftFiles, id, file);
  }
  for (const [id, file] of Object.entries(record.draftFiles)) {
    defineOwn(draftFiles, id, encodeCanopiDesign(file));
  }
  return {
    version: record.version,
    drafts: [...record.drafts, ...record.refused.summaries],
    draftFiles,
  };
}

function withoutRefusedDraft(refused: RefusedDrafts, id: string): RefusedDrafts {
  if (!Object.prototype.hasOwnProperty.call(refused.files, id)) return refused;
  const { [id]: _removed, ...files } = refused.files;
  return {
    summaries: refused.summaries.filter((draft) => !isRecord(draft) || draft.id !== id),
    files,
  };
}

function decodeDraftFiles(value: unknown): {
  decoded: Record<string, CanopiFile>;
  refused: Record<string, unknown>;
} {
  const decoded: Record<string, CanopiFile> = {};
  const refused: Record<string, unknown> = {};
  if (!isRecord(value)) return { decoded, refused };
  for (const [id, rawFile] of Object.entries(value)) {
    try {
      defineOwn(decoded, id, decodeCanopiDesign(rawFile));
    } catch {
      // A Draft that does not open is not listed, but its stored value is
      // kept: it is the user's Design, not ours to erase.
      defineOwn(refused, id, rawFile);
    }
  }
  return { decoded, refused };
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isDraftSummary(value: unknown): value is BrowserDraftSummary {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.updatedAt === "string";
}

function isSavedObjectStampRecord(value: unknown): value is BrowserSavedObjectStampRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && Object.prototype.hasOwnProperty.call(value, "payload");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function draftIdFor(name: string): string {
  const slug = name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `draft-${slug || "untitled"}`;
}

function normalizeDraftId(id: string | undefined, name: string): string {
  const normalized = id?.trim();
  return normalized && normalized.length > 0 ? normalized : draftIdFor(name);
}
