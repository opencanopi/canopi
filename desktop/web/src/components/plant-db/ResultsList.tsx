import type { ComponentChildren } from 'preact'
import { useRef, useLayoutEffect, useReducer } from 'preact/hooks'
import { useSignalEffect } from '@preact/signals'
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
  elementScroll,
} from '@tanstack/virtual-core'
import { t } from '../../i18n'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import { plantCatalogCause } from '../../failures/health'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import type { CatalogDesignSpecies } from './design-species'
import { PlantRow } from './PlantRow'
import styles from './PlantDb.module.css'

// Force a re-render (used as Virtualizer.onChange callback)
function useForceUpdate(): () => void {
  const [, dispatch] = useReducer((n: number) => n + 1, 0)
  return dispatch as () => void
}

/** Rows have one fixed height (names and facts stay on one line each) so the list can virtualise. */
const ROW_HEIGHT = 62

function makeVirtOpts(
  scrollRef: { current: HTMLDivElement | null },
  count: number,
  onChange: (instance: Virtualizer<HTMLDivElement, Element>) => void,
) {
  return {
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange,
  }
}

export function ResultsList({ id, designSpecies, englishNames, highlight, footer }: {
  readonly id?: string
  readonly designSpecies: ReadonlyMap<string, CatalogDesignSpecies>
  /** English catalog names of rows with no name in the interface language, shown marked "(en)". */
  readonly englishNames?: ReadonlyMap<string, string>
  /** Marks a row's names with the search matches, by canonical name. */
  readonly highlight?: (canonicalName: string) => ((text: string) => ComponentChildren) | undefined
  /** A quiet hint under the rows. */
  readonly footer?: ComponentChildren
}) {
  const resultState = speciesCatalogWorkbench.results.value
  const results = resultState.items
  const resultSetRevision = resultState.committedRevision
  const searching = speciesCatalogWorkbench.isSearchLoading(resultState.status)
  const error = resultState.error
  const hasMore = resultState.nextCursor !== null

  const scrollRef = useRef<HTMLDivElement>(null)
  const forceUpdate = useForceUpdate()
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null)
  const showList = results.length > 0

  // Rebuild the virtualizer when a brand-new first page replaces the current
  // result set. Query text can change before the async search resolves, so using
  // query inputs as the reset key recreates the list against stale rows.
  useLayoutEffect(() => {
    if (!showList) return
    if (scrollRef.current) scrollRef.current.scrollTop = 0

    const handleChange = (instance: Virtualizer<HTMLDivElement, Element>) => {
      virtualizerRef.current = instance
      forceUpdate()
    }
    const virt = new Virtualizer<HTMLDivElement, Element>(
      makeVirtOpts(scrollRef, results.length, handleChange),
    )
    virtualizerRef.current = virt
    const cleanup = virt._didMount()
    virt._willUpdate()

    return () => {
      cleanup?.()
      virtualizerRef.current = null
    }
  // forceUpdate is stable (reducer dispatch); rebuild when the displayed result set is replaced.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultSetRevision, showList])

  // Keep Virtualizer measurements in sync when rows are appended or replaced
  // without swapping to a new scroll element.
  useSignalEffect(() => {
    const items = speciesCatalogWorkbench.results.value.items
    const virt = virtualizerRef.current
    if (!virt) return
    virt.setOptions(
      makeVirtOpts(scrollRef, items.length, (instance) => {
        virtualizerRef.current = instance
        forceUpdate()
      }),
    )
    virt.measure()
  })

  // Infinite scroll: load next page when near the bottom
  const handleScroll = () => {
    const el = scrollRef.current
    const latestResults = speciesCatalogWorkbench.results.value
    if (!el || speciesCatalogWorkbench.isSearchLoading(latestResults.status) || latestResults.nextCursor === null) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      void speciesCatalogWorkbench.loadNextPage()
    }
  }

  if (searching && results.length === 0) {
    return (
      <div className={styles.listContainer}>
        <p className={styles.listLoader} role="status" aria-busy="true">{t('plantDb.loading')}</p>
      </div>
    )
  }

  const cause = plantCatalogCause()
  if (error !== null && results.length === 0 && cause !== null) {
    // Search short-circuits without the database file; say why, as the notice does, instead of the internal error.
    return (
      <div className={styles.listContainer}>
        <div className={styles.listError} role="alert">
          <span>{t(cause === 'open_failed' ? 'health.plantDbCorrupt' : 'health.plantDbMissing')}</span>
        </div>
      </div>
    )
  }

  if (error !== null && results.length === 0) {
    return (
      <div className={styles.listContainer}>
        <div className={styles.listError} role="alert">
          <span>{t('plantDb.loadFailed')}</span>
          <button type="button" className={styles.retryBtn} onClick={() => speciesCatalogWorkbench.retrySearch()}>
            {t('plantDb.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className={styles.listContainer}>
        <CatalogEmptyState />
      </div>
    )
  }

  const virt = virtualizerRef.current
  const virtualItems = virt?.getVirtualItems() ?? []
  const totalSize = virt?.getTotalSize() ?? results.length * ROW_HEIGHT

  return (
    <div ref={scrollRef} className={styles.listContainer} onScroll={handleScroll}>
      <div
        id={id}
        className={styles.listInner}
        style={{ height: `${totalSize}px` }}
        role="list"
        aria-label={t('plantDb.title')}
      >
        {virtualItems.map((virtualRow) => {
          const plant = results[virtualRow.index]
          if (!plant) return null
          return (
            <div
              key={virtualRow.key}
              className={styles.virtualRow}
              data-index={virtualRow.index}
              style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
            >
              <PlantRow
                plant={plant}
                inDesign={designSpecies.get(plant.canonical_name)}
                englishName={englishNames?.get(plant.canonical_name)}
                highlight={highlight?.(plant.canonical_name)}
              />
            </div>
          )
        })}
      </div>
      {(searching || hasMore) && (
        <p className={styles.listLoader} role="status" aria-busy={searching}>
          {searching ? t('plantDb.loadingMore') : ''}
        </p>
      )}
      {!hasMore && footer}
    </div>
  )
}

/** No rows: nothing matches the search or filters, or the catalog itself is empty. */
function CatalogEmptyState() {
  const intent = speciesCatalogWorkbench.intent.value
  const query = intent.text.trim()
  const filterCount = speciesCatalogWorkbench.filterStrip.value.activeCount
  const hasFilters = speciesCatalogWorkbench.hasActiveFilters.value
  if (!query && !hasFilters) {
    return (
      <EmptyState
        icon={<PanelIcon panel="plant-db" />}
        action={{ label: t('plantDb.retry'), onClick: () => speciesCatalogWorkbench.retrySearch() }}
      >
        {t('plantDb.emptyCatalog')}
      </EmptyState>
    )
  }
  if (query && !speciesCatalogWorkbench.isActiveSearchText(query) && !hasFilters) {
    return <EmptyState status>{t('plantDb.tooShort')}</EmptyState>
  }
  const message = query && hasFilters
    ? t('plantDb.noResultsQueryFilters', { query, count: Math.max(filterCount, 1) })
    : query
      ? t('plantDb.noResultsQuery', { query })
      : t('plantDb.noResultsFilters', { count: Math.max(filterCount, 1) })
  return (
    <EmptyState
      status
      action={hasFilters ? { label: t('plantDb.clearFilters'), onClick: () => speciesCatalogWorkbench.clearFilters() } : undefined}
    >
      {message}
    </EmptyState>
  )
}
