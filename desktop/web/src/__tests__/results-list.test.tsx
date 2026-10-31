// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaginatedResult, SpeciesListItem } from '../types/species'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import {
  createTestSpeciesCatalogWorkbench,
  emptySpeciesSearchResult,
  makeSpeciesListItem,
} from './support/species-catalog-workbench'
import type * as ResultsListModule from '../components/plant-db/ResultsList'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'

const virtualCoreMocks = vi.hoisted(() => {
  const instances: Array<{
    cleanup: ReturnType<typeof vi.fn>
    setOptions: ReturnType<typeof vi.fn>
    measure: ReturnType<typeof vi.fn>
    _didMount: ReturnType<typeof vi.fn>
    _willUpdate: ReturnType<typeof vi.fn>
    getVirtualItems: ReturnType<typeof vi.fn>
    getTotalSize: ReturnType<typeof vi.fn>
    options: {
      count: number
      getScrollElement?: () => unknown
      onChange?: (instance: unknown) => void
    }
  }> = []

  class MockVirtualizer {
    cleanup = vi.fn()
    scrollElement: unknown = null
    options: {
      count: number
      getScrollElement?: () => unknown
      onChange?: (instance: unknown) => void
    }

    constructor(options: {
      count: number
      getScrollElement?: () => unknown
      onChange?: (instance: unknown) => void
    }) {
      this.options = options
      instances.push(this)
    }

    setOptions = vi.fn((nextOptions: {
      count: number
      getScrollElement?: () => unknown
      onChange?: (instance: unknown) => void
    }) => {
      this.options = nextOptions
    })

    measure = vi.fn(() => {
      this.options.onChange?.(this)
    })

    _didMount = vi.fn(() => this.cleanup)

    _willUpdate = vi.fn(() => {
      const nextScrollElement = this.options.getScrollElement?.() ?? null
      if (this.scrollElement !== nextScrollElement) {
        this.scrollElement = nextScrollElement
        this.options.onChange?.(this)
      }
    })

    getVirtualItems = vi.fn(() => (
      Array.from({ length: Math.min(this.options.count, 3) }, (_, index) => ({
        index,
        key: `row-${index}`,
        size: 38,
        start: index * 38,
      }))
    ))

    getTotalSize = vi.fn(() => this.options.count * 38)
  }

  return {
    instances,
    MockVirtualizer,
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
    elementScroll: vi.fn(),
  }
})

vi.mock('@tanstack/virtual-core', () => ({
  Virtualizer: virtualCoreMocks.MockVirtualizer,
  observeElementRect: virtualCoreMocks.observeElementRect,
  observeElementOffset: virtualCoreMocks.observeElementOffset,
  elementScroll: virtualCoreMocks.elementScroll,
}))

vi.mock('../components/plant-db/PlantRow', () => ({
  PlantRow: ({ plant }: { plant: SpeciesListItem }) => <div>{plant.canonical_name}</div>,
}))

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ResultsList', () => {
  let container: HTMLDivElement
  let ResultsList: typeof ResultsListModule.ResultsList
  let locale: typeof SettingsStateModule.locale
  let workbench: SpeciesCatalogWorkbench
  let searchResponses: Array<PaginatedResult<SpeciesListItem> | Promise<PaginatedResult<SpeciesListItem>>>

  beforeEach(async () => {
    vi.resetModules()
    virtualCoreMocks.instances.length = 0
    searchResponses = []
    const settings = await import('../app/settings/state')
    locale = settings.locale
    locale.value = 'en'
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      search: async () => searchResponses.shift() ?? emptySpeciesSearchResult(),
    })
    vi.doMock('../app/plant-browser', async () => {
      const actual = await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser')
      return {
        ...actual,
        speciesCatalogWorkbench: workbench,
      }
    })
    ;({ ResultsList } = await import('../components/plant-db/ResultsList'))

    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
  })

  it('says why plant search is off when the plant database is unavailable, not the internal error', async () => {
    const { plantDbStatus } = await import('../app/health/state')
    plantDbStatus.value = 'missing'
    searchResponses.push(Promise.reject(new Error('Plant database unavailable: bundled plant database is missing')))
    try {
      workbench.mount()
      await flushMicrotasks()
      await act(async () => {
        render(<ResultsList designSpecies={new Map()} />, container)
      })
      const alert = container.querySelector('[role="alert"]')!
      expect(alert.textContent).toContain("The plant catalog's database file is missing")
      expect(alert.textContent).not.toContain('bundled plant database')
      // Retrying cannot bring the file back.
      expect(alert.querySelector('button')).toBeNull()
    } finally {
      plantDbStatus.value = 'available'
    }
  })

  it('keeps the existing virtualizer when only more rows are appended', async () => {
    searchResponses.push({
      items: [
        makeSpeciesListItem('Achillea millefolium'),
        makeSpeciesListItem('Aegopodium podagraria'),
        makeSpeciesListItem('Allium angulosum'),
      ],
      next_cursor: 'offset:3',
      total_estimate: 4,
    })
    workbench.mount()
    await flushMicrotasks()

    await act(async () => {
      render(<ResultsList designSpecies={new Map()} />, container)
    })

    expect(virtualCoreMocks.instances).toHaveLength(1)
    const firstVirtualizer = virtualCoreMocks.instances[0]

    searchResponses.push({
      items: [makeSpeciesListItem('Allium carinatum')],
      next_cursor: null,
      total_estimate: 0,
    })

    await act(async () => {
      await workbench.loadNextPage()
    })

    expect(virtualCoreMocks.instances).toHaveLength(1)
    expect(firstVirtualizer?.setOptions).toHaveBeenCalled()
    expect(firstVirtualizer?.measure).toHaveBeenCalled()
    expect(firstVirtualizer?.cleanup).not.toHaveBeenCalled()
  })

  it('rebuilds the virtualizer when a new first-page result set replaces stale rows', async () => {
    searchResponses.push({
      items: [
        makeSpeciesListItem('Abies alba'),
        makeSpeciesListItem('Abies spectabilis'),
      ],
      next_cursor: null,
      total_estimate: 2,
    })
    workbench.mount()
    await flushMicrotasks()

    await act(async () => {
      render(<ResultsList designSpecies={new Map()} />, container)
    })

    expect(virtualCoreMocks.instances).toHaveLength(1)
    const firstVirtualizer = virtualCoreMocks.instances[0]
    const replacement = deferred<PaginatedResult<SpeciesListItem>>()
    searchResponses.push(replacement.promise)

    await act(async () => {
      workbench.setSearchText('as')
      await flushMicrotasks()
    })

    expect(virtualCoreMocks.instances).toHaveLength(1)

    await act(async () => {
      replacement.resolve({
        items: Array.from({ length: 50 }, (_, index) =>
          makeSpeciesListItem(`Plant ${index + 1}`),
        ),
        next_cursor: null,
        total_estimate: 50,
      })
      await flushMicrotasks()
    })

    expect(virtualCoreMocks.instances).toHaveLength(2)
    expect(firstVirtualizer?.cleanup).toHaveBeenCalledTimes(1)
  })
})
