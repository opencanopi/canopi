/**
 * failures/store-read.ts: how a TS store adapter reads its record without losing the user's data (SET-05, 2.1-Q67,
 * 2.1-M438; canopi-f47t.52.36). A record that cannot be read is refused with a typed error and a catalogue code, read
 * again after bounded pauses while its reader is current, and never written over: a damaged browser record moves
 * aside under its own key, or, when it cannot be moved, its store refuses writes for the session. Each outcome is
 * written to the one health model, which the notice row tells once.
 */
import type { FailureCode, StoreId } from '../generated/contracts'
import { failureOf } from './ipc-failure'
import { writeStoreHealth } from './health'

/** What a store adapter throws when its record cannot be read, with the code the problem report carries. */
export class StoreUnreadableError extends Error {
  override readonly name = 'StoreUnreadableError'

  constructor(readonly store: StoreId, readonly code: FailureCode, options?: { readonly cause?: unknown }) {
    super(`The ${store} record could not be read`, options)
  }
}

/** A write to a store that refuses writes for this session: its record is damaged or newer (2.1-M438). */
export class StoreRefusedError extends Error {
  override readonly name = 'StoreRefusedError'

  constructor(readonly store: StoreId) {
    super(`The ${store} store refuses writes for this session`)
  }
}

/** A failed read's code: the typed failure's, the adapter's own, else `internal`. */
export function readFailureCode(error: unknown): FailureCode {
  return failureOf(error)?.code ?? (error instanceof StoreUnreadableError ? error.code : { kind: 'internal' })
}

/**
 * Reads until a read answers, waiting each of `delays` after a failed one while `current()` holds; rejects with the last
 * failure, or with the failure in hand once the reader is no longer current (a retired projection reads nothing more).
 */
export async function readWithRetry<T>(
  first: Promise<T>,
  read: () => T | Promise<T>,
  delays: readonly number[],
  current: () => boolean,
): Promise<T> {
  let pending = first
  for (const delay of delays) {
    try {
      return await pending
    } catch (error) {
      if (!current()) throw error
      await new Promise((resolve) => { globalThis.setTimeout(resolve, delay) })
      if (!current()) throw error
    }
    pending = Promise.resolve().then(read)
  }
  return pending
}

/** The browser storage a damaged record is moved aside in. */
export interface RecordStorage {
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Keeps a browser record that does not read (2.1-M438, 2.1-Q287): a newer one stays and its store refuses writes; a
 * damaged one moves under `<key>:damaged-<at>` and is named once, or, when it cannot be moved (the quota), stays where
 * it is and its store refuses writes for the session. Returns whether the store now refuses writes.
 */
export function keepUnreadableRecord(
  storage: RecordStorage,
  record: { readonly store: StoreId; readonly key: string; readonly raw: string; readonly newer: boolean; readonly at: string },
): boolean {
  const { store, key, raw } = record
  if (record.newer) {
    writeStoreHealth(store, { status: { kind: 'refused_newer' }, notice: null })
    return true
  }
  const aside = `${key}:damaged-${record.at}`
  try {
    storage.setItem(aside, raw)
    storage.removeItem(key)
    writeStoreHealth(store, { status: { kind: 'set_aside_damaged', file: aside }, notice: null })
    return false
  } catch (error) {
    const quota = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    writeStoreHealth(store, { status: { kind: 'unavailable', code: { kind: 'io', io: quota ? 'no_space' : 'other' } }, notice: null })
    return true
  }
}
