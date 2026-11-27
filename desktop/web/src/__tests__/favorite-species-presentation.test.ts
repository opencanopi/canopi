// @vitest-environment jsdom
//
// Contracts §17: Desktop FavoritesPanel and Web WebSpeciesCatalogPanel (favorites mode)
// share the same plant-finder pipeline (`buildFavoriteFinderSpecies` + `usePlantFinder`
// + `rankFavoriteSpecies`), matching accented names, typos, catalog names in every
// language, and Design species codes in identical order.

import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesListItem } from '../types/species'
import type { SavedObjectStampLibraryView } from '../app/saved-object-stamps/workbench'

const CATALOG_NAMES_BY_LOCALE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'Prunus persica': 'Peach',
    'Malus domestica': 'Apple',
    'Castanea sativa': 'Sweet chestnut',
  },
  fr: {
    'Prunus persica': 'Pêcher',
    'Malus domestica': 'Pommier',
    'Castanea sativa': 'Châtaignier',
  },
  de: {
    'Prunus persica': 'Pfirsich',
    'Malus domestica': 'Apfel',
    'Castanea sativa': 'Edelkastanie',
  },
}

const makeItem = (canonical_name: string, common_name: string): SpeciesListItem => ({
  canonical_name,
  slug: canonical_name.toLowerCase().replace(/\s+/g, '-'),
  common_name,
  common_name_2: null,
  matched_common_name: null,
  is_name_fallback: false,
  family: 'Rosaceae',
  genus: canonical_name.split(' ')[0] ?? null,
  height_max_m: null,
  hardiness_zone_min: null,
  hardiness_zone_max: null,
  growth_rate: null,
  stratum: null,
  habit: 'tree',
  climate_zones: [],
  life_cycles: [],
  edibility_rating: null,
  medicinal_rating: null,
  width_max_m: null,
  is_favorite: true,
})

const FAVORITES: readonly SpeciesListItem[] = [
  makeItem('Prunus persica', 'Pêcher'),
  makeItem('Malus domestica', 'Pommier'),
  makeItem('Castanea sativa', 'Châtaignier'),
]

const workbenchMocks = vi.hoisted(() => ({
  favorites: null as ReturnType<typeof signal<{ items: readonly SpeciesListItem[]; loading: boolean; failed: boolean }>> | null,
  sidebar: null as ReturnType<typeof signal<{ recentlyViewed: readonly SpeciesListItem[]; recentlyViewedLoading: boolean; recentlyViewedFailed: boolean }>> | null,
  detail: null as ReturnType<typeof signal<{ canonicalName: string | null; detail: null; loading: boolean; error: null }>> | null,
  selectedCanonicalName: null as ReturnType<typeof signal<string | null>> | null,
}))

vi.mock('../app/plant-browser', () => ({
  speciesCatalogWorkbench: {
    get favorites() {
      return workbenchMocks.favorites!
    },
    get sidebar() {
      return workbenchMocks.sidebar!
    },
    get detail() {
      return workbenchMocks.detail!
    },
    get selectedCanonicalName() {
      return workbenchMocks.selectedCanonicalName!
    },
    mount: () => () => undefined,
    openDetail: () => undefined,
    closeDetail: () => undefined,
    toggleFavorite: async () => undefined,
    retrySidebarLists: async () => undefined,
    resolveCommonNames: async (canonicalNames: readonly string[], requestedLocale: string) => {
      const table = CATALOG_NAMES_BY_LOCALE[requestedLocale] ?? {}
      const names: Record<string, string> = {}
      for (const name of canonicalNames) {
        if (table[name]) names[name] = table[name]!
      }
      return names
    },
    resolveDisplayNames: async (canonicalNames: readonly string[], requestedLocale: string) => {
      const table = CATALOG_NAMES_BY_LOCALE[requestedLocale] ?? {}
      const names: Record<string, string> = {}
      for (const name of canonicalNames) {
        if (table[name]) names[name] = table[name]!
      }
      return { names, englishFallbacks: [] }
    },
  },
}))

