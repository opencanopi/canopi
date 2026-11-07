// platform/problem-report.ts: the problemReport port (contracts §22, 2.1-M422). One TS builder
// (app/problem-report/builder.ts) and two writers: Desktop's adapter sends the frontend sections to the native command,
// which adds its own and zips; Web's zips the whole report in TS and downloads it. Invariant: an edition's adapter
// names each section it fills, leaves to its native writer, or lacks (marked not on this edition, F13, 2.1-M412).
import type { ProblemReportResult } from '../generated/contracts'
import type { EditionSections, ProblemReport } from '../app/problem-report/builder'

export interface ProblemReportPort {
  /** How this edition fills each section the frontend does not. */
  readonly sections: EditionSections
  /** Writes one report as one zip; its file name only, never a path. Throws a typed failure (busy, io) unwritten. */
  write(report: ProblemReport): Promise<ProblemReportResult>
}
