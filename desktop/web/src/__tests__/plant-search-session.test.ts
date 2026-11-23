import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlantSearchSession,
  isActiveSpeciesSearchText,
  type PlantSearchAdapter,
} from '../app/plant-browser/search-session'
import { SPECIES_SEARCH_NORMALIZATION_CORPUS } from '../generated/species-search-normalization'
import type { DynamicFilterOptions, PaginatedResult, SpeciesListItem } from '../types/species'

function makePlant(canonicalName: string): SpeciesListItem {
  return {
    canonical_name: canonicalName,
    slug: canonicalName.toLowerCase().replace(/\s+/g, '-'),
    common_name: canonicalName,
    common_name_2: null,
    matched_common_name: null,
    is_name_fallback: false,
    family: null,
    genus: null,
    height_max_m: null,
    hardiness_zone_min: null,
    hardiness_zone_max: null,
    growth_rate: null,
    stratum: null,
    habit: null,
    climate_zones: [],
    life_cycles: [],
    edibility_rating: null,
    medicinal_rating: null,
    width_max_m: null,
    is_favorite: false,
  }
}

function page(
  names: string[],
  nextCursor: string | null,
  totalEstimate: number,
): PaginatedResult<SpeciesListItem> {
  return {
    items: names.map(makePlant),
    next_cursor: nextCursor,
    total_estimate: totalEstimate,
  }
}

