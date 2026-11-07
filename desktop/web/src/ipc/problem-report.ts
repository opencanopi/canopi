import { invokeCommand } from './transport'
import type { ProblemReportRequest, ProblemReportResult } from '../generated/contracts'

export type { ProblemReportRequest, ProblemReportResult }

export async function createProblemReport(
  request: ProblemReportRequest,
): Promise<ProblemReportResult> {
  return invokeCommand('create_problem_report', { request })
}

/** Shows a saved report selected in the "Problem reports" folder, named by its file name, never a path. */
export async function showProblemReportFolder(fileName: string): Promise<void> {
  await invokeCommand('show_problem_report_folder', { fileName })
}
