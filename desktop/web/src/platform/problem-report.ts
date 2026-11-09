// platform/problem-report.ts: the problemReport port (contracts §22, 2.1-M422, ADR 0025): one builder
// (app/problem-report/builder.ts), a writer per edition beside this file. Desktop's adapter sends the frontend sections
// to the native command, which adds its own and zips; Web's zips the whole report in TS and downloads it. Invariant:
// each edition names how it fills every section the frontend does not, a section it lacks marked not on this edition
// (F13, 2.1-M412), so a section added to `REPORT_SECTIONS` fails typecheck until each edition says.
import type { ProblemReportResult, ReportManifest, ReportSectionId, ReportSectionStatus } from '../generated/contracts'

/** The sections the builder fills on both editions; the Design is attached by consent. */
export type FrontendSectionId = 'originating_failure' | 'description' | 'frontend_ring'

/** The sections an edition fills, natively or by a reader, or lacks. */
type EditionSectionId = Exclude<ReportSectionId, FrontendSectionId | 'design'>

/** How an edition fills one section: a reader of its value, its native writer, or not at all on this edition (F13). */
export type SectionReader = 'native' | 'not_on_this_edition' | (() => unknown)

/** Every section an edition answers for. */
export type EditionSections = { readonly [S in EditionSectionId]: SectionReader }

/** One entry of the report; a native section's text is the native writer's, so null here. */
export interface ReportEntry {
  readonly section: ReportSectionId
  readonly file: string
  readonly status: ReportSectionStatus | 'native'
  readonly text: string | null
}

export interface ProblemReport {
  /** `canopi-report-YYYYMMDD-HHMMSS.zip`, UTC, the same on both editions (2.1-Q281). */
  readonly fileName: string
  readonly entries: readonly ReportEntry[]
  /** The manifest, or null when a native writer lists its own sections. */
  readonly manifest: ReportManifest | null
}

export interface ProblemReportPort {
  readonly sections: EditionSections
  /** Writes one report as one zip; its file name only, never a path. Throws a typed failure (busy, io) unwritten. */
  write(report: ProblemReport): Promise<ProblemReportResult>
}
