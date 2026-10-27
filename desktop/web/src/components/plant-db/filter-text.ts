import { isLocaleKey, t } from '../../i18n'

/**
 * A filter schema label or a catalog value's name, or `fallback` when English has none: a catalog value is an open set
 * the catalog may extend before its strings exist, and the generated filter schema carries its keys as strings.
 */
export function filterText(key: string, fallback: string): string {
  return isLocaleKey(key) ? t(key) : fallback
}
