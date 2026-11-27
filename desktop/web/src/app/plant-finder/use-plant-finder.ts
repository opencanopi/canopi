import { useMemo } from 'preact/hooks'
import { useCatalogNamesInEveryLanguage } from './catalog-names'
import { findPlants, type PlantFinderResult } from './matcher'
import { plantFinderRecord, type PlantFinderSpecies } from './records'

export interface FavoriteSpeciesEntry {
  readonly canonical_name: string
  readonly common_name: string | null
}

/** Builds plant-finder species inputs for a favourites list on both Desktop and Web (contracts §17). */
export function buildFavoriteFinderSpecies(
  items: readonly FavoriteSpeciesEntry[],
  codesBySpecies?: Readonly<Record<string, string>>,
): readonly PlantFinderSpecies[] {
  return items.map((item) => {
    const code = codesBySpecies?.[item.canonical_name]
    return {
      canonicalName: item.canonical_name,
      commonName: item.common_name,
      ...(code !== undefined ? { code } : {}),
    }
  })
}

/** Matches species against every name the catalog knows for them across all languages. */
function findPlantsWithCatalogNames(
  species: readonly PlantFinderSpecies[],
  query: string,
  catalogNames: (canonicalName: string) => readonly string[],
): PlantFinderResult<string> {
  const records = species.map((entry) => plantFinderRecord({
    ...entry,
    otherNames: [...(entry.otherNames ?? []), ...catalogNames(entry.canonicalName)],
  }))
  return findPlants(records, query)
}

/** Filters and ranks favourite species using a finder result, preserving match order when active. */
export function rankFavoriteSpecies<T extends FavoriteSpeciesEntry>(
  items: readonly T[],
  finder: PlantFinderResult<string>,
  predicate?: (item: T) => boolean,
): T[] {
  const shown = items.filter((item) => (
    (!predicate || predicate(item))
    && (!finder.active || finder.byKey.has(item.canonical_name))
  ))
  if (!finder.active) return shown
  const rank = new Map(finder.hits.map((hit, index) => [hit.key, index]))
  return shown.sort((left, right) => rank.get(left.canonical_name)! - rank.get(right.canonical_name)!)
}

/** Matches a list's species by every name the catalog knows for them. */
export function usePlantFinder(
  species: readonly PlantFinderSpecies[],
  query: string,
): PlantFinderResult<string> {
  const catalogNames = useCatalogNamesInEveryLanguage(species.map((entry) => entry.canonicalName))
  return useMemo(() => findPlantsWithCatalogNames(species, query, catalogNames), [species, query, catalogNames])
}
