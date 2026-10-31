// web/duckdb-wasm-catalog.ts
// Owner of the Web species reader's fetch and worker (fetch-only-in-owners and
// worker-only-in-owner, ADR 0028; §18 F15, F16). Invariant: the catalog is fetched and its DuckDB worker started only here.

import * as duckdb from '@duckdb/duckdb-wasm'
import {
  type ReducedSpeciesCatalogReader,
  type ReducedSpeciesImageRow,
  type ReducedSpeciesRow,
  type WebSupportedFilterOptionsKey,
} from './reduced-species-catalog'
import {
  admitWebCatalogManifest,
  type AdmittedWebCatalog as WebCatalogManifest,
  type WebCatalogSupportedFilter as WebSupportedFilter,
} from '../generated/web-catalog-artifact.mjs'
import type { SpeciesCatalogDetail } from '../app/plant-browser/workbench'
import type {
  DynamicFilterOptions,
  FilterOptions,
  PaginatedResult,
  SpeciesListItem,
  SpeciesSearchRequest,
} from '../types/species'
import {
  admittedSpeciesSearchText,
  EMPTY_ADMITTED_SPECIES_SEARCH_TEXT,
  speciesSearchAdmission,
  type AdmittedSpeciesSearchText as NormalizedSearchText,
} from '../utils/species-search-normalization'

interface DuckDbQueryTable {
  toArray(): unknown[]
}

interface DuckDbCatalogConnection {
  query(sql: string): DuckDbQueryTable | Promise<DuckDbQueryTable>
  close(): void | Promise<void>
}

interface DuckDbCatalogDatabase {
  connect(): DuckDbCatalogConnection | Promise<DuckDbCatalogConnection>
  registerFileURL(
    name: string,
    url: string,
    protocol: unknown,
    directIO: boolean,
  ): void | Promise<void>
  terminate(): void | Promise<void>
}

interface DuckDbReducedSpeciesCatalogReaderOptions {
  readonly catalogBaseUrl?: URL
  readonly fetchJson?: (url: URL, signal: AbortSignal) => Promise<unknown>
  readonly createDatabase?: (signal: AbortSignal) => Promise<DuckDbCatalogDatabase>
  readonly disposeTimeoutMs?: number
}

class DuckDbCatalogDisposedError extends Error {
  constructor() {
    super('Web Species Catalog reader is disposed.')
    this.name = 'DuckDbCatalogDisposedError'
  }
}

class DuckDbCatalogOpeningError extends Error {
  readonly cause: unknown
  readonly cleanupErrors: readonly unknown[]

  constructor(cause: unknown, cleanupErrors: readonly unknown[]) {
    super(`Failed to open Web Species Catalog: ${describeError(cause)}`)
    this.name = 'DuckDbCatalogOpeningError'
    this.cause = cause
    this.cleanupErrors = cleanupErrors
  }
}

class DuckDbCatalogCleanupError extends Error {
  readonly cleanupErrors: readonly unknown[]

  constructor(cleanupErrors: readonly unknown[]) {
    super(`Failed to dispose Web Species Catalog: ${cleanupErrors.map(describeError).join('; ')}`)
    this.name = 'DuckDbCatalogCleanupError'
    this.cleanupErrors = cleanupErrors
  }
}

