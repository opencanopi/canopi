import { createRequire } from 'node:module'
import {
  createDuckDB,
  NODE_RUNTIME,
  VoidLogger,
  type DuckDBBundles,
} from '@duckdb/duckdb-wasm/blocking'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEmptySpeciesFilter } from '../app/plant-browser'
import { createDuckDbReducedSpeciesCatalogReader } from '../web/duckdb-wasm-catalog'
import { validWebCatalogManifest } from './fixtures/web-catalog-manifest'

const SPECIES_PARQUET = "read_parquet('species/species-0000.parquet')"
const FRENCH_NAMES_PARQUET = "read_parquet('names/names-fr.parquet')"
const ENGLISH_NAMES_PARQUET = "read_parquet('names/names-en.parquet')"
const IMAGES_PARQUET = "read_parquet('images/images-0000.parquet')"

describe('DuckDB-WASM Species Catalog executable SQL', () => {
  it('canopi-f47t.52.228.33: the engine is created before the tests, never inside one test\'s timeout', () => {
    expect(engine).not.toBeNull()
  })

  it.each(['apple', 'pear'])('does not match another locale\'s source Common Name: %s', async (text) => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      const result = await reader.searchSpecies({
        text,
        filters: createEmptySpeciesFilter(),
        cursor: null,
        limit: 10,
        sort: 'Relevance',
        locale: 'fr',
        include_total: true,
      }, new Set())

      expect(result).toMatchObject({ items: [], total_estimate: 0, next_cursor: null })
    } finally {
      await reader.dispose()
    }
  })

  it('executes detail hydration and locale-name ordering in real DuckDB-WASM', async () => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      await expect(reader.getSpeciesDetail('Malus domestica', 'fr')).resolves.toMatchObject({
        canonical_name: 'Malus domestica',
        common_name: 'A',
        common_names: ['A', 'a', 'Á', '𐀀', 'zz'],
        image: {
          url: 'https://images.example.test/apple.jpg',
        },
      })

      const request = {
        text: 'ar',
        filters: createEmptySpeciesFilter(),
        cursor: null,
        limit: 1,
        sort: 'Relevance' as const,
        locale: 'fr',
        include_total: false,
      }
      const firstPage = await reader.searchSpecies(request, new Set())
      const secondPage = await reader.searchSpecies({
        ...request,
        cursor: firstPage.next_cursor,
      }, new Set())
      const thirdPage = await reader.searchSpecies({
        ...request,
        cursor: secondPage.next_cursor,
      }, new Set())

      expect(firstPage.items.map((item) => item.canonical_name)).toEqual(['Prunus armeniaca'])
      expect(firstPage.next_cursor).toBe('offset:1')
      expect(secondPage.items.map((item) => item.canonical_name)).toEqual(['Ar alpha'])
      expect(secondPage.next_cursor).toBe('offset:2')
      expect(thirdPage.items.map((item) => item.canonical_name)).toEqual(['Ar beta'])
      expect(thirdPage.next_cursor).toBeNull()
      expect([firstPage, secondPage, thirdPage].map((page) => page.total_estimate)).toEqual([0, 0, 0])
    } finally {
      await reader.dispose()
    }
  })

  it('keeps detail Common Names empty when the selected locale has none', async () => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      await expect(reader.getSpeciesDetail('Pyrus communis', 'fr')).resolves.toMatchObject({
        canonical_name: 'Pyrus communis',
        common_name: null,
        common_names: [],
      })
    } finally {
      await reader.dispose()
    }
  })

  it('uses Canonical Name fallback for search and saved-list rows without local names', async () => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      const favorites = new Set(['Pyrus communis'])
      const request = {
        text: 'pyrus',
        filters: createEmptySpeciesFilter(),
        cursor: null,
        limit: 10,
        sort: 'Relevance' as const,
        locale: 'fr',
        include_total: true,
      }
      const result = await reader.searchSpecies(request, favorites)
      const savedItems = await reader.listSpeciesByCanonicalNames(['Pyrus communis'], 'fr', favorites)
      const expectedItem = {
        canonical_name: 'Pyrus communis',
        common_name: null,
        matched_common_name: null,
        is_name_fallback: true,
        is_favorite: true,
      }

      expect(result).toMatchObject({ items: [expectedItem], total_estimate: 1, next_cursor: null })
      expect(savedItems).toMatchObject([expectedItem])
    } finally {
      await reader.dispose()
    }
  })

  it('browses species named in the interface language first under Recommended', async () => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      const browse = (sort: 'Recommended' | 'Name') => reader.searchSpecies({
        text: '',
        filters: createEmptySpeciesFilter(),
        cursor: null,
        limit: 10,
        sort,
        locale: 'en',
        include_total: true,
      }, new Set())
      const names = async (sort: 'Recommended' | 'Name') => (await browse(sort)).items.map((item) => item.canonical_name)

      await expect(names('Recommended')).resolves.toEqual(['Malus domestica', 'Pyrus communis', 'Ar alpha', 'Ar beta', 'Prunus armeniaca'])
      await expect(names('Name')).resolves.toEqual(['Ar alpha', 'Ar beta', 'Malus domestica', 'Prunus armeniaca', 'Pyrus communis'])
    } finally {
      await reader.dispose()
    }
  })

  it.each([
    { locale: 'en', text: 'pear', canonicalName: 'Pyrus communis', commonName: 'Pear', matchedName: 'Pear' },
    { locale: 'fr', text: 'arbre', canonicalName: 'Prunus armeniaca', commonName: 'Arbre fruitier', matchedName: 'Arbre fruitier' },
    { locale: 'fr', text: 'zz', canonicalName: 'Malus domestica', commonName: 'A', matchedName: 'zz' },
  ])('preserves $locale primary and alternate Common Name matches for $text', async ({
    locale, text, canonicalName, commonName, matchedName,
  }) => {
    const duckdb = await createExecutableDuckDb()
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://catalog.example.test/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => duckdb,
    })

    try {
      const result = await reader.searchSpecies({
        text,
        filters: createEmptySpeciesFilter(),
        cursor: null,
        limit: 10,
        sort: 'Relevance',
        locale,
        include_total: true,
      }, new Set())

      expect(result).toMatchObject({
        items: [{
          canonical_name: canonicalName,
          common_name: commonName,
          matched_common_name: matchedName,
          is_name_fallback: false,
        }],
        total_estimate: 1,
        next_cursor: null,
      })
      await expect(reader.getSpeciesDetail(canonicalName, locale)).resolves.toMatchObject({
        canonical_name: canonicalName,
        common_name: commonName,
        common_names: expect.arrayContaining([matchedName]),
      })
    } finally {
      await reader.dispose()
    }
  })
})

