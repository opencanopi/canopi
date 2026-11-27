import { signal, type Signal } from '@preact/signals'
import { getLocaleCommonNames, getSpeciesHabits } from '../../ipc/species'
import { speciesCatalogWorkbench, type SpeciesDisplayNameResolver } from '../plant-browser'
import type { CommonNameEntry, SpeciesDetail } from '../../types/species'

type PlantDetailLoadState = 'loading' | 'loaded' | 'error'

export interface PlantDetailController {
  detail: Signal<SpeciesDetail | null>
  loadState: Signal<PlantDetailLoadState>
  errorMessage: Signal<string | null>
  secondaryNames: Signal<CommonNameEntry[]>
  /** The English name shown, marked "(en)", when the species has none in the interface language. */
  englishName: Signal<string | null>
  /** The catalog habit key (`Tree`, `Shrub`, …) that picks the glyph of a species not in the Design. */
  habitKey: Signal<string | null>
  setTarget(canonicalName: string, locale: string): void
  retry(): void
  dispose(): void
}

interface CreatePlantDetailControllerOptions {
  loadDetail?: (canonicalName: string, locale: string) => Promise<SpeciesDetail>
  loadLocaleCommonNames?: typeof getLocaleCommonNames
  /** The catalog's display-name projection; the title's "(en)" fallback comes from it. */
  resolveDisplayNames?: SpeciesDisplayNameResolver
  loadHabits?: typeof getSpeciesHabits
}

function isFullSpeciesDetail(detail: unknown): detail is SpeciesDetail {
  return Boolean(detail && typeof detail === 'object' && 'canonical_name' in detail && !('common_names' in detail))
}

export function createPlantDetailController(
  options: CreatePlantDetailControllerOptions = {},
): PlantDetailController {
  const loadDetail = options.loadDetail
    ?? (async (canonicalName, locale) => {
      const fetched = await speciesCatalogWorkbench.fetchSpeciesDetail(canonicalName, locale)
      if (!isFullSpeciesDetail(fetched)) {
        throw new Error(`Desktop species detail unavailable for ${canonicalName}`)
      }
      return fetched
    })
  const loadLocaleCommonNames = options.loadLocaleCommonNames ?? getLocaleCommonNames
  const resolveDisplayNames = options.resolveDisplayNames
    ?? ((names, locale) => speciesCatalogWorkbench.resolveDisplayNames(names, locale))
  const loadHabits = options.loadHabits ?? getSpeciesHabits

  const detail = signal<SpeciesDetail | null>(null)
  const loadState = signal<PlantDetailLoadState>('loading')
  const errorMessage = signal<string | null>(null)
  const secondaryNames = signal<CommonNameEntry[]>([])
  const englishName = signal<string | null>(null)
  const habitKey = signal<string | null>(null)

  let currentCanonicalName = ''
  let currentLocale = ''
  let generation = 0
  let disposed = false

  function beginLoad(): void {
    if (!currentCanonicalName) return
    const requestGeneration = ++generation

    detail.value = null
    loadState.value = 'loading'
    errorMessage.value = null
    secondaryNames.value = []
    englishName.value = null
    habitKey.value = null
    const canonicalName = currentCanonicalName
    const requestLocale = currentLocale
    const isCurrent = () => !disposed && requestGeneration === generation

    void loadDetail(canonicalName, requestLocale)
      .then(async (nextDetail) => {
        if (!isCurrent()) return
        // Resolved before publishing so the title does not change under the reader.
        if (!nextDetail.common_name?.trim() && requestLocale.split('-')[0] !== 'en') {
          const display = await resolveDisplayNames([canonicalName], requestLocale).catch(() => null)
          if (!isCurrent()) return
          englishName.value = display?.englishFallbacks.includes(canonicalName) ? display.names[canonicalName] ?? null : null
        }
        detail.value = nextDetail
        loadState.value = 'loaded'
      })
      .catch((error) => {
        if (disposed || requestGeneration !== generation) return
        errorMessage.value = error instanceof Error ? error.message : String(error)
        loadState.value = 'error'
      })

    void loadLocaleCommonNames(currentCanonicalName, currentLocale)
      .then((entries) => {
        if (disposed || requestGeneration !== generation) return
        secondaryNames.value = entries
      })
      .catch(() => {
        // Secondary locale names are optional and should not block detail rendering.
      })

    void loadHabits([canonicalName])
      .then((habits) => {
        if (isCurrent()) habitKey.value = habits[canonicalName] ?? null
      })
      .catch(() => {
        // The habit only picks a glyph; the detail renders without it.
      })
  }

  function setTarget(canonicalName: string, locale: string): void {
    if (canonicalName === currentCanonicalName && locale === currentLocale) return
    currentCanonicalName = canonicalName
    currentLocale = locale
    beginLoad()
  }

  function retry(): void {
    beginLoad()
  }

  function dispose(): void {
    disposed = true
    generation += 1
  }

  return {
    detail,
    loadState,
    errorMessage,
    secondaryNames,
    englishName,
    habitKey,
    setTarget,
    retry,
    dispose,
  }
}
