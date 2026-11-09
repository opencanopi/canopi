import type { AnalysisEntry } from '../../../generated/analysis-registry'
import type { AnalysisParamValue, StaleReason } from '../../../generated/contracts'
import type { AnalysisAvailability, ParamError } from '../../../app/analyses/model'
import { formatLocaleNumber, paramUnitSuffix } from '../../../app/analyses/model'
import { itemTypeLabel, unitSuffix } from '../../../app/lidar/item-types'
import { t } from '../../../i18n'

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

export function paramErrorText(error: ParamError, locale: string): string {
  switch (error.code) {
    case 'range':
      return t('analyses.dialog.errors.range', { min: formatLocaleNumber(error.min, locale), max: formatLocaleNumber(error.max, locale) })
    case 'step':
      return t('analyses.dialog.errors.step', { step: formatLocaleNumber(error.step, locale) })
    default:
      return t(`analyses.dialog.errors.${error.code}`)
  }
}

/** One recorded parameter as the user chose it: option label, number with unit, yes or no. */
export function paramValueText(entry: AnalysisEntry | null, parameter: AnalysisParamValue, locale: string): string {
  const spec = entry?.params.find((param) => param.key === parameter.key)
  const value = parameter.value
  if ('Choice' in value) {
    const key = spec?.optionLabelKeys[value.Choice]
    return key ? t(key) : value.Choice
  }
  if ('Boolean' in value) return value.Boolean ? t('analyses.dialog.yes') : t('analyses.dialog.no')
  const number = 'Number' in value ? value.Number : value.Integer
  const unit = spec?.kind.type === 'number' ? unitSuffix(paramUnitSuffix(spec.kind.unit)) : ''
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(number)}${unit}`
}

/** A recorded timestamp (unix milliseconds as text) as a local date and time. */
export function formatTimestamp(value: string, locale: string): string {
  const time = Number(value)
  if (!Number.isFinite(time)) return value
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time))
}
