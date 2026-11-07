import { invokeCommand } from './transport'
import type { ProblemReportRequest, ProblemReportResult } from '../generated/contracts'

export type { ProblemReportRequest, ProblemReportResult }

export async function createProblemReport(
  request: ProblemReportRequest,
): Promise<ProblemReportResult> {
  return invokeCommand('create_problem_report', { request })
}

export async function showProblemReportFolder(folderPath: string): Promise<void> {
  await invokeCommand('show_problem_report_folder', { path: folderPath })
}
