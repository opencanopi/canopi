import { useMemo } from 'preact/hooks'
import { locale } from '../../app/settings/state'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { buildSpeciesKey } from '../../canvas/runtime/species-key'
import type { PlantSymbolId } from '../../canvas/runtime/scene'

/** A catalog species that has plants in the open Design: its code and first appearance. */
export interface CatalogDesignSpecies {
  readonly code: string
  readonly count: number
  readonly symbol: PlantSymbolId
  readonly color: string
}

const NO_NAMES: ReadonlyMap<string, string | null> = new Map()
const NO_FALLBACKS: ReadonlyMap<string, string> = new Map()
const NO_SPECIES: ReadonlyMap<string, CatalogDesignSpecies> = new Map()

/** Species with plants in the open Design, by canonical name; empty without a Design. */
export function useCatalogDesignSpecies(): ReadonlyMap<string, CatalogDesignSpecies> {
  const queries = currentCanvasQuerySurface.value
  const revision = queries?.revision.scene.value
  const speciesRevision = queries?.revision.plantNames.value
  const activeLocale = locale.value
  return useMemo(() => {
    if (!queries) return NO_SPECIES
    const entries = buildSpeciesKey(queries.getSceneSnapshot(), queries.getSpeciesCache(), NO_NAMES, NO_FALLBACKS, activeLocale)
    if (entries.length === 0) return NO_SPECIES
    return new Map(entries.flatMap((entry) => {
      const appearance = entry.appearances[0]
      return appearance
        ? [[entry.canonicalName, { code: entry.code, count: entry.count, symbol: appearance.symbol, color: appearance.color }] as const]
        : []
    }))
  }, [queries, revision, speciesRevision, activeLocale])
}
