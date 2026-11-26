/**
 * platform/draft-records-move.ts: Pure helpers for the Web Drafts IndexedDB store (2b-6,
 * canopi-f47t.52.50; contracts §11, 2.1-M157, 2.1-M21, 2.1-M526, 2.1-M527, 2.1-Q322):
 * legacy v3 localStorage envelope parsing, canonicalisation through DesignCore, SHA-256
 * hashing, deterministic older-tab copy ids, and pending-write markers over injected storage.
 * Touches neither raw `indexedDB` nor raw `localStorage`.
 */
import type { BrowserStorage } from './browser-record'
import type { DesignCore } from './design-core'

/** The 2.0 Web Drafts localStorage key — read once by 2.1, never written or deleted (2.1-M21). */
export const LEGACY_DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'
const PENDING_WRITE_IDS_KEY = 'canopi:web-drafts:pending-ids'
const PENDING_WRITE_PREFIX = 'canopi:web-drafts:pending:'

/** One record of the `drafts` object store (`spec/web/frozen/drafts.json`; pure JSON, no Blob/Date/ArrayBuffer). */
export interface StoredDraftRecord {
  readonly id: string
  readonly canopi_version: string
  readonly version: number
  readonly name: string
  readonly updated_at: string
  readonly content: string
}

interface OlderTabCopyEntry {
  readonly copyId: string
  readonly canonicalHash: string
}

/** The `meta` store's `move` record (`spec/web/frozen/drafts.json`, 2.1-Q322, 2.1-M157, 2.1-M527). */
export interface DraftMoveMetaRecord {
  readonly key: 'move'
  readonly state: 'copied' | 'live'
  readonly sourceHash: string
  readonly rev: number
  /** Append-only list of legacy v3 Draft ids copied into IndexedDB (frozen for v2.0.5 reader). */
  readonly copiedIds: readonly string[]
  /** Map of legacy id -> canonical content hash at the initial move (for post-move 2.0 tab detection). */
  readonly movedHashes?: Readonly<Record<string, string>>
  /** Map of legacy id -> single "copied from an older tab" Draft id and last copied hash. */
  readonly olderTabCopies?: Readonly<Record<string, OlderTabCopyEntry>>
}

export interface LegacyDraftEntry {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
  readonly rawText: string
}

export interface PreparedLegacyDraft {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
  readonly content: string
  readonly contentHash: string
  readonly decodable: boolean
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isQuotaDomError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { readonly name?: unknown }).name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = utf8Encoder.encode(text)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Deterministic 64-bit FNV-1a fallback for environments without SubtleCrypto.
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193)
    h2 = Math.imul(h2 ^ bytes[i]!, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/** Deterministic `[a-z0-9-]{1,64}` id for the single "copied from an older tab" Draft per legacy id. */
function olderTabCopyId(legacyId: string): string {
  const clean = legacyId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const suffix = clean.length > 0 ? clean.slice(0, 52) : 'draft'
  return `older-tab-${suffix}`.slice(0, 64)
}

export function parseDraftWriteBytes(
  bytes: Uint8Array,
  fallbackNowIso: string,
): { readonly ok: true; readonly content: string; readonly name: string; readonly updatedAt: string } | { readonly ok: false } {
  try {
    const content = utf8Decoder.decode(bytes)
    const parsed: unknown = JSON.parse(content)
    if (!isPlainRecord(parsed)) return { ok: false }
    if (typeof parsed.name !== 'string') return { ok: false }
    if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 10) {
      return { ok: false }
    }
    const updatedAt = typeof parsed.updated_at === 'string' && parsed.updated_at.length > 0
      ? parsed.updated_at
      : fallbackNowIso
    return { ok: true, content, name: parsed.name, updatedAt }
  } catch {
    // Non-UTF-8 or malformed JSON bytes cannot be stored as a v10 Draft record.
    return { ok: false }
  }
}

