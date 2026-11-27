export type SpeciesCacheEntry = Record<string, unknown>

/** What the app's catalog shows for species in one language; the runtime never resolves names itself. */
export interface CanvasSpeciesDisplayNames {
  /** Common Name in `locale`, or the English one for the species in `englishFallbacks`. */
  readonly names: Readonly<Record<string, string>>
  readonly englishFallbacks: readonly string[]
}

export type CanvasSpeciesDisplayNameResolver = (
  canonicalNames: readonly string[],
  locale: string,
) => Promise<CanvasSpeciesDisplayNames>

export interface CanvasPlantLabelSource {
  /** Names in `locale`; null when the catalog has none in that language. */
  getLocaleSnapshot(locale: string): ReadonlyMap<string, string | null>
  /**
   * English catalog names for the species with no name in `locale`; empty in
   * English. Lists show these, marked, before a Design's stored name.
   */
  getEnglishFallbackSnapshot(locale: string): ReadonlyMap<string, string>
  ensureEntries(canonicalNames: string[], locale: string): Promise<boolean>
}

export interface CanvasSpeciesPresentationCache {
  getCache(): Map<string, SpeciesCacheEntry>
  ensureEntries(canonicalNames: string[], activeLocale: string): Promise<boolean>
}

export function createDetachedCanvasPlantLabelSource(): CanvasPlantLabelSource {
  return {
    getLocaleSnapshot: () => new Map(),
    getEnglishFallbackSnapshot: () => new Map(),
    ensureEntries: async () => false,
  }
}

export function createDetachedCanvasSpeciesPresentationCache(): CanvasSpeciesPresentationCache {
  const cache = new Map<string, SpeciesCacheEntry>()
  return {
    getCache: () => cache,
    ensureEntries: async (canonicalNames) => {
      const missing = canonicalNames.filter((name) => name && !cache.has(name))
      for (const canonicalName of missing) {
        cache.set(canonicalName, {
          canonical_name: canonicalName,
        })
      }
      return missing.length > 0
    },
  }
}
