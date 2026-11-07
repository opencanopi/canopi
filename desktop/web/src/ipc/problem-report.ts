import { invoke } from '@tauri-apps/api/core'
import type { ProblemReportRequest, ProblemReportResult } from '../generated/contracts'

export type { ProblemReportRequest, ProblemReportResult }

export async function createProblemReport(
  request: ProblemReportRequest,
): Promise<ProblemReportResult> {
  return invoke('create_problem_report', { request })
}

/** Shows a saved report selected in the "Problem reports" folder, named by its file name, never a path. */
export async function showProblemReportFolder(fileName: string): Promise<void> {
  await invoke('show_problem_report_folder', { fileName })
}
