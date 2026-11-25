import type { DesignSessionWorkflow } from './workflow-runner'

export const DESIGN_SESSION_WORKFLOWS: DesignSessionWorkflow[] = []

export function registerDesignSessionWorkflow(workflow: DesignSessionWorkflow): void {
  if (DESIGN_SESSION_WORKFLOWS.some((existing) => existing.id === workflow.id)) return
  DESIGN_SESSION_WORKFLOWS.push(workflow)
}