/**
 * One real DuckDB-WASM instance for the whole file, created in `beforeAll`
 * under its own budget: instantiating the module is the slow part (seconds
 * under whole-suite load) and must not spend the first test's timeout. Every
 * test reads only inline fixtures, so a fresh connection per reader keeps
 * them independent.
 */
const ENGINE_BUDGET_MS = 60_000
let engine: Awaited<ReturnType<typeof createDuckDB>> | null = null

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const bundles: DuckDBBundles = {
    mvp: {
      mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
      mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'),
      mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js'),
    },
  }
  const bindings = await createDuckDB(bundles, new VoidLogger(), NODE_RUNTIME)
  await bindings.instantiate(() => {})
  bindings.open({})
  engine = bindings
}, ENGINE_BUDGET_MS)

afterAll(() => {
  engine?.reset()
  engine = null
})

async function createExecutableDuckDb() {
  if (!engine) throw new Error('The DuckDB-WASM engine was not created in beforeAll.')
  const connection = engine.connect()

  return {
    connect: () => ({
      query: (sql: string) => connection.query(withInlineCatalogFixtures(sql)),
      close: () => connection.close(),
    }),
    registerFileURL: () => {},
    terminate: () => connection.close(),
  }
}

function withInlineCatalogFixtures(sql: string): string {
  return sql
    .split(SPECIES_PARQUET).join(SPECIES_VALUES)
    .split(FRENCH_NAMES_PARQUET).join(FRENCH_NAME_VALUES)
    .split(ENGLISH_NAMES_PARQUET).join(ENGLISH_NAME_VALUES)
    .split(IMAGES_PARQUET).join(IMAGE_VALUES)
}

