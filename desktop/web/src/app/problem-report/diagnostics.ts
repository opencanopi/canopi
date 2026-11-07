// app/problem-report/diagnostics.ts: the problem report's reading of the failures/ ring (ADR 0025: the ring lives in
// failures/, written only through failures/report.ts, and the report reads it here as frontend diagnostics entries).
import type { FrontendDiagnosticEntry } from '../../generated/contracts'
import { ringEntries } from '../../failures/ring'

// The suites that still import the ring's test reset from here find it until they import failures/ring directly; a
// star re-export, since no production file may name a `*ForTests` export (test-only-exports-only-in-tests).
export * from '../../failures/ring'

export function recentFrontendDiagnostics(): FrontendDiagnosticEntry[] {
  return ringEntries().map((entry) => ({
    level: entry.level,
    source: entry.source,
    message: entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text,
    timestamp_ms: entry.timestamp_ms,
  }))
}