export interface DuckDbReducedSpeciesCatalogReader extends ReducedSpeciesCatalogReader {
  dispose(): Promise<void>
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 250

export function createDuckDbReducedSpeciesCatalogReader(
  options: DuckDbReducedSpeciesCatalogReaderOptions = {},
): DuckDbReducedSpeciesCatalogReader {
  let readerPromise: Promise<DuckDbParquetReducedSpeciesCatalogReader> | null = null
  let openingAbort: AbortController | null = null
  const operationAbort = new AbortController()
  let disposed = false
  let disposePromise: Promise<void> | null = null
  const activeOperations = new Set<Promise<unknown>>()

  async function reader(): Promise<DuckDbParquetReducedSpeciesCatalogReader> {
    let current = readerPromise
    if (!current) {
      openingAbort = new AbortController()
      current = loadDuckDbCatalogReader(options, openingAbort.signal)
      readerPromise = current
    }
    try {
      const loaded = await current
      if (readerPromise === current) openingAbort = null
      return loaded
    } catch (error) {
      if (readerPromise === current) {
        if (!(error instanceof DuckDbCatalogOpeningError)) {
          readerPromise = null
        }
        openingAbort = null
      }
      throw error
    }
  }

  function run<T>(
    operation: (loaded: DuckDbParquetReducedSpeciesCatalogReader) => Promise<T>,
  ): Promise<T> {
    if (disposed) return Promise.reject(new DuckDbCatalogDisposedError())
    const active = reader().then((loaded) => {
      if (disposed) throw new DuckDbCatalogDisposedError()
      return operation(loaded)
    })
    activeOperations.add(active)
    active.then(
      () => activeOperations.delete(active),
      () => activeOperations.delete(active),
    )
    return rejectOnAbort(active, operationAbort.signal)
  }

  async function disposeReader(): Promise<void> {
    const opening = readerPromise
    let loaded: DuckDbParquetReducedSpeciesCatalogReader | null = null
    if (opening) {
      try {
        loaded = await opening
      } catch (error) {
        if (error instanceof DuckDbCatalogOpeningError) throw error
      }
    }
    const drained = await settleWithin(
      [...activeOperations],
      options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
    )
    if (!loaded) return
    if (drained) {
      await loaded.dispose()
    } else {
      await loaded.forceDispose()
    }
  }

  return {
    async searchSpecies(
      request: SpeciesSearchRequest,
      favoriteNames: ReadonlySet<string>,
    ): Promise<PaginatedResult<SpeciesListItem>> {
      if (disposed) throw new DuckDbCatalogDisposedError()
      if (speciesSearchAdmission(request.text) === 'too-short') {
        return {
          items: [],
          next_cursor: null,
          total_estimate: 0,
        }
      }
      return run((loaded) => loaded.searchSpecies(request, favoriteNames))
    },

    async listSpeciesByCanonicalNames(
      canonicalNames: readonly string[],
      locale: string,
      favoriteNames: ReadonlySet<string>,
    ): Promise<SpeciesListItem[]> {
      return run((loaded) => loaded.listSpeciesByCanonicalNames(canonicalNames, locale, favoriteNames))
    },

    async getFilterOptions(): Promise<FilterOptions> {
      return run((loaded) => loaded.getFilterOptions())
    },

    async getSupportedFilterFields(): Promise<readonly string[]> {
      return run((loaded) => loaded.getSupportedFilterFields())
    },

    async getDynamicFilterOptions(
      fields: readonly string[],
      locale: string,
    ): Promise<DynamicFilterOptions[]> {
      return run((loaded) => loaded.getDynamicFilterOptions(fields, locale))
    },

    async getSpeciesDetail(canonicalName: string, locale: string): Promise<SpeciesCatalogDetail | null> {
      return run((loaded) => loaded.getSpeciesDetail(canonicalName, locale))
    },

    dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposed = true
      const disposedError = new DuckDbCatalogDisposedError()
      openingAbort?.abort(disposedError)
      operationAbort.abort(disposedError)
      disposePromise = disposeReader()
      return disposePromise
    },
  }
}

async function loadDuckDbCatalogReader(
  options: DuckDbReducedSpeciesCatalogReaderOptions,
  signal: AbortSignal,
): Promise<DuckDbParquetReducedSpeciesCatalogReader> {
  const catalogBaseUrl = options.catalogBaseUrl ?? defaultCatalogBaseUrl()
  const cleanupTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  const fetchJson = options.fetchJson ?? fetchCatalogJson
  const manifest = admitWebCatalogManifest(await fetchJson(new URL('manifest.json', catalogBaseUrl), signal))
  throwIfAborted(signal)
  const database = options.createDatabase
    ? await options.createDatabase(signal)
    : await instantiateDuckDb(signal)
  let connection: DuckDbCatalogConnection | null = null
  let connectionAttempt: Promise<DuckDbCatalogConnection> | null = null

  try {
    throwIfAborted(signal)
    connectionAttempt = Promise.resolve().then(() => database.connect())
    connection = await rejectOnAbort(connectionAttempt, signal)
    throwIfAborted(signal)
    await rejectOnAbort(registerCatalogAssets(database, catalogBaseUrl, manifest), signal)
    throwIfAborted(signal)
    return new DuckDbParquetReducedSpeciesCatalogReader(
      database,
      connection,
      catalogBaseUrl,
      manifest,
      cleanupTimeoutMs,
    )
  } catch (error) {
    const cleanupErrors = await cleanupDuckDb(database, connection, cleanupTimeoutMs)
    if (signal.aborted && connection === null && connectionAttempt) {
      cleanupErrors.push(...await cleanupLateConnectionAttempt(
        connectionAttempt,
        cleanupTimeoutMs,
      ))
    }
    if (cleanupErrors.length > 0) {
      throw new DuckDbCatalogOpeningError(error, cleanupErrors)
    }
    throw error
  }
}

class DuckDbParquetReducedSpeciesCatalogReader implements ReducedSpeciesCatalogReader {
  private readonly localeAssetRegistrations = new Map<string, Promise<void>>()
  private readonly imageAssetRegistrations = new Map<string, Promise<void>>()
  private filterOptionsPromise: Promise<FilterOptions> | null = null
  private disposePromise: Promise<void> | null = null

  constructor(
    private readonly database: DuckDbCatalogDatabase,
    private readonly connection: DuckDbCatalogConnection,
    private readonly catalogBaseUrl: URL,
    private readonly manifest: WebCatalogManifest,
    private readonly cleanupTimeoutMs: number,
  ) {}

