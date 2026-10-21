import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validWebCatalogManifest } from './fixtures/web-catalog-manifest'

const mocks = vi.hoisted(() => ({
  constructorError: null as Error | null,
  instantiate: vi.fn(async () => {}),
  open: vi.fn(async (_config: unknown) => {}),
  connect: vi.fn(),
  terminateDatabase: vi.fn(async () => {}),
  terminateWorker: vi.fn(),
  revokeObjectUrl: vi.fn(),
}))

vi.mock('@duckdb/duckdb-wasm', () => {
  class AsyncDuckDB {
    constructor() {
      if (mocks.constructorError) throw mocks.constructorError
    }

    instantiate = mocks.instantiate
    open = mocks.open
    terminate = mocks.terminateDatabase
    connect = mocks.connect
    registerFileURL = vi.fn()
  }

  return {
    AsyncDuckDB,
    VoidLogger: class VoidLogger {},
    DuckDBDataProtocol: { HTTP: 0 },
    getJsDelivrBundles: () => ({}),
    selectBundle: async () => ({
      mainWorker: 'https://cdn.example.test/duckdb-worker.js',
      mainModule: 'https://cdn.example.test/duckdb.wasm',
      pthreadWorker: null,
    }),
  }
})

import { createDuckDbReducedSpeciesCatalogReader } from '../web/duckdb-wasm-catalog'

describe('DuckDB-WASM default database factory', () => {
  beforeEach(() => {
    mocks.constructorError = null
    mocks.instantiate.mockReset().mockResolvedValue(undefined)
    mocks.open.mockReset().mockResolvedValue(undefined)
    mocks.connect.mockReset().mockRejectedValue(new Error('no connection in this test'))
    mocks.terminateDatabase.mockReset().mockResolvedValue(undefined)
    mocks.terminateWorker.mockReset()
    mocks.revokeObjectUrl.mockReset()
    vi.stubGlobal('Worker', class Worker {
      terminate = mocks.terminateWorker
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:duckdb-worker')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(mocks.revokeObjectUrl)
  })

  it('terminates the database when WASM instantiation fails', async () => {
    mocks.instantiate.mockRejectedValueOnce(new Error('WASM instantiation failed'))
    const reader = createReaderUsingDefaultDatabaseFactory()

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('WASM instantiation failed')

    expect(mocks.terminateDatabase).toHaveBeenCalledOnce()
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith('blob:duckdb-worker')
  })

  it('opens the database for ranged catalog reads, never a whole-file download', async () => {
    // A catalog shard is read by HTTP range; without this DuckDB-WASM skips the ranged HEAD probe and GETs whole files.
    const reader = createReaderUsingDefaultDatabaseFactory()

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('no connection in this test')

    expect(mocks.open).toHaveBeenCalledOnce()
    expect(mocks.open.mock.calls[0]![0]).toMatchObject({
      filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false },
    })
    expect(mocks.instantiate.mock.invocationCallOrder[0]!).toBeLessThan(mocks.open.mock.invocationCallOrder[0]!)
    await reader.dispose()
  })

  it('terminates the Worker when database construction fails', async () => {
    mocks.constructorError = new Error('DuckDB construction failed')
    const reader = createReaderUsingDefaultDatabaseFactory()

    await expect(reader.getSupportedFilterFields()).rejects.toThrow('DuckDB construction failed')

    expect(mocks.terminateWorker).toHaveBeenCalledOnce()
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith('blob:duckdb-worker')
  })

  it('terminates a stalled WASM instantiation when the reader is disposed', async () => {
    mocks.instantiate.mockImplementationOnce(() => new Promise(() => {}))
    const reader = createReaderUsingDefaultDatabaseFactory()

    const opening = reader.getSupportedFilterFields()
    await vi.waitFor(() => expect(mocks.instantiate).toHaveBeenCalledOnce())
    const openingRejection = expect(opening).rejects.toThrow(/disposed/i)
    const disposal = reader.dispose()

    await openingRejection
    await disposal
    expect(mocks.terminateDatabase).toHaveBeenCalledOnce()
    expect(mocks.revokeObjectUrl).toHaveBeenCalledWith('blob:duckdb-worker')
  })
})

function createReaderUsingDefaultDatabaseFactory() {
  return createDuckDbReducedSpeciesCatalogReader({
    catalogBaseUrl: new URL('https://cdn.example.test/app/canopi-catalog/'),
    fetchJson: async () => validWebCatalogManifest(),
  })
}
