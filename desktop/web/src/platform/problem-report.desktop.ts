// platform/problem-report.desktop.ts: Desktop's problemReport adapter (contracts §22, 2.1-M422). Invariant: the
// native command fills every section but the frontend's own, redacts them and writes the zip in "Problem reports"; a
// busy lane or a failed write settles as its typed failure with nothing written.
import { createProblemReport } from '../ipc/problem-report'
import { nativeRequest } from '../app/problem-report/builder'
import type { ProblemReportPort } from './problem-report'

export const desktopProblemReport: ProblemReportPort = {
  sections: {
    build: 'native',
    health: 'native',
    queues: 'native',
    native_settlements: 'native',
    jobs: 'native',
    library_disk: 'native',
    log_tail: 'native',
    settings_summary: 'native',
  },
  write: (report) => createProblemReport(nativeRequest(report)),
}