  dispose(): Promise<void> {
    this.disposePromise ??= closeDuckDb(
      this.database,
      this.connection,
      this.cleanupTimeoutMs,
    )
    return this.disposePromise
  }

  forceDispose(): Promise<void> {
    this.disposePromise ??= forceTerminateDuckDb(this.database)
    return this.disposePromise
  }

  async searchSpecies(
    request: SpeciesSearchRequest,
    favoriteNames: ReadonlySet<string>,
  ): Promise<PaginatedResult<SpeciesListItem>> {
    await this.ensureLocaleNameAsset(request.locale)
    const offset = cursorToOffset(request.cursor)
    const limit = Math.max(0, request.limit)
    const speciesTable = readParquetSql(this.manifest.assets.species.map((asset) => asset.path))
    const namesTable = localeNamesSql(this.manifest, request.locale)
    const searchText = admittedSpeciesSearchText(request.text)
    const whereSql = speciesWhereSql({
      searchText,
      filters: request.filters,
      supportedFilters: this.manifest.supportedFilters,
    })
    if (limit === 0) {
      return {
        items: [],
        next_cursor: null,
        total_estimate: request.include_total
          ? await this.countSpecies(speciesTable, namesTable, whereSql)
          : 0,
      }
    }
    const queryLimit = request.include_total ? limit : limit + 1
    const rowsTable = await this.connection.query(`
      ${speciesProjectionSql({
        speciesTable,
        namesTable,
        whereSql,
        searchText,
        sort: request.sort,
      })}
      LIMIT ${queryLimit}
      OFFSET ${offset}
    `)
    const queriedRows = tableRows(rowsTable).map(parseSpeciesProjection)
    const rows = queriedRows.slice(0, limit)
    const totalEstimate = request.include_total
      ? await this.countSpecies(speciesTable, namesTable, whereSql)
      : 0
    const nextOffset = offset + rows.length
    const hasNextPage = request.include_total
      ? nextOffset < totalEstimate
      : queriedRows.length > limit

    return {
      items: rows.map((row) => speciesProjectionToListItem(row, favoriteNames)),
      next_cursor: hasNextPage ? `offset:${nextOffset}` : null,
      total_estimate: totalEstimate,
    }
  }

  async listSpeciesByCanonicalNames(
    canonicalNames: readonly string[],
    locale: string,
    favoriteNames: ReadonlySet<string>,
  ): Promise<SpeciesListItem[]> {
    if (canonicalNames.length === 0) return []
    await this.ensureLocaleNameAsset(locale)
    const speciesTable = readParquetSql(this.manifest.assets.species.map((asset) => asset.path))
    const namesTable = localeNamesSql(this.manifest, locale)
    const rowsTable = await this.connection.query(`
      ${speciesProjectionSql({
        speciesTable,
        namesTable,
        whereSql: `WHERE s.canonical_name IN (${canonicalNames.map(quoteSqlString).join(', ')})`,
        searchText: EMPTY_ADMITTED_SPECIES_SEARCH_TEXT,
      })}
    `)
    const rowsByName = new Map(tableRows(rowsTable).map((row) => {
      const species = parseSpeciesProjection(row)
      return [species.row.canonical_name, species]
    }))
    return canonicalNames.flatMap((canonicalName) => {
      const row = rowsByName.get(canonicalName)
      return row ? [speciesProjectionToListItem(row, favoriteNames)] : []
    })
  }

  async getFilterOptions(): Promise<FilterOptions> {
    const current = this.filterOptionsPromise ?? this.loadFilterOptions()
    this.filterOptionsPromise = current
    try {
      return await current
    } catch (error) {
      if (this.filterOptionsPromise === current) this.filterOptionsPromise = null
      throw error
    }
  }

  async getSupportedFilterFields(): Promise<readonly string[]> {
    return this.manifest.supportedFilters.map((filter) => filter.key)
  }

  async getDynamicFilterOptions(
    fields: readonly string[],
    _locale: string,
  ): Promise<DynamicFilterOptions[]> {
    const supportedByKey = new Map<string, WebSupportedFilter>(
      this.manifest.supportedFilters.map((filter) => [filter.key, filter]),
    )
    const options = await this.getFilterOptions()
    return fields.flatMap((field): DynamicFilterOptions[] => {
      const supported = supportedByKey.get(field)
      if (!supported) return []
      return [categoricalDynamicFilterOptions(field, filterOptionValues(options, supported.optionsKey))]
    })
  }

