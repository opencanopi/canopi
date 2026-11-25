/**
 * app/document-session/core/history.ts: Unified Undo/Redo history owned by the Session Core
 * (ADR 0024, contracts §4, 2.1-Q80, 2.1-M89, 2.1-M159, 2.1-M160, 2.1-M528, 2.1-M547).
 *
 * - Document-owned edits store changed top-level Document keys as `Partial<DeepReadonly<CanopiFile>>`
 *   snapshots (O(1) record, undo, redo, and coalesce).
 * - Scene-owned edits store a Scene command token replayed through the scene runtime's transaction undo path.
 * - Compound entries join both halves under one `HistoryEntryId`; detaching the Scene removes every
 *   entry carrying a Scene token (including compound entries, keeping both halves consistent).
 */
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { CanopiFile } from '../../../types/design'
import type { DeepReadonly } from './immutable'

export type HistoryEntryId = string & { readonly __brand: 'HistoryEntryId' }

const MAX_HISTORY = 500

export interface DocumentHistoryDelta {
  readonly before: Partial<DeepReadonly<CanopiFile>>
  readonly after: Partial<DeepReadonly<CanopiFile>>
}

export interface HistoryEntry {
  readonly id: HistoryEntryId
  readonly label: string
  readonly kind: 'document' | 'scene' | 'compound'
  readonly document?: DocumentHistoryDelta
  readonly scene?: SceneCommand
  readonly coalesceKey?: string
  readonly isDelete?: boolean
}

export interface TransientHistoryPort {
  canUndo(): boolean
  canRedo(): boolean
  undo(): boolean
  redo(): boolean
}

export type UndoOutcome =
  | { readonly status: 'applied'; readonly entry: HistoryEntry | 'transient' }
  | { readonly status: 'empty' }
  | { readonly status: 'stale' }

export interface SessionHistory {
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly newestUndoable: HistoryEntry | null
  readonly pastCount: number
  readonly futureCount: number
  recordDocument(
    label: string,
    delta: DocumentHistoryDelta,
    options?: { readonly coalesce?: string; readonly isDelete?: boolean },
  ): HistoryEntryId
  recordScene(label: string, command: SceneCommand): HistoryEntryId
  recordCompound(label: string, command: SceneCommand, delta: DocumentHistoryDelta): HistoryEntryId
  endCoalesce(key: string): void
  setTransient(port: TransientHistoryPort | null): void
  undo(
    applyDocument: (patch: Partial<DeepReadonly<CanopiFile>>) => void,
    applyScene: (command: SceneCommand, direction: 'undo' | 'redo') => void,
    options?: { readonly expect?: HistoryEntryId },
  ): UndoOutcome
  redo(
    applyDocument: (patch: Partial<DeepReadonly<CanopiFile>>) => void,
    applyScene: (command: SceneCommand, direction: 'undo' | 'redo') => void,
  ): UndoOutcome
  /** Removes every entry holding a Scene token (including compound entries) on Scene detach (contracts §4). */
  dropSceneEntries(): void
  /** Reprojects stored Scene commands when the session plane reorigins. */
  remapSceneCommands(map: (command: SceneCommand) => SceneCommand): void
  /** Clears Undo and Redo stacks (e.g. on Revert, 2.1-Q363). */
  clear(): void
}

