import { formatRasterMetres } from '../../../app/data-library/display-legend'
import { itemTypeLabel } from '../../../app/data-library/item-types'
import type { LibraryItem } from '../../../app/data-library/library-items'
import { locale, unitSystem } from '../../../app/settings/state'
import { t } from '../../../i18n'

/** Wording and states of one library item, shared by the Data library and Layers details. */
export function isStale(row: LibraryItem): boolean {
  return row.status === 'ready' && row.freshness.state === 'Stale'
}

/** A derived item whose run (first calculation, retry or refresh) is in progress. */
export function isRunning(row: LibraryItem): boolean {
  return row.role === 'Derived' && row.run?.state === 'Preparing'
}

/** A result's units in words ("degrees"), else the stored symbol. */
export function unitWords(units: string): string {
  if (units === '°') return t('canvas.lidar.units.degrees')
  if (units === '%') return t('canvas.lidar.units.percent')
  return units === 'unknown' ? t('canvas.lidar.library.unitUnknown') : units
}

/** Type and resolution for a source, type and units for a result. */
export function itemSummary(row: LibraryItem): string {
  const type = itemTypeLabel(row.itemType)
  if (row.role === 'Derived') return row.units ? `${type} · ${unitWords(row.units)}` : type
  const resolution = row.resolutionM !== null ? ` · ${formatRasterMetres(row.resolutionM, locale.value, unitSystem.value)}` : ''
  return `${type}${resolution}`
}

export function itemStatusLabel(row: LibraryItem): string {
  if (row.status === 'preparing') {
    const phase = row.importJob?.progress?.phase
    return phase ? t(`canvas.lidar.progressPhase.${phase}`) : t('canvas.lidar.library.preparing')
  }
  if (row.run?.state === 'Cancelled') return t('canvas.lidar.library.cancelled')
  return row.role === 'Derived' ? t('canvas.lidar.library.calculationFailed') : t('canvas.lidar.library.importFailed')
}
