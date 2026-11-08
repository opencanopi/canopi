// platform/problem-report.desktop.ts: Desktop's problemReport adapter (contracts §22, 2.1-M422). Invariant: the
// native command fills every section but the frontend's own, redacts them and writes the zip in "Problem reports"; a
// busy lane or a failed write settles as its typed failure with nothing written.
import { createProblemReport } from '../ipc/problem-report'
import { NATIVE_SECTIONS, nativeRequest, type ProblemReportPort } from '../app/problem-report/builder'

export const desktopProblemReport: ProblemReportPort = {
  sections: NATIVE_SECTIONS,
  write: (report) => createProblemReport(nativeRequest(report)),
}
