/**
 * failures/notices.ts: Owner of the one notice queue the notice row shows (contracts §13 and §18 F3, design check F16,
 * 2.1-Q290). Invariant: notices are kept oldest first and each stays until dismissed, so a notice raised during boot
 * survives every later one; a notice whose dedupe key (a failure's code plus its StoreId or op) is already queued adds
 * none. A notice holds locale keys, never words, so it re-renders in the current locale.
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
  readonly tone?: 'info' | 'error'
  /** One action beside Dismiss (Update, Reload, Try again); running it does not dismiss the notice. */
  readonly action?: { readonly label: LocaleKey; run(): void }
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

/** The queued notices, oldest first; the notice row shows the first with its place in the count. */
export const notices: ReadonlySignal<readonly Notice[]> = queue

/** Queues a notice and returns its id; a notice with the same key already queued is kept and its id returned. */
export function raiseNotice(spec: NoticeSpec): number {
  const queued = queue.peek().find((notice) => notice.key === spec.key)
  if (queued) return queued.id
  const notice: Notice = { ...spec, id: nextId++ }
  queue.value = [...queue.peek(), notice]
  return notice.id
}

/** Removes a notice the user dismissed; its raiser hears of it through `onDismiss`. */
export function dismissNotice(id: number): void {
  const notice = queue.peek().find((candidate) => candidate.id === id)
  if (!notice) return
  queue.value = queue.peek().filter((candidate) => candidate.id !== id)
  notice.onDismiss?.()
}

/** @testonly */
export function resetNoticesForTests(): void {
  queue.value = []
  nextId = 1
}
