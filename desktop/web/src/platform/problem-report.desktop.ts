// platform/problem-report.desktop.ts
//
// Owner of the Desktop problem report writer: a native host adapter for the problemReport port
// (platform/problem-report.ts; tauri-only-in-native-host, ADR 0022, ADR 0025; contracts §22, 2.1-M421, 2.1-M422).
// Invariant: the native command fills every section but the frontend's own, redacts them and writes the zip in
// "Problem reports"; a busy lane or a failed write settles as its typed failure with nothing written.
import { createProblemReport } from '../ipc/problem-report'
import type { ProblemReportRequest, RedactedText } from '../generated/contracts'
import type { EditionSections, ProblemReport, ProblemReportPort } from './problem-report'

/** Desktop: the native command fills every section but the frontend's own (2.1-M421). */
const NATIVE_SECTIONS: EditionSections = {
  build: 'native',
  health: 'native',
  queues: 'native',
  native_settlements: 'native',
  jobs: 'native',
  library_disk: 'native',
  log_tail: 'native',
  settings_summary: 'native',
}

/**
 * What the native command takes: every frontend section that holds anything (it marks the rest empty) and the Design.
 * Every edition section here is native, so an included entry is a frontend section or the consented Design.
 */
function nativeRequest(report: ProblemReport): ProblemReportRequest {
  const sections = report.entries.flatMap((entry) =>
    entry.section !== 'design' && entry.status === 'included' && entry.text !== null
      ? [{ id: entry.section, text: entry.text as RedactedText }]
      : [],
  )
  const design = report.entries.find((entry) => entry.section === 'design')
  return { sections, current_design: design?.text ?? null }
}

export const desktopProblemReport: ProblemReportPort = {
  sections: NATIVE_SECTIONS,
  write: (report) => createProblemReport(nativeRequest(report)),
}
