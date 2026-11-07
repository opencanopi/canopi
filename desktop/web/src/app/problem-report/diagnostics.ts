// app/problem-report/diagnostics.ts: the problem report's reading of the failures/ ring (ADR 0025: the ring lives in
// failures/, written only through failures/report.ts, and the report lists it in its app-failures section).
import { ringEntries } from '../../failures/ring'

/** The ring as the report's app-failures section lists it, oldest first: a native entry by its redacted detail. */
export function recentFrontendDiagnostics() {
  return ringEntries().map((entry) => ({
    level: entry.level,
    source: entry.source,
    message: entry.origin === 'native' ? entry.detail ?? entry.code.kind : entry.text,
    timestamp_ms: entry.timestamp_ms,
  }))
}
