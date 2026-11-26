import { groupPlantsBySpecies } from '../../canvas/plant-grouping'
import { getConsortiumCanonicalName } from '../../target'
import type { Consortium, PlacedPlant } from '../../types/design'
import type { PlantSymbolId } from '../../canvas/runtime/scene'
import { isEnglishFallbackName, type SpeciesKeyEntry } from '../../canvas/runtime/species-key'
import { CONSORTIUM_STRATA, SUCCESSION_PHASE_COUNT } from '../../planning/time-model'
import type { ConsortiumListFilter } from '../planning-view/state'

export interface ConsortiumPlanningProjection {
  readonly activeEntries: readonly Consortium[]
  readonly rows: readonly ConsortiumPlanningRow[]
  readonly groups: readonly ConsortiumPlanningGroup[]
  readonly matrix: readonly ConsortiumMatrixRow[]
  readonly activeSpeciesCount: number
  readonly activePlantCount: number
}

export interface ConsortiumPlanningRow {
  readonly entry: Consortium
  readonly canonicalName: string
  readonly commonName: string
  /** `commonName` is the English catalog name: none exists in the UI language. */
  readonly englishFallback: boolean
  readonly code?: string
  readonly appearances: readonly { readonly symbol: PlantSymbolId; readonly color: string }[]
  readonly count: number
  readonly stratum: string
  readonly startPhase: number
  readonly endPhase: number
}

interface ConsortiumPlanningGroup {
  readonly stratum: string
  readonly supported: boolean
  readonly rows: readonly ConsortiumPlanningRow[]
  readonly speciesCount: number
  readonly plantCount: number
}

interface ConsortiumMatrixRow {
  readonly stratum: string
  readonly counts: readonly number[]
}

export interface ConsortiumListProjection {
  readonly groups: readonly ConsortiumPlanningGroup[]
  readonly visibleCount: number
  readonly restricted: boolean
}

export interface BuildConsortiumPlanningProjectionOptions {
  readonly consortiums: readonly Consortium[]
  readonly plants: readonly PlacedPlant[]
  /** Names in the UI language, with English fallbacks filled in. */
  readonly localizedNames?: ReadonlyMap<string, string | null>
  readonly englishFallbackNames?: ReadonlyMap<string, string>
  readonly speciesKey?: readonly SpeciesKeyEntry[]
}

export function buildConsortiumPlanningProjection({
  consortiums,
  plants,
  localizedNames,
  englishFallbackNames = new Map(),
  speciesKey = [],
}: BuildConsortiumPlanningProjectionOptions): ConsortiumPlanningProjection {
  const activeEntries = filterActiveConsortiumEntries(consortiums, plants)
  const rows = buildConsortiumRows(activeEntries, plants, localizedNames, englishFallbackNames, speciesKey)
  return {
    activeEntries,
    rows,
    groups: groupConsortiumRows(rows),
    matrix: CONSORTIUM_STRATA.map((stratum) => ({
      stratum,
      counts: Array.from({ length: SUCCESSION_PHASE_COUNT }, (_, phase) => new Set(
        rows
          .filter((row) => row.stratum === stratum && row.startPhase <= phase && row.endPhase >= phase)
          .map((row) => row.canonicalName),
      ).size),
    })),
    activeSpeciesCount: new Set(rows.map((row) => row.canonicalName)).size,
    activePlantCount: plants.length,
  }
}

export function buildConsortiumListProjection(
  projection: ConsortiumPlanningProjection,
  options: {
    /** Species the finder matched; null when the finder is empty. */
    readonly matches: ReadonlySet<string> | null
    /** Species selected on the map; null when that filter is off. */
    readonly selectedSpecies: ReadonlySet<string> | null
    /** Species passing the Stratum and Form quick filters; null when neither is chosen. */
    readonly quickFilterSpecies?: ReadonlySet<string> | null
    readonly filter: ConsortiumListFilter | null
  },
): ConsortiumListProjection {
  const groups = projection.groups.map((group) => {
    const rows = group.rows.filter((row) => {
      if (options.filter?.stratum && row.stratum !== options.filter.stratum) return false
      if (
        options.filter?.phase !== null
        && options.filter?.phase !== undefined
        && !(row.startPhase <= options.filter.phase && row.endPhase >= options.filter.phase)
      ) return false
      if (options.selectedSpecies && !options.selectedSpecies.has(row.canonicalName)) return false
      if (options.quickFilterSpecies && !options.quickFilterSpecies.has(row.canonicalName)) return false
      return !options.matches || options.matches.has(row.canonicalName)
    })
    return {
      ...group,
      rows,
      speciesCount: rows.length,
      plantCount: rows.reduce((sum, row) => sum + row.count, 0),
    }
  }).filter((group) => group.rows.length > 0)
  return {
    groups,
    visibleCount: groups.reduce((sum, group) => sum + group.rows.length, 0),
    restricted: options.matches !== null || options.selectedSpecies !== null
      || (options.quickFilterSpecies ?? null) !== null || options.filter !== null,
  }
}

function buildConsortiumRows(
  entries: readonly Consortium[],
  plants: readonly PlacedPlant[],
  localizedNames: ReadonlyMap<string, string | null> | undefined,
  englishFallbackNames: ReadonlyMap<string, string>,
  speciesKey: readonly SpeciesKeyEntry[],
): ConsortiumPlanningRow[] {
  const plantCounts = groupPlantsBySpecies(plants, localizedNames)
  const identity = new Map(speciesKey.map((entry) => [entry.canonicalName, entry]))
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const canonicalName = getConsortiumCanonicalName(entry)
    if (seen.has(canonicalName)) return false
    seen.add(canonicalName)
    return true
  }).map((entry) => {
    const canonicalName = getConsortiumCanonicalName(entry)
    const plantInfo = plantCounts.get(canonicalName)
    const speciesIdentity = identity.get(canonicalName)
    const commonName = plantInfo?.commonName ?? speciesIdentity?.commonName ?? canonicalName
    const code = speciesIdentity?.code
    return {
      entry,
      canonicalName,
      commonName,
      englishFallback: isEnglishFallbackName(englishFallbackNames, canonicalName, commonName),
      code,
      appearances: speciesIdentity?.appearances ?? [],
      count: plantInfo?.count ?? 0,
      stratum: entry.stratum,
      startPhase: entry.start_phase,
      endPhase: entry.end_phase,
    }
  }).sort((left, right) => (
    left.commonName.localeCompare(right.commonName)
    || left.canonicalName.localeCompare(right.canonicalName)
  ))
}

function groupConsortiumRows(rows: readonly ConsortiumPlanningRow[]): ConsortiumPlanningGroup[] {
  const order = new Map<string, number>(CONSORTIUM_STRATA.map((stratum, index) => [stratum, index]))
  const grouped = new Map<string, ConsortiumPlanningRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.stratum) ?? []
    group.push(row)
    grouped.set(row.stratum, group)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    ))
    .map(([stratum, groupRows]) => ({
      stratum,
      supported: order.has(stratum),
      rows: groupRows,
      speciesCount: groupRows.length,
      plantCount: groupRows.reduce((sum, row) => sum + row.count, 0),
    }))
}


function filterActiveConsortiumEntries(
  entries: readonly Consortium[],
  plants: readonly PlacedPlant[],
): Consortium[] {
  const activeSpecies = new Set(plants.map((plant) => plant.canonical_name))
  return entries.filter((entry) => activeSpecies.has(getConsortiumCanonicalName(entry)))
}
