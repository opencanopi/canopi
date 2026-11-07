/**
 * failures/report.ts: Owner of the frontend failure sink, `reportFailure`, and the window error hooks
 * (console-only-in-sink, contracts §2 and §13, ADR 0025 Frontend sinks). Invariant: every frontend failure reaches the
 * ring through `reportFailure`, which never throws; a settlement object has one ring entry however many times it is
 * reported (transport, a surface, `unhandledrejection`); only `shown: 'notice'` queues a notice, once per failure until
 * it recovers (2.1-Q294), and none after the app lifetime that installed the hooks is disposed.
 */
import { signal } from '@preact/signals'
import type { Failure, FailureCode, FrontendDiagnosticLevel } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'
import { IpcFailure } from './ipc-failure'
import { failureMessage, type FailurePlatform } from './messages'
import { appendEntry, entryForSettlement, type RingEntry } from './ring'
import { redact } from './redact'

/** The longest frontend text an entry keeps, after redaction. */
const MAX_ENTRY_TEXT = 8 * 1024

/** How the user was told: by the surface itself, by a notice, or not at all (contracts §18 F3, design check F16). */
type FailureShown = 'inline' | 'notice' | 'none'

interface ReportOptions {
  readonly shown: FailureShown
  /** A frontend failure's code; `internal` when omitted (2.1-Q289). Ignored for a native settlement. */
  readonly code?: FailureCode
  /** A frontend failure's source (`plant-catalog`, `map`); a native settlement's is its op. */
  readonly source?: string
  readonly level?: FrontendDiagnosticLevel
  /** Also write the redacted text to the console (the Web console, design check F23). */
  readonly echo?: boolean
}

interface FailureNotice {
  readonly id: number
  /** The dedupe key: the code (with its own sub-kind) and the op or source. */
  readonly key: string
  readonly code: FailureCode
  readonly source: string
  /** What the notice says on this edition (failures/messages.ts). */
  readonly message: LocaleKey
}

const INTERNAL: FailureCode = { kind: 'internal' }
const REDACTION_FAILED = 'redaction_failed'

// The notice queue, oldest first; 1b-c3's notice row renders it and adds dismissal (design check F16).
const queue = signal<readonly FailureNotice[]>([])
/** Occurrences per dedupe key since its first notice, until it recovers; 1b-c5's report reads the counts. */
const repeats = new Map<string, number>()
let nextNoticeId = 1
let noticesOpen = true
let platform: FailurePlatform = 'desktop'

/**
 * Records a failure and tells the user as `shown` says. `subject` is a settlement (`IpcFailure` or a wire `Failure`)
 * or a frontend error or value; the same object reported again marks its entry surfaced and never adds a second.
 */
export function reportFailure(subject: unknown, options: ReportOptions): void {
  try {
    record(subject, options)
  } catch {
    // The sink never throws (contracts §13): a fault here must not become a second failure in its caller.
  }
}

function record(subject: unknown, options: ReportOptions): void {
  const settlement = typeof subject === 'object' && subject !== null ? subject : null
  const known = settlement ? entryForSettlement(settlement) : undefined
  const entry = known ?? newEntry(subject, options)
  if (!known) {
    appendEntry(entry, settlement)
    if (options.echo) echo(entry)
  }
  if (options.shown !== 'none') entry.surfaced = true
  if (options.shown === 'notice') notice(entry)
}

function newEntry(subject: unknown, options: ReportOptions): RingEntry {
  const failure = subject instanceof IpcFailure ? subject.failure : isFailure(subject) ? subject : null
  const base = { level: options.level ?? 'error', timestamp_ms: Date.now(), surfaced: false }
  if (failure) {
    return { ...base, origin: 'native', source: failure.op, code: failure.code, operation: failure.operation, detail: failure.detail }
  }
  return {
    ...base,
    origin: 'frontend',
    source: safeRedact(options.source ?? 'frontend'),
    code: options.code ?? INTERNAL,
    operation: null,
    text: capped(safeRedact(textOf(subject))),
  }
}

function notice(entry: RingEntry): void {
  const message = failureMessage(entry.code, entry.source, platform)
  // A silent code is recorded and never told (a cancel; a map failure until 2d's map status, 2.1-Q300).
  if (!noticesOpen || message === null) return
  const key = noticeKey(entry.code, entry.source)
  const seen = repeats.get(key)
  repeats.set(key, (seen ?? 0) + 1)
  if (seen !== undefined) return
  queue.value = [...queue.value, { id: nextNoticeId++, key, code: entry.code, source: entry.source, message }]
}

/** The dedupe key of a failure: its code, sub-kind included, and its op or source. */
function noticeKey(code: FailureCode, source: string): string {
  return `${JSON.stringify(code)}@${source}`
}

function echo(entry: RingEntry): void {
  const text = entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text
  if (entry.level === 'warning') console.warn(`[${entry.source}]`, text)
  else console.error(`[${entry.source}]`, text)
}

function isFailure(value: unknown): value is Failure {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof Failure, unknown>>
  return typeof record.op === 'string' && typeof record.user_may_retry === 'boolean'
    && typeof record.code === 'object' && record.code !== null && typeof (record.code as { kind?: unknown }).kind === 'string'
}

function textOf(subject: unknown): string {
  if (subject instanceof Error) return subject.stack || `${subject.name}: ${subject.message}`
  if (typeof subject === 'string') return subject
  try {
    return String(subject)
  } catch {
    // A value whose toString throws still leaves an entry; its text is what cannot be printed.
    return 'Unprintable failure'
  }
}

function safeRedact(text: string): string {
  try {
    return redact(text)
  } catch {
    // A redactor fault stores the marker, never the unredacted text (contracts §13).
    return REDACTION_FAILED
  }
}

function capped(text: string): string {
  return text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT)}…` : text
}

// The window hooks of the current install, kept on the window itself so a second copy of this module (HMR) finds and
// removes the first copy's listeners: one entry per error however many times the roots bootstrap.
const HOOKS = Symbol.for('canopi.failures.windowHooks')

type HookTarget = Pick<Window, 'addEventListener' | 'removeEventListener'> & { [HOOKS]?: () => void }

/**
 * Installs the window `error` and `unhandledrejection` hooks for an edition's app lifetime (both roots; ADR 0025) and
 * returns its disposer; notices are worded for that edition. A second install replaces the first. After dispose, reports still reach the ring but queue
 * no notice.
 */
export function installFailureHooks(edition: FailurePlatform, target: HookTarget = window): () => void {
  target[HOOKS]?.()
  platform = edition
  const onError = (event: Event) => {
    const error = (event as ErrorEvent).error ?? (event as ErrorEvent).message
    reportFailure(error ?? 'Uncaught error', { shown: 'none', source: 'window.error' })
  }
  const onRejection = (event: Event) => {
    reportFailure((event as PromiseRejectionEvent).reason, { shown: 'none', source: 'window.unhandledrejection' })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  noticesOpen = true
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
    if (target[HOOKS] === dispose) {
      delete target[HOOKS]
      noticesOpen = false
    }
  }
  target[HOOKS] = dispose
  return dispose
}

/** @testonly The queued notices and the occurrence count per dedupe key. */
export function failureNoticesForTests(): { notices: readonly FailureNotice[]; repeats: ReadonlyMap<string, number> } {
  return { notices: queue.value, repeats: new Map(repeats) }
}

/** @testonly */
export function resetFailureNoticesForTests(): void {
  queue.value = []
  repeats.clear()
  nextNoticeId = 1
  noticesOpen = true
}
