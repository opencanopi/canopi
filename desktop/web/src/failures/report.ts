/**
 * failures/report.ts: Owner of the frontend failure sink, `reportFailure`, and the window error hooks
 * (console-only-in-sink, contracts §2 and §13, ADR 0025 Frontend sinks). Invariant: every frontend failure but a
 * `store_read_only` refusal, which is never recorded (2.1-M487), reaches the ring through `reportFailure`, which never
 * throws; a settlement object has one ring entry however many times it is reported (transport, a surface,
 * `unhandledrejection`); only `shown: 'notice'` queues a notice, once per failure for
 * its first occurrence, later ones only counted, dismissed or not (2.1-Q294: until it recovers; dismissing is no
 * recovery, and the sink sees none yet), and none after the app lifetime that installed the hooks is disposed.
 */
import type { FailureCode, FrontendDiagnosticLevel, OperationId } from '../generated/contracts'
import type { LocaleKey } from '../generated/locale-keys'
import { failureOf } from './ipc-failure'
import { failureMessage, type FailureCapabilities } from './messages'
import { notices, raiseNotice, type Notice } from './notices'
import { appendEntry, entryForSettlement, type RingEntry } from './ring'
import { redact } from './redact'
import { StoreRefusedError } from './store-read'

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
  /** A frontend failure's text in place of the subject's own, so a typed failure is still recorded against its object. */
  readonly text?: string
  readonly level?: FrontendDiagnosticLevel
  /**
   * Also write to the console (the Web console, design check F23): `true` writes the entry's text; values write those
   * instead, each redacted, keeping a logger's shape (`'label:', error`; an error stays an error for its stack).
   */
  readonly echo?: boolean | readonly unknown[]
}

const INTERNAL: FailureCode = { kind: 'internal' }
const REDACTION_FAILED = 'redaction_failed'

/**
 * The dedupe keys whose first occurrence was told: a repeat queues no notice. The counts live on the ring entry
 * (`entry.count`, ring.ts), which the problem report reads.
 */
const told = new Set<string>()
let noticesOpen = true
let capabilities: FailureCapabilities = { storage: 'disk' }

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
  // A write a read-only store refused is never recorded, logged or told (2.1-M487): the store's one notice says it, so
  // no caller's inline report, log or unhandled rejection puts it in the ring or the problem report. A Web store's
  // refusal is a StoreRefusedError, whose code no settlement carries.
  const refused = subject instanceof StoreRefusedError ? subject.code : undefined
  if ((failureOf(subject)?.code ?? refused ?? options.code)?.kind === 'store_read_only') return
  const settlement = typeof subject === 'object' && subject !== null ? subject : null
  const known = settlement ? entryForSettlement(settlement) : undefined
  const entry = known ?? appendEntry(newEntry(subject, options), settlement)
  // An echo is the caller's console line, written even when the transport recorded the settlement silently.
  if (options.echo) echo(entry, options.echo)
  // Surfaced only when the user was told: inline, or by a notice a silent code or a disposed lifetime never queues.
  if (options.shown === 'inline' || (options.shown === 'notice' && notice(entry))) entry.surfaced = true
}

function newEntry(subject: unknown, options: ReportOptions): RingEntry {
  const failure = failureOf(subject)
  const base = { level: options.level ?? 'error', timestamp_ms: Date.now(), count: 1, surfaced: false }
  if (failure) {
    return { ...base, origin: 'native', source: failure.op, code: failure.code, operation: failure.operation, detail: failure.detail }
  }
  return {
    ...base,
    origin: 'frontend',
    source: safeRedact(options.source ?? 'frontend'),
    code: options.code ?? INTERNAL,
    operation: null,
    text: capped(safeRedact(options.text ?? textOf(subject))),
  }
}

/**
 * The failure a problem report is opened from (a notice's or a boundary's Report a problem): its code, its op or
 * source, its operation and its redacted detail, which the report lists first (contracts §13, 2.1-Q286). A store
 * notice's state that carries no code names its store and state in `detail`.
 */
export interface ReportOrigin {
  readonly source: string
  readonly code: FailureCode | null
  readonly operation: OperationId | null
  readonly detail: string | null
}

/** The origin of a failure this sink recorded, found by identity; null for one it never saw. */
export function reportOriginOf(subject: unknown): ReportOrigin | null {
  if (typeof subject !== 'object' || subject === null) return null
  const entry = entryForSettlement(subject)
  if (!entry) return null
  return {
    source: entry.source,
    code: entry.code,
    operation: entry.operation,
    detail: entry.origin === 'native' ? entry.detail : entry.text,
  }
}

