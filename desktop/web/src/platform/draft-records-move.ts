/**
 * platform/draft-records-move.ts: Pure helpers for the Web Drafts IndexedDB store (2b-6,
 * canopi-f47t.52.50; contracts §11, 2.1-M157, 2.1-M21, 2.1-M526, 2.1-M527, 2.1-Q322):
 * legacy v3 localStorage envelope parsing, canonicalisation through DesignCore, SHA-256
 * hashing, deterministic older-tab copy ids, and per-tab pending-write markers over injected
 * storage. Touches neither raw `indexedDB` nor raw `localStorage`.
 */
import type { BrowserStorage } from './browser-record'
import type { DesignCore } from './design-core'

/** The 2.0 Web Drafts localStorage key — read once by 2.1, never written or deleted (2.1-M21). */
export const LEGACY_DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'

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
  /** Last record version written by the older-tab lane; a higher version means 2.1 edited this copy. */
  readonly writtenVersion: number
}

/** The `meta` store's `move` record (`spec/web/frozen/drafts.json`, 2.1-Q322, 2.1-M157, 2.1-M527). */
export interface DraftMoveMetaRecord {
  readonly key: 'move'
  readonly state: 'copied' | 'live'
  readonly sourceHash: string
  readonly rev: number
  /** Append-only list of legacy v3 Draft ids copied into IndexedDB (frozen for v2.0.5 reader). */
  readonly copiedIds: readonly string[]
  /**
   * Map of legacy id -> SHA-256 of DesignCore's canonical v10 bytes at the initial move (for post-move
   * 2.0 tab detection). Note: depends on DesignCore's canonical encoding; a future encoding change
   * would cause a subsequent 2.0 write to look modified and create an older-tab copy.
   */
  readonly movedHashes?: Readonly<Record<string, string>>
  /** Map of legacy id -> latest "copied from an older tab" Draft id, last copied hash, and written version. */
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

/** Extracts a Draft's display name from UTF-8 `.canopi` bytes, falling back to `fallback`. */
export function draftNameFromBytes(bytes: Uint8Array | null, fallback = 'Untitled'): string {
  if (!bytes) return fallback
  try {
    const parsed = JSON.parse(utf8Decoder.decode(bytes)) as { readonly name?: unknown }
    return typeof parsed?.name === 'string' && parsed.name.trim().length > 0 ? parsed.name : fallback
  } catch {
    // Unreadable Draft bytes fall back to Untitled in list and notice views.
    return fallback
  }
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

/** Deterministic `[a-z0-9-]{1,64}` id for an "older-tab" copy (2.1-M527(c)); `revision > 1` disambiguates after 2.1 edits. */
function olderTabCopyId(legacyId: string, revision = 1): string {
  const clean = legacyId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const suffix = clean.length > 0 ? clean : 'draft'
  if (revision <= 1) return `older-tab-${suffix.slice(0, 54)}`.slice(0, 64)
  const revTag = `-${revision}`
  const maxSuffix = Math.max(1, 64 - 'older-tab-'.length - revTag.length)
  return `older-tab-${suffix.slice(0, maxSuffix)}${revTag}`
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

export interface LegacyMoveStores {
  readonly draftsStore: string
  readonly metaStore: string
  readonly moveKey: string
}

export function readIdbRequests(tx: IDBTransaction, requests: readonly IDBRequest[], label: string): Promise<unknown[]> {
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
  readonly appVersion: string
  readonly legacyStorage: BrowserStorage | undefined
  readonly designCore: Pick<DesignCore, 'decode' | 'encode'> | undefined
  readonly onMigrationFailed: ((error: unknown) => void) | undefined
}): Promise<boolean> {
  const { conn, stores, prepared, sourceHash, appVersion, legacyStorage, designCore, onMigrationFailed } = params
  let stagedRev = 0
  let alreadyLive = false
  const verifyIds = new Set<string>()

  // Stage in one readwrite transaction, re-reading `meta.move` inside the tx for CAS between concurrent 2.1 tabs.
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction([stores.draftsStore, stores.metaStore], 'readwrite')
    const draftsStore = tx.objectStore(stores.draftsStore)
    const metaStore = tx.objectStore(stores.metaStore)
    let existingRows: StoredDraftRecord[] | null = null
    let existingMeta: DraftMoveMetaRecord | null | undefined = undefined

    const finish = () => {
      if (existingRows === null || existingMeta === undefined) return
      if (existingMeta?.state === 'live') {
        alreadyLive = true
        return
      }
      const heldById = new Map<string, StoredDraftRecord>()
      for (const row of existingRows) heldById.set(row.id, row)
      stagedRev = (existingMeta?.rev ?? 0) + 1
      const copiedIds = [...new Set([...(existingMeta?.copiedIds ?? []), ...prepared.map((p) => p.id)])]
      const movedHashes: Record<string, string> = { ...(existingMeta?.movedHashes ?? {}) }

      for (const item of prepared) {
        const existing = heldById.get(item.id)
        if (!existing) {
          draftsStore.put({
            id: item.id,
            canopi_version: appVersion,
            version: 1,
            name: item.name,
            updated_at: item.updatedAt,
            content: item.content,
          } satisfies StoredDraftRecord)
          movedHashes[item.id] = item.contentHash
          verifyIds.add(item.id)
        } else if (existing.version <= 1) {
          // Unpublished staged copy (state !== 'live'): re-stage with a bumped version if content differs (B1/B2)
          // so any 2.1 session holding version "1" sees a CAS conflict instead of silently overwriting 2.0 edits.
          if (existing.content !== item.content) {
            draftsStore.put({
              id: item.id,
              canopi_version: appVersion,
              version: existing.version + 1,
              name: item.name,
              updated_at: item.updatedAt,
              content: item.content,
            } satisfies StoredDraftRecord)
          }
          movedHashes[item.id] = item.contentHash
          verifyIds.add(item.id)
        } else {
          // Already edited by 2.1 (version > 1): never overwrite, and preserve the earlier movedHash so
          // a concurrent 2.0 edit is routed through the older-tab copy lane once live (B2).
          if (!(item.id in movedHashes)) movedHashes[item.id] = item.contentHash
        }
      }
      metaStore.put({
        key: 'move',
        state: 'copied',
        sourceHash,
        rev: stagedRev,
        copiedIds,
        movedHashes,
        ...(existingMeta?.olderTabCopies ? { olderTabCopies: existingMeta.olderTabCopies } : {}),
      } satisfies DraftMoveMetaRecord)
    }

    const draftsReq = draftsStore.getAll()
    draftsReq.onsuccess = () => {
      existingRows = (Array.isArray(draftsReq.result) ? draftsReq.result : [])
        .filter((r): r is StoredDraftRecord => isPlainRecord(r) && typeof r.id === 'string')
      finish()
    }
    const metaReq = metaStore.get(stores.moveKey)
    metaReq.onsuccess = () => {
      const raw = metaReq.result
      existingMeta = isPlainRecord(raw) && raw.key === stores.moveKey ? (raw as unknown as DraftMoveMetaRecord) : null
      finish()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Staging legacy Drafts failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Staging legacy Drafts aborted'))
  })

  if (alreadyLive) return false

  // Read-back verification outside any transaction through DesignCore (2.1-M157, B1).
  const verifyTx = conn.transaction(stores.draftsStore, 'readonly')
  const [allRows] = await readIdbRequests(verifyTx, [verifyTx.objectStore(stores.draftsStore).getAll()], stores.draftsStore)
  const byId = new Map<string, StoredDraftRecord>()
  for (const row of Array.isArray(allRows) ? allRows : []) {
    if (isPlainRecord(row) && typeof row.id === 'string') byId.set(row.id, row as unknown as StoredDraftRecord)
  }
  for (const item of prepared) {
    if (!verifyIds.has(item.id)) continue
    if (!(await verifyStoredContent(byId.get(item.id), item, designCore))) {
      onMigrationFailed?.(new Error(`Verification mismatch for migrated Draft ${item.id}`))
      return false
    }
  }

  // Re-read the 2.0 key synchronously before swapping live; a change during staging aborts the swap.
  const rawNow = legacyStorage?.getItem(LEGACY_DRAFTS_KEY)
  if (rawNow === null || rawNow === undefined || (await sha256Hex(rawNow)) !== sourceHash) return false
  let swapped = false
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction(stores.metaStore, 'readwrite')
    const metaStore = tx.objectStore(stores.metaStore)
    const getReq = metaStore.get(stores.moveKey)
    getReq.onsuccess = () => {
      const cur = getReq.result as DraftMoveMetaRecord | undefined
      if (!cur || cur.state !== 'copied' || cur.rev !== stagedRev) return
      metaStore.put({ ...cur, state: 'live' } satisfies DraftMoveMetaRecord)
      swapped = true
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Swapping legacy Drafts live failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Swapping legacy Drafts live aborted'))
  })
  return swapped
}

