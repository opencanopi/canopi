import { describe, expect, it, vi } from 'vitest'
import { createEmptySpeciesFilter } from '../app/plant-browser'
import { SPECIES_SEARCH_NORMALIZATION_CORPUS } from '../generated/species-search-normalization'
import { createDuckDbReducedSpeciesCatalogReader } from '../editions/web/duckdb-wasm-catalog'
import type { SpeciesSearchRequest } from '../types/species'
import { validWebCatalogManifest } from './fixtures/web-catalog-manifest'

describe('DuckDB-WASM reduced Species Catalog reader', () => {
  it('retries initialization after a transient manifest fetch failure', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const fetchJson = vi.fn()
      .mockRejectedValueOnce(new Error('catalog temporarily unavailable'))
      .mockResolvedValue(validWebCatalogManifest())
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson,
      createDatabase: async () => database,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('temporarily unavailable')
    await expect(reader.getSupportedFilterFields()).resolves.toContain('climate_zones')

    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(database.connect).toHaveBeenCalledOnce()
  })

  it('terminates a database when connection acquisition fails', async () => {
    const database = {
      connect: vi.fn(async () => {
        throw new Error('connection failed')
      }),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('connection failed')

    expect(database.terminate).toHaveBeenCalledOnce()
    expect(database.registerFileURL).not.toHaveBeenCalled()
  })

  it('rolls back failed asset registration before reacquiring a fresh database', async () => {
    const failedConnection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const failedDatabase = {
      connect: vi.fn(async () => failedConnection),
      registerFileURL: vi.fn(async () => {
        throw new Error('asset registration failed')
      }),
      terminate: vi.fn(async () => {}),
    }
    const readyConnection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const readyDatabase = {
      connect: vi.fn(async () => readyConnection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const createDatabase = vi.fn()
      .mockResolvedValueOnce(failedDatabase)
      .mockResolvedValueOnce(readyDatabase)
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('asset registration failed')
    await expect(reader.getSupportedFilterFields()).resolves.toContain('climate_zones')

    expect(failedConnection.close).toHaveBeenCalledOnce()
    expect(failedDatabase.terminate).toHaveBeenCalledOnce()
    expect(createDatabase).toHaveBeenCalledTimes(2)
  })

  it('waits for every base shard registration before rolling back a failed opening', async () => {
    const siblingRegistration = deferred<void>()
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (name === 'species/species-0000.parquet') {
          throw new Error('first shard registration failed')
        }
        if (name === 'species/species-0001.parquet') {
          await siblingRegistration.promise
        }
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => manifestWithShards('species', [
        'species/species-0000.parquet',
        'species/species-0001.parquet',
      ]),
      createDatabase: async () => database,
    })

    const opening = reader.getSupportedFilterFields()
    await vi.waitFor(() => expect(database.registerFileURL).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(connection.close).not.toHaveBeenCalled()
    expect(database.terminate).not.toHaveBeenCalled()

    siblingRegistration.resolve(undefined)
    await expect(opening).rejects.toThrow('first shard registration failed')
    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('preserves the opening error when rollback also fails', async () => {
    const openingError = new Error('asset registration failed')
    const closeError = new Error('connection close failed')
    const terminationError = new Error('database termination failed')
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {
        throw closeError
      }),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {
        throw openingError
      }),
      terminate: vi.fn(async () => {
        throw terminationError
      }),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    const error = await reader.getSupportedFilterFields().catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      message: expect.stringContaining('asset registration failed'),
      cause: openingError,
      cleanupErrors: [closeError, terminationError],
    })
    await expect(reader.getSupportedFilterFields()).rejects.toBe(error)
    expect(database.connect).toHaveBeenCalledOnce()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('disposes ready resources exactly once and rejects later operations', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })
    await reader.getSupportedFilterFields()

    const firstDisposal = reader.dispose()
    const secondDisposal = reader.dispose()

    expect(secondDisposal).toBe(firstDisposal)
    await firstDisposal
    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
    await expect(reader.getSupportedFilterFields()).rejects.toThrow(/disposed/i)
  })

  it('attempts database termination when connection close fails during disposal', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {
        throw new Error('connection close failed')
      }),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })
    await reader.getSupportedFilterFields()

    await expect(reader.dispose()).rejects.toThrow('connection close failed')
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('force-terminates a ready database when connection close stalls', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(() => new Promise<void>(() => {})),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
      disposeTimeoutMs: 0,
    })
    await reader.getSupportedFilterFields()

    await reader.dispose()

    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('force-terminates opening rollback when connection close stalls', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(() => new Promise<void>(() => {})),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {
        throw new Error('asset registration failed')
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
      disposeTimeoutMs: 0,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('asset registration failed')

    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('joins and reports late connection cleanup during an aborted opening', async () => {
    const closeError = new Error('late connection close failed')
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {
        throw closeError
      }),
    }
    const connectionAcquisition = deferred<typeof connection>()
    const database = {
      connect: vi.fn(() => connectionAcquisition.promise),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
      disposeTimeoutMs: 50,
    })

    const operation = reader.getSupportedFilterFields()
    await vi.waitFor(() => expect(database.connect).toHaveBeenCalledOnce())
    const operationRejection = expect(operation).rejects.toThrow(/disposed/i)
    const disposal = reader.dispose()
    connectionAcquisition.resolve(connection)

    await operationRejection
    const disposalError = await disposal.catch((error: unknown) => error)
    expect(disposalError).toMatchObject({
      cleanupErrors: [closeError],
    })
    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('waits for an admitted query before closing its resources', async () => {
    const queryResult = deferred<ReturnType<typeof table>>()
    const connection = {
      query: vi.fn(() => queryResult.promise),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    const search = reader.searchSpecies(searchRequest(), new Set())
    await vi.waitFor(() => expect(connection.query).toHaveBeenCalledOnce())
    const searchRejection = expect(search).rejects.toThrow(/disposed/i)
    const disposal = reader.dispose()
    await Promise.resolve()
    expect(connection.close).not.toHaveBeenCalled()

    queryResult.resolve(table([]))
    await searchRejection
    await disposal
    expect(connection.close).toHaveBeenCalledOnce()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('forces terminal cleanup when an admitted query never settles', async () => {
    const queryResult = deferred<ReturnType<typeof table>>()
    const connection = {
      query: vi.fn(() => queryResult.promise),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
      disposeTimeoutMs: 0,
    })

    const search = reader.searchSpecies(searchRequest(), new Set())
    await vi.waitFor(() => expect(connection.query).toHaveBeenCalledOnce())
    const searchRejection = expect(search).rejects.toThrow(/disposed/i)
    await reader.dispose()

    await searchRejection
    expect(connection.close).not.toHaveBeenCalled()
    expect(database.terminate).toHaveBeenCalledOnce()
  })

  it('retires resources acquired while disposal is waiting on initialization', async () => {
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const databaseCreation = deferred<typeof database>()
    const createDatabase = vi.fn(() => databaseCreation.promise)
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase,
    })

    const operation = reader.getSupportedFilterFields()
    await vi.waitFor(() => expect(createDatabase).toHaveBeenCalledOnce())
    const operationRejection = expect(operation).rejects.toThrow(/disposed/i)
    const disposal = reader.dispose()
    databaseCreation.resolve(database)

    await operationRejection
    await disposal
    await vi.waitFor(() => expect(database.terminate).toHaveBeenCalledOnce())
    expect(connection.close).not.toHaveBeenCalled()
  })

  it('aborts an in-flight manifest fetch when disposed', async () => {
    const fetchSignals: AbortSignal[] = []
    const fetchJson = vi.fn((_url: URL, signal: AbortSignal) => {
      fetchSignals.push(signal)
      return new Promise<unknown>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('manifest fetch aborted')), { once: true })
      })
    })
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson,
      createDatabase: vi.fn(),
    })

    const operation = reader.getSupportedFilterFields()
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledOnce())
    const disposal = reader.dispose()

    expect(fetchSignals[0]?.aborted).toBe(true)
    await expect(operation).rejects.toThrow(/disposed/i)
    await disposal
  })

  it('coalesces concurrent registration of one locale shard', async () => {
    const localeRegistration = deferred<void>()
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (name === 'names/names-fr.parquet') await localeRegistration.promise
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })
    await reader.getSupportedFilterFields()
    database.registerFileURL.mockClear()

    const firstSearch = reader.searchSpecies(searchRequest({ locale: 'fr' }), new Set())
    const secondSearch = reader.searchSpecies(searchRequest({ locale: 'fr' }), new Set())
    await vi.waitFor(() => {
      expect(database.registerFileURL).toHaveBeenCalledTimes(1)
    })

    localeRegistration.resolve(undefined)
    await Promise.all([firstSearch, secondSearch])
    expect(database.registerFileURL).toHaveBeenCalledOnce()
  })

  it('retries a locale shard after registration rejects', async () => {
    let localeAttempts = 0
    const connection = {
      query: vi.fn(async () => table([])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (name !== 'names/names-fr.parquet') return
        localeAttempts += 1
        if (localeAttempts === 1) throw new Error('locale registration failed')
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    await expect(reader.searchSpecies(searchRequest({ locale: 'fr' }), new Set()))
      .rejects.toThrow('locale registration failed')
    await expect(reader.searchSpecies(searchRequest({ locale: 'fr' }), new Set()))
      .resolves.toMatchObject({ items: [] })
    expect(localeAttempts).toBe(2)
  })

  it('coalesces concurrent registration of image shards', async () => {
    const imageRegistration = deferred<void>()
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('web_species_images')) return table([])
        return table([{
          id: 'species-apple',
          slug: 'malus-domestica',
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          localized_common_name: null,
          matched_common_name: null,
          climate_zones: '[]',
          habit: 'Tree',
          growth_form: 'Tree',
          life_cycles: '[]',
        }])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (name.startsWith('images/')) await imageRegistration.promise
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })
    await reader.getSupportedFilterFields()

    const firstDetail = reader.getSpeciesDetail('Malus domestica', 'en')
    const secondDetail = reader.getSpeciesDetail('Malus domestica', 'en')
    await vi.waitFor(() => {
      expect(imageRegistrationCallCount(database.registerFileURL.mock.calls)).toBe(1)
    })

    imageRegistration.resolve(undefined)
    await Promise.all([firstDetail, secondDetail])
    expect(imageRegistrationCallCount(database.registerFileURL.mock.calls)).toBe(1)
  })

  it('retries image shards after registration rejects', async () => {
    let imageAttempts = 0
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('web_species_images')) return table([])
        return table([{
          id: 'species-apple',
          slug: 'malus-domestica',
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          localized_common_name: null,
          matched_common_name: null,
          climate_zones: '[]',
          habit: 'Tree',
          growth_form: 'Tree',
          life_cycles: '[]',
        }])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (!name.startsWith('images/')) return
        imageAttempts += 1
        if (imageAttempts === 1) throw new Error('image registration failed')
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    await expect(reader.getSpeciesDetail('Malus domestica', 'en'))
      .rejects.toThrow('image registration failed')
    await expect(reader.getSpeciesDetail('Malus domestica', 'en'))
      .resolves.toMatchObject({ canonical_name: 'Malus domestica', image: null })
    expect(imageAttempts).toBe(2)
  })

  it('waits for sibling image registrations and retries only failed shards', async () => {
    const siblingRegistration = deferred<void>()
    let failedShardAttempts = 0
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('web_species_images')) return table([])
        return table([{
          id: 'species-apple',
          slug: 'malus-domestica',
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          localized_common_name: null,
          matched_common_name: null,
          climate_zones: '[]',
          habit: 'Tree',
          growth_form: 'Tree',
          life_cycles: '[]',
        }])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async (name: string) => {
        if (name === 'images/images-0000.parquet') {
          failedShardAttempts += 1
          if (failedShardAttempts === 1) throw new Error('first image shard failed')
        }
        if (name === 'images/images-0001.parquet') {
          await siblingRegistration.promise
        }
      }),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => manifestWithShards('images', [
        'images/images-0000.parquet',
        'images/images-0001.parquet',
      ]),
      createDatabase: async () => database,
    })
    await reader.getSupportedFilterFields()

    let firstDetailSettled = false
    const firstDetail = reader.getSpeciesDetail('Malus domestica', 'en').then(
      () => null,
      (error: unknown) => error,
    ).finally(() => {
      firstDetailSettled = true
    })
    await vi.waitFor(() => {
      expect(imageRegistrationCallCount(database.registerFileURL.mock.calls)).toBe(2)
    })
    await Promise.resolve()
    expect(firstDetailSettled).toBe(false)

    siblingRegistration.resolve(undefined)
    await expect(firstDetail).resolves.toMatchObject({ message: 'first image shard failed' })
    await expect(reader.getSpeciesDetail('Malus domestica', 'en'))
      .resolves.toMatchObject({ canonical_name: 'Malus domestica', image: null })

    const imageCalls = database.registerFileURL.mock.calls
      .map(([name]) => name)
      .filter((name) => String(name).startsWith('images/'))
    expect(imageCalls).toEqual([
      'images/images-0000.parquet',
      'images/images-0001.parquet',
      'images/images-0000.parquet',
    ])
  })

  it('retries filter option projection after a transient query failure', async () => {
    let filterQueryAttempts = 0
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (!sql.includes('SELECT s.climate_zones')) return table([])
        filterQueryAttempts += 1
        if (filterQueryAttempts === 1) throw new Error('filter query failed')
        return table([{
          climate_zones: '["Temperate"]',
          habit: 'Tree',
          growth_form: 'Woody',
          life_cycles: '["Perennial"]',
        }])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    await expect(reader.getFilterOptions()).rejects.toThrow('filter query failed')
    await expect(reader.getFilterOptions()).resolves.toMatchObject({
      climate_zones: ['Temperate'],
      habits: ['Tree', 'Woody'],
      life_cycles: ['Perennial'],
    })
    expect(filterQueryAttempts).toBe(2)
  })

  it('does not initialize DuckDB for direct one-character searches while preserving blank browsing', async () => {
    const connection = {
      query: vi.fn(async () => table([{
        id: 'species-apple',
        slug: 'malus-domestica',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        localized_common_name: null,
        matched_common_name: null,
        climate_zones: '[]',
        habit: 'Tree',
        growth_form: 'Tree',
        life_cycles: '[]',
      }])),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const fetchJson = vi.fn(async () => validWebCatalogManifest())
    const createDatabase = vi.fn(async () => database)
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson,
      createDatabase,
    })

    try {
      const tooShort = await reader.searchSpecies(searchRequest({
        text: 'm',
        include_total: true,
      }), new Set())

      expect(fetchJson).not.toHaveBeenCalled()
      expect(createDatabase).not.toHaveBeenCalled()
      expect(connection.query).not.toHaveBeenCalled()
      expect(tooShort).toEqual({
        items: [],
        next_cursor: null,
        total_estimate: 0,
      })

      const blankBrowse = await reader.searchSpecies(searchRequest({ text: '' }), new Set())
      const whitespaceBrowse = await reader.searchSpecies(searchRequest({ text: ' \t ' }), new Set())

      expect(blankBrowse.items).toHaveLength(1)
      expect(whitespaceBrowse.items).toHaveLength(1)
      expect(connection.query).toHaveBeenCalledTimes(2)
    } finally {
      await reader.dispose()
    }
  })

  it('browses Species from Parquet assets and keeps DuckDB alive for reuse', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (/COUNT/i.test(sql)) {
          return table([{ total_count: 3 }])
        }
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            localized_common_name: 'Apple',
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    const page = await reader.searchSpecies(searchRequest({
      include_total: true,
      limit: 1,
    }), new Set(['Malus domestica']))

    expect(database.registerFileURL).toHaveBeenCalledWith(
      'species/species-0000.parquet',
      'https://cdn.example.test/app/canopi-catalog/species/species-0000.parquet',
      expect.anything(),
      false,
    )
    expect(queries.some((sql) => sql.includes('read_parquet'))).toBe(true)
    expect(queries.join('\n')).toContain('LIMIT 1')
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          climate_zones: ['Temperate'],
          life_cycles: ['Perennial'],
          is_favorite: true,
        }),
      ],
      next_cursor: 'offset:1',
      total_estimate: 3,
    })
    expect(connection.close).not.toHaveBeenCalled()
    expect(database.terminate).not.toHaveBeenCalled()
  })

  it('looks one row ahead instead of returning a redundant terminal cursor', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            climate_zones: '[]',
            life_cycles: '[]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    const page = await reader.searchSpecies(searchRequest({ limit: 1 }), new Set())

    expect(queries.at(-1)).toContain('LIMIT 2')
    expect(page.items).toHaveLength(1)
    expect(page.next_cursor).toBeNull()
  })

  it('uses the lookahead row only to prove that another page exists', async () => {
    const connection = {
      query: vi.fn(async () => table([
        {
          id: 'species-apple',
          slug: 'malus-domestica',
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          climate_zones: '[]',
          life_cycles: '[]',
        },
        {
          id: 'species-balm',
          slug: 'melissa-officinalis',
          canonical_name: 'Melissa officinalis',
          common_name: 'Lemon balm',
          climate_zones: '[]',
          life_cycles: '[]',
        },
      ])),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    const page = await reader.searchSpecies(searchRequest({ limit: 1 }), new Set())

    expect(page.items.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
    expect(page.next_cursor).toBe('offset:1')
  })

  it('returns an empty terminal page without querying DuckDB when the limit is zero', async () => {
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (!/COUNT/i.test(sql)) throw new Error('zero-sized page executed a projection query')
        return table([{ total_count: 3 }])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    await expect(reader.searchSpecies(searchRequest({ limit: 0 }), new Set())).resolves.toEqual({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    })
    expect(connection.query).not.toHaveBeenCalled()

    await expect(reader.searchSpecies(searchRequest({
      limit: 0,
      include_total: true,
    }), new Set())).resolves.toEqual({
      items: [],
      next_cursor: null,
      total_estimate: 3,
    })
    expect(connection.query).toHaveBeenCalledOnce()
    expect(connection.query.mock.calls[0]?.[0]).toMatch(/COUNT/i)
  })

  it('rejects legacy NDJSON catalog manifests in the production Web reader', async () => {
    const createDatabase = vi.fn(async () => ({
      connect: vi.fn(async () => ({
        query: vi.fn(async () => table([])),
        close: vi.fn(async () => {}),
      })),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }))
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => ({
        ...validWebCatalogManifest(),
        asset_format: 'ndjson',
      }),
      createDatabase,
    })

    await expect(reader.searchSpecies(searchRequest(), new Set())).rejects.toThrow(/Parquet/i)
    expect(createDatabase).not.toHaveBeenCalled()
  })

  it('rejects a catalog from another artifact owner before starting DuckDB', async () => {
    const createDatabase = vi.fn(async () => ({
      connect: vi.fn(async () => ({
        query: vi.fn(async () => table([])),
        close: vi.fn(async () => {}),
      })),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }))
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => ({
        ...validWebCatalogManifest(),
        generated_by: 'another-catalog-producer',
      }),
      createDatabase,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow(/owner/i)
    expect(createDatabase).not.toHaveBeenCalled()
  })

  it('rejects a stale artifact contract before starting DuckDB', async () => {
    const createDatabase = vi.fn(async () => ({
      connect: vi.fn(async () => ({
        query: vi.fn(async () => table([])),
        close: vi.fn(async () => {}),
      })),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }))
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => ({
        ...validWebCatalogManifest(),
        artifact_contract_fingerprint: '0'.repeat(64),
      }),
      createDatabase,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow(/compiled contract/i)
    expect(createDatabase).not.toHaveBeenCalled()
  })

  it('rejects stale Species Search normalization before starting DuckDB', async () => {
    const createDatabase = vi.fn(async () => ({
      connect: vi.fn(async () => ({
        query: vi.fn(async () => table([])),
        close: vi.fn(async () => {}),
      })),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }))
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => ({
        ...validWebCatalogManifest(),
        species_search_normalization: {
          version: 0,
          fingerprint: '0'.repeat(64),
        },
      }),
      createDatabase,
    })

    await expect(reader.getSupportedFilterFields()).rejects.toThrow(
      /species_search_normalization.*compiled normalization authority/i,
    )
    expect(createDatabase).not.toHaveBeenCalled()
  })

  it('uses only the active locale name shard for localized display and matching', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            localized_common_name: 'Pommier',
            matched_common_name: 'Pommier',
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    const page = await reader.searchSpecies(searchRequest({
      text: 'pomm',
      locale: 'fr',
      limit: 10,
    }), new Set())

    expect(database.registerFileURL).toHaveBeenCalledWith(
      'names/names-fr.parquet',
      'https://cdn.example.test/app/canopi-catalog/names/names-fr.parquet',
      expect.anything(),
      false,
    )
    expect(database.registerFileURL).not.toHaveBeenCalledWith(
      'names/names-en.parquet',
      expect.anything(),
      expect.anything(),
      false,
    )
    expect(queries.join('\n')).toContain("read_parquet('names/names-fr.parquet')")
    expect(queries.join('\n')).toContain('normalized_name')
    expect(page.items[0]).toMatchObject({
      canonical_name: 'Malus domestica',
      common_name: 'Pommier',
      matched_common_name: 'Pommier',
    })
  })

  it('orders active text searches by selected-locale Common Name relevance tiers', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            localized_common_name: 'Pommier',
            matched_common_name: 'Pomme commune',
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    await reader.searchSpecies(searchRequest({
      text: 'pomme commune',
      locale: 'fr',
      limit: 10,
    }), new Set())

    const searchSql = queries.at(-1) ?? ''
    expect(searchSql).toContain('ORDER BY CASE')
    expect(searchSql).toContain("WHEN primary_names.normalized_name = 'pomme commune' THEN 0")
    expect(searchSql).toContain("WHEN primary_names.normalized_name LIKE 'pomme commune%' ESCAPE '\\' THEN 1")
    expect(searchSql).toContain("WHEN primary_names.normalized_name LIKE '%pomme%' ESCAPE '\\'")
    expect(searchSql).toContain("AND primary_names.normalized_name LIKE '%commune%' ESCAPE '\\'")
    expect(searchSql).toContain('WHEN matched_names.species_id IS NOT NULL THEN 3')
    expect(searchSql).toContain('matched_names.match_tier')
    expect(searchSql).toContain('s.normalized_canonical_name')
    expect(searchSql).not.toContain('s.normalized_common_name')
    expect(searchSql).not.toContain('LOWER(s.canonical_name)')
    expect(searchSql).not.toContain("LOWER(COALESCE(s.common_name, ''))")
    expect(searchSql).toContain('s.canonical_name,')
    expect(searchSql).toContain('s.id')
    expect(database.registerFileURL).toHaveBeenCalledWith(
      'names/names-fr.parquet',
      'https://cdn.example.test/app/canopi-catalog/names/names-fr.parquet',
      expect.anything(),
      false,
    )
    expect(database.registerFileURL).not.toHaveBeenCalledWith(
      'names/names-en.parquet',
      expect.anything(),
      expect.anything(),
      false,
    )
  })

  it('keeps separated short tokens active through the Web query path', async () => {
    const testCase = SPECIES_SEARCH_NORMALIZATION_CORPUS.find(
      (candidate) => candidate.name === 'separated-short-tokens-are-admitted-together',
    )
    expect(testCase).toBeDefined()

    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return table([])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    await reader.searchSpecies(searchRequest({
      text: testCase!.input,
      locale: 'en',
      limit: 10,
    }), new Set())

    const searchSql = queries.at(-1) ?? ''
    expect(searchSql).toContain('ORDER BY CASE')
    for (const token of testCase!.queryTokens) {
      expect(searchSql).toContain(`LIKE '%${token}%' ESCAPE '\\'`)
    }
  })

  it('keeps canonical ordering for empty browse and filter-only searches', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    await reader.searchSpecies(searchRequest({
      text: '',
      locale: 'fr',
      filters: {
        ...createEmptySpeciesFilter(),
        habit: ['Tree'],
      },
    }), new Set())

    const searchSql = queries.at(-1) ?? ''
    expect(searchSql).toContain('ORDER BY s.canonical_name, s.id')
    expect(searchSql).not.toContain('ORDER BY CASE')
  })

  it('projects supported filters and applies them to Parquet searches', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('SELECT s.climate_zones')) {
          return table([
            {
              climate_zones: '["Temperate","Boreal"]',
              habit: 'Tree',
              growth_form: 'Woody',
              life_cycles: '["Perennial"]',
            },
            {
              climate_zones: '["Mediterranean"]',
              habit: 'Herbaceous',
              growth_form: 'Forb',
              life_cycles: '["Annual"]',
            },
          ])
        }
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    await expect(reader.getSupportedFilterFields()).resolves.toEqual([
      'climate_zones',
      'habit',
      'life_cycle',
    ])
    await expect(reader.getFilterOptions()).resolves.toMatchObject({
      climate_zones: ['Boreal', 'Mediterranean', 'Temperate'],
      habits: ['Forb', 'Herbaceous', 'Tree', 'Woody'],
      life_cycles: ['Annual', 'Perennial'],
      sun_tolerances: [],
    })

    await reader.searchSpecies(searchRequest({
      filters: {
        ...createEmptySpeciesFilter(),
        climate_zones: ['Temperate'],
        habit: ['Tree'],
        life_cycle: ['Perennial'],
        woody: true,
      },
    }), new Set())

    const searchSql = queries.at(-1) ?? ''
    expect(searchSql).toContain(`CAST(s.climate_zones AS VARCHAR) LIKE '%"Temperate"%'`)
    expect(searchSql).toContain(`COALESCE(s.habit, '') IN ('Tree')`)
    expect(searchSql).toContain(`COALESCE(s.growth_form, '') IN ('Tree')`)
    expect(searchSql).toContain(`CAST(s.life_cycles AS VARCHAR) LIKE '%"Perennial"%'`)
    expect(searchSql).not.toContain('woody')
  })

  it('hydrates reduced Species detail and one hero image from Parquet assets', async () => {
    const queries: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('web_species_detail_names')) {
          return table([
            { common_name: 'Pommier' },
            { common_name: 'Pomme commune' },
            { common_name: 'Pommier' },
          ])
        }
        if (sql.includes('web_species_images')) {
          return table([
            {
              species_id: 'species-apple',
              url: 'https://images.example.test/apple.jpg',
              source: 'Wikimedia Commons',
              source_page_url: 'https://commons.example.test/apple',
              credit: 'Jane Gardener',
              license: 'CC BY-SA 4.0',
            },
          ])
        }
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            localized_common_name: 'Pommier',
            matched_common_name: null,
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const database = {
      connect: vi.fn(async () => connection),
      registerFileURL: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => database,
    })

    const detail = await reader.getSpeciesDetail('Malus domestica', 'fr')

    expect(database.registerFileURL).toHaveBeenCalledWith(
      'images/images-0000.parquet',
      'https://cdn.example.test/app/canopi-catalog/images/images-0000.parquet',
      expect.anything(),
      false,
    )
    expect(queries.join('\n')).toContain("read_parquet('images/images-0000.parquet')")
    expect(detail).toEqual({
      canonical_name: 'Malus domestica',
      common_name: 'Pommier',
      common_names: ['Pommier', 'Pomme commune'],
      climate_zones: ['Temperate'],
      habit: 'Tree',
      growth_form: 'Tree',
      life_cycles: ['Perennial'],
      image: {
        url: 'https://images.example.test/apple.jpg',
        source: 'Wikimedia Commons',
        source_page_url: 'https://commons.example.test/apple',
        credit: 'Jane Gardener',
        license: 'CC BY-SA 4.0',
      },
    })
    expect(detail).not.toHaveProperty('height_max_m')
    expect(detail).not.toHaveProperty('hardiness_zone_min')
    expect(detail).not.toHaveProperty('stratum')
    expect(detail).not.toHaveProperty('edibility_rating')
  })

  it('hydrates reduced Species detail when image metadata is absent', async () => {
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('web_species_detail_names')) return table([])
        if (sql.includes('web_species_images')) return table([])
        return table([
          {
            id: 'species-apple',
            slug: 'malus-domestica',
            canonical_name: 'Malus domestica',
            common_name: 'Apple',
            localized_common_name: null,
            matched_common_name: null,
            climate_zones: '["Temperate"]',
            habit: 'Tree',
            growth_form: 'Tree',
            life_cycles: '["Perennial"]',
          },
        ])
      }),
      close: vi.fn(async () => {}),
    }
    const reader = createDuckDbReducedSpeciesCatalogReader({
      catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
      fetchJson: async () => validWebCatalogManifest(),
      createDatabase: async () => ({
        connect: vi.fn(async () => connection),
        registerFileURL: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
      }),
    })

    await expect(reader.getSpeciesDetail('Malus domestica', 'fr')).resolves.toMatchObject({
      canonical_name: 'Malus domestica',
      common_name: null,
      common_names: [],
      image: null,
    })
  })
})