  async getSpeciesDetail(
    canonicalName: string,
    locale: string,
  ): Promise<SpeciesCatalogDetail | null> {
    await this.ensureLocaleNameAsset(locale)
    const speciesTable = readParquetSql(this.manifest.assets.species.map((asset) => asset.path))
    const namesTable = localeNamesSql(this.manifest, locale)
    const rowsTable = await this.connection.query(`
      ${speciesProjectionSql({
        speciesTable,
        namesTable,
        whereSql: `WHERE s.canonical_name = ${quoteSqlString(canonicalName)}`,
        searchText: EMPTY_ADMITTED_SPECIES_SEARCH_TEXT,
      })}
      LIMIT 1
    `)
    const projection = tableRows(rowsTable).map(parseSpeciesProjection)[0]
    if (!projection) return null

    const commonNames = await this.loadDetailCommonNames(projection.row.id, namesTable)
    await this.ensureImageAssets()
    const image = await this.loadHeroImage(projection.row.id)
    return speciesProjectionToDetail(projection, commonNames, image)
  }

  private async countSpecies(
    speciesTable: string,
    namesTable: string,
    whereSql: string,
  ): Promise<number> {
    const countTable = await this.connection.query(`
      WITH locale_names AS (
        SELECT species_id,
               normalized_name
        FROM ${namesTable}
      )
      SELECT COUNT(*) AS total_count
      FROM ${speciesTable} s
      ${whereSql}
    `)
    const countRow = tableRows(countTable)[0]
    return numberValue(countRow?.total_count)
  }

  private async loadFilterOptions(): Promise<FilterOptions> {
    const speciesTable = readParquetSql(this.manifest.assets.species.map((asset) => asset.path))
    const columns = supportedFilterColumns(this.manifest.supportedFilters)
    if (columns.length === 0) return emptyFilterOptions()
    const rowsTable = await this.connection.query(`
      SELECT ${columns.map((column) => `s.${column}`).join(', ')}
      FROM ${speciesTable} s
    `)
    const rows = tableRows(rowsTable)
    const options = emptyFilterOptions()
    for (const filter of this.manifest.supportedFilters) {
      const values = rows.flatMap((row) => valuesForSupportedFilterRow(row, filter))
      options[filter.optionsKey] = sortedUnique(values)
    }
    return options
  }

  private async ensureLocaleNameAsset(locale: string): Promise<void> {
    const current = this.localeAssetRegistrations.get(locale)
    if (current) return current
    const asset = this.manifest.assets.names[locale]
    const registration = Promise.resolve().then(() => (asset
      ? this.database.registerFileURL(
          asset.path,
          new URL(asset.path, this.catalogBaseUrl).toString(),
          duckdb.DuckDBDataProtocol.HTTP,
          false,
        )
      : undefined))
    this.localeAssetRegistrations.set(locale, registration)
    try {
      await registration
    } catch (error) {
      if (this.localeAssetRegistrations.get(locale) === registration) {
        this.localeAssetRegistrations.delete(locale)
      }
      throw error
    }
  }

  private async ensureImageAssets(): Promise<void> {
    await allSettledOrThrow(this.manifest.assets.images.map((asset) => (
      this.ensureImageAsset(asset.path)
    )))
  }

  private ensureImageAsset(path: string): Promise<void> {
    const current = this.imageAssetRegistrations.get(path)
    if (current) return current
    const registration = Promise.resolve().then(() => this.database.registerFileURL(
      path,
      new URL(path, this.catalogBaseUrl).toString(),
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    ))
    this.imageAssetRegistrations.set(path, registration)
    void registration.catch(() => {
      if (this.imageAssetRegistrations.get(path) === registration) {
        this.imageAssetRegistrations.delete(path)
      }
    })
    return registration
  }

  private async loadHeroImage(speciesId: string): Promise<ReducedSpeciesImageRow | null> {
    const imagesTable = this.manifest.assets.images.length > 0
      ? readParquetSql(this.manifest.assets.images.map((asset) => asset.path))
      : emptyImagesSql()
    const imageTable = await this.connection.query(`
      WITH web_species_images AS (
        SELECT species_id,
               url,
               source,
               source_page_url,
               credit,
               license
        FROM ${imagesTable}
      )
      SELECT species_id,
             url,
             source,
             source_page_url,
             credit,
             license
      FROM web_species_images
      WHERE species_id = ${quoteSqlString(speciesId)}
      LIMIT 1
    `)
    return tableRows(imageTable).map(parseImageRow)[0] ?? null
  }

  private async loadDetailCommonNames(
    speciesId: string,
    namesTable: string,
  ): Promise<string[]> {
    const names = await this.connection.query(`
      WITH web_species_detail_names AS (
        SELECT common_name,
               TRY_CAST(display_order AS INTEGER) AS numeric_display_order,
               CASE WHEN CAST(is_primary AS VARCHAR) IN ('true', '1') THEN 0 ELSE 1 END
                 AS primary_order
        FROM ${namesTable}
        WHERE species_id = ${quoteSqlString(speciesId)}
      )
      SELECT common_name
      FROM web_species_detail_names
      ORDER BY numeric_display_order,
               primary_order,
               LENGTH(common_name),
               common_name
    `)
    return [...new Set(tableRows(names).flatMap((row) => compact([
      nullableString(row.common_name),
    ])))]
  }
}

