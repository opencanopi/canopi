/**
 * failures/ring.ts: Owner of the frontend diagnostics ring, the last 50 settlements the problem report carries
 * (no-renderer-module-state's failures/ entry, contracts §13 Failure report, ADR 0025). Invariant: only the sink,
 * failures/report.ts, writes it; a settlement object has one entry, kept by identity even after it leaves the ring.
 */
import type { FailureCode, FrontendDiagnosticLevel, OperationId, RedactedText } from '../generated/contracts'

/** How many entries the ring keeps; older ones drop first. */
const RING_CAPACITY = 50

interface RingEntryBase {
  readonly level: FrontendDiagnosticLevel
  /** The dotted op of a native settlement, or the frontend source that reported. */
  readonly source: string
  readonly code: FailureCode
  readonly operation: OperationId | null
  readonly timestamp_ms: number
  /** Whether a surface told the user (an inline message or a notice). */
  surfaced: boolean
}

/** A ring entry (contracts §13): native detail arrives redacted by Rust; frontend text is redacted by failures/redact.ts. */
export type RingEntry =
  | (RingEntryBase & { readonly origin: 'native'; readonly detail: RedactedText | null })
  | (RingEntryBase & { readonly origin: 'frontend'; readonly text: string })

let entries: RingEntry[] = []
let bySettlement = new WeakMap<object, RingEntry>()

export function appendEntry(entry: RingEntry, settlement: object | null): void {
  entries.push(entry)
  if (entries.length > RING_CAPACITY) entries = entries.slice(-RING_CAPACITY)
  if (settlement) bySettlement.set(settlement, entry)
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