const SPECIES_VALUES = `(
  SELECT * FROM (VALUES
    (
      'species-apple'::VARCHAR,
      'malus-domestica'::VARCHAR,
      'Malus domestica'::VARCHAR,
      'Apple'::VARCHAR,
      'malus domestica'::VARCHAR,
      'apple'::VARCHAR,
      '["Temperate"]'::VARCHAR,
      'Tree'::VARCHAR,
      'Tree'::VARCHAR,
      '["Perennial"]'::VARCHAR
    ),
    (
      'species-apricot'::VARCHAR,
      'prunus-armeniaca'::VARCHAR,
      'Prunus armeniaca'::VARCHAR,
      'Apricot'::VARCHAR,
      'prunus armeniaca'::VARCHAR,
      'apricot'::VARCHAR,
      '["Temperate"]'::VARCHAR,
      'Tree'::VARCHAR,
      'Tree'::VARCHAR,
      '["Perennial"]'::VARCHAR
    ),
    (
      'species-pear'::VARCHAR,
      'pyrus-communis'::VARCHAR,
      'Pyrus communis'::VARCHAR,
      'Pear'::VARCHAR,
      'pyrus communis'::VARCHAR,
      'pear'::VARCHAR,
      '["Temperate"]'::VARCHAR,
      'Tree'::VARCHAR,
      'Tree'::VARCHAR,
      '["Perennial"]'::VARCHAR
    ),
    (
      'species-ar-alpha'::VARCHAR,
      'ar-alpha'::VARCHAR,
      'Ar alpha'::VARCHAR,
      NULL::VARCHAR,
      'ar alpha'::VARCHAR,
      NULL::VARCHAR,
      '[]'::VARCHAR,
      NULL::VARCHAR,
      NULL::VARCHAR,
      '[]'::VARCHAR
    ),
    (
      'species-ar-beta'::VARCHAR,
      'ar-beta'::VARCHAR,
      'Ar beta'::VARCHAR,
      NULL::VARCHAR,
      'ar beta'::VARCHAR,
      NULL::VARCHAR,
      '[]'::VARCHAR,
      NULL::VARCHAR,
      NULL::VARCHAR,
      '[]'::VARCHAR
    )
  ) AS fixture(
    id,
    slug,
    canonical_name,
    common_name,
    normalized_canonical_name,
    normalized_common_name,
    climate_zones,
    habit,
    growth_form,
    life_cycles
  )
)`

const FRENCH_NAME_VALUES = `(
  SELECT * FROM (VALUES
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, 'zz'::VARCHAR, 'zz'::VARCHAR, 'false'::VARCHAR, '0'::VARCHAR),
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, '𐀀'::VARCHAR, '𐀀'::VARCHAR, 'false'::VARCHAR, '0'::VARCHAR),
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, 'Á'::VARCHAR, 'a'::VARCHAR, 'false'::VARCHAR, '0'::VARCHAR),
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, 'a'::VARCHAR, 'a'::VARCHAR, 'false'::VARCHAR, '0'::VARCHAR),
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, 'A'::VARCHAR, 'a'::VARCHAR, 'false'::VARCHAR, '0'::VARCHAR),
    ('species-apple'::VARCHAR, 'fr'::VARCHAR, 'A'::VARCHAR, 'a'::VARCHAR, 'true'::VARCHAR, '5'::VARCHAR),
    ('species-apricot'::VARCHAR, 'fr'::VARCHAR, 'Arbre fruitier'::VARCHAR, 'arbre fruitier'::VARCHAR, 'true'::VARCHAR, '0'::VARCHAR)
  ) AS fixture(
    species_id,
    language,
    common_name,
    normalized_name,
    is_primary,
    display_order
  )
)`

const ENGLISH_NAME_VALUES = `(
  SELECT * FROM (VALUES
    ('species-apple'::VARCHAR, 'en'::VARCHAR, 'Apple'::VARCHAR, 'apple'::VARCHAR, 'true'::VARCHAR, '0'::VARCHAR),
    ('species-pear'::VARCHAR, 'en'::VARCHAR, 'Pear'::VARCHAR, 'pear'::VARCHAR, 'true'::VARCHAR, '0'::VARCHAR)
  ) AS fixture(species_id, language, common_name, normalized_name, is_primary, display_order)
)`

const IMAGE_VALUES = `(
  SELECT * FROM (VALUES
    (
      'species-apple'::VARCHAR,
      'https://images.example.test/apple.jpg'::VARCHAR,
      NULL::VARCHAR,
      NULL::VARCHAR,
      NULL::VARCHAR,
      NULL::VARCHAR
    )
  ) AS fixture(species_id, url, source, source_page_url, credit, license)
)`
