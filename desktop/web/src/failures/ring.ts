/**
 * failures/ring.ts: the frontend diagnostics ring, the last 50 settlements the problem report carries
 * (no-renderer-module-state's failures/ entry, contracts §13 Failure report, ADR 0025). Invariant: only the sink,
 * failures/report.ts, writes it; a settlement object has one entry, kept by identity even after it leaves the ring.
 * A repeat of an entry the ring holds (same origin, level, source, code and redacted text) is counted on that entry,
 * which moves to the newest place and takes the repeat's time and operation, so a failure that repeats on every re-ask
 * never pushes older ones out (canopi-vsey; counted in the report until it recovers, 2.1-Q294). The operation stays out
 * of the repeat key: each re-ask runs under a new one.
 */
import type { FailureCode, FrontendDiagnosticLevel, OperationId, RedactedText } from '../generated/contracts'

/** How many entries the ring keeps; older ones drop first. */
const RING_CAPACITY = 50

interface RingEntryBase {
  readonly level: FrontendDiagnosticLevel
  /** The dotted op of a native settlement, or the frontend source that reported. */
  readonly source: string
  readonly code: FailureCode
  /** The operation of its newest occurrence. */
  operation: OperationId | null
  /** When it last occurred. */
  timestamp_ms: number
  /** How many times it occurred while the ring held it. */
  count: number
  /** Whether a surface told the user (an inline message or a notice). */
  surfaced: boolean
}

/** A ring entry (contracts §13): native detail arrives redacted by Rust; frontend text is redacted by failures/redact.ts. */
export type RingEntry =
  | (RingEntryBase & { readonly origin: 'native'; readonly detail: RedactedText | null })
  | (RingEntryBase & { readonly origin: 'frontend'; readonly text: string })

let entries: RingEntry[] = []
let bySettlement = new WeakMap<object, RingEntry>()

/** Records one occurrence: a repeat of a held entry counts on it and takes its time, operation and newest place. */
export function appendEntry(entry: RingEntry, settlement: object | null): RingEntry {
  const held = entries.findIndex((candidate) => sameFailure(candidate, entry))
  const kept = held < 0 ? entry : entries.splice(held, 1)[0]!
  if (kept !== entry) {
    kept.count += entry.count
    kept.timestamp_ms = entry.timestamp_ms
    kept.operation = entry.operation
  }
  entries.push(kept)
  if (entries.length > RING_CAPACITY) entries = entries.slice(-RING_CAPACITY)
  if (settlement) bySettlement.set(settlement, kept)
  return kept
}

function sameFailure(a: RingEntry, b: RingEntry): boolean {
  return a.origin === b.origin && a.level === b.level && a.source === b.source
    && JSON.stringify(a.code) === JSON.stringify(b.code) && textOf(a) === textOf(b)
}

function textOf(entry: RingEntry): string | null {
  return entry.origin === 'native' ? entry.detail : entry.text
}

/** The entry a settlement object already has, by identity. */
export function entryForSettlement(settlement: object): RingEntry | undefined {
  return bySettlement.get(settlement)
}

/** A copy of the ring, oldest first. */
export function ringEntries(): readonly RingEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/** @testonly */
export function resetFrontendDiagnosticsForTests(): void {
  entries = []
  bySettlement = new WeakMap()
}