async function closeDuckDb(
  database: DuckDbCatalogDatabase,
  connection: DuckDbCatalogConnection,
  timeoutMs: number,
): Promise<void> {
  const cleanupErrors = await cleanupDuckDb(database, connection, timeoutMs)
  if (cleanupErrors.length > 0) throw new DuckDbCatalogCleanupError(cleanupErrors)
}

async function cleanupDuckDb(
  database: DuckDbCatalogDatabase,
  connection: DuckDbCatalogConnection | null,
  timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS,
): Promise<unknown[]> {
  const errors: unknown[] = []
  if (connection) {
    errors.push(...await closeDuckDbConnection(connection, timeoutMs))
  }
  errors.push(...await terminateDuckDb(database))
  return errors
}

async function cleanupLateConnectionAttempt(
  connectionAttempt: Promise<DuckDbCatalogConnection>,
  timeoutMs: number,
): Promise<unknown[]> {
  const outcome = await settlePromiseWithin(connectionAttempt, timeoutMs)
  if (outcome.status === 'rejected') return []
  if (outcome.status === 'fulfilled') {
    return closeDuckDbConnection(outcome.value, timeoutMs)
  }
  void connectionAttempt.then((connection) => {
    void closeDuckDbConnection(connection, timeoutMs)
  }, () => {})
  return []
}

async function closeDuckDbConnection(
  connection: DuckDbCatalogConnection,
  timeoutMs: number,
): Promise<unknown[]> {
  const outcome = await settlePromiseWithin(
    Promise.resolve().then(() => connection.close()),
    timeoutMs,
  )
  return outcome.status === 'rejected' ? [outcome.reason] : []
}

async function terminateDuckDb(database: DuckDbCatalogDatabase): Promise<unknown[]> {
  try {
    await database.terminate()
    return []
  } catch (error) {
    return [error]
  }
}

async function forceTerminateDuckDb(database: DuckDbCatalogDatabase): Promise<void> {
  const cleanupErrors = await terminateDuckDb(database)
  if (cleanupErrors.length > 0) throw new DuckDbCatalogCleanupError(cleanupErrors)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const CATALOG_FILESYSTEM: duckdb.DuckDBFilesystemConfig = {
  reliableHeadRequests: true,
  allowFullHTTPReads: false,
  forceFullHTTPReads: false,
}

async function instantiateDuckDb(signal: AbortSignal): Promise<DuckDbCatalogDatabase> {
  const bundle = await rejectOnAbort(
    duckdb.selectBundle(duckdb.getJsDelivrBundles()),
    signal,
  )
  throwIfAborted(signal)
  if (bundle.mainWorker === null) {
    throw new Error('DuckDB-WASM did not provide a browser worker bundle.')
  }

  const workerUrl = URL.createObjectURL(new Blob([
    `importScripts(${JSON.stringify(bundle.mainWorker)});`,
  ], { type: 'text/javascript' }))

  try {
    const worker = new Worker(workerUrl)
    let database: duckdb.AsyncDuckDB
    try {
      database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    } catch (error) {
      worker.terminate()
      throw error
    }
    try {
      await rejectOnAbort(
        database.instantiate(bundle.mainModule, bundle.pthreadWorker),
        signal,
      )
      // Catalog shards are read by HTTP range (a ranged HEAD for the size, then ranged GETs), never downloaded whole:
      // Pages answers ranges through the zone Cache Rule, and the Vite dev middleware serves them too.
      await rejectOnAbort(database.open({ filesystem: CATALOG_FILESYSTEM }), signal)
      return database
    } catch (error) {
      const cleanupErrors = await cleanupDuckDb(database, null)
      if (cleanupErrors.length > 0) {
        throw new DuckDbCatalogOpeningError(error, cleanupErrors)
      }
      throw error
    }
  } finally {
    URL.revokeObjectURL(workerUrl)
  }
}

async function registerCatalogAssets(
  database: DuckDbCatalogDatabase,
  catalogBaseUrl: URL,
  manifest: WebCatalogManifest,
): Promise<void> {
  const assets = [
    ...manifest.assets.species,
  ]
  await allSettledOrThrow(assets.map((asset) => Promise.resolve().then(() => (
    database.registerFileURL(
      asset.path,
      new URL(asset.path, catalogBaseUrl).toString(),
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    )
  ))))
}

async function allSettledOrThrow(promises: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises)
  const failure = results.find((result): result is PromiseRejectedResult => (
    result.status === 'rejected'
  ))
  if (failure) throw failure.reason
}

function rejectOnAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DuckDbCatalogDisposedError()
}

async function settleWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  if (promises.length === 0) return true
  const outcome = await settlePromiseWithin(Promise.allSettled(promises), timeoutMs)
  return outcome.status === 'fulfilled'
}

type BoundedSettlement<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }
  | { readonly status: 'timed-out' }

