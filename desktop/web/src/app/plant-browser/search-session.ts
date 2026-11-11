import { batch, computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import type {
  DynamicFilter,
  DynamicFilterOptions,
  FilterOp,
  PaginatedResult,
  SpeciesFilter,
  SpeciesListItem,
  SpeciesSearchRequest,
} from '../../types/species'
import { reportFailure } from '../../failures/report'
import { speciesSearchAdmission } from '../../utils/species-search-normalization'
import { createEmptySpeciesFilter, plantFilterModel } from './plant-filter-model'

export type PlantSearchStatus = 'idle' | 'loading-first-page' | 'loading-next-page' | 'error'

/** Browse orders a user can pick; an active search text always ranks by relevance. */
export type SpeciesBrowseSort = Exclude<SpeciesSearchRequest['sort'], 'Relevance'>

const DEFAULT_SPECIES_BROWSE_SORT: SpeciesBrowseSort = 'Recommended'

export interface PlantSearchIntent {
  readonly text: string
  readonly filters: SpeciesFilter
  readonly extraFilters: readonly DynamicFilter[]
  readonly sort: SpeciesSearchRequest['sort']
  /** The chosen browse order, kept while a search text ranks by relevance. */
  readonly browseSort: SpeciesBrowseSort
  readonly locale: string
}

export interface PlantSearchResultState {
  readonly items: readonly SpeciesListItem[]
  readonly nextCursor: string | null
  readonly totalEstimate: number
  readonly committedRevision: number
  readonly status: PlantSearchStatus
  readonly error: string | null
}

interface PlantSearchSession {
  readonly intent: ReadonlySignal<PlantSearchIntent>
  readonly results: ReadonlySignal<PlantSearchResultState>
  setText(text: string): void
  setBrowseSort(sort: SpeciesBrowseSort): void
  patchFilters(patch: Partial<SpeciesFilter>): void
  retry(): void
  loadNextPage(): Promise<void>
  dispose(): void
}

export type PlantSearchAdapter = (
  request: SpeciesSearchRequest,
) => Promise<PaginatedResult<SpeciesListItem>>

export type PlantSearchSupersedeAdapter = () => Promise<void>

export type DynamicFilterOptionsAdapter = (
  fields: string[],
  locale: string,
) => Promise<DynamicFilterOptions[]>

interface PlantSearchSessionSignals {
  readonly text: Signal<string>
  readonly browseSort: Signal<SpeciesBrowseSort>
  readonly filters: Signal<SpeciesFilter>
  readonly extraFilters: Signal<DynamicFilter[]>
  readonly items: Signal<SpeciesListItem[]>
  readonly nextCursor: Signal<string | null>
  readonly totalEstimate: Signal<number>
  readonly committedRevision: Signal<number>
  readonly status: Signal<PlantSearchStatus>
  readonly error: Signal<string | null>
  readonly dynamicOptionsCache: Signal<Record<string, Record<string, DynamicFilterOptions>>>
  readonly dynamicOptionsPending: Signal<Record<string, Record<string, boolean>>>
  readonly dynamicOptionsErrors: Signal<Record<string, Record<string, string>>>
}

export interface ManagedPlantSearchSession extends PlantSearchSession {
  readonly signals: PlantSearchSessionSignals
  start(): () => void
  addExtraFilter(field: string, op: FilterOp, values: string[]): void
  removeExtraFilter(field: string): void
  clearFilters(): void
  loadDynamicOptions(fields: string[]): Promise<void>
  updateResultItem(
    canonicalName: string,
    update: (item: SpeciesListItem) => SpeciesListItem,
  ): void
}

type TimerHandle = ReturnType<typeof setTimeout>

interface PlantSearchTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

interface PlantSearchSessionOptions {
  readonly search: PlantSearchAdapter
  readonly supersedeSearch?: PlantSearchSupersedeAdapter
  readonly loadDynamicFilterOptions?: DynamicFilterOptionsAdapter
  readonly locale: ReadonlySignal<string>
  readonly pageSize?: number
  readonly textDebounceMs?: number
  readonly timers?: PlantSearchTimers
}

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_TEXT_DEBOUNCE_MS = 150
type SearchTextPolicy = 'browse' | 'too-short' | 'active-text'

export const DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR =
  'Filter not exposed by running desktop backend. Restart the app after rebuilding.'

const defaultTimers: PlantSearchTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

export function isPlantSearchLoading(status: PlantSearchStatus): boolean {
  return status === 'loading-first-page' || status === 'loading-next-page'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A catalog request that failed: the raw error goes to the frontend diagnostics only (redacted there), never the
 * console or the page, which say "The plant catalog couldn’t load." with Retry (canopi-etzh). The error state keeps
 * the message for the surfaces' own tests and logic.
 */
export function recordCatalogFailure(caught: unknown): void {
  reportFailure(caught, { shown: 'none', source: 'plant-catalog', level: 'error' })
}

function searchTextPolicy(rawText: string): SearchTextPolicy {
  return speciesSearchAdmission(rawText)
}

function buildSearchRequest(
  intent: PlantSearchIntent,
  cursor: string | null,
  limit: number,
  includeTotal: boolean,
): SpeciesSearchRequest {
  return {
    text: intent.text,
    filters: plantFilterModel.toRequestFilters(intent.filters, intent.extraFilters),
    cursor,
    limit,
    sort: intent.sort,
    locale: intent.locale,
    include_total: includeTotal,
  }
}

export function isActiveSpeciesSearchText(rawText: string): boolean {
  return searchTextPolicy(rawText) === 'active-text'
}

export function createPlantSearchSession({
  search,
  supersedeSearch = async () => {},
  loadDynamicFilterOptions = async () => [],
  locale,
  pageSize = DEFAULT_PAGE_SIZE,
  textDebounceMs = DEFAULT_TEXT_DEBOUNCE_MS,
  timers = defaultTimers,
}: PlantSearchSessionOptions): ManagedPlantSearchSession {
  const text = signal('')
  const browseSort = signal<SpeciesBrowseSort>(DEFAULT_SPECIES_BROWSE_SORT)
  const filters = signal<SpeciesFilter>(createEmptySpeciesFilter())
  const extraFilters = signal<DynamicFilter[]>([])
  const items = signal<SpeciesListItem[]>([])
  const nextCursor = signal<string | null>(null)
  const totalEstimate = signal(0)
  const committedRevision = signal(0)
  const status = signal<PlantSearchStatus>('idle')
  const error = signal<string | null>(null)
  const dynamicOptionsCache = signal<Record<string, Record<string, DynamicFilterOptions>>>({})
  const dynamicOptionsPending = signal<Record<string, Record<string, boolean>>>({})
  const dynamicOptionsErrors = signal<Record<string, Record<string, string>>>({})

  const effectiveSort = computed<SpeciesSearchRequest['sort']>(() => {
    if (isActiveSpeciesSearchText(text.value)) {
      return 'Relevance'
    }

    return browseSort.value
  })

  const intent = computed<PlantSearchIntent>(() => ({
    text: text.value,
    filters: filters.value,
    extraFilters: extraFilters.value,
    sort: effectiveSort.value,
    browseSort: browseSort.value,
    locale: locale.value,
  }))

  const results = computed<PlantSearchResultState>(() => ({
    items: items.value,
    nextCursor: nextCursor.value,
    totalEstimate: totalEstimate.value,
    committedRevision: committedRevision.value,
    status: status.value,
    error: error.value,
  }))

  let searchGeneration = 0
  let debounceTimer: TimerHandle | null = null
  let disposeIntentEffect: (() => void) | null = null
  let lastText = text.peek()
  let disposed = false
  let activeBackendSearches = 0
  let supersessionPending = false
  let supersessionTail = Promise.resolve()

  function invokeSupersession(): Promise<void> {
    try {
      return Promise.resolve(supersedeSearch())
    } catch (caught) {
      return Promise.reject(caught)
    }
  }

  function enqueueSupersession(): Promise<void> {
    const operation = supersessionPending
      ? supersessionTail.then(invokeSupersession)
      : invokeSupersession()
    supersessionPending = true
    const completion = operation.catch((caught) => {
      console.error('Failed to supersede active Species Search', caught)
    })
    supersessionTail = completion
    void completion.finally(() => {
      if (supersessionTail === completion) supersessionPending = false
    })
    return completion
  }

  function supersedeActiveBackendSearch(): Promise<void> {
    return activeBackendSearches > 0 ? enqueueSupersession() : supersessionTail
  }

  async function runBackendSearch(
    request: SpeciesSearchRequest,
  ): Promise<PaginatedResult<SpeciesListItem>> {
    activeBackendSearches += 1
    try {
      return await search(request)
    } finally {
      activeBackendSearches -= 1
    }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer === null) return
    timers.clearTimeout(debounceTimer)
    debounceTimer = null
  }

  function currentIntent(): PlantSearchIntent {
    return intent.value
  }

  async function executeFirstPage(
    generation: number,
    dispatchBarrier: Promise<void>,
  ): Promise<void> {
    await dispatchBarrier
    if (generation !== searchGeneration || disposed) return

    const requestIntent = currentIntent()
    const textPolicy = searchTextPolicy(requestIntent.text)

    if (textPolicy === 'too-short') {
      if (generation !== searchGeneration) return

      batch(() => {
        items.value = []
        committedRevision.value += 1
        nextCursor.value = null
        totalEstimate.value = 0
        status.value = 'idle'
        error.value = null
      })
      return
    }

    const includeTotal = textPolicy === 'browse'

    try {
      const result = await runBackendSearch(
        buildSearchRequest(requestIntent, null, pageSize, includeTotal),
      )

      if (generation !== searchGeneration) return

      batch(() => {
        items.value = result.items
        committedRevision.value += 1
        nextCursor.value = result.next_cursor
        totalEstimate.value = includeTotal ? result.total_estimate : 0
        status.value = 'idle'
        error.value = null
      })
    } catch (caught) {
      if (generation !== searchGeneration) return
      recordCatalogFailure(caught)
      batch(() => {
        status.value = 'error'
        error.value = errorMessage(caught)
      })
    }
  }

  function scheduleFirstPage(debounceMs: number): void {
    if (disposed) return
    searchGeneration += 1
    const generation = searchGeneration
    const dispatchBarrier = supersedeActiveBackendSearch()

    batch(() => {
      nextCursor.value = null
      error.value = null
      status.value = 'loading-first-page'
    })

    clearDebounceTimer()
    if (debounceMs <= 0) {
      void executeFirstPage(generation, dispatchBarrier)
      return
    }

    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null
      void executeFirstPage(generation, dispatchBarrier)
    }, debounceMs)
  }

  function start(): () => void {
    if (disposed) return () => {}
    if (disposeIntentEffect !== null) return stop

    lastText = text.peek()
    disposeIntentEffect = effect(() => {
      const currentText = text.value
      void filters.value
      void extraFilters.value
      void effectiveSort.value
      void locale.value

      const textChanged = currentText !== lastText
      lastText = currentText
      scheduleFirstPage(textChanged ? textDebounceMs : 0)
    })

    return stop
  }

  function stop(): void {
    const wasActive = disposeIntentEffect !== null ||
      debounceTimer !== null ||
      isPlantSearchLoading(status.value)
    if (!wasActive) return
    disposeIntentEffect?.()
    disposeIntentEffect = null
    clearDebounceTimer()
    searchGeneration += 1
    void supersedeActiveBackendSearch()
    if (isPlantSearchLoading(status.value)) {
      status.value = 'idle'
    }
  }

  async function loadNextPage(): Promise<void> {
    if (disposed) return
    const cursor = nextCursor.value
    if (cursor === null || isPlantSearchLoading(status.value)) return

    const generation = searchGeneration
    const requestIntent = currentIntent()
    const dispatchBarrier = supersessionTail
    status.value = 'loading-next-page'
    error.value = null

    try {
      await dispatchBarrier
      if (generation !== searchGeneration || disposed) return
      const result = await runBackendSearch(
        buildSearchRequest(requestIntent, cursor, pageSize, false),
      )

      if (generation !== searchGeneration) return

      batch(() => {
        items.value = [...items.value, ...result.items]
        nextCursor.value = result.next_cursor
        status.value = 'idle'
        error.value = null
      })
    } catch (caught) {
      if (generation !== searchGeneration) return
      recordCatalogFailure(caught)
      batch(() => {
        status.value = 'error'
        error.value = errorMessage(caught)
      })
    }
  }

  async function loadDynamicOptions(fields: string[]): Promise<void> {
    if (disposed) return

    const currentLocale = locale.value
    const cacheForLocale = dynamicOptionsCache.value[currentLocale] ?? {}
    const pendingForLocale = dynamicOptionsPending.value[currentLocale] ?? {}
    const uncached = fields.filter((field) => !cacheForLocale[field] && !pendingForLocale[field])
    if (uncached.length === 0) return

    const errorsForLocale = { ...(dynamicOptionsErrors.value[currentLocale] ?? {}) }
    for (const field of uncached) {
      delete errorsForLocale[field]
    }
    dynamicOptionsErrors.value = {
      ...dynamicOptionsErrors.value,
      [currentLocale]: errorsForLocale,
    }

    dynamicOptionsPending.value = {
      ...dynamicOptionsPending.value,
      [currentLocale]: {
        ...pendingForLocale,
        ...Object.fromEntries(uncached.map((field) => [field, true])),
      },
    }

    try {
      const options = await loadDynamicFilterOptions(uncached, currentLocale)
      if (disposed) return

      const updatedLocale = { ...(dynamicOptionsCache.value[currentLocale] ?? {}) }
      const updatedErrors = { ...(dynamicOptionsErrors.value[currentLocale] ?? {}) }
      for (const option of options) {
        updatedLocale[option.field] = option
        delete updatedErrors[option.field]
      }

      const returnedFields = new Set(options.map((option) => option.field))
      const missingFields = uncached.filter((field) => !returnedFields.has(field))
      if (missingFields.length > 0) {
        console.error('Dynamic filter options missing from IPC response', {
          locale: currentLocale,
          requested: uncached,
          returned: [...returnedFields],
          missing: missingFields,
        })
        for (const field of missingFields) {
          updatedErrors[field] = DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR
        }
      }

      dynamicOptionsCache.value = { ...dynamicOptionsCache.value, [currentLocale]: updatedLocale }
      dynamicOptionsErrors.value = { ...dynamicOptionsErrors.value, [currentLocale]: updatedErrors }
    } catch (caught) {
      if (disposed) return

      const message = errorMessage(caught)
      recordCatalogFailure(caught)
      dynamicOptionsErrors.value = {
        ...dynamicOptionsErrors.value,
        [currentLocale]: {
          ...(dynamicOptionsErrors.value[currentLocale] ?? {}),
          ...Object.fromEntries(uncached.map((field) => [field, message])),
        },
      }
    } finally {
      if (!disposed) {
        const localePending = { ...(dynamicOptionsPending.value[currentLocale] ?? {}) }
        for (const field of uncached) {
          delete localePending[field]
        }
        dynamicOptionsPending.value = {
          ...dynamicOptionsPending.value,
          [currentLocale]: localePending,
        }
      }
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stop()
  }

  return {
    intent,
    results,
    signals: {
      text,
      browseSort,
      filters,
      extraFilters,
      items,
      nextCursor,
      totalEstimate,
      committedRevision,
      status,
      error,
      dynamicOptionsCache,
      dynamicOptionsPending,
      dynamicOptionsErrors,
    },
    start,
    setText(nextText) {
      if (disposed) return
      text.value = nextText
    },
    setBrowseSort(sort) {
      if (disposed) return
      browseSort.value = sort
    },
    patchFilters(patch) {
      if (disposed) return
      filters.value = { ...filters.value, ...patch }
    },
    addExtraFilter(field, op, values) {
      if (disposed) return
      const without = extraFilters.value.filter((filter) => filter.field !== field)
      extraFilters.value = [...without, { field, op, values }]
    },
    removeExtraFilter(field) {
      if (disposed) return
      extraFilters.value = extraFilters.value.filter((filter) => filter.field !== field)
    },
    clearFilters() {
      if (disposed) return
      batch(() => {
        filters.value = createEmptySpeciesFilter()
        extraFilters.value = []
      })
    },
    retry() {
      if (disposed) return
      scheduleFirstPage(0)
    },
    loadNextPage,
    loadDynamicOptions,
    updateResultItem(canonicalName, update) {
      if (disposed) return
      items.value = items.value.map((item) =>
        item.canonical_name === canonicalName ? update(item) : item,
      )
    },
    dispose,
  }
}