function indexLegacySummaries(drafts: unknown): Map<string, { readonly name: string; readonly updatedAt: string }> {
  const summariesById = new Map<string, { readonly name: string; readonly updatedAt: string }>()
  if (!Array.isArray(drafts)) return summariesById
  for (const item of drafts) {
    if (!isPlainRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue
    summariesById.set(item.id, {
      name: typeof item.name === 'string' ? item.name : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })
  }
  return summariesById
}

function buildLegacyEntry(
  id: string,
  rawFile: unknown,
  summary: { readonly name: string; readonly updatedAt: string } | undefined,
): LegacyDraftEntry | null {
  if (id.length === 0) return null
  let rawText: string
  try {
    rawText = JSON.stringify(rawFile)
  } catch {
    // Unserializable legacy draft entry skipped.
    return null
  }
  const fileName = isPlainRecord(rawFile) && typeof rawFile.name === 'string' ? rawFile.name : ''
  const fileUpdatedAt = isPlainRecord(rawFile) && typeof rawFile.updated_at === 'string' ? rawFile.updated_at : ''
  return {
    id,
    name: summary?.name || fileName || 'Untitled',
    updatedAt: summary?.updatedAt || fileUpdatedAt || '',
    rawText,
  }
}

/** Parses the 2.0 `canopi:web-app-data:v3:drafts` JSON envelope, keeping refused Drafts intact. */
export function parseLegacyDraftsEnvelope(raw: string): readonly LegacyDraftEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupted legacy JSON yields no extractable entries; caller leaves the raw key untouched.
    return []
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.draftFiles)) return []
  const summariesById = indexLegacySummaries(parsed.drafts)
  const entries: LegacyDraftEntry[] = []
  for (const [id, rawFile] of Object.entries(parsed.draftFiles)) {
    const entry = buildLegacyEntry(id, rawFile, summariesById.get(id))
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Canonicalises each 2.0 Draft through `designCore` (`decode` + `encode` so v9 migrates to
 * canonical v10 `.canopi` text, invariant 2.1-M527(a)). A refused/unreadable legacy Draft keeps
 * its verbatim raw JSON text so no user work is dropped during the move.
 */
export async function prepareLegacyDrafts(
  entries: readonly LegacyDraftEntry[],
  designCore: Pick<DesignCore, 'decode' | 'encode'> | undefined,
  fallbackNowIso: string,
): Promise<readonly PreparedLegacyDraft[]> {
  const prepared: PreparedLegacyDraft[] = []
  for (const entry of entries) {
    let content = entry.rawText
    let name = entry.name
    let updatedAt = entry.updatedAt || fallbackNowIso
    let decodable = false
    if (designCore) {
      try {
        const decoded = await designCore.decode(utf8Encoder.encode(entry.rawText))
        if ('ok' in decoded) {
          const encoded = await designCore.encode(decoded.ok.design)
          if ('ok' in encoded) {
            content = utf8Decoder.decode(encoded.ok)
            if (typeof decoded.ok.design.name === 'string' && decoded.ok.design.name.length > 0) {
              name = decoded.ok.design.name
            }
            if (typeof decoded.ok.design.updated_at === 'string' && decoded.ok.design.updated_at.length > 0) {
              updatedAt = decoded.ok.design.updated_at
            }
            decodable = true
          }
        }
      } catch {
        // Refused or un-decodable legacy Draft is copied verbatim as a refused record.
      }
    }
    const contentHash = await sha256Hex(content)
    prepared.push({ id: entry.id, name, updatedAt, content, contentHash, decodable })
  }
  return prepared
}

async function verifyStoredContent(
  stored: StoredDraftRecord | undefined,
  expected: PreparedLegacyDraft,
  designCore: Pick<DesignCore, 'decode' | 'encode'> | undefined,
): Promise<boolean> {
  if (!stored || stored.id !== expected.id || typeof stored.content !== 'string') return false
  if (stored.content === expected.content) return true
  if (!expected.decodable || !designCore) return false
  try {
    const decoded = await designCore.decode(utf8Encoder.encode(stored.content))
    if (!('ok' in decoded)) return false
    const encoded = await designCore.encode(decoded.ok.design)
    if (!('ok' in encoded)) return false
    return utf8Decoder.decode(encoded.ok) === expected.content
  } catch {
    // Verification decode failure means read-back did not match staged canonical content.
    return false
  }
}

function readPendingWriteIds(storage: BrowserStorage | undefined): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(PENDING_WRITE_IDS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  } catch {
    // Corrupt pending-write index treated as empty.
    return []
  }
}

