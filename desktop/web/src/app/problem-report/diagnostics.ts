// app/problem-report/diagnostics.ts: the problem report's reading of the failures/ ring (ADR 0025: the ring lives in
// failures/ from Phase 1's 1b-c1, and the report reads it there), plus `recordFrontendDiagnostic` for ErrorBoundary.tsx,
// the last writer through this name until 1b-c3 points it at failures/report.ts. A write here is a `reportFailure` with
// no notice; the report reads the ring as frontend diagnostics entries.
import type { FrontendDiagnosticLevel } from '../../generated/contracts'
import { reportFailure } from '../../failures/report'
import { ringEntries } from '../../failures/ring'

// The suites that still import the ring's test reset from here (error-boundary, lidar-display) find it until they
// import failures/ring directly; a star re-export, since no production file may name a `*ForTests` export
// (test-only-exports-only-in-tests).
export * from '../../failures/ring'

interface RecordFrontendDiagnosticInput {
  readonly level: FrontendDiagnosticLevel
  readonly source: string
  readonly message: string
}

export function recordFrontendDiagnostic(input: RecordFrontendDiagnosticInput): void {
  reportFailure(input.message, { shown: 'none', source: input.source, level: input.level })
}

/** One ring entry as the report's app-failures section lists it. */
export interface FrontendDiagnosticEntry {
  readonly level: FrontendDiagnosticLevel
  readonly source: string
  readonly message: string
  readonly timestamp_ms: number
}

export function recentFrontendDiagnostics(): FrontendDiagnosticEntry[] {
  return ringEntries().map((entry) => ({
    level: entry.level,
    source: entry.source,
    message: entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text,
    timestamp_ms: entry.timestamp_ms,
  }))
}