function chooseAvailableCopyId(legacyId: string, existingIds: ReadonlySet<string>): string {
  for (let rev = 2; rev < 1000; rev += 1) {
    const candidate = olderTabCopyId(legacyId, rev)
    if (!existingIds.has(candidate)) return candidate
  }
  return olderTabCopyId(`${legacyId}-${Date.now().toString(36)}`, 2)
}

function applyOlderTabItem(params: {
  readonly item: PreparedLegacyDraft
  readonly movedHashes: Readonly<Record<string, string>>
  readonly rowsById: ReadonlyMap<string, StoredDraftRecord>
  readonly existingIds: Set<string>
  readonly nextCopies: Record<string, OlderTabCopyEntry>
  readonly draftsStore: IDBObjectStore
  readonly appVersion: string
}): { readonly legacyId: string; readonly copyId: string; readonly name: string } | null {
  const { item, movedHashes, rowsById, existingIds, nextCopies, draftsStore, appVersion } = params
  const prevCopy = nextCopies[item.id]
  if (item.contentHash === movedHashes[item.id] || item.contentHash === prevCopy?.canonicalHash) return null
  const preferredId = prevCopy?.copyId ?? olderTabCopyId(item.id)
  const existing = rowsById.get(preferredId)
  // Rotate when the tracked copy has 2.1 edits (or collides with an existing ordinary Draft):
  // the 2.1-edited copy stays as an ordinary Draft, and a fresh older-tab-* record gets the new 2.0 content (2.1-M527).
  const writtenVersion = prevCopy?.writtenVersion ?? 1
  const needsRotate = existing !== undefined && (prevCopy === undefined || existing.version > writtenVersion)
  const copyId = needsRotate ? chooseAvailableCopyId(item.id, existingIds) : preferredId
  const nextVersion = !needsRotate && existing ? existing.version + 1 : 1
  existingIds.add(copyId)
  draftsStore.put({
    id: copyId,
    canopi_version: appVersion,
    version: nextVersion,
    name: item.name,
    updated_at: item.updatedAt,
    content: item.content,
  } satisfies StoredDraftRecord)
  nextCopies[item.id] = { copyId, canonicalHash: item.contentHash, writtenVersion: nextVersion }
  return { legacyId: item.id, copyId, name: item.name }
}

