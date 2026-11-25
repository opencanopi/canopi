/**
 * app/document-session/core/state.ts: Discriminated state union, SaveState, Question state,
 * and DesignScope factory for the unified Session Core (ADR 0024, contracts §4, 2b-3).
 */
import type { DesignHome, DesignSource, HomeVersion } from '../../../platform/design-home'
import type { CanopiFile } from '../../../types/design'
import type { DesignScope } from '../../../types/design-scope'
import type { DeepReadonly } from './immutable'
import type { ScenePort } from './scene-half'

export type QuestionId = string & { readonly __brand: 'QuestionId' }

export type QuestionKind =
  | 'flush-failed-before-open'
  | 'flush-failed-before-close'
  | 'settings-flush-failed-before-close'
  | 'jobs-running-before-close'

export type QuestionPurpose = 'open' | 'close' | 'quit' | 'reload' | 'update'

export type QuestionChoice = 'retry' | 'discard' | 'cancel'

export interface SessionQuestion {
  readonly id: QuestionId
  readonly kind: QuestionKind
  readonly purpose: QuestionPurpose
  readonly detail?: string
  /** For `settings-flush-failed-before-close`: whether the open Design was saved (false if discarded or none open). */
  readonly designSaved?: boolean
}

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'writing'; readonly rev: number }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly current: HomeVersion | null }
  | { readonly kind: 'quota' }
  | { readonly kind: 'copy_blocked'; readonly folder: string }

type SceneAttachment =
  | { readonly kind: 'attached'; readonly port: ScenePort; readonly fields: DeepReadonly<Partial<CanopiFile>> }
  | { readonly kind: 'detached'; readonly fields: DeepReadonly<Partial<CanopiFile>> }

export interface OpenDesignState {
  readonly scope: DesignScope
  readonly home: DesignHome
  readonly document: DeepReadonly<CanopiFile>
  /** Composed file at install; unchanged by Save As so Revert restores the opened baseline. */
  readonly baseline: DeepReadonly<CanopiFile>
  /** Monotonic revision advanced only by edits (`rev > ackRev` is the sole dirty predicate, 2.1-Q68). */
  readonly rev: number
  /** Last acknowledged revision written to `home` (or initial revision on clean open). */
  readonly ackRev: number
  readonly save: SaveState
  readonly scene: SceneAttachment
  readonly migratedFrom: number | null
  readonly readOnly: boolean
  readonly savedByVersion: number | null
}

export type DesignSessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening'; readonly source: DesignSource; readonly current?: OpenDesignState }
  | { readonly kind: 'open'; readonly design: OpenDesignState }
  | { readonly kind: 'replacing'; readonly current: OpenDesignState; readonly next: DesignSource; readonly question?: SessionQuestion }
  | { readonly kind: 'closing'; readonly current?: OpenDesignState; readonly question?: SessionQuestion }
  | { readonly kind: 'disposed' }

/** The sole dirty predicate (ADR 0024, 2.1-Q68): dirty iff `rev > ackRev`. */
export function isDesignDirty(design: Pick<OpenDesignState, 'rev' | 'ackRev'> | null | undefined): boolean {
  return design != null && design.rev > design.ackRev
}

export interface ManagedDesignScope extends DesignScope {
  dispose(): void
}

/** Creates a DesignScope whose cleanups run synchronously in LIFO order on dispose (ADR 0024). */
export function createDesignScope(): ManagedDesignScope {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  let closed = false

  return {
    get signal() {
      return controller.signal
    },
    get closed() {
      return closed
    },
    onDispose(cleanup: () => void): () => void {
      if (closed) {
        cleanup()
        return () => {}
      }
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index >= 0) cleanups.splice(index, 1)
      }
    },
    dispose(): void {
      if (closed) return
      closed = true
      controller.abort()
      while (cleanups.length > 0) {
        const fn = cleanups.pop()!
        try {
          fn()
        } catch {
          // Scope disposal never stops on a single cleanup error.
        }
      }
    },
  }
}