function settlePromiseWithin<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
): Promise<BoundedSettlement<T>> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: BoundedSettlement<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(outcome)
    }
    const timeout = setTimeout(
      () => finish({ status: 'timed-out' }),
      Math.max(0, timeoutMs),
    )
    void Promise.resolve(promise).then(
      (value) => finish({ status: 'fulfilled', value }),
      (reason: unknown) => finish({ status: 'rejected', reason }),
    )
  })
}

function readParquetSql(paths: readonly string[]): string {
  if (paths.length === 0) return '(SELECT * FROM (SELECT NULL) WHERE FALSE)'
  if (paths.length === 1) return `read_parquet(${quoteSqlString(paths[0] ?? '')})`
  return `read_parquet([${paths.map(quoteSqlString).join(', ')}])`
}

function localeNamesSql(manifest: WebCatalogManifest, locale: string): string {
  const asset = manifest.assets.names[locale]
  return asset ? readParquetSql([asset.path]) : emptyLocaleNamesSql()
}

function emptyLocaleNamesSql(): string {
  return `(
    SELECT NULL::VARCHAR AS species_id,
           NULL::VARCHAR AS common_name,
           NULL::VARCHAR AS normalized_name,
           NULL::VARCHAR AS is_primary,
           NULL::VARCHAR AS display_order
    WHERE FALSE
  )`
}

function emptyImagesSql(): string {
  return `(
    SELECT NULL::VARCHAR AS species_id,
           NULL::VARCHAR AS url,
           NULL::VARCHAR AS source,
           NULL::VARCHAR AS source_page_url,
           NULL::VARCHAR AS credit,
           NULL::VARCHAR AS license
    WHERE FALSE
  )`
}

function speciesProjectionSql({
  speciesTable,
  namesTable,
  whereSql,
  searchText,
  sort = 'Name',
}: {
  readonly speciesTable: string
  readonly namesTable: string
  readonly whereSql: string
  readonly searchText: NormalizedSearchText
  readonly sort?: SpeciesSearchRequest['sort']
}): string {
  const matchPredicate = searchText.text
    ? nameMatchCondition('normalized_name', searchText)
    : 'FALSE'
  const matchedNameTier = activeSearchNameTierSql('normalized_name', searchText)
  return `
    WITH locale_names AS (
      SELECT species_id,
             common_name,
             normalized_name,
             is_primary,
             display_order
      FROM ${namesTable}
    ),
    primary_names AS (
      SELECT species_id,
             common_name,
             normalized_name,
             display_order
      FROM (
        SELECT species_id,
               common_name,
               normalized_name,
               display_order,
               ROW_NUMBER() OVER (
                 PARTITION BY species_id
                 ORDER BY TRY_CAST(display_order AS INTEGER),
                          CASE WHEN CAST(is_primary AS VARCHAR) IN ('true', '1') THEN 0 ELSE 1 END,
                          LENGTH(common_name),
                          common_name
               ) AS rank
        FROM locale_names
      )
      WHERE rank = 1
    ),
    matched_names AS (
      SELECT species_id,
             common_name,
             match_tier
      FROM (
        SELECT species_id,
               common_name,
               ${matchedNameTier} AS match_tier,
               ROW_NUMBER() OVER (
                 PARTITION BY species_id
                 ORDER BY ${matchedNameTier},
                          TRY_CAST(display_order AS INTEGER),
                          CASE WHEN CAST(is_primary AS VARCHAR) IN ('true', '1') THEN 0 ELSE 1 END,
                          LENGTH(common_name),
                          common_name
               ) AS rank
        FROM locale_names
        WHERE ${matchPredicate}
      )
      WHERE rank = 1
    )
    SELECT s.id,
           s.slug,
           s.canonical_name,
           s.common_name,
           primary_names.common_name AS localized_common_name,
           matched_names.common_name AS matched_common_name,
           s.climate_zones,
           s.habit,
           s.growth_form,
           s.life_cycles
    FROM ${speciesTable} s
    LEFT JOIN primary_names ON primary_names.species_id = s.id
    LEFT JOIN matched_names ON matched_names.species_id = s.id
    ${whereSql}
    ${speciesOrderBySql(searchText, sort)}
  `
}

function speciesWhereSql({
  searchText,
  filters,
  supportedFilters,
}: {
  readonly searchText: NormalizedSearchText
  readonly filters: SpeciesSearchRequest['filters']
  readonly supportedFilters: readonly WebSupportedFilter[]
}): string {
  const predicates = [
    searchPredicateSql(searchText),
    ...supportedFilters.flatMap((filter) => {
      const values = stringFilterValues(filters[filter.key])
      return values.length === 0 ? [] : [supportedFilterPredicateSql(filter, values)]
    }),
  ].filter((predicate) => predicate.length > 0)

  return predicates.length > 0 ? `WHERE ${predicates.join('\n  AND ')}` : ''
}

