// In-memory Reduced Species Catalog reader: a test fake for the Web catalog
// adapters. Production reads the catalog through DuckDB-Wasm
// (src/web/duckdb-wasm-catalog.ts).
import type {
  DynamicFilterOptions,
  FilterOptions,
  SpeciesFilter,
  SpeciesListItem,
} from '../../types/species'
import type { SpeciesCatalogDetail } from '../../app/plant-browser/workbench'
import {
  admittedSpeciesSearchText,
  EMPTY_ADMITTED_SPECIES_SEARCH_TEXT,
  speciesSearchAdmission,
  type AdmittedSpeciesSearchText,
} from '../../utils/species-search-normalization'
import type {
  ReducedSpeciesCatalogReader,
  ReducedSpeciesImageRow,
  ReducedSpeciesRow,
} from '../../editions/web/reduced-species-catalog'

// 0: the whole search text; 1: a prefix; 2: every token somewhere in the name.
type SpeciesSearchMatchTier = 0 | 1 | 2

function normalizedSpeciesSearchMatchTier(
  candidate: string,
  searchText: AdmittedSpeciesSearchText,
): SpeciesSearchMatchTier | null {
  if (!searchText.text) return null
  if (candidate === searchText.text) return 0
  if (candidate.startsWith(searchText.text)) return 1
  return searchText.tokens.every((token) => candidate.includes(token)) ? 2 : null
}

interface ReducedSpeciesArtifactRow extends ReducedSpeciesRow {
  readonly normalized_canonical_name: string
  readonly normalized_common_name: string | null
}

interface ReducedSpeciesNameRow {
  readonly species_id: string
  readonly language: string
  readonly common_name: string
  readonly normalized_name: string
  readonly is_primary: boolean
  readonly display_order: number
}

export interface ReducedSpeciesCatalogData {
  readonly species: readonly ReducedSpeciesArtifactRow[]
  readonly names: readonly ReducedSpeciesNameRow[]
  readonly images: readonly ReducedSpeciesImageRow[]
}


const EMPTY_FILTER_OPTIONS: FilterOptions = {
  families: [],
  growth_rates: [],
  climate_zones: [],
  habits: [],
  life_cycles: [],
  sun_tolerances: [],
  soil_tolerances: [],
}

interface SpeciesNameIndexEntry {
  readonly primary: ReducedSpeciesNameRow | null
  readonly names: readonly ReducedSpeciesNameRow[]
}