export async function runOlderTabLegacyCopy(params: {
  readonly conn: IDBDatabase
  readonly stores: LegacyMoveStores
  readonly prepared: readonly PreparedLegacyDraft[]
  readonly sourceHash: string
  readonly expectedRev: number
  readonly appVersion: string
  readonly onOlderTabCopy: ((copy: { readonly legacyId: string; readonly copyId: string; readonly name: string }) => void) | undefined
}): Promise<boolean> {
  const { conn, stores, prepared, sourceHash, expectedRev, appVersion, onOlderTabCopy } = params
  const createdOrUpdated: Array<{ readonly legacyId: string; readonly copyId: string; readonly name: string }> = []
  let committed = false

  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction([stores.draftsStore, stores.metaStore], 'readwrite')
    const draftsStore = tx.objectStore(stores.draftsStore)
    const metaStore = tx.objectStore(stores.metaStore)
    let existingRows: StoredDraftRecord[] | null = null
    let currentMeta: DraftMoveMetaRecord | null | undefined = undefined

    const finish = () => {
      if (existingRows === null || currentMeta === undefined) return
      // Meta CAS: if another 2.1 tab advanced `rev`, bail so caller can re-sync without dropping entries.
      if (!currentMeta || currentMeta.state !== 'live' || currentMeta.rev !== expectedRev) return
      const rowsById = new Map<string, StoredDraftRecord>(existingRows.map((row) => [row.id, row]))
      const existingIds = new Set<string>(rowsById.keys())
      const movedHashes = currentMeta.movedHashes ?? {}
      const nextCopies: Record<string, OlderTabCopyEntry> = { ...(currentMeta.olderTabCopies ?? {}) }

      for (const item of prepared) {
        const result = applyOlderTabItem({ item, movedHashes, rowsById, existingIds, nextCopies, draftsStore, appVersion })
        if (result) createdOrUpdated.push(result)
      }
      const copiedIds = [...new Set([...currentMeta.copiedIds, ...prepared.map((p) => p.id)])]
      metaStore.put({
        ...currentMeta,
        sourceHash,
        rev: currentMeta.rev + 1,
        copiedIds,
        olderTabCopies: nextCopies,
      } satisfies DraftMoveMetaRecord)
      committed = true
    }

    const draftsReq = draftsStore.getAll()
    draftsReq.onsuccess = () => {
      existingRows = (Array.isArray(draftsReq.result) ? draftsReq.result : [])
        .filter((r): r is StoredDraftRecord => isPlainRecord(r) && typeof r.id === 'string')
      finish()
    }
    const metaReq = metaStore.get(stores.moveKey)
    metaReq.onsuccess = () => {
      const raw = metaReq.result
      currentMeta = isPlainRecord(raw) && raw.key === stores.moveKey ? (raw as unknown as DraftMoveMetaRecord) : null
      finish()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Copying older-tab Drafts failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Copying older-tab Drafts aborted'))
  })

  if (committed) {
    for (const copy of createdOrUpdated) onOlderTabCopy?.(copy)
  }
  return committed
}
