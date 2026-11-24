import { describe, expect, it } from 'vitest'
import { ANALYSIS_GROUPS, ANALYSIS_I18N_KEYS, ANALYSIS_REGISTRY } from '../generated/analysis-registry'
import type { AnalysisUnavailable, RasterQuantity, StaleReason } from '../generated/contracts'
import type { AnalysisAvailability } from '../app/analyses/model'
import { RASTER_QUANTITIES } from '../app/data-library/item-types'
import en from '../i18n/en.json'
import de from '../i18n/de.json'
import es from '../i18n/es.json'
import fr from '../i18n/fr.json'
import itLocale from '../i18n/it.json'
import ja from '../i18n/ja.json'
import ko from '../i18n/ko.json'
import nl from '../i18n/nl.json'
import pt from '../i18n/pt.json'
import ru from '../i18n/ru.json'
import zh from '../i18n/zh.json'

const LOCALES: Record<string, unknown> = { en, de, es, fr, it: itLocale, ja, ko, nl, pt, ru, zh }

/**
 * Every reason the frontend can name. The `satisfies` records fail to compile
 * when the contract gains a reason, so a new one cannot ship untranslated.
 */
const UNAVAILABLE = Object.keys({
  WrongInput: true, NotReady: true, ValuesNotMetres: true, GridNotProjectedMetres: true, EngineMissing: true,
  NeedsDesktop: true, AlreadyInSiteData: true,
} satisfies Record<AnalysisAvailability['reason'] | AnalysisUnavailable['reason'], true>)
const STALE = Object.keys({
  InputUpdated: true, InputStale: true, RecipeUpdated: true, ToolUpdated: true,
} satisfies Record<StaleReason['reason'], true>)

function lookup(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, tree)
}

describe('analysis registry translations', () => {
  const keys = [
    ...ANALYSIS_I18N_KEYS,
    ...UNAVAILABLE.map((reason) => `analyses.unavailable.${reason}`),
    ...STALE.map((reason) => `analyses.stale.${reason}`),
    ...(Object.keys(RASTER_QUANTITIES) as RasterQuantity[]).map((quantity) => RASTER_QUANTITIES[quantity].labelKey),
  ]

  for (const [locale, tree] of Object.entries(LOCALES)) {
    it(`${locale} names every registry key, reason and item type`, () => {
      const missing = keys.filter((key) => {
        const value = lookup(tree, key)
        return typeof value !== 'string' || value.trim() === ''
      })
      expect(missing).toEqual([])
    })
  }

  it('lists every key the registry entries and groups name', () => {
    const named = [
      ...ANALYSIS_GROUPS.map((group) => group.labelKey),
      ...ANALYSIS_REGISTRY.flatMap((entry) => [
        entry.titleKey,
        entry.summaryKey,
        ...entry.params.flatMap((param) => [param.labelKey, param.helpKey, ...Object.values(param.optionLabelKeys)]),
        ...entry.outputs.map((output) => output.labelKey),
      ]),
    ]
    expect(named.filter((key) => !ANALYSIS_I18N_KEYS.includes(key))).toEqual([])
    expect(named.every((key) => typeof lookup(en, key) === 'string')).toBe(true)
  })
})