vi.mock('../app/saved-object-stamps', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    savedObjectStampWorkbench: {
      library: signal<SavedObjectStampLibraryView>({ items: [], loading: false, revision: 0 }),
      selection: signal({ canSaveSelection: false, selectionLabel: null, objectCount: 0, plantCount: 0, zoneCount: 0, annotationCount: 0, guideCount: 0 }),
      loadLibrary: async () => undefined,
      renameStamp: async () => null,
      deleteStamp: async () => false,
      reorderStamps: async () => undefined,
    },
  }
})

import { FavoritesPanel } from '../components/panels/FavoritesPanel'
import { WebSpeciesCatalogPanel } from '../editions/web/WebSpeciesCatalogPanel'
import { setCurrentCanvasSession } from '../canvas/session'
import type { CanvasRuntimeSurfaces } from '../canvas/runtime/runtime'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { locale } from '../app/settings/state'

const desktopRoot = document.createElement('div')
const webRoot = document.createElement('div')

function renderedCanonicalOrder(root: HTMLElement): string[] {
  const text = root.textContent ?? ''
  return FAVORITES
    .map((item) => ({ name: item.canonical_name, index: text.indexOf(item.canonical_name) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.name)
}

async function typeSearch(root: HTMLElement, query: string): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('input[type="search"], input[role="searchbox"], input')!
  expect(input).not.toBeNull()
  await act(async () => {
    input.value = query
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

let previousLocale: typeof locale.value = 'en'

beforeEach(() => {
  previousLocale = locale.value
  locale.value = 'fr'
  workbenchMocks.favorites = signal({ items: FAVORITES, loading: false, failed: false })
  workbenchMocks.sidebar = signal({ recentlyViewed: [], recentlyViewedLoading: false, recentlyViewedFailed: false })
  workbenchMocks.detail = signal({ canonicalName: null, detail: null, loading: false, error: null })
  workbenchMocks.selectedCanonicalName = signal<string | null>(null)
  const queries = createTestCanvasQuerySurface({
    scene: {
      ...createDefaultScenePersistedState(),
      plantSpeciesCodes: {
        'Malus domestica': 'MD',
        'Prunus persica': 'PP',
        'Castanea sativa': 'CS',
      },
    },
  })
  setCurrentCanvasSession({ queries } as unknown as CanvasRuntimeSurfaces)
  document.body.append(desktopRoot, webRoot)
})

afterEach(() => {
  render(null, desktopRoot)
  render(null, webRoot)
  desktopRoot.remove()
  webRoot.remove()
  setCurrentCanvasSession(null)
  locale.value = previousLocale
})

describe('favorite species list search parity (contracts §17)', () => {
  it('matches Common, Canonical, typo/accented, cross-language, and species-code queries identically in Desktop FavoritesPanel and Web WebSpeciesCatalogPanel (contracts §17)', async () => {
    await act(async () => {
      render(h(FavoritesPanel, {}), desktopRoot)
      render(h(WebSpeciesCatalogPanel, { mode: 'favorites' }), webRoot)
      await Promise.resolve()
      await Promise.resolve()
    })

    const cases: readonly [string, readonly string[]][] = [
      // Accented common name in interface language (French)
      ['pecher', ['Prunus persica']],
      // Canonical name (case-insensitive)
      ['MALUS', ['Malus domestica']],
      // 1-edit typo on French common name ("Pommier")
      ['Pomier', ['Malus domestica']],
      // English catalog name in a French interface
      ['apple', ['Malus domestica']],
      // German catalog name in a French interface
      ['Edelkastanie', ['Castanea sativa']],
      // Species code from open Design on both Desktop and Web
      ['MD', ['Malus domestica']],
    ]

    for (const [query, expected] of cases) {
      await typeSearch(desktopRoot, query)
      await typeSearch(webRoot, query)
      const desktopOrder = renderedCanonicalOrder(desktopRoot)
      const webOrder = renderedCanonicalOrder(webRoot)
      expect(desktopOrder, `Desktop query "${query}"`).toEqual(expected)
      expect(webOrder, `Web query "${query}"`).toEqual(desktopOrder)
    }
  })
})
