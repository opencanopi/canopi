// app/document-session/continuous-save.ts
//
// Owner of the Session core write lane today (serial-lane-only-in-owners, ADR 0024; §18 F37), moving to
// app/document-session/core/ in 2b. Invariant: one write in flight; a change during it queues one more.

import { batch, computed, effect, signal, type ReadonlySignal } from '@preact/signals'
import type { CanopiFile } from '../../types/design'
import type { DesignSessionStore } from './store'

/** Continuous save writes this long after the last committed change. */
export const CONTINUOUS_SAVE_DELAY_MS = 1500

/**
 * `draft`: the Design lives in a Design Draft (never saved to a file); Canopi
 * keeps every change there. `saved`/`saving` describe a Design with a file.
 */
export type DesignSaveStatus = 'saved' | 'saving' | 'draft' | 'error' | 'conflict'

/**
 * Where a Design Session writes. A file home is the `.canopi` file the
 * Design came from (Desktop only); a draft home is an app-data Design Draft.
 * `fingerprint` is what the file must still hold on disk; `null` overwrites.
 */
export type DesignHome =
  | { readonly kind: 'file'; readonly path: string; readonly fingerprint: string | null }
  | { readonly kind: 'draft'; readonly id: string }

export type HomeWriteOutcome =
  | { readonly kind: 'written' }
  /** A newer save overtook this one, so the home may not hold this content. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'conflict'; readonly fileGone: boolean }

interface ContinuousSaveConflict {
  /** The file was moved or deleted rather than changed. */
  readonly fileGone: boolean
}

export interface DesignSessionHomeInput {
  /** The draft home; ignored while the store has a file path. */
  readonly draftId: string | null
  /** Fingerprint of the file at the store's path, when it has one. */
  readonly fingerprint: string | null
  /** The home does not hold this content yet (template, imported file, revert). */
  readonly writePending: boolean
}

/** Thrown by a file writer when the file changed outside Canopi. */
export class DesignHomeConflictError extends Error {
  constructor(readonly fileGone: boolean) {
    super(fileGone ? 'Design file was moved or deleted' : 'Design file changed outside Canopi')
    this.name = 'DesignHomeConflictError'
  }
}

export interface ContinuousSaveOptions {
  readonly store: DesignSessionStore
  /**
   * Edition writer: writes the committed Design to `home` and acknowledges it.
   * A synchronous writer (browser Drafts) settles within the calling task, so
   * a page-hide flush completes before the page goes away.
   */
  writeHome(home: DesignHome): HomeWriteOutcome | Promise<HomeWriteOutcome>
  readonly delayMs?: number
  readonly logError?: (message?: unknown, ...optionalParams: unknown[]) => void
}

/**
 * The continuous-save core shared by both editions. It owns the session's
 * home, the debounce timer, write coalescing, the save status, the conflict
 * pause and the snapshot used by "Revert to version when opened".
 */
export interface ContinuousSave {
  readonly status: ReadonlySignal<DesignSaveStatus>
  /** Why the last write failed, in the writer's words; null unless the status is `error`. */
  readonly failureReason: ReadonlySignal<string | null>
  readonly conflict: ReadonlySignal<ContinuousSaveConflict | null>
  readonly revertAvailable: ReadonlySignal<boolean>
  /** Bind a new home to the store's current session (call from replacement finalization). */
  beginSession(input: DesignSessionHomeInput): void
  /** Forget the closed session's home: nothing more is written for it (call from close finalization). */
  endSession(): void
  /** Opaque identity of the current session, for writes that settle later. */
  sessionToken(): object | null
  readHome(): DesignHome | null
  readSnapshot(): CanopiFile | null
  recordFileFingerprint(token: object | null, path: string, fingerprint: string): void
  /** Change the draft home of the session `token` names; clears failure and conflict. */
  rehome(token: object | null, home: { readonly draftId: string | null }): void
  hasPendingChanges(): boolean
  /** Write now; true when the home holds every committed change. */
  flush(): Promise<boolean>
  /**
   * A manual Save: write now even with nothing pending, so the home also holds the live view. It asks for one write
   * and marks nothing: when a write with no edits fails, the error shows but nothing stays unsaved. Retry in both
   * editions is this Save (U30), so it writes even when an undo left nothing pending.
   */
  save(): Promise<boolean>
  /** Resolve a conflict by overwriting the file with the Design of the session `token` names. */
  overwriteHome(token: object | null): Promise<boolean>
  /** Resolves when no write is in flight or queued. */
  idle(): Promise<void>
  install(): () => void
  dispose(): void
}

