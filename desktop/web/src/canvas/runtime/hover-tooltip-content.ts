// canvas/runtime/hover-tooltip-content.ts
// Formats passive hover tooltip content for every Design Object kind (2.1-Q158, 2.1-Q355).

import { formatArea, formatLength, type UnitSystem } from '../../utils/format'
import type { GroundMeasure } from '../../geo/session-plane'
import type { SceneDesignObjectTarget, ScenePersistedState, SceneZoneEntity } from './scene'
import { getZoneOutlinePoints, isZoneClosed } from './zone-geometry'
import { zoneDisplayName } from './zone-identity'

export interface HoverTooltipContent {
  readonly title: string | null
  readonly subtitle: string
  readonly subtitleItalic: boolean
}

function formatZoneHover(
  zone: SceneZoneEntity,
  plane: GroundMeasure,
  unitSystem: UnitSystem,
  locale: string,
): HoverTooltipContent {
  const title = zoneDisplayName(zone) ?? zone.zoneType
  if (isZoneClosed(zone)) {
    const ring = getZoneOutlinePoints(zone)
    const areaM2 = ring.length >= 3 ? plane.groundArea(ring) : 0
    return { title, subtitle: areaM2 > 0 ? formatArea(areaM2, unitSystem, locale) : zone.zoneType, subtitleItalic: false }
  }
  let lengthM = 0
  for (let i = 1; i < zone.points.length; i += 1) {
    lengthM += plane.groundLength(zone.points[i - 1]!, zone.points[i]!)
  }
  return { title, subtitle: lengthM > 0 ? formatLength(lengthM, unitSystem, locale) : zone.zoneType, subtitleItalic: false }
}

export function formatHoverTooltipContent(
  scene: ScenePersistedState,
  target: SceneDesignObjectTarget,
  plane: GroundMeasure,
  localizedCommonNames: ReadonlyMap<string, string | null>,
  unitSystem: UnitSystem,
  locale: string,
): HoverTooltipContent | null {
  if (target.kind === 'plant') {
    const plant = scene.plants.find((entry) => entry.id === target.id)
    if (!plant) return null
    const commonName = localizedCommonNames.get(plant.canonicalName) ?? plant.commonName
    return { title: commonName, subtitle: plant.canonicalName, subtitleItalic: true }
  }
  if (target.kind === 'zone') {
    const zone = scene.zones.find((entry) => entry.id === target.id)
    return zone ? formatZoneHover(zone, plane, unitSystem, locale) : null
  }
  if (target.kind === 'measurement-guide') {
    const guide = scene.measurementGuides.find((entry) => entry.id === target.id)
    if (!guide) return null
    return { title: null, subtitle: formatLength(plane.groundLength(guide.start, guide.end), unitSystem, locale), subtitleItalic: false }
  }
  if (target.kind === 'annotation') {
    const note = scene.annotations.find((entry) => entry.id === target.id)
    const firstLine = note?.text.split('\n')[0]?.trim() ?? ''
    if (!firstLine) return null
    return { title: null, subtitle: firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine, subtitleItalic: false }
  }
  const group = scene.groups.find((entry) => entry.id === target.id)
  if (!group) return null
  return { title: group.name ?? null, subtitle: `${group.members.length}`, subtitleItalic: false }
}
