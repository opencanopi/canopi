import {
  ANALYSIS_REGISTRY,
  type AnalysisEntry,
  type AnalysisGroup,
} from '../../generated/analysis-registry'
import { t } from '../../i18n'

/**
 * Lookups over the generated analysis registry for read models that name,
 * group or attach derived items. The registry is the only authority on what
 * an analysis is; an id this build no longer knows is named by its id.
 */
export function findAnalysis(
  id: string,
  registry: readonly AnalysisEntry[] = ANALYSIS_REGISTRY,
): AnalysisEntry | null {
  return registry.find((entry) => entry.id === id) ?? null
}

export function analysisTitle(id: string, registry: readonly AnalysisEntry[] = ANALYSIS_REGISTRY): string {
  const entry = findAnalysis(id, registry)
  return entry ? t(entry.titleKey) : id
}

export function analysisGroup(id: string, registry: readonly AnalysisEntry[] = ANALYSIS_REGISTRY): AnalysisGroup | null {
  return findAnalysis(id, registry)?.group ?? null
}

/** Whether one output of an analysis is drawn on the map, or kept only for provenance. */
export function isPresentableOutput(
  analysisId: string,
  outputKey: string,
  registry: readonly AnalysisEntry[] = ANALYSIS_REGISTRY,
): boolean {
  return findAnalysis(analysisId, registry)?.outputs.find((output) => output.key === outputKey)?.presentable ?? false
}

/**
 * The name of a derived item published unnamed: its first input, then its
 * analysis ("Ground · Slope"). An invented name is never stored; this is
 * display only.
 */
export function derivedItemName(inputName: string | null | undefined, analysisId: string): string {
  const title = analysisTitle(analysisId)
  return inputName ? `${inputName} · ${title}` : title
}