function searchPredicateSql(searchText: NormalizedSearchText): string {
  if (!searchText.text) return ''
  return `
    (
       ${nameMatchCondition('s.normalized_canonical_name', searchText)}
       OR EXISTS (
         SELECT 1
         FROM locale_names search_names
         WHERE search_names.species_id = s.id
           AND ${nameMatchCondition('search_names.normalized_name', searchText)}
       )
    )
  `
}

function speciesOrderBySql(searchText: NormalizedSearchText, sort: SpeciesSearchRequest['sort']): string {
  // The artifact has no ratings or heights, so Recommended browses species named in
  // the interface language first; the workbench offers only Recommended and Name here.
  if (!searchText.text && sort === 'Recommended') {
    return 'ORDER BY primary_names.species_id IS NULL, s.canonical_name, s.id'
  }
  if (!searchText.text) return 'ORDER BY s.canonical_name, s.id'
  const primaryName = 'primary_names.normalized_name'
  return `ORDER BY CASE
      WHEN ${primaryName} = ${quoteSqlString(searchText.text)} THEN 0
      WHEN ${primaryName} LIKE ${quoteLikePrefixPattern(searchText.text)} ESCAPE '\\' THEN 1
      WHEN ${allTokenContainsCondition(primaryName, searchText)} THEN 2
      WHEN matched_names.species_id IS NOT NULL THEN 3
      WHEN ${nameMatchCondition('s.normalized_canonical_name', searchText)} THEN 4
      ELSE 5
    END,
    COALESCE(matched_names.match_tier, 2147483647),
    TRY_CAST(primary_names.display_order AS INTEGER),
    COALESCE(LENGTH(primary_names.common_name), 2147483647),
    s.canonical_name,
    s.id`
}

function activeSearchNameTierSql(column: string, searchText: NormalizedSearchText): string {
  if (!searchText.text) return '2147483647'
  return `CASE
    WHEN ${column} = ${quoteSqlString(searchText.text)} THEN 0
    WHEN ${column} LIKE ${quoteLikePrefixPattern(searchText.text)} ESCAPE '\\' THEN 1
    WHEN ${allTokenContainsCondition(column, searchText)} THEN 2
    ELSE 3
  END`
}

function nameMatchCondition(column: string, searchText: NormalizedSearchText): string {
  const containsSearchText = `${column} LIKE ${quoteLikeContainsPattern(searchText.text)} ESCAPE '\\'`
  if (searchText.tokens.length <= 1) return `(${containsSearchText})`
  return `(${containsSearchText}
       OR ${allTokenContainsCondition(column, searchText)})`
}

function allTokenContainsCondition(column: string, searchText: NormalizedSearchText): string {
  if (searchText.tokens.length === 0) return 'FALSE'
  return searchText.tokens
    .map((token) => `${column} LIKE ${quoteLikeContainsPattern(token)} ESCAPE '\\'`)
    .join(' AND ')
}

function supportedFilterPredicateSql(
  filter: WebSupportedFilter,
  values: readonly string[],
): string {
  switch (filter.predicate.kind) {
    case 'json_array_any':
      return `(${filter.predicate.columns.flatMap((column) => (
        values.map((value) => (
          `CAST(s.${column} AS VARCHAR) LIKE ${quoteSqlString(jsonArrayLikePattern(value))} ESCAPE '\\'`
        ))
      )).join(' OR ')})`
    case 'text_any':
      return `(${filter.predicate.columns.map((column) => (
        `COALESCE(s.${column}, '') IN (${values.map(quoteSqlString).join(', ')})`
      )).join(' OR ')})`
  }
}

function jsonArrayLikePattern(value: string): string {
  return `%${escapeLikeLiteral(JSON.stringify(value))}%`
}

function escapeLikeLiteral(value: string): string {
  return value
    .split('\\').join('\\\\')
    .split('%').join('\\%')
    .split('_').join('\\_')
}

