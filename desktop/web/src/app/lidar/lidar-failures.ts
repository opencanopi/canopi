import type { LidarImportRefusal, LidarImportRefusalReason } from '../../generated/contracts'
import { t } from '../../i18n'
import { locale } from '../settings/state'
import { reportFailure } from '../../failures/report'

/**
 * The one mapper from a Data library failure to what users read (canopi-bkbh).
 *
 * An Import or Retry refusal (`LidarImportRefusal`) is named by its kind in
 * the interface language; anything else (an `Internal` refusal, a failed
 * command, a malformed read) reads as the generic message. The English detail
 * goes to diagnostics only, never on screen. Job failures stored on a row are
 * never shown: the row reads Import failed or Calculation failed.
 */

type Reason = LidarImportRefusalReason
type Kind = Reason['kind']

/** "2 GB", "512 MB": a limit in mebibytes, in the interface language. */
function formatLimit(limitMib: number): string {
  const gigabytes = limitMib >= 1024
  return new Intl.NumberFormat(locale.value, {
    style: 'unit',
    unit: gigabytes ? 'gigabyte' : 'megabyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(gigabytes ? limitMib / 1024 : limitMib)
}

const REFUSAL_COPY = {
  TooManyFiles: (reason) => t('canvas.lidar.failure.tooManyFiles', { limit: reason.limit }),
  SourceTooLarge: (reason) => t('canvas.lidar.failure.sourceTooLarge', { file: reason.file, size: formatLimit(reason.limit_mib) }),
  ImportTooLarge: (reason) => t('canvas.lidar.failure.importTooLarge', { size: formatLimit(reason.limit_mib) }),
  SourceMissing: (reason) => t('canvas.lidar.failure.sourceMissing', { file: reason.file }),
  Unreadable: (reason) => t('canvas.lidar.failure.unreadable', { file: reason.file }),
  NotGeotiff: (reason) => t('canvas.lidar.failure.notGeotiff', { file: reason.file }),
  NoCrs: (reason) => t('canvas.lidar.failure.noCrs', { file: reason.file }),
  // A system the file spells out key by key has no code to name.
  UnsupportedCrs: (reason) => reason.crs
    ? t('canvas.lidar.failure.unsupportedCrs', { file: reason.file, crs: reason.crs })
    : t('canvas.lidar.failure.unsupportedCrsUnnamed', { file: reason.file }),
  JobRunning: () => t('canvas.lidar.failure.jobRunning'),
  LibraryUnavailable: () => t('canvas.lidar.failure.libraryUnavailable'),
  Internal: () => t('canvas.lidar.failure.generic'),
} satisfies { [K in Kind]: (reason: Extract<Reason, { kind: K }>) => string }

function isRefusal(error: unknown): error is LidarImportRefusal {
  if (typeof error !== 'object' || error === null) return false
  const { reason, detail } = error as { reason?: unknown, detail?: unknown }
  return typeof detail === 'string'
    && typeof reason === 'object' && reason !== null
    && typeof (reason as { kind?: unknown }).kind === 'string'
    && Object.prototype.hasOwnProperty.call(REFUSAL_COPY, (reason as { kind: string }).kind)
}

/**
 * What users read for a failed Data library action or read, in the interface
 * language; the failure's own text is kept for diagnostics unless `record` is
 * false (a repeat the caller already recorded, so it cannot fill the ring). The
 * caller shows the message inline, so the entry is marked surfaced.
 */
export function lidarFailureMessage(error: unknown, record = true): string {
  if (isRefusal(error)) {
    if (record) reportFailure(`${error.reason.kind}: ${error.detail}`, { shown: 'inline', source: 'lidar-library', level: 'warning' })
    return (REFUSAL_COPY[error.reason.kind] as (reason: Reason) => string)(error.reason)
  }
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)
  if (record) reportFailure(detail, { shown: 'inline', source: 'lidar-library', level: 'error' })
  return t('canvas.lidar.failure.generic')
}