/**
 * Records a typed failure its surface tells inline and returns its catalogue message, never its text (.117); null for
 * a value that carries no settlement, or a silent code, which the caller words itself.
 */
export function reportInline(subject: unknown, source: string): LocaleKey | null {
  const failure = failureOf(subject)
  if (!failure) return null
  reportFailure(subject, { shown: 'inline', source })
  return failureMessage(failure.code, failure.op, capabilities)
}

/**
 * A console-shaped reporter for an owner that injects `logError(message, ...params)`: each call is echoed to the
 * console with no notice (the owner shows its own state) and is one ring entry under `source`, unless it logs a
 * settlement already in the ring (a rejected command the transport recorded), which keeps that one entry.
 */
export function failureLogger(source: string): (message?: unknown, ...optionalParams: unknown[]) => void {
  return (...values) => {
    const present = values.filter((value) => value !== undefined)
    const recorded = present.find((value) => typeof value === 'object' && value !== null && entryForSettlement(value))
    reportFailure(recorded ?? present.map(textOf).join(' '), { shown: 'none', source, echo: present })
  }
}

/** Queues the entry's notice unless one was told for its key; false when the user is not told at all. */
function notice(entry: RingEntry): boolean {
  const message = failureMessage(entry.code, entry.source, capabilities)
  // A silent code is recorded and never told (a cancel; a map failure until 2d's map status, 2.1-Q300).
  if (!noticesOpen || message === null) return false
  const key = noticeKey(entry.code, entry.source)
  // A repeat was told by the first occurrence's notice, shown or dismissed: the ring counts it.
  if (!told.has(key)) raiseNotice({ key, message, tone: 'error', code: entry.code, source: entry.source })
  told.add(key)
  return true
}

/** The dedupe key of a failure: its code, sub-kind included, and its op or source. */
function noticeKey(code: FailureCode, source: string): string {
  return `${JSON.stringify(code)}@${source}`
}

function echo(entry: RingEntry, values: true | readonly unknown[]): void {
  const written = values === true ? [`[${entry.source}]`, entryText(entry)] : values.map(redactedValue)
  if (entry.level === 'warning') console.warn(...written)
  else console.error(...written)
}

function entryText(entry: RingEntry): string {
  return entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text
}

function redactedValue(value: unknown): unknown {
  if (typeof value === 'string') return safeRedact(value)
  // A recorded non-Error object (a typed load failure) prints its entry's redacted text, never `[object Object]`.
  const recorded = typeof value === 'object' && value !== null && !(value instanceof Error) ? entryForSettlement(value) : undefined
  if (recorded) return entryText(recorded)
  if (value instanceof Error) {
    const message = safeRedact(value.message)
    if (message === value.message) return value
    const redacted = new Error(message)
    redacted.name = value.name
    return redacted
  }
  return safeRedact(textOf(value))
}

function textOf(subject: unknown): string {
  if (subject instanceof Error) return errorText(subject)
  if (typeof subject === 'string') return subject
  try {
    return String(subject)
  } catch {
    // A value whose toString throws still leaves an entry; its text is what cannot be printed.
    return 'Unprintable failure'
  }
}

// V8 starts `stack` with `Name: message`; JavaScriptCore (WebKitGTK, Safari) and SpiderMonkey (Firefox) hold only
// frames there, so the cause line goes first unless the stack already carries it.
function errorText(error: Error): string {
  const cause = error.message ? `${error.name}: ${error.message}` : error.name
  const stack = error.stack
  if (!stack) return cause
  return stack.startsWith(cause) ? stack : `${cause}\n${stack}`
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
 * returns its disposer; notices are worded for its capabilities. A second install replaces the first. After dispose,
 * reports still reach the ring but queue no notice.
 */
export function installFailureHooks(edition: FailureCapabilities, target: HookTarget = window): () => void {
  target[HOOKS]?.()
  capabilities = edition
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

/** @testonly The queued notices this sink raised. */
export function failureNoticesForTests(): { notices: readonly Notice[] } {
  return { notices: notices.value.filter((notice) => told.has(notice.key)) }
}

/** @testonly */
export function resetFailureNoticesForTests(): void {
  told.clear()
  noticesOpen = true
}