export function markPendingWrite(storage: BrowserStorage | undefined, id: string, nowIso: string): void {
  if (!storage || id.length === 0) return
  try {
    storage.setItem(`${PENDING_WRITE_PREFIX}${id}`, nowIso)
    const ids = readPendingWriteIds(storage)
    if (!ids.includes(id)) {
      storage.setItem(PENDING_WRITE_IDS_KEY, JSON.stringify([...ids, id]))
    }
  } catch {
    // Pending-write marker is best-effort; storage quota refusal is handled by the write lane.
  }
}

export function clearPendingWrite(storage: BrowserStorage | undefined, id: string): void {
  if (!storage || id.length === 0) return
  try {
    storage.removeItem(`${PENDING_WRITE_PREFIX}${id}`)
    const ids = readPendingWriteIds(storage).filter((entry) => entry !== id)
    if (ids.length === 0) storage.removeItem(PENDING_WRITE_IDS_KEY)
    else storage.setItem(PENDING_WRITE_IDS_KEY, JSON.stringify(ids))
  } catch {
    // Best-effort clear of pending-write marker.
  }
}

export function takePendingWrites(storage: BrowserStorage | undefined): readonly string[] {
  if (!storage) return []
  const ids = readPendingWriteIds(storage)
  const found: string[] = []
  for (const id of ids) {
    try {
      if (storage.getItem(`${PENDING_WRITE_PREFIX}${id}`) !== null) found.push(id)
      storage.removeItem(`${PENDING_WRITE_PREFIX}${id}`)
    } catch {
      // Best-effort cleanup of pending-write marker.
    }
  }
  try {
    storage.removeItem(PENDING_WRITE_IDS_KEY)
  } catch {
    // Best-effort cleanup of pending-write index.
  }
  return found
}

export interface LegacyMoveStores {
  readonly draftsStore: string
  readonly metaStore: string
  readonly moveKey: string
}

function readIdbRequests(tx: IDBTransaction, requests: readonly IDBRequest[], label: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(requests.map((request) => request.result as unknown))
    tx.onerror = () => reject(tx.error ?? new Error(`Reading ${label} failed`))
    tx.onabort = () => reject(tx.error ?? new Error(`Reading ${label} was aborted`))
  })
}

export async function readMoveMetaRecord(conn: IDBDatabase, stores: LegacyMoveStores): Promise<DraftMoveMetaRecord | null> {
  const tx = conn.transaction(stores.metaStore, 'readonly')
  const [raw] = await readIdbRequests(tx, [tx.objectStore(stores.metaStore).get(stores.moveKey)], stores.metaStore)
  if (!isPlainRecord(raw) || raw.key !== stores.moveKey) return null
  return raw as unknown as DraftMoveMetaRecord
}

