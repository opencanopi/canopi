import {
  ANALYSIS_REGISTRY,
  type AnalysisEntry,
  type AnalysisGroup,
} from '../../generated/analysis-registry'
import { isLocaleKey, t } from '../../i18n'

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

/**
 * A group label the analysis model carries as a string, or the key itself when English lacks it, as i18next shows a
 * missing key. Its one caller is the Analyze dialog's group legend; it goes once app/analyses/model.ts types
 * AnalysisOptionGroup.labelKey as LocaleKey (canopi-f47t.52.228.48).
 */
export function registryText(key: string): string {
  return isLocaleKey(key) ? t(key) : key
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
