import type { FlowerColorResolution, SpeciesDetail } from '../../generated/contracts'
import { getFlowerColorHex } from '../../canvas/plant-colors'
import type {
  CanvasSpeciesPresentationCache,
  SpeciesCacheEntry,
} from '../../canvas/runtime/presentation-data'

export type { SpeciesCacheEntry } from '../../canvas/runtime/presentation-data'

export interface SpeciesCacheLoader {
  readonly getSpeciesBatch: (canonicalNames: string[], locale: string) => Promise<SpeciesDetail[]>
  readonly getFlowerColorBatch: (canonicalNames: string[]) => Promise<FlowerColorResolution[]>
  readonly isPlantDbUnavailableError: (error: unknown) => boolean
}

const DEFAULT_LOADER: SpeciesCacheLoader = {
  getSpeciesBatch: async () => [],
  getFlowerColorBatch: async () => [],
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
    let flowerColors: FlowerColorResolution[]
    try {
      [details, flowerColors] = await Promise.all([
        loader.getSpeciesBatch(missingNames, activeLocale),
        loader.getFlowerColorBatch(missingNames),
      ])
    } catch (error) {
      if (!loader.isPlantDbUnavailableError(error)) {
        throw error
      }
      for (const canonicalName of missingNames) {
        this._cache.set(canonicalName, {
          canonical_name: canonicalName,
          resolved_flower_color: null,
          resolved_flower_color_source: 'none',
        })
      }
      return true
    }
    const detailByName = new Map(
      details.map((detail) => [detail.canonical_name, detail as unknown as SpeciesCacheEntry]),
    )
    const flowerByName = new Map(flowerColors.map((entry) => [entry.canonical_name, entry]))

    for (const canonicalName of missingNames) {
      const detail = detailByName.get(canonicalName) ?? { canonical_name: canonicalName }
      const flower = flowerByName.get(canonicalName)
      this._cache.set(canonicalName, {
        ...detail,
        resolved_flower_color: flower?.flower_color ?? null,
        resolved_flower_color_source: flower?.source ?? 'none',
      })
    }

    return true
  }

  getSuggestedPlantColor(canonicalName: string): string | null {
    const detail = this._cache.get(canonicalName)
    return getFlowerColorHex(
      (detail?.resolved_flower_color as string | null | undefined)
      ?? (detail?.flower_color as string | null | undefined),
    )
  }
}