describe('Species Search admission', () => {
  it('routes the authored corpus through the public UI admission boundary', () => {
    for (const testCase of SPECIES_SEARCH_NORMALIZATION_CORPUS) {
      expect(isActiveSpeciesSearchText(testCase.input), testCase.name)
        .toBe(testCase.admission === 'active-text')
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('plant search session', () => {
  it('does not restart or accept commands after terminal disposal', async () => {
    const locale = signal('en')
    const search = vi.fn(async () => page([], null, 0))
    const session = createPlantSearchSession({ search, locale })

    session.dispose()
    session.start()
    session.setText('apple')
    session.patchFilters({ habit: ['Tree'] })
    session.retry()
    await flushMicrotasks()

    expect(search).not.toHaveBeenCalled()
    expect(session.intent.value.text).toBe('')
    expect(session.intent.value.filters.habit).toBeNull()
  })

  it('does not publish dynamic options that resolve after terminal disposal', async () => {
    const locale = signal('en')
    const request = deferred<DynamicFilterOptions[]>()
    const session = createPlantSearchSession({
      search: async () => page([], null, 0),
      loadDynamicFilterOptions: () => request.promise,
      locale,
    })

    const loading = session.loadDynamicOptions(['habit'])
    expect(session.signals.dynamicOptionsPending.value.en?.habit).toBe(true)

    session.dispose()
    const cacheAfterDisposal = session.signals.dynamicOptionsCache.value
    const errorsAfterDisposal = session.signals.dynamicOptionsErrors.value
    const pendingAfterDisposal = session.signals.dynamicOptionsPending.value

    request.resolve([{
      field: 'habit',
      field_type: 'categorical',
      values: [{ value: 'Shrub', label: 'Shrub' }],
      range: null,
    }])
    await loading

    expect(session.signals.dynamicOptionsCache.value).toBe(cacheAfterDisposal)
    expect(session.signals.dynamicOptionsErrors.value).toBe(errorsAfterDisposal)
    expect(session.signals.dynamicOptionsPending.value).toBe(pendingAfterDisposal)
  })

  it('does not publish or log dynamic-option failures after terminal disposal', async () => {
    const locale = signal('en')
    const request = deferred<DynamicFilterOptions[]>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = createPlantSearchSession({
      search: async () => page([], null, 0),
      loadDynamicFilterOptions: () => request.promise,
      locale,
    })

    const loading = session.loadDynamicOptions(['habit'])
    session.dispose()
    const errorsAfterDisposal = session.signals.dynamicOptionsErrors.value
    const pendingAfterDisposal = session.signals.dynamicOptionsPending.value

    request.reject(new Error('catalog unavailable'))
    await loading

    expect(session.signals.dynamicOptionsErrors.value).toBe(errorsAfterDisposal)
    expect(session.signals.dynamicOptionsPending.value).toBe(pendingAfterDisposal)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('debounces text changes before issuing a first-page request', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const search = vi.fn(async (..._args: Parameters<PlantSearchAdapter>) => page([], null, 0))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(search).toHaveBeenCalledTimes(1)

    search.mockClear()
    session.setText('a')
    session.setText('al')
    await flushMicrotasks()

    expect(session.results.value.status).toBe('loading-first-page')
    expect(search).not.toHaveBeenCalled()

    vi.advanceTimersByTime(149)
    await flushMicrotasks()
    expect(search).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await flushMicrotasks()

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'al',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Relevance',
      locale: 'en',
      include_total: false,
    }))

    dispose()
  })

  it('clears results for one-character normalized text without hitting backend search', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['Initial row'], null, 42))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Initial row'])

    search.mockClear()
    session.setText(' é ')
    await flushMicrotasks()

    expect(session.results.value.status).toBe('loading-first-page')
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Initial row'])

    vi.advanceTimersByTime(150)
    await flushMicrotasks()

    expect(search).not.toHaveBeenCalled()
    expect(session.results.value.status).toBe('idle')
    expect(session.results.value.items).toEqual([])
    expect(session.results.value.nextCursor).toBeNull()
    expect(session.results.value.totalEstimate).toBe(0)
    expect(session.results.value.committedRevision).toBe(2)

    dispose()
  })

  it('supersedes an active backend search immediately before clearing too-short text', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const activeSearch = deferred<PaginatedResult<SpeciesListItem>>()
    const supersession = deferred<void>()
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['Browse row'], null, 1))
      .mockReturnValueOnce(activeSearch.promise)
    const supersedeSearch = vi.fn(() => supersession.promise)
    const session = createPlantSearchSession({ search, supersedeSearch, locale })
    const dispose = session.start()

    await flushMicrotasks()
    session.setText('al')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    expect(search).toHaveBeenCalledTimes(2)

    session.setText('a')
    expect(supersedeSearch).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(150)
    await flushMicrotasks()

    expect(session.results.value.status).toBe('loading-first-page')
    supersession.resolve(undefined)
    await flushMicrotasks()
    expect(session.results.value).toMatchObject({
      items: [],
      nextCursor: null,
      totalEstimate: 0,
      status: 'idle',
    })

    activeSearch.resolve(page(['Stale active row'], null, 0))
    await flushMicrotasks()
    expect(session.results.value.items).toEqual([])
    dispose()
  })

  it.each([
    ['active text', 'apple', true],
    ['browse text', '', true],
    ['too-short text', 'a', false],
    ['one Han character', '栗', true],
  ] as const)(
    'immediately supersedes an active request when scheduling %s',
    async (_label, nextText, dispatchesSuccessor) => {
      vi.useFakeTimers()
      const locale = signal('en')
      const activeSearch = deferred<PaginatedResult<SpeciesListItem>>()
      const search = vi.fn<PlantSearchAdapter>()
        .mockResolvedValueOnce(page([], null, 0))
        .mockReturnValueOnce(activeSearch.promise)
        .mockResolvedValueOnce(page([], null, 0))
      const supersedeSearch = vi.fn(async () => {})
      const session = createPlantSearchSession({ search, supersedeSearch, locale })
      const stop = session.start()

      await flushMicrotasks()
      session.setText('al')
      vi.advanceTimersByTime(150)
      await flushMicrotasks()
      expect(search).toHaveBeenCalledTimes(2)

      session.setText(nextText)

      expect(supersedeSearch).toHaveBeenCalledOnce()
      expect(search).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(150)
      await flushMicrotasks()
      expect(search).toHaveBeenCalledTimes(dispatchesSuccessor ? 3 : 2)

      activeSearch.resolve(page([], null, 0))
      await flushMicrotasks()
      stop()
    },
  )

  it('serializes supersession and lets only the newest intent dispatch after it', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const activeSearch = deferred<PaginatedResult<SpeciesListItem>>()
    const firstSupersession = deferred<void>()
    const secondSupersession = deferred<void>()
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page([], null, 0))
      .mockReturnValueOnce(activeSearch.promise)
      .mockResolvedValueOnce(page(['Newest row'], null, 0))
    const supersedeSearch = vi.fn()
      .mockReturnValueOnce(firstSupersession.promise)
      .mockReturnValueOnce(secondSupersession.promise)
    const session = createPlantSearchSession({ search, supersedeSearch, locale })
    const stop = session.start()

    await flushMicrotasks()
    session.setText('al')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()

    session.setText('apple')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    session.setText('pear')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()

    expect(supersedeSearch).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledTimes(2)

    firstSupersession.resolve(undefined)
    await flushMicrotasks()
    expect(supersedeSearch).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenCalledTimes(2)

    secondSupersession.resolve(undefined)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(search).toHaveBeenCalledTimes(3)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'pear' }))
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Newest row'])

    activeSearch.resolve(page(['Stale row'], null, 0))
    await flushMicrotasks()
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Newest row'])
    stop()
  })

  it.each(['stop', 'dispose'] as const)(
    'supersedes an active backend request on session %s',
    async (lifecycleAction) => {
      vi.useFakeTimers()
      const locale = signal('en')
      const activeSearch = deferred<PaginatedResult<SpeciesListItem>>()
      const search = vi.fn<PlantSearchAdapter>()
        .mockResolvedValueOnce(page([], null, 0))
        .mockReturnValueOnce(activeSearch.promise)
      const supersedeSearch = vi.fn(async () => {})
      const session = createPlantSearchSession({ search, supersedeSearch, locale })
      const stop = session.start()

      await flushMicrotasks()
      session.setText('al')
      vi.advanceTimersByTime(150)
      await flushMicrotasks()

      if (lifecycleAction === 'stop') stop()
      else session.dispose()

      expect(supersedeSearch).toHaveBeenCalledOnce()
      activeSearch.resolve(page([], null, 0))
      await flushMicrotasks()
      session.dispose()
    },
  )

  it('keeps exact counts for empty browse and omits them for active text searches', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['Browse row'], null, 42))
      .mockResolvedValueOnce(page(['Search row'], 'offset:50', 0))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: '',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Recommended',
      locale: 'en',
      include_total: true,
    }))
    expect(session.results.value.totalEstimate).toBe(42)

    session.setText('al')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()

    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: 'al',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Relevance',
      locale: 'en',
      include_total: false,
    }))
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Search row'])
    expect(session.results.value.totalEstimate).toBe(0)

    dispose()
  })

  it('keeps active text on relevance ordering and browse on the chosen browse order', async () => {
    vi.useFakeTimers()
    const locale = signal('en')
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValue(page([], null, 0))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Recommended',
      locale: 'en',
      include_total: true,
    }))

    session.setText('lin')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'lin',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Relevance',
      locale: 'en',
      include_total: false,
    }))

    // Choosing a browse order during a search keeps relevance until the text is cleared.
    const callsBeforeSort = search.mock.calls.length
    session.setBrowseSort('Height')
    await flushMicrotasks()
    expect(search.mock.calls.length).toBe(callsBeforeSort)
    expect(session.intent.value).toMatchObject({ sort: 'Relevance', browseSort: 'Height' })

    session.setText('')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '',
      filters: expect.any(Object),
      cursor: null,
      limit: 50,
      sort: 'Height',
      locale: 'en',
      include_total: true,
    }))

    session.setBrowseSort('Name')
    await flushMicrotasks()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ text: '', sort: 'Name', cursor: null }))

    dispose()
  })

  it('ignores stale first-page responses while keeping committed rows visible', async () => {
    const locale = signal('en')
    const stale = deferred<PaginatedResult<SpeciesListItem>>()
    const fresh = deferred<PaginatedResult<SpeciesListItem>>()
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['Initial row'], null, 1))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Initial row'])
    expect(session.results.value.committedRevision).toBe(1)

    session.patchFilters({ woody: true })
    await flushMicrotasks()
    expect(session.results.value.status).toBe('loading-first-page')
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Initial row'])

    session.patchFilters({ edible: true })
    await flushMicrotasks()
    expect(search).toHaveBeenCalledTimes(3)

    stale.resolve(page(['Stale row'], null, 1))
    await flushMicrotasks()
    expect(session.results.value.status).toBe('loading-first-page')
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Initial row'])
    expect(session.results.value.committedRevision).toBe(1)

    fresh.resolve(page(['Fresh row'], null, 1))
    await flushMicrotasks()
    expect(session.results.value.status).toBe('idle')
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Fresh row'])
    expect(session.results.value.committedRevision).toBe(2)

    dispose()
  })

  it('appends pagination without advancing the committed first-page revision', async () => {
    const locale = signal('en')
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['First row'], 'offset:50', 42))
      .mockResolvedValueOnce(page(['Second row'], null, 0))
      .mockResolvedValueOnce(page(['Replacement row'], null, 7))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(session.results.value.committedRevision).toBe(1)
    expect(session.results.value.totalEstimate).toBe(42)

    await session.loadNextPage()

    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: '',
      filters: expect.any(Object),
      cursor: 'offset:50',
      limit: 50,
      sort: 'Recommended',
      locale: 'en',
      include_total: false,
    }))
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual([
      'First row',
      'Second row',
    ])
    expect(session.results.value.committedRevision).toBe(1)
    expect(session.results.value.totalEstimate).toBe(42)

    session.retry()
    await flushMicrotasks()

    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Replacement row'])
    expect(session.results.value.committedRevision).toBe(2)
    expect(session.results.value.totalEstimate).toBe(7)

    dispose()
  })

  it('preserves visible stale items when a replacement search errors', async () => {
    const locale = signal('en')
    const search = vi.fn<PlantSearchAdapter>()
      .mockResolvedValueOnce(page(['Committed row'], 'offset:50', 1))
      .mockRejectedValueOnce(new Error('backend unavailable'))
    const session = createPlantSearchSession({ search, locale })
    const dispose = session.start()

    await flushMicrotasks()
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Committed row'])

    session.patchFilters({ woody: true })
    await flushMicrotasks()

    expect(session.results.value.status).toBe('error')
    expect(session.results.value.error).toBe('backend unavailable')
    expect(session.results.value.items.map((item) => item.canonical_name)).toEqual(['Committed row'])
    expect(session.results.value.committedRevision).toBe(1)

    dispose()
  })
})