export function createInMemoryReducedSpeciesCatalogReader(
  data: ReducedSpeciesCatalogData,
): ReducedSpeciesCatalogReader {
  const species = [...data.species].sort(compareSpeciesRows)
  const speciesByCanonicalName = new Map(species.map((row) => [row.canonical_name, row]))
  const namesByLocaleAndSpecies = buildNameIndex(data.names)
  const imagesBySpecies = buildImageIndex(data.images)
  const filterOptions = buildFilterOptions(species)

  return {
    async searchSpecies(request, favoriteNames) {
      if (speciesSearchAdmission(request.text) === 'too-short') {
        return {
          items: [],
          next_cursor: null,
          total_estimate: 0,
        }
      }
      const searchText = admittedSpeciesSearchText(request.text)
      const offset = cursorToOffset(request.cursor)
      const matched = species.filter((row) => (
        matchesSupportedFilters(row, request.filters) &&
        matchesSearchText(row, searchText, namesByLocaleAndSpecies.get(request.locale)?.get(row.id))
      ))
      if (searchText.text) {
        const localeNames = namesByLocaleAndSpecies.get(request.locale)
        matched.sort((left, right) => compareSpeciesSearchRelevance(
          left,
          right,
          searchText,
          localeNames,
        ))
      }
      const limit = Math.max(0, request.limit)
      const page = matched.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return {
        items: page.map((row) => toSpeciesListItem({
          row,
          locale: request.locale,
          favoriteNames,
          nameIndex: namesByLocaleAndSpecies,
          searchText,
        })),
        next_cursor: limit > 0 && nextOffset < matched.length ? `offset:${nextOffset}` : null,
        total_estimate: request.include_total ? matched.length : 0,
      }
    },

    async listSpeciesByCanonicalNames(canonicalNames, locale, favoriteNames) {
      return canonicalNames.flatMap((canonicalName) => {
        const row = speciesByCanonicalName.get(canonicalName)
        return row
          ? [toSpeciesListItem({
              row,
              locale,
              favoriteNames,
              nameIndex: namesByLocaleAndSpecies,
              searchText: EMPTY_ADMITTED_SPECIES_SEARCH_TEXT,
            })]
          : []
      })
    },

    async getFilterOptions() {
      return filterOptions
    },

    async getSupportedFilterFields() {
      return []
    },

    async getDynamicFilterOptions(fields, _locale) {
      return fields.flatMap((field): DynamicFilterOptions[] => {
        if (field === 'climate_zones') {
          return [categoricalDynamicFilterOptions(field, filterOptions.climate_zones)]
        }
        if (field === 'habit' || field === 'growth_form_type') {
          return [categoricalDynamicFilterOptions(field, filterOptions.habits)]
        }
        if (field === 'life_cycle') {
          return [categoricalDynamicFilterOptions(field, filterOptions.life_cycles)]
        }
        return []
      })
    },

    async getSpeciesDetail(canonicalName, locale) {
      const row = speciesByCanonicalName.get(canonicalName)
      if (!row) return null
      const localeNames = namesByLocaleAndSpecies.get(locale)?.get(row.id)
      const commonNames = detailCommonNames(row, localeNames)

      return {
        canonical_name: row.canonical_name,
        common_name: commonNames[0] ?? row.common_name,
        common_names: commonNames,
        climate_zones: [...row.climate_zones],
        habit: row.habit,
        growth_form: row.growth_form,
        life_cycles: [...row.life_cycles],
        image: detailImage(imagesBySpecies.get(row.id)?.[0] ?? null),
      }
    },
  }
}

function buildImageIndex(
  images: readonly ReducedSpeciesImageRow[],
): ReadonlyMap<string, readonly ReducedSpeciesImageRow[]> {
  const bySpecies = new Map<string, ReducedSpeciesImageRow[]>()
  for (const image of images) {
    bySpecies.set(image.species_id, [...(bySpecies.get(image.species_id) ?? []), image])
  }
  return bySpecies
}

function buildNameIndex(
  names: readonly ReducedSpeciesNameRow[],
): ReadonlyMap<string, ReadonlyMap<string, SpeciesNameIndexEntry>> {
  const byLocale = new Map<string, Map<string, ReducedSpeciesNameRow[]>>()
  for (const name of names) {
    const normalizedLocale = name.language.trim()
    if (!normalizedLocale) continue
    const bySpecies = byLocale.get(normalizedLocale) ?? new Map<string, ReducedSpeciesNameRow[]>()
    const speciesNames = bySpecies.get(name.species_id) ?? []
    bySpecies.set(name.species_id, [...speciesNames, name])
    byLocale.set(normalizedLocale, bySpecies)
  }

  return new Map(
    [...byLocale.entries()].map(([locale, bySpecies]) => [
      locale,
      new Map(
        [...bySpecies.entries()].map(([speciesId, speciesNames]) => {
          const sorted = [...speciesNames].sort(compareNameRows)
          return [speciesId, { primary: sorted[0] ?? null, names: sorted }]
        }),
      ),
    ]),
  )
}

function compareSpeciesRows(left: ReducedSpeciesRow, right: ReducedSpeciesRow): number {
  return compareBinaryText(left.canonical_name, right.canonical_name) ||
    compareBinaryText(left.id, right.id)
}

