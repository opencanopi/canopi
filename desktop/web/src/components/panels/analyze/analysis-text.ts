import type { AnalysisEntry, ParamUnit } from '../../../generated/analysis-registry'
import type { AnalysisParamValue, StaleReason } from '../../../generated/contracts'
import type { AnalysisAvailability, ParamError } from '../../../app/analyses/model'
import { formatLocaleNumber, paramUnitSuffix } from '../../../app/analyses/model'
import { itemTypeLabel, unitSuffix } from '../../../app/data-library/item-types'
import { t } from '../../../i18n'
import { formatArea, formatElevation, formatNumber, formatQuantityInputNumber, type UnitSystem } from '../../../utils/format'

/**
 * Localized wording for analysis states shared by the Analyze dialog, the
 * Data Library and Layers. Every reason is named, never a generic failure.
 */
export function unavailableText(reason: AnalysisAvailability): string {
  switch (reason.reason) {
    case 'WrongInput':
      return t('analyses.unavailable.WrongInput', { expected: reason.expected.map(itemTypeLabel).join(', ') })
    case 'ValuesNotMetres':
      return t('analyses.unavailable.ValuesNotMetres', { units: reason.units })
    case 'EngineMissing': {
      const text = t('analyses.unavailable.EngineMissing')
      return reason.detail ? `${text} (${reason.detail})` : text
    }
    default:
      return t(`analyses.unavailable.${reason.reason}`)
  }
}

/** Why a derived item is out of date, naming the input by its library name. */
export function staleReasonText(reason: StaleReason, nameOf: (itemId: string) => string): string {
  switch (reason.reason) {
    case 'InputUpdated':
    case 'InputStale':
      return t(`analyses.stale.${reason.reason}`, { input: nameOf(reason.item_id) })
    case 'RecipeUpdated':
      return t('analyses.stale.RecipeUpdated', { from: reason.from, to: reason.to })
    case 'ToolUpdated':
      return t('analyses.stale.ToolUpdated', { from: reason.from, to: reason.to })
  }
}

function formatBound(value: number, unit: ParamUnit | undefined, locale: string, system: UnitSystem): string {
  if (unit === 'metre') return formatQuantityInputNumber('length', value, system, locale, system === 'metric' ? 6 : 2)
  if (unit === 'square-metre') return formatQuantityInputNumber('area', value, system, locale, system === 'metric' ? 6 : 2)
  return formatLocaleNumber(value, locale)
}

export function paramErrorText(error: ParamError, locale: string, system: UnitSystem = 'metric'): string {
  switch (error.code) {
    case 'range':
      return t('analyses.dialog.errors.range', {
        min: formatBound(error.min, error.unit, locale, system),
        max: formatBound(error.max, error.unit, locale, system),
      })
    case 'step':
      return t('analyses.dialog.errors.step', { step: formatBound(error.step, error.unit, locale, system) })
    default:
      return t(`analyses.dialog.errors.${error.code}`)
  }
}

/** One recorded parameter as the user chose it: option label, number with unit, yes or no. */
export function paramValueText(
  entry: AnalysisEntry | null,
  parameter: AnalysisParamValue,
  locale: string,
  system: UnitSystem = 'metric',
): string {
  const spec = entry?.params.find((param) => param.key === parameter.key)
  const value = parameter.value
  if ('Choice' in value) {
    const key = spec?.optionLabelKeys[value.Choice]
    return key ? t(key) : value.Choice
  }
  if ('Boolean' in value) return value.Boolean ? t('analyses.dialog.yes') : t('analyses.dialog.no')
  const number = 'Number' in value ? value.Number : value.Integer
  if (spec?.kind.type === 'number') {
    if (spec.kind.unit === 'metre') {
      return formatElevation(number, system, locale, { maximumFractionDigits: 6, trimTrailingZeros: true })
    }
    if (spec.kind.unit === 'square-metre') {
      return formatArea(number, system, locale, { maximumFractionDigits: 6, trimTrailingZeros: true })
    }
    const unit = unitSuffix(paramUnitSuffix(spec.kind.unit, system))
    return `${formatNumber(number, locale, { maximumFractionDigits: 6 })}${unit}`
  }
  return formatNumber(number, locale, { maximumFractionDigits: 6 })
}
