import type { SpeciesDetail } from '../../generated/contracts'
import type {
  CanvasSpeciesPresentationCache,
  SpeciesCacheEntry,
} from '../../canvas/runtime/presentation-data'

export type { SpeciesCacheEntry } from '../../canvas/runtime/presentation-data'

export interface SpeciesCacheLoader {
  readonly getSpeciesBatch: (canonicalNames: string[], locale: string) => Promise<SpeciesDetail[]>
  readonly isPlantDbUnavailableError: (error: unknown) => boolean
}

const DEFAULT_LOADER: SpeciesCacheLoader = {
  getSpeciesBatch: async () => [],
  isPlantDbUnavailableError: () => false,
}

const loaderSlot: { current: SpeciesCacheLoader } = { current: DEFAULT_LOADER }

/** Installs the Desktop species-cache loader (called by editions/desktop/boot.ts). */
export function installSpeciesCacheLoader(loader: SpeciesCacheLoader): () => void {
  const previous = loaderSlot.current
  loaderSlot.current = loader
  return () => {
    if (loaderSlot.current === loader) loaderSlot.current = previous
  }
}

export class CanvasSpeciesCache implements CanvasSpeciesPresentationCache {
  private readonly _cache = new Map<string, SpeciesCacheEntry>()
  private readonly _loader: SpeciesCacheLoader | null

  constructor(loader: SpeciesCacheLoader | null = null) {
    this._loader = loader
  }

  getCache(): Map<string, SpeciesCacheEntry> {
    return this._cache
  }

  async ensureEntries(
    canonicalNames: string[],
    activeLocale: string,
  ): Promise<boolean> {
    const missingNames = [...new Set(canonicalNames.filter((name) => name && !this._cache.has(name)))]
    if (missingNames.length === 0) return false

    const loader = this._loader ?? loaderSlot.current
    let details: SpeciesDetail[]
    try {
      details = await loader.getSpeciesBatch(missingNames, activeLocale)
    } catch (error) {
      if (!loader.isPlantDbUnavailableError(error)) {
        throw error
      }
      for (const canonicalName of missingNames) {
        this._cache.set(canonicalName, {
          canonical_name: canonicalName,
        })
      }
      return true
    }
    const detailByName = new Map(
      details.map((detail) => [detail.canonical_name, detail as unknown as SpeciesCacheEntry]),
    )

    for (const canonicalName of missingNames) {
      const detail = detailByName.get(canonicalName) ?? { canonical_name: canonicalName }
      this._cache.set(canonicalName, { ...detail })
    }

    return true
  }
}