export async function runInitialLegacyMove(params: {
  readonly conn: IDBDatabase
  readonly stores: LegacyMoveStores
  readonly prepared: readonly PreparedLegacyDraft[]
  readonly sourceHash: string
  readonly existingMove: DraftMoveMetaRecord | null
  readonly appVersion: string
  readonly legacyStorage: BrowserStorage | undefined
  readonly designCore: Pick<DesignCore, 'decode' | 'encode'> | undefined
  readonly onMigrationFailed: ((error: unknown) => void) | undefined
}): Promise<void> {
  const { conn, stores, prepared, sourceHash, existingMove, appVersion, legacyStorage, designCore, onMigrationFailed } = params
  const stagedRev = (existingMove?.rev ?? 0) + 1
  const copiedIds = [...new Set([...(existingMove?.copiedIds ?? []), ...prepared.map((p) => p.id)])]
  const movedHashes: Record<string, string> = { ...(existingMove?.movedHashes ?? {}) }
  for (const item of prepared) movedHashes[item.id] = item.contentHash

  const stagedIds = new Set<string>()
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction([stores.draftsStore, stores.metaStore], 'readwrite')
    const draftsStore = tx.objectStore(stores.draftsStore)
    const existingReq = draftsStore.getAll()
    existingReq.onsuccess = () => {
      const held = new Set(
        (Array.isArray(existingReq.result) ? existingReq.result : [])
          .filter((r): r is StoredDraftRecord => isPlainRecord(r) && typeof r.id === 'string')
          .map((r) => r.id),
      )
      for (const item of prepared) {
        if (held.has(item.id)) continue
        stagedIds.add(item.id)
        draftsStore.put({
          id: item.id,
          canopi_version: appVersion,
          version: 1,
          name: item.name,
          updated_at: item.updatedAt,
          content: item.content,
        } satisfies StoredDraftRecord)
      }
      tx.objectStore(stores.metaStore).put({
        key: 'move',
        state: 'copied',
        sourceHash,
        rev: stagedRev,
        copiedIds,
        movedHashes,
        ...(existingMove?.olderTabCopies ? { olderTabCopies: existingMove.olderTabCopies } : {}),
      } satisfies DraftMoveMetaRecord)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Staging legacy Drafts failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Staging legacy Drafts aborted'))
  })

  const verifyTx = conn.transaction(stores.draftsStore, 'readonly')
  const [allRows] = await readIdbRequests(verifyTx, [verifyTx.objectStore(stores.draftsStore).getAll()], stores.draftsStore)
  const byId = new Map<string, StoredDraftRecord>()
  for (const row of Array.isArray(allRows) ? allRows : []) {
    if (isPlainRecord(row) && typeof row.id === 'string') byId.set(row.id, row as unknown as StoredDraftRecord)
  }
  for (const item of prepared) {
    if (!stagedIds.has(item.id)) continue
    if (!(await verifyStoredContent(byId.get(item.id), item, designCore))) {
      onMigrationFailed?.(new Error(`Verification mismatch for migrated Draft ${item.id}`))
      return
    }
  }

  const rawNow = legacyStorage?.getItem(LEGACY_DRAFTS_KEY)
  if (rawNow === null || rawNow === undefined || (await sha256Hex(rawNow)) !== sourceHash) return
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction(stores.metaStore, 'readwrite')
    const metaStore = tx.objectStore(stores.metaStore)
    const getReq = metaStore.get(stores.moveKey)
    getReq.onsuccess = () => {
      const cur = getReq.result as DraftMoveMetaRecord | undefined
      if (!cur || cur.rev !== stagedRev) return
      metaStore.put({ ...cur, state: 'live' } satisfies DraftMoveMetaRecord)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Swapping legacy Drafts live failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Swapping legacy Drafts live aborted'))
  })
}

export async function runOlderTabLegacyCopy(params: {
  readonly conn: IDBDatabase
  readonly stores: LegacyMoveStores
  readonly prepared: readonly PreparedLegacyDraft[]
  readonly sourceHash: string
  readonly move: DraftMoveMetaRecord
  readonly appVersion: string
  readonly onOlderTabCopy: ((copy: { readonly legacyId: string; readonly copyId: string; readonly name: string }) => void) | undefined
}): Promise<void> {
  const { conn, stores, prepared, sourceHash, move, appVersion, onOlderTabCopy } = params
  const movedHashes = move.movedHashes ?? {}
  const nextCopies: Record<string, OlderTabCopyEntry> = { ...(move.olderTabCopies ?? {}) }
  const changed: Array<{ readonly item: PreparedLegacyDraft; readonly copyId: string }> = []
  for (const item of prepared) {
    const prevCopy = nextCopies[item.id]
    if (item.contentHash === movedHashes[item.id] || item.contentHash === prevCopy?.canonicalHash) continue
    const copyId = prevCopy?.copyId ?? olderTabCopyId(item.id)
    changed.push({ item, copyId })
    nextCopies[item.id] = { copyId, canonicalHash: item.contentHash }
  }
  const copiedIds = [...new Set([...move.copiedIds, ...prepared.map((p) => p.id)])]
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction([stores.draftsStore, stores.metaStore], 'readwrite')
    const draftsStore = tx.objectStore(stores.draftsStore)
    for (const { item, copyId } of changed) {
      const req = draftsStore.get(copyId)
      req.onsuccess = () => {
        const existing = isPlainRecord(req.result) ? (req.result as unknown as StoredDraftRecord) : null
        draftsStore.put({
          id: copyId,
          canopi_version: appVersion,
          version: existing ? existing.version + 1 : 1,
          name: item.name,
          updated_at: item.updatedAt,
          content: item.content,
        } satisfies StoredDraftRecord)
      }
    }
    tx.objectStore(stores.metaStore).put({
      ...move,
      sourceHash,
      rev: move.rev + 1,
      copiedIds,
      olderTabCopies: nextCopies,
    } satisfies DraftMoveMetaRecord)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Copying older-tab Drafts failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Copying older-tab Drafts aborted'))
  })
  for (const { item, copyId } of changed) {
    onOlderTabCopy?.({ legacyId: item.id, copyId, name: item.name })
  }
}