function compareNameRows(left: ReducedSpeciesNameRow, right: ReducedSpeciesNameRow): number {
  if (left.display_order !== right.display_order) return left.display_order - right.display_order
  if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1
  const leftLength = unicodeScalarLength(left.common_name)
  const rightLength = unicodeScalarLength(right.common_name)
  if (leftLength !== rightLength) {
    return leftLength - rightLength
  }
  return compareBinaryText(left.common_name, right.common_name)
}

function detailCommonNames(
  row: ReducedSpeciesRow,
  localeNames: SpeciesNameIndexEntry | undefined,
): string[] {
  const names = localeNames?.names.map((name) => name.common_name) ?? compact([row.common_name])
  return [...new Set(names)]
}

function detailImage(image: ReducedSpeciesImageRow | null): SpeciesCatalogDetail['image'] {
  if (!image) return null
  return {
    url: image.url,
    source: image.source,
    source_page_url: image.source_page_url,
    credit: image.credit,
    license: image.license,
  }
}

function matchesSearchText(
  row: ReducedSpeciesArtifactRow,
  searchText: AdmittedSpeciesSearchText,
  localeNames: SpeciesNameIndexEntry | undefined,
): boolean {
  if (!searchText.text) return true
  if (normalizedSpeciesSearchMatchTier(row.normalized_canonical_name, searchText) !== null) return true
  if (normalizedSpeciesSearchMatchTier(row.normalized_common_name ?? '', searchText) !== null) {
    return true
  }
  return localeNames?.names.some((name) => (
    normalizedSpeciesSearchMatchTier(name.normalized_name, searchText) !== null
  )) ?? false
}

function matchesSupportedFilters(row: ReducedSpeciesRow, filters: SpeciesFilter): boolean {
  return matchesAny(row.climate_zones, filters.climate_zones) &&
    matchesAny([...compact([row.habit, row.growth_form])], filters.habit) &&
    matchesAny(row.life_cycles, filters.life_cycle)
}

function matchesAny(values: readonly string[], requested: readonly string[] | null): boolean {
  if (requested === null || requested.length === 0) return true
  const valueSet = new Set(values)
  return requested.some((value) => valueSet.has(value))
}

function toSpeciesListItem({
  row,
  locale,
  favoriteNames,
  nameIndex,
  searchText,
}: {
  readonly row: ReducedSpeciesArtifactRow
  readonly locale: string
  readonly favoriteNames: ReadonlySet<string>
  readonly nameIndex: ReadonlyMap<string, ReadonlyMap<string, SpeciesNameIndexEntry>>
  readonly searchText: AdmittedSpeciesSearchText
}): SpeciesListItem {
  const localeNames = nameIndex.get(locale)?.get(row.id)
  const matchedName = searchText.text
    ? bestMatchingName(localeNames, searchText)?.name ?? null
    : null
  const localizedCommonName = localeNames?.primary?.common_name ?? row.common_name

  return {
    canonical_name: row.canonical_name,
    slug: row.slug,
    common_name: localizedCommonName,
    common_name_2: null,
    matched_common_name: matchedName?.common_name ?? null,
    is_name_fallback: localizedCommonName === null,
    family: null,
    genus: null,
    height_max_m: null,
    hardiness_zone_min: null,
    hardiness_zone_max: null,
    growth_rate: null,
    stratum: null,
    habit: null,
    climate_zones: [...row.climate_zones],
    life_cycles: [...row.life_cycles],
    edibility_rating: null,
    medicinal_rating: null,
    width_max_m: null,
    is_favorite: favoriteNames.has(row.canonical_name),
  }
}

interface RankedSpeciesName {
  readonly name: ReducedSpeciesNameRow
  readonly tier: SpeciesSearchMatchTier
}

function bestMatchingName(
  localeNames: SpeciesNameIndexEntry | undefined,
  searchText: AdmittedSpeciesSearchText,
): RankedSpeciesName | null {
  let best: RankedSpeciesName | null = null
  for (const name of localeNames?.names ?? []) {
    const tier = normalizedSpeciesSearchMatchTier(name.normalized_name, searchText)
    if (tier === null) continue
    if (!best || tier < best.tier || (tier === best.tier && compareNameRows(name, best.name) < 0)) {
      best = { name, tier }
    }
  }
  return best
}