export function createSessionHistory(maxHistory = MAX_HISTORY): SessionHistory {
  let past: HistoryEntry[] = []
  let future: HistoryEntry[] = []
  let openCoalesceKey: string | null = null
  let nextId = 1
  let transient: TransientHistoryPort | null = null

  const mintId = (): HistoryEntryId => `h-${nextId++}` as HistoryEntryId

  const pushEntry = (entry: HistoryEntry): HistoryEntryId => {
    future = []
    past.push(entry)
    if (past.length > maxHistory) {
      past = past.slice(past.length - maxHistory)
    }
    return entry.id
  }

  return {
    get canUndo(): boolean {
      return Boolean(transient?.canUndo()) || past.length > 0
    },
    get canRedo(): boolean {
      return Boolean(transient?.canRedo()) || future.length > 0
    },
    get newestUndoable(): HistoryEntry | null {
      return past.length > 0 ? past[past.length - 1]! : null
    },
    get pastCount(): number {
      return past.length
    },
    get futureCount(): number {
      return future.length
    },
    recordDocument(label, delta, options) {
      const coalesceKey = options?.isDelete ? undefined : options?.coalesce
      const top = past[past.length - 1]
      if (
        coalesceKey &&
        openCoalesceKey === coalesceKey &&
        top &&
        top.kind === 'document' &&
        !top.isDelete &&
        top.coalesceKey === coalesceKey &&
        top.document
      ) {
        // Merge into the open coalesced entry: keep original `before` keys (adding any newly touched
        // key's pre-value) and overwrite `after` with latest values (O(1), 2.1-M160, 2.1-M547).
        const mergedBefore: Record<string, unknown> = { ...top.document.before }
        for (const [k, v] of Object.entries(delta.before)) {
          if (!(k in mergedBefore)) mergedBefore[k] = v
        }
        const mergedAfter: Record<string, unknown> = { ...top.document.after, ...delta.after }
        past[past.length - 1] = {
          ...top,
          label,
          document: {
            before: mergedBefore,
            after: mergedAfter,
          },
        }
        future = []
        return top.id
      }

      openCoalesceKey = coalesceKey ?? null
      return pushEntry({
        id: mintId(),
        label,
        kind: 'document',
        document: delta,
        ...(coalesceKey ? { coalesceKey } : {}),
        ...(options?.isDelete ? { isDelete: true } : {}),
      })
    },
    recordScene(label, command) {
      // Any non-coalescing entry seals the open coalesce key (2.1-M160).
      openCoalesceKey = null
      return pushEntry({
        id: mintId(),
        label,
        kind: 'scene',
        scene: command,
      })
    },
    recordCompound(label, command, delta) {
      openCoalesceKey = null
      return pushEntry({
        id: mintId(),
        label,
        kind: 'compound',
        scene: command,
        document: delta,
      })
    },
    endCoalesce(key: string) {
      if (openCoalesceKey === key) openCoalesceKey = null
    },
    setTransient(port) {
      transient = port
    },
    undo(applyDocument, applyScene, options) {
      if (!options?.expect && transient?.canUndo()) {
        if (transient.undo()) return { status: 'applied', entry: 'transient' }
      }
      const top = past[past.length - 1]
      if (!top) return { status: 'empty' }
      if (options?.expect && top.id !== options.expect) return { status: 'stale' }

      openCoalesceKey = null
      past.pop()
      if (top.document) applyDocument(top.document.before)
      if (top.scene) applyScene(top.scene, 'undo')
      future.push(top)
      return { status: 'applied', entry: top }
    },
    redo(applyDocument, applyScene) {
      if (transient?.canRedo()) {
        if (transient.redo()) return { status: 'applied', entry: 'transient' }
      }
      const top = future[future.length - 1]
      if (!top) return { status: 'empty' }

      openCoalesceKey = null
      future.pop()
      if (top.scene) applyScene(top.scene, 'redo')
      if (top.document) applyDocument(top.document.after)
      past.push(top)
      return { status: 'applied', entry: top }
    },
    dropSceneEntries() {
      openCoalesceKey = null
      past = past.filter((entry) => entry.kind === 'document')
      future = future.filter((entry) => entry.kind === 'document')
    },
    remapSceneCommands(map) {
      const remap = (entry: HistoryEntry): HistoryEntry =>
        entry.scene ? { ...entry, scene: map(entry.scene) } : entry
      past = past.map(remap)
      future = future.map(remap)
    },
    clear() {
      openCoalesceKey = null
      past = []
      future = []
    },
  }
}
