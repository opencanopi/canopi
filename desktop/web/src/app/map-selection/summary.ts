import { useMemo } from 'preact/hooks'
import { currentCanvasQuerySurface, currentCanvasSelection } from '../../canvas/session'
import { nearestPlantNeighbour, nearestPlantSpacing } from '../../canvas/plant-spacing'
import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { measureZone } from '../../canvas/runtime/zone-geometry'
import { zoneDisplayName } from '../../canvas/runtime/zone-identity'

/**
 * What is selected on the map, for the selection status chip: counts by kind,
 * the species of the selected plants and their spacing, the selected zones
 * with their measures, and the one selected text note or measurement.
 * Read through read-only runtime queries, with geometry in the session
 * plane's metres; groups count as their members. It carries no object ids;
 * a zone's `name` is its display name, null until the user names it.
 */
export interface MapSelectionSummary {
  readonly plantCount: number
  /** Selected plants per species, in Design order. */
  readonly species: readonly MapSelectionSpecies[]
  /** Mean distance from each selected plant to its nearest selected neighbour, in metres; null below two plants. */
  readonly plantSpacingM: number | null
  readonly zones: readonly MapSelectionZone[]
  readonly noteCount: number
  /** The text of the one selected text note. */
  readonly noteText: string | null
  readonly measurementCount: number
  /** The length of the one selected measurement, in metres. */
  readonly measurementLengthM: number | null
}

interface MapSelectionZone {
  /** The name the user gave the zone; null until it has one. */
  readonly name: string | null
  /** `rect`, `ellipse`, `polygon` or `line`. */
  readonly zoneType: string
  /** Null for a line zone. */
  readonly areaM2: number | null
  /** A line zone's length. */
  readonly perimeterM: number | null
}

interface MapSelectionSpecies {
  readonly canonicalName: string
  /** The common name in the current language, else the English catalog name, else the Design's, else the scientific name. */
  readonly name: string
  /** `name` is the English catalog name: the species has none in the current language. */
  readonly englishFallback: boolean
  readonly selectedCount: number
  /** Every plant of this species in the Design. */
  readonly designCount: number
}

/** Follows the canvas selection; null when nothing is selected. */
export function useMapSelectionSummary(): MapSelectionSummary | null {
  const queries = currentCanvasQuerySurface.value
  const selection = currentCanvasSelection.value
  const sceneRevision = queries?.revision.scene.value
  const namesRevision = queries?.revision.plantNames.value
  return useMemo(
    () => readMapSelectionSummary(queries),
    [queries, selection, sceneRevision, namesRevision],
  )
}

export function readMapSelectionSummary(queries: CanvasQuerySurface | null): MapSelectionSummary | null {
  const selection = queries?.getSelection() ?? []
  if (!queries || selection.length === 0) return null
  const scene = queries.getSceneSnapshot()
  const plantIds = new Set<string>()
  const zoneIds = new Set<string>()
  const noteIds = new Set<string>()
  const measurementIds = new Set<string>()
  const add = (kind: string, id: string) => {
    if (kind === 'plant') plantIds.add(id)
    else if (kind === 'zone') zoneIds.add(id)
    else if (kind === 'annotation') noteIds.add(id)
    else if (kind === 'measurement-guide') measurementIds.add(id)
  }
  for (const target of selection) {
    if (target.kind !== 'group') {
      add(target.kind, target.id)
      continue
    }
    for (const member of scene.groups.find((group) => group.id === target.id)?.members ?? []) add(member.kind, member.id)
  }

  const counts = new Map<string, { selected: number; design: number; commonName: string | null }>()
  let plantCount = 0
  for (const plant of scene.plants) {
    let entry = counts.get(plant.canonicalName)
    if (!entry) {
      entry = { selected: 0, design: 0, commonName: null }
      counts.set(plant.canonicalName, entry)
    }
    entry.design += 1
    if (!plantIds.has(plant.id)) continue
    entry.selected += 1
    entry.commonName ??= plant.commonName
    plantCount += 1
  }
  const localized = queries.getLocalizedCommonNames()
  const english = queries.getEnglishFallbackNames()
  const species: MapSelectionSpecies[] = []
  for (const [canonicalName, entry] of counts) {
    if (entry.selected === 0) continue
    const localizedName = localized.get(canonicalName)
    const englishName = localizedName ? undefined : english.get(canonicalName)
    species.push({
      canonicalName,
      name: localizedName || englishName || entry.commonName || canonicalName,
      englishFallback: Boolean(englishName),
      selectedCount: entry.selected,
      designCount: entry.design,
    })
  }

  const plane = queries.sessionPlane.peek() ?? undefined
  const selectedPlants = plantCount >= 2 ? scene.plants.filter((plant) => plantIds.has(plant.id)) : []
  const zones = scene.zones.filter((zone) => zoneIds.has(zone.id)).map((zone): MapSelectionZone => {
    const measure = plane ? measureZone(zone, plane) : null
    return {
      name: zoneDisplayName(zone),
      zoneType: zone.zoneType,
      areaM2: measure?.areaM2 ?? null,
      perimeterM: measure?.perimeterM ?? null,
    }
  })
  const notes = scene.annotations.filter((note) => noteIds.has(note.id))
  const measurements = scene.measurementGuides.filter((guide) => measurementIds.has(guide.id))
  if (plantCount + zones.length + notes.length + measurements.length === 0) return null
  const [guide] = measurements
  return {
    plantCount,
    species,
    plantSpacingM: meanNearestSpacing(selectedPlants, plane),
    zones,
    noteCount: notes.length,
    noteText: notes.length === 1 ? notes[0]!.text : null,
    measurementCount: measurements.length,
    measurementLengthM: measurements.length === 1 && guide
      ? (plane ? plane.groundLength(guide.start, guide.end) : Math.hypot(guide.end.x - guide.start.x, guide.end.y - guide.start.y))
      : null,
  }
}

function meanNearestSpacing(
  plants: readonly { readonly position: { readonly x: number; readonly y: number } }[],
  measure?: { groundLength(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number },
): number | null {
  let total = 0
  let counted = 0
  for (const plant of plants) {
    let spacing = Infinity
    if (measure) {
      const neighbour = nearestPlantNeighbour(plants, plant.position)
      if (neighbour) spacing = measure.groundLength(plant.position, neighbour)
    } else {
      spacing = nearestPlantSpacing(plants, plant.position)
    }
    if (!Number.isFinite(spacing)) continue
    total += spacing
    counted += 1
  }
  return counted > 0 ? total / counted : null
}
