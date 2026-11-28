import { invokeTyped, mintOperationId } from './transport'
import type { ProblemReportRequest, ProblemReportResult } from '../generated/contracts'

export type { ProblemReportRequest, ProblemReportResult }

export async function createProblemReport(
  request: ProblemReportRequest,
): Promise<ProblemReportResult> {
  return invokeTyped('create_problem_report', { request }, mintOperationId('u'))
}

/** Shows a saved report selected in the "Problem reports" folder, named by its file name, never a path. */
export async function showProblemReportFolder(fileName: string): Promise<void> {
  await invokeTyped('show_problem_report_folder', { fileName }, mintOperationId('u'))
}
