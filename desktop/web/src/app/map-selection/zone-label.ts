import type { SceneZoneEntity } from '../../canvas/runtime/scene'
import { measureZone } from '../../canvas/runtime/zone-geometry'
import { zoneDisplayName } from '../../canvas/runtime/zone-identity'
import type { GroundMeasure } from '../../geo/view/types'
import { t } from '../../i18n'
import {
  formatArea as formatQuantityArea,
  formatLength as formatQuantityLength,
  type UnitSystem,
} from '../../utils/format'
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
export function zoneLabel(
  zone: SceneZoneEntity,
  activeLocale: string,
  measure: GroundMeasure,
  system: UnitSystem = 'metric',
): string {
  const name = zoneDisplayName(zone)
  if (name !== null) return name
  const measured = measureZone(zone, measure)
  const size = measured === null
    ? null
    : measured.areaM2 === null
      ? formatLength(measured.perimeterM, activeLocale, system)
      : formatArea(measured.areaM2, activeLocale, system)
  const type = zoneTypeLabel(zone.zoneType)
  return size === null ? type : `${type} · ${size}`
}

/** A target whose zone is gone: plain "Zone", since a zone's id is never shown. */
export function missingZoneLabel(): string {
  return t('canvas.selectionChip.zone')
}

/** Lengths as the map labels them, routed through the active unit system. */
export function formatLength(meters: number, activeLocale: string, system: UnitSystem = 'metric'): string {
  return formatQuantityLength(meters, system, activeLocale, { trimTrailingZeros: true })
}

/** Areas as the map labels them, routed through the active unit system. */
export function formatArea(squareMeters: number, activeLocale: string, system: UnitSystem = 'metric'): string {
  return formatQuantityArea(squareMeters, system, activeLocale, { trimTrailingZeros: true })
}