interface SessionHomeRecord {
  readonly identity: object
  draftId: string | null
  readonly fingerprints: Map<string, string | null>
  readonly snapshot: CanopiFile | null
}

export function createContinuousSave({
  store,
  writeHome,
  delayMs = CONTINUOUS_SAVE_DELAY_MS,
  logError = (message, ...rest) => console.error(message, ...rest),
}: ContinuousSaveOptions): ContinuousSave {
  const record = signal<SessionHomeRecord | null>(null)
  const writePending = signal(false)
  const changed = signal(false)
  const failed = signal(false)
  const failureReason = signal<string | null>(null)
  const conflict = signal<ContinuousSaveConflict | null>(null)
  // The session whose write is in flight; another session's write never shows as its "Saving…".
  const writingSession = signal<object | null>(null)
  // A manual Save asked for the next write even if nothing is pending; the write that starts consumes it.
  let forceWrite = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let active: Promise<boolean> | null = null
  let queued: Promise<boolean> | null = null
  let disposed = false

  const currentRecord = (): SessionHomeRecord | null => {
    const current = record.value
    return current && current.identity === store.sessionIdentity.value ? current : null
  }

  const pending = computed(() =>
    store.currentDesign.value !== null
    && (store.designDirty.value || (currentRecord() !== null && writePending.value))
  )

  // A Design with no home cannot be written; treat its changes as unsaved.
  const homeless = computed(() => {
    const current = currentRecord()
    return !current || (!store.designPath.value && !current.draftId)
  })

  const status = computed<DesignSaveStatus>(() => {
    if (homeless.value) return pending.value ? 'error' : 'saved'
    if (conflict.value) return 'conflict'
    if (failed.value) return 'error'
    if (!store.designPath.value) return 'draft'
    const writing = writingSession.value !== null && writingSession.value === currentRecord()?.identity
    return writing || pending.value ? 'saving' : 'saved'
  })

  // Changed since opened: unwritten edits now, or edits already written.
  const revertAvailable = computed(() =>
    currentRecord() !== null && (changed.value || store.designDirty.value)
  )


  function peekRecord(): SessionHomeRecord | null {
    const current = record.peek()
    return current && current.identity === store.sessionIdentity.peek() ? current : null
  }

  function readHome(): DesignHome | null {
    const current = peekRecord()
    if (!current) return null
    const path = store.readDesignPath()
    if (path) {
      return { kind: 'file', path, fingerprint: current.fingerprints.get(path) ?? null }
    }
    return current.draftId ? { kind: 'draft', id: current.draftId } : null
  }

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    clearTimer()
    if (disposed) return
    timer = setTimeout(() => {
      timer = null
      void requestWrite()
    }, delayMs)
  }

  function requestWrite(): Promise<boolean> {
    if (!active) return startWrite()
    queued ??= active.then(() => {
      queued = null
      return startWrite()
    })
    return queued
  }

  function startWrite(): Promise<boolean> {
    const result = performWrite()
    if (typeof result === 'boolean') return Promise.resolve(result)
    active = result
    void result.finally(() => {
      if (active === result) active = null
    })
    return result
  }

  function performWrite(): boolean | Promise<boolean> {
    const force = forceWrite
    forceWrite = false
    const session = peekRecord()
    const home = readHome()
    if (!session || !home || !store.hasCurrentDesign()) return !pending.peek()
    if (conflict.peek()) return false
    if (!pending.peek() && !force) return true

    // Only a write that started with the home marked behind clears the mark.
    const pendingAtStart = writePending.peek()
    if (store.designDirty.peek()) changed.value = true
    let outcome: HomeWriteOutcome | Promise<HomeWriteOutcome>
    try {
      outcome = writeHome(home)
    } catch (error) {
      return settleFailure(session, error)
    }
    if (!isPromise(outcome)) return settleOutcome(session, outcome, pendingAtStart)
    writingSession.value = session.identity
    return outcome.then(
      (settled) => settleOutcome(session, settled, pendingAtStart),
      (error: unknown) => settleFailure(session, error),
    ).finally(() => {
      if (writingSession.peek() === session.identity) writingSession.value = null
    })
  }

  function settleOutcome(
    session: SessionHomeRecord,
    outcome: HomeWriteOutcome,
    pendingAtStart: boolean,
  ): boolean {
    if (peekRecord() !== session) return false
    if (outcome.kind === 'conflict') {
      clearTimer()
      conflict.value = { fileGone: outcome.fileGone }
      return false
    }
    if (outcome.kind === 'stale') {
      if (pending.peek()) schedule()
      return false
    }
    batch(() => {
      if (pendingAtStart) writePending.value = false
      failed.value = false
      failureReason.value = null
    })
    if (pending.peek()) {
      schedule()
      return false
    }
    return true
  }

  function settleFailure(session: SessionHomeRecord, error: unknown): boolean {
    if (peekRecord() !== session) return false
    if (error instanceof DesignHomeConflictError) {
      return settleOutcome(session, { kind: 'conflict', fileGone: error.fileGone }, false)
    }
    batch(() => {
      failed.value = true
      failureReason.value = describeFailure(error)
    })
    logError('Continuous save failed:', error)
    return false
  }

  async function flush(): Promise<boolean> {
    clearTimer()
    if (!store.hasCurrentDesign()) return true
    if (!pending.peek() && !active && !forceWrite) return true
    if (conflict.peek()) return false
    const written = await requestWrite()
    return written && !pending.peek() && !conflict.peek()
  }

  return {
    status,
    failureReason: computed(() => status.value === 'error' ? failureReason.value : null),
    conflict,
    revertAvailable,

    beginSession({ draftId, fingerprint, writePending: pendingWrite }) {
      const path = store.readDesignPath()
      const fingerprints = new Map<string, string | null>()
      if (path) fingerprints.set(path, fingerprint)
      const current = store.readCurrentDesign()
      clearTimer()
      forceWrite = false
      batch(() => {
        record.value = {
          identity: store.sessionIdentity.peek(),
          draftId,
          fingerprints,
          snapshot: current ? cloneDocument(current) : null,
        }
        writePending.value = pendingWrite
        changed.value = false
        failed.value = false
        failureReason.value = null
        conflict.value = null
      })
    },

    endSession() {
      clearTimer()
      batch(() => {
        record.value = null
        writePending.value = false
        changed.value = false
        failed.value = false
        failureReason.value = null
        conflict.value = null
      })
    },

    sessionToken() {
      return peekRecord()?.identity ?? null
    },

    readHome,

    readSnapshot() {
      const snapshot = peekRecord()?.snapshot
      return snapshot ? cloneDocument(snapshot) : null
    },

    recordFileFingerprint(token, path, fingerprint) {
      const current = peekRecord()
      if (!current || current.identity !== token) return
      current.fingerprints.set(path, fingerprint)
    },

    rehome(token, { draftId }) {
      const current = peekRecord()
      if (!current || current.identity !== token) return
      current.draftId = draftId
      batch(() => {
        record.value = { ...current }
        failed.value = false
        failureReason.value = null
        conflict.value = null
      })
    },

    hasPendingChanges: () => pending.peek(),

    flush,

    save() {
      // A Save that cannot write now (no Design, or a conflict) is not kept for a later write.
      if (store.hasCurrentDesign() && !conflict.peek()) forceWrite = true
      return flush()
    },

    async overwriteHome(token) {
      const current = peekRecord()
      const path = store.readDesignPath()
      if (!current || current.identity !== token) return false
      if (path) current.fingerprints.set(path, null)
      batch(() => {
        conflict.value = null
        // The file no longer holds this session's content: write even if clean.
        writePending.value = true
      })
      return flush()
    },

    async idle() {
      while (active || queued) {
        await (queued ?? active)?.catch(() => false)
      }
    },

    install() {
      let lastIdentity: object | null = null
      let lastRevision = -1
      let lastCanvasRevision = -1
      let lastPending = false
      const dispose = effect(() => {
        const identity = store.sessionIdentity.value
        const revision = store.committedDesignRevision.value
        const canvasRevision = store.canvasChangeRevision.value
        const isPending = pending.value
        const paused = conflict.value !== null
        const sessionChanged = identity !== lastIdentity
        const contentChanged = revision !== lastRevision || canvasRevision !== lastCanvasRevision
        const becamePending = isPending && !lastPending
        lastIdentity = identity
        lastRevision = revision
        lastCanvasRevision = canvasRevision
        lastPending = isPending

        if (sessionChanged) clearTimer()
        if (!isPending || paused) {
          clearTimer()
          return
        }
        if (sessionChanged || contentChanged || becamePending || timer === null) schedule()
      })
      return () => {
        dispose()
        clearTimer()
      }
    },

    dispose() {
      disposed = true
      clearTimer()
    },
  }
}

function describeFailure(error: unknown): string | null {
  if (error instanceof Error) return error.message || null
  return typeof error === 'string' && error ? error : null
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function'
}

function cloneDocument(file: CanopiFile): CanopiFile {
  return JSON.parse(JSON.stringify(file)) as CanopiFile
}
