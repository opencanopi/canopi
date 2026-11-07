/**
 * failures/notices.ts: Owner of the one notice queue the notice row shows (notice-only-in-failures, ADR 0025, contracts §13 and §18 F3, design check F16,
 * 2.1-Q290). Invariant: notices are kept oldest first and each stays until dismissed (an undismissable one until its
 * raiser withdraws it), so a notice raised during boot survives every later one; an undismissable status (a window
 * close waiting for an update) queues ahead of every notice the user can dismiss, so the row says why Canopi waits; a notice whose dedupe key (a
 * failure's code plus its StoreId or op) is already queued adds none. A notice holds locale keys, never words, so it re-renders in the current locale.
 */
import { signal, type ReadonlySignal } from '@preact/signals'
import type { FailureCode } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'

type NoticeParams = Readonly<Record<string, string | number>>

export interface NoticeSpec {
  /** The dedupe key: a failure's code with its StoreId or op, or the raiser's own name for its one notice. */
  readonly key: string
  readonly message: LocaleKey
  readonly params?: NoticeParams
  readonly title?: LocaleKey
  /** Info is announced politely, a warning or an error as its Notice tone says; info when omitted. */
  readonly tone?: 'info' | 'warning' | 'error'
  /** One action beside Dismiss (Update, Reload, Try again); running it does not dismiss the notice. */
  readonly action?: { readonly label: LocaleKey; run(): void }
  /** A second action after `action` (Report a problem beside Try again, 2.1-Q295); drawn only with `action`. */
  readonly secondaryAction?: { readonly label: LocaleKey; run(): void }
  /**
   * A status its raiser withdraws once it no longer holds (a window close waiting for an update): the row draws no
   * Dismiss, since nothing would raise it again meanwhile.
   */
  readonly undismissable?: true
  /** Called once the user dismisses it, for a raiser that keeps its own session state. */
  readonly onDismiss?: () => void
  /** A failure notice's code and op or source, for the problem report (failures/report.ts). */
  readonly code?: FailureCode
  readonly source?: string
}

export interface Notice extends NoticeSpec {
  readonly id: number
}

const queue = signal<readonly Notice[]>([])
let nextId = 1

/** The queued notices, statuses then the rest, each oldest first; the notice row shows the first with its place in the count. */
export const notices: ReadonlySignal<readonly Notice[]> = queue

/** Queues a notice and returns its id; a notice with the same key already queued is kept and its id returned. */
export function raiseNotice(spec: NoticeSpec): number {
  const queued = queue.peek().find((notice) => notice.key === spec.key)
  if (queued) return queued.id
  const notice: Notice = { ...spec, id: nextId++ }
  const current = queue.peek()
  const at = notice.undismissable ? current.filter((other) => other.undismissable).length : current.length
  queue.value = [...current.slice(0, at), notice, ...current.slice(at)]
  return notice.id
}

/** Removes a notice the user dismissed; its raiser hears of it through `onDismiss`. */
export function dismissNotice(id: number): void {
  const notice = queue.peek().find((candidate) => candidate.id === id)
  if (!notice) return
  queue.value = queue.peek().filter((candidate) => candidate.id !== id)
  notice.onDismiss?.()
}

/** Removes the notice queued under `key`, if it still waits: its raiser withdraws what no longer holds. */
export function withdrawNotice(key: string): void {
  const queued = queue.peek().find((notice) => notice.key === key)
  if (queued) dismissNotice(queued.id)
}

/** @testonly */
export function resetNoticesForTests(): void {
  queue.value = []
  nextId = 1
}
