import { describe, expect, it, vi } from 'vitest'
import { createBrowserSpeciesCatalogRuntime } from '../editions/web/species-catalog-runtime'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import type { SpeciesListItem } from '../types/species'

describe('Web Species Catalog runtime', () => {
  it('owns terminal Workbench and reader disposal behind one idempotent boundary', async () => {
    const disposeReader = vi.fn(async () => {})
    const reader = {
      searchSpecies: vi.fn(async () => ({ items: [], next_cursor: null, total_estimate: 0 })),
      listSpeciesByCanonicalNames: vi.fn(async () => []),
      getSupportedFilterFields: vi.fn(async () => []),
      getFilterOptions: vi.fn(async () => ({
        families: [],
        growth_rates: [],
        climate_zones: [],
        habits: [],
        life_cycles: [],
        sun_tolerances: [],
        soil_tolerances: [],
      })),
      getDynamicFilterOptions: vi.fn(async () => []),
      getSpeciesDetail: vi.fn(async () => null),
      dispose: disposeReader,
    }
    const runtime = createBrowserSpeciesCatalogRuntime({
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      reader,
    })
    const stop = runtime.workbench.mount()

    const firstDisposal = runtime.dispose()
    const secondDisposal = runtime.dispose()

    expect(secondDisposal).toBe(firstDisposal)
    await firstDisposal
    expect(disposeReader).toHaveBeenCalledOnce()
    reader.searchSpecies.mockClear()
    runtime.workbench.retrySearch()
    await Promise.resolve()
    expect(reader.searchSpecies).not.toHaveBeenCalled()
    stop()
  })

  it('reads catalog habits from the artifact rows for the plant finder', async () => {
    const reader = {
      searchSpecies: vi.fn(async () => ({ items: [], next_cursor: null, total_estimate: 0 })),
      listSpeciesByCanonicalNames: vi.fn(async (names: readonly string[]) => names.map((name) => ({
        canonical_name: name,
        habit: name === 'Malus domestica' ? 'Tree' : null,
      }) as unknown as SpeciesListItem)),
      getSupportedFilterFields: vi.fn(async () => []),
      getFilterOptions: vi.fn(async () => null as never),
      getDynamicFilterOptions: vi.fn(async () => []),
      getSpeciesDetail: vi.fn(async () => null),
      dispose: vi.fn(async () => {}),
    }
    const runtime = createBrowserSpeciesCatalogRuntime({
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      reader,
    })
    await expect(runtime.workbench.resolveHabits(['Malus domestica', 'Mentha spicata'])).resolves.toEqual({ 'Malus domestica': 'Tree' })
    await expect(runtime.workbench.resolveHabits([])).resolves.toEqual({})
    await runtime.dispose()
  })
})

function memoryStorage(): BrowserStorageAdapter {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
