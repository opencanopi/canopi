import { getLiveSessionCore } from '../document-session/live-core'

/** The open Design as Desktop's report attaches it, encoded via the active SessionCore's DesignCore codec; null with none open. */
export async function buildCurrentDesignProblemReportAttachment(): Promise<string | null> {
  const core = getLiveSessionCore()
  if (!core) return null
  const bytes = await core.encodeSnapshot()
  if (!bytes) return null
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.endsWith('\n') ? text : `${text}\n`
}
