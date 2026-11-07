// app/problem-report/diagnostics.ts: the problem report's reading of the failures/ ring and the writers that still
// record through this name (ADR 0025: the ring lives in failures/ from Phase 1's 1b-c1, and the report reads it
// there). A write here is a `reportFailure` with no notice; the report reads the ring as frontend diagnostics entries.
import type { FrontendDiagnosticEntry, FrontendDiagnosticLevel } from '../../generated/contracts'
import { reportFailure } from '../../failures/report'
import { ringEntries } from '../../failures/ring'

// The suites that import the ring's test reset from here still find it, until they import failures/ring directly; a
// star re-export, since no production file may name a `*ForTests` export (test-only-exports-only-in-tests).
export * from '../../failures/ring'

interface RecordFrontendDiagnosticInput {
  readonly level: FrontendDiagnosticLevel
  readonly source: string
  readonly message: string
}

export function recordFrontendDiagnostic(input: RecordFrontendDiagnosticInput): void {
  reportFailure(input.message, { shown: 'none', source: input.source, level: input.level })
}

export function recentFrontendDiagnostics(): FrontendDiagnosticEntry[] {
  return ringEntries().map((entry) => ({
    level: entry.level,
    source: entry.source,
    message: entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text,
    timestamp_ms: entry.timestamp_ms,
  }))
}

export function diagnosticMessageFromError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}
