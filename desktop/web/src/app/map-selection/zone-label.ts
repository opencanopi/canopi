import type { SceneZoneEntity } from '../../canvas/runtime/scene'
import { measureZone } from '../../canvas/runtime/zone-geometry'
import { zoneDisplayName } from '../../canvas/runtime/zone-identity'
import { t } from '../../i18n'
import type { LocaleKey } from '../../generated/locale-keys'

const ZONE_TYPE_KEYS: Readonly<Record<string, LocaleKey>> = {
  rect: 'canvas.selectionChip.zoneRect',
  ellipse: 'canvas.selectionChip.zoneEllipse',
  polygon: 'canvas.selectionChip.zonePolygon',
  line: 'canvas.selectionChip.zoneLine',
}

/** "Rectangle zone", "Line zone"…; plain "Zone" for an unknown type. */
export function zoneTypeLabel(zoneType: string): string {
  return t(ZONE_TYPE_KEYS[zoneType] ?? 'canvas.selectionChip.zone')
}

/**
 * How every list names a zone: the name the user gave it, else its type and
 * size ("Rectangle zone · 120 m²", "Line zone · 50 m"). The interface never
 * shows a zone's id.
 */
export function zoneLabel(zone: SceneZoneEntity, activeLocale: string): string {
  const name = zoneDisplayName(zone)
  if (name !== null) return name
  const measure = measureZone(zone)
  const size = measure === null
    ? null
    : measure.areaM2 === null ? formatLength(measure.perimeterM, activeLocale) : formatArea(measure.areaM2, activeLocale)
  const type = zoneTypeLabel(zone.zoneType)
  return size === null ? type : `${type} · ${size}`
}

/** A target whose zone is gone: plain "Zone", since a zone's id is never shown. */
export function missingZoneLabel(): string {
  return t('canvas.selectionChip.zone')
}

/** Lengths as the map labels them: two decimals below 1 m, one below 100 m, none above. */
export function formatLength(meters: number, activeLocale: string): string {
  const digits = meters < 1 ? 2 : meters < 100 ? 1 : 0
  return new Intl.NumberFormat(activeLocale, { style: 'unit', unit: 'meter', unitDisplay: 'short', maximumFractionDigits: digits }).format(meters)
}

/** Areas in m² (one decimal below 10 m²), or in hectares from 1 ha. */
export function formatArea(squareMeters: number, activeLocale: string): string {
  if (squareMeters >= 10_000) {
    return new Intl.NumberFormat(activeLocale, { style: 'unit', unit: 'hectare', unitDisplay: 'short', maximumFractionDigits: 2 }).format(squareMeters / 10_000)
  }
  // Intl has no square-metre unit; the symbol m² is the same in every interface language.
  const value = new Intl.NumberFormat(activeLocale, { maximumFractionDigits: squareMeters < 10 ? 1 : 0 }).format(squareMeters)
  return `${value} m²`
}