function stringFilterValues(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function quoteSqlString(value: string): string {
  return `'${value.split("'").join("''")}'`
}

function quoteLikeContainsPattern(value: string): string {
  return quoteSqlString(`%${escapeLikeLiteral(value)}%`)
}

function quoteLikePrefixPattern(value: string): string {
  return quoteSqlString(`${escapeLikeLiteral(value)}%`)
}

function emptyFilterOptions(): FilterOptions {
  return {
    families: [],
    growth_rates: [],
    climate_zones: [],
    habits: [],
    life_cycles: [],
    sun_tolerances: [],
    soil_tolerances: [],
  }
}

function supportedFilterColumns(filters: readonly WebSupportedFilter[]): string[] {
  return sortedUnique(filters.flatMap((filter) => filter.predicate.columns))
}

function valuesForSupportedFilterRow(
  row: Record<string, unknown>,
  filter: WebSupportedFilter,
): string[] {
  switch (filter.predicate.kind) {
    case 'json_array_any':
      return filter.predicate.columns.flatMap((column) => stringArray(row[column]))
    case 'text_any':
      return filter.predicate.columns.flatMap((column) => compact([nullableString(row[column])]))
  }
}

function filterOptionValues(
  options: FilterOptions,
  key: WebSupportedFilterOptionsKey,
): readonly string[] {
  return options[key]
}

function categoricalDynamicFilterOptions(
  field: string,
  values: readonly string[],
): DynamicFilterOptions {
  return {
    field,
    field_type: 'categorical',
    values: values.map((value) => ({ value, label: value })),
    range: null,
  }
}

function tableRows(table: { toArray(): unknown[] }): readonly Record<string, unknown>[] {
  return table.toArray().flatMap((row) => {
    if (!isRecord(row)) return []
    if ('toJSON' in row && typeof row.toJSON === 'function') {
      const json = row.toJSON() as unknown
      return isRecord(json) ? [json] : []
    }
    return [row]
  })
}

function parseSpeciesRow(row: Record<string, unknown>): ReducedSpeciesRow {
  return {
    id: requiredString(row.id, 'species.id'),
    slug: requiredString(row.slug, 'species.slug'),
    canonical_name: requiredString(row.canonical_name, 'species.canonical_name'),
    common_name: nullableString(row.common_name),
    climate_zones: stringArray(row.climate_zones),
    habit: nullableString(row.habit),
    growth_form: nullableString(row.growth_form),
    life_cycles: stringArray(row.life_cycles),
  }
}

function parseImageRow(row: Record<string, unknown>): ReducedSpeciesImageRow {
  return {
    species_id: requiredString(row.species_id, 'image.species_id'),
    url: requiredString(row.url, 'image.url'),
    source: nullableString(row.source),
    source_page_url: nullableString(row.source_page_url),
    credit: nullableString(row.credit),
    license: nullableString(row.license),
  }
}

interface SpeciesProjection {
  readonly row: ReducedSpeciesRow
  readonly localizedCommonName: string | null
  readonly matchedCommonName: string | null
}

function parseSpeciesProjection(row: Record<string, unknown>): SpeciesProjection {
  return {
    row: parseSpeciesRow(row),
    localizedCommonName: nullableString(row.localized_common_name),
    matchedCommonName: nullableString(row.matched_common_name),
  }
}

async function fetchCatalogJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Failed to fetch Web Edition Species Catalog asset ${url.pathname}: ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

/** The catalog directory the Web build named by its manifest's content id (vite.config.ts, 2.1-M176). */
function defaultCatalogBaseUrl(): URL {
  return new URL(__CANOPI_WEB_CATALOG_PATH__, new URL(import.meta.env.BASE_URL, globalThis.location.href))
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  throw new Error(`Invalid Web Edition Species Catalog row: ${field} is required.`)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string')
      }
    } catch {
      return []
    }
  }
  if (isRecord(value) && 'toArray' in value && typeof value.toArray === 'function') {
    const array = value.toArray() as unknown
    return Array.isArray(array)
      ? array.filter((entry): entry is string => typeof entry === 'string')
      : []
  }
  return []
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function cursorToOffset(cursor: string | null): number {
  if (cursor === null) return 0
  const match = /^offset:(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : 0
}

function speciesProjectionToListItem(
  projection: SpeciesProjection,
  favoriteNames: ReadonlySet<string>,
): SpeciesListItem {
  const row = projection.row
  const commonName = projection.localizedCommonName
  return {
    canonical_name: row.canonical_name,
    slug: row.slug,
    common_name: commonName,
    common_name_2: null,
    matched_common_name: projection.matchedCommonName,
    is_name_fallback: commonName === null,
    family: null,
    genus: null,
    height_max_m: null,
    hardiness_zone_min: null,
    hardiness_zone_max: null,
    growth_rate: null,
    stratum: null,
    habit: row.habit,
    climate_zones: [...row.climate_zones],
    life_cycles: [...row.life_cycles],
    edibility_rating: null,
    medicinal_rating: null,
    width_max_m: null,
    is_favorite: favoriteNames.has(row.canonical_name),
  }
}

function speciesProjectionToDetail(
  projection: SpeciesProjection,
  localizedCommonNames: readonly string[],
  image: ReducedSpeciesImageRow | null,
): SpeciesCatalogDetail {
  const row = projection.row
  const commonNames = localizedCommonNames.length > 0
    ? [...localizedCommonNames]
    : compact([projection.localizedCommonName])
  const commonName = commonNames[0] ?? null
  return {
    canonical_name: row.canonical_name,
    common_name: commonName,
    common_names: commonNames,
    climate_zones: [...row.climate_zones],
    habit: row.habit,
    growth_form: row.growth_form,
    life_cycles: [...row.life_cycles],
    image: image === null
      ? null
      : {
          url: image.url,
          source: image.source,
          source_page_url: image.source_page_url,
          credit: image.credit,
          license: image.license,
        },
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