function compareSpeciesSearchRelevance(
  left: ReducedSpeciesArtifactRow,
  right: ReducedSpeciesArtifactRow,
  searchText: AdmittedSpeciesSearchText,
  localeNames: ReadonlyMap<string, SpeciesNameIndexEntry> | undefined,
): number {
  const leftRank = speciesSearchRelevance(left, searchText, localeNames?.get(left.id))
  const rightRank = speciesSearchRelevance(right, searchText, localeNames?.get(right.id))
  return leftRank.group - rightRank.group ||
    leftRank.matchedNameTier - rightRank.matchedNameTier ||
    leftRank.primaryDisplayOrder - rightRank.primaryDisplayOrder ||
    leftRank.primaryNameLength - rightRank.primaryNameLength ||
    compareBinaryText(left.canonical_name, right.canonical_name) ||
    compareBinaryText(left.id, right.id)
}

interface SpeciesSearchRelevance {
  readonly group: number
  readonly matchedNameTier: number
  readonly primaryDisplayOrder: number
  readonly primaryNameLength: number
}

function speciesSearchRelevance(
  row: ReducedSpeciesArtifactRow,
  searchText: AdmittedSpeciesSearchText,
  localeNames: SpeciesNameIndexEntry | undefined,
): SpeciesSearchRelevance {
  const primary = localeNames?.primary ?? null
  const primaryTier = primary
    ? normalizedSpeciesSearchMatchTier(primary.normalized_name, searchText)
    : null
  const matchedName = bestMatchingName(localeNames, searchText)
  const canonicalTier = normalizedSpeciesSearchMatchTier(row.normalized_canonical_name, searchText)
  const group = primaryTier !== null
    ? primaryTier
    : matchedName
      ? 3
      : canonicalTier !== null
        ? 4
        : 5
  return {
    group,
    matchedNameTier: matchedName?.tier ?? Number.MAX_SAFE_INTEGER,
    primaryDisplayOrder: primary?.display_order ?? Number.MAX_SAFE_INTEGER,
    primaryNameLength: primary ? unicodeScalarLength(primary.common_name) : Number.MAX_SAFE_INTEGER,
  }
}

function unicodeScalarLength(value: string): number {
  let length = 0
  for (const _scalar of value) length += 1
  return length
}

function compareBinaryText(left: string, right: string): number {
  // DuckDB's binary UTF-8 order is scalar order for well-formed catalog text.
  let leftOffset = 0
  let rightOffset = 0
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftScalar = left.codePointAt(leftOffset)!
    const rightScalar = right.codePointAt(rightOffset)!
    if (leftScalar !== rightScalar) return leftScalar < rightScalar ? -1 : 1
    leftOffset += leftScalar > 0xffff ? 2 : 1
    rightOffset += rightScalar > 0xffff ? 2 : 1
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0
}

function buildFilterOptions(species: readonly ReducedSpeciesRow[]): FilterOptions {
  return {
    ...EMPTY_FILTER_OPTIONS,
    climate_zones: sortedUnique(species.flatMap((row) => row.climate_zones)),
    habits: sortedUnique(species.flatMap((row) => compact([row.habit, row.growth_form]))),
    life_cycles: sortedUnique(species.flatMap((row) => row.life_cycles)),
  }
}

function categoricalDynamicFilterOptions(
  field: string,
  values: readonly string[],
): DynamicFilterOptions {
  return {
    field,
    field_type: 'categorical',
    values: values.map((value) => ({ value, label: value })),
    range: null,
  }
}

function cursorToOffset(cursor: string | null): number {
  if (cursor === null) return 0
  const match = /^offset:(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : 0
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}