function searchRequest(overrides: Partial<SpeciesSearchRequest> = {}): SpeciesSearchRequest {
  return {
    text: '',
    filters: createEmptySpeciesFilter(),
    cursor: null,
    limit: 50,
    sort: 'Name',
    locale: 'en',
    include_total: false,
    ...overrides,
  }
}

function table(rows: readonly Record<string, unknown>[]): { toArray(): unknown[] } {
  return {
    toArray: () => [...rows],
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function manifestWithShards(
  kind: 'species' | 'images',
  paths: readonly string[],
): Record<string, unknown> {
  const manifest = validWebCatalogManifest() as {
    [key: string]: unknown
    assets: {
      species: Array<Record<string, unknown>>
      names: Record<string, Record<string, unknown>>
      images: Array<Record<string, unknown>>
    }
    duckdb: {
      reader: string
      tables: {
        web_species: string[]
        web_species_names: string[]
        web_species_images: string[]
      }
    }
  }
  const tableName = kind === 'species' ? 'web_species' : 'web_species_images'
  const assets = paths.map((path, index) => ({
    path,
    bytes: 10,
    sha256: String(index + 1).repeat(64),
  }))

  return {
    ...manifest,
    assets: {
      ...manifest.assets,
      [kind]: assets,
    },
    duckdb: {
      ...manifest.duckdb,
      tables: {
        ...manifest.duckdb.tables,
        [tableName]: [...paths],
      },
    },
  }
}

function imageRegistrationCallCount(calls: unknown[][]): number {
  return calls.filter(([name]) => typeof name === 'string' && name.startsWith('images/')).length
}
