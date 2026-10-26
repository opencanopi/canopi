import { resolvePlantSymbolForPlant, type PlantSymbolId } from './scene/plant-symbols'
import type { ScenePersistedState } from './scene/types'
import { resolvePlantBaseColor } from './plant-presentation'
import { normalizeHexColor } from '../plant-colors'
import { getStratumColor } from '../plants'
import type { SpeciesCacheEntry } from './species-cache'

/** A species' symbol and colour on the map. */
export interface SpeciesAppearance {
  readonly symbol: PlantSymbolId
  readonly color: string
}

/**
 * The symbol and colour a new plant of this species takes in this Design:
 * the Design's species symbol and colour, else the default symbol and the
 * stratum colour. The same rules as a placed plant without overrides. The
 * stratum is the species source's: a Favorite or recent pick has no entry in
 * the runtime's species cache, and a Design species' source reads it from there.
 */
export function speciesPlacementAppearance(
  scene: Pick<ScenePersistedState, 'plantSpeciesSymbols' | 'plantSpeciesColors'>,
  species: { readonly canonicalName: string; readonly stratum: string | null },
): SpeciesAppearance {
  return {
    symbol: resolvePlantSymbolForPlant({ canonicalName: species.canonicalName }, scene.plantSpeciesSymbols),
    color: normalizeHexColor(scene.plantSpeciesColors[species.canonicalName]) ?? getStratumColor(species.stratum),
  }
}

/**
 * Codes belong to a Design; removed species keep their reservation. The keys
 * come out sorted whatever the input order, so an unchanged Design compares
 * equal as JSON.
 */
export function allocateSpeciesCodes(
  existing: Readonly<Record<string, string>>,
  canonicalNames: Iterable<string>,
): Record<string, string> {
  const kept = new Map<string, string>()
  const used = new Set<string>()
  const names = [
    ...new Set([...Object.keys(existing), ...canonicalNames]),
  ].sort()
  for (const name of names) {
    const code = existing[name]
    if (
      typeof code === 'string' &&
      /^[A-Z]{1,6}[0-9]{0,6}$/.test(code) &&
      !used.has(code)
    ) {
      kept.set(name, code)
      used.add(code)
    }
  }
  const codes: Record<string, string> = Object.create(null)
  for (const name of names) {
    const keptCode = kept.get(name)
    if (keptCode) {
      codes[name] = keptCode
      continue
    }
    const words =
      name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .match(/[A-Z]+/g) ?? []
    const base =
      words.length > 1
        ? words[0]![0]! + words[1]!.slice(0, 2)
        : words[0]?.slice(0, 3) || 'SP'
    let code = base
    let suffix = 2
    while (used.has(code)) code = `${base}${suffix++}`
    codes[name] = code
    used.add(code)
  }
  return codes
}

export interface SpeciesFocus {
  readonly canonicalName: string | null
}

export interface SpeciesFocusCommands {
  focus(canonicalName: string | null): void
}

/** Opacity of the plants Species Focus leaves out, applied to each one as a whole. */
export const SPECIES_FOCUS_DIM_OPACITY = 0.16

export function speciesFocusOpacity(
  focus: SpeciesFocus,
  canonicalName: string,
): number {
  return focus.canonicalName && focus.canonicalName !== canonicalName ? SPECIES_FOCUS_DIM_OPACITY : 1
}

const NO_ENGLISH_FALLBACKS: ReadonlyMap<string, string> = new Map()

/**
 * The species names lists show: the name in the UI language, else the English
 * catalog name (see `CanvasQuerySurface.getEnglishFallbackNames`).
 */
export function speciesDisplayNames(
  localizedNames: ReadonlyMap<string, string | null>,
  englishFallbackNames: ReadonlyMap<string, string>,
): ReadonlyMap<string, string | null> {
  if (englishFallbackNames.size === 0) return localizedNames
  const names = new Map(localizedNames)
  for (const [canonicalName, englishName] of englishFallbackNames) {
    if (!names.get(canonicalName)) names.set(canonicalName, englishName)
  }
  return names
}

/** Whether `shownName` is the English fallback name resolved for the species. */
export function isEnglishFallbackName(
  englishFallbackNames: ReadonlyMap<string, string>,
  canonicalName: string,
  shownName: string | null | undefined,
): boolean {
  return Boolean(shownName) && englishFallbackNames.get(canonicalName) === shownName
}

export interface SpeciesKeyEntry {
  readonly canonicalName: string
  readonly commonName: string | null
  /** The common name is the English catalog name: none exists in the UI language. */
  readonly englishFallback: boolean
  readonly code: string
  readonly count: number
  readonly appearances: readonly { symbol: PlantSymbolId; color: string }[]
}

export function buildSpeciesKey(
  scene: ScenePersistedState,
  speciesCache: ReadonlyMap<string, SpeciesCacheEntry>,
  localizedNames: ReadonlyMap<string, string | null>,
  englishFallbackNames: ReadonlyMap<string, string> = NO_ENGLISH_FALLBACKS,
): SpeciesKeyEntry[] {
  const entries = new Map<
    string,
    {
      canonicalName: string
      commonName: string | null
      englishFallback: boolean
      code: string
      count: number
      appearances: { symbol: PlantSymbolId; color: string }[]
    }
  >()
  for (const plant of scene.plants) {
    let entry = entries.get(plant.canonicalName)
    if (!entry) {
      entry = {
        canonicalName: plant.canonicalName,
        commonName: localizedNames.get(plant.canonicalName)
          || englishFallbackNames.get(plant.canonicalName)
          || plant.commonName,
        englishFallback: !localizedNames.get(plant.canonicalName)
          && Boolean(englishFallbackNames.get(plant.canonicalName)),
        code: scene.plantSpeciesCodes[plant.canonicalName] ?? '',
        count: 0,
        appearances: [],
      }
      entries.set(plant.canonicalName, entry)
    }
    entry.count += 1
    const symbol = resolvePlantSymbolForPlant(plant, scene.plantSpeciesSymbols)
    const color = resolvePlantBaseColor(plant, speciesCache)
    if (
      !entry.appearances.some(
        (appearance) =>
          appearance.symbol === symbol && appearance.color === color,
      )
    )
      {entry.appearances.push({ symbol, color })}
  }
  return [...entries.values()].sort((a, b) =>
    a.canonicalName < b.canonicalName
      ? -1
      : a.canonicalName > b.canonicalName
        ? 1
        : 0,
  )
}
