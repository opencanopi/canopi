import { useId, useMemo, useState } from 'preact/hooks'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { speciesCatalogWorkbench, type SpeciesBrowseSort } from '../../app/plant-browser'
import { useEnglishFallbackNames } from '../../app/plant-finder/catalog-names'
import { findPlants } from '../../app/plant-finder/matcher'
import { plantFinderRecord } from '../../app/plant-finder/records'
import { formatCount } from '../../utils/format-count'
import { ControlIcon } from '../shared/ControlIcon'
import { Dropdown } from '../shared/Dropdown'
import { PlantFinder, QuickFilterChip, finderHighlight } from '../shared/PlantFinder'
import row from '../shared/species-row.module.css'
import { ActiveChips } from './ActiveChips'
import { catalogQuickFilters } from './catalog-quick-filters'
import { useCatalogDesignSpecies } from './design-species'
import { FilterStrip } from './FilterStrip'
import { ResultsList } from './ResultsList'
import styles from './PlantDb.module.css'
import type { LocaleKey } from '../../generated/locale-keys'

const SORT_LABEL_KEYS: Readonly<Record<SpeciesBrowseSort, LocaleKey>> = {
  Recommended: 'plantDb.sortRecommended',
  Name: 'plantDb.sortName',
  Height: 'plantDb.sortHeight',
  Edibility: 'plantDb.sortEdibility',
}

/**
 * The catalog list shared by both editions: the finder (search, quick filters, "Filters"),
 * active filters as removable tokens, the count with Sort and Clear filters, and the rows.
 * Each edition wraps it with its own header, detail and "More filters".
 */
export function CatalogBrowser({ onMoreFilters, searchScope }: {
  /** Opens the filters beyond the strip; Desktop only. */
  readonly onMoreFilters?: () => void
  /** What a search looks through, e.g. "common names in English, scientific names and families". */
  readonly searchScope: string
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersId = useId()
  const listId = useId()
  const intent = speciesCatalogWorkbench.intent.value
  const results = speciesCatalogWorkbench.results.value
  const filterStrip = speciesCatalogWorkbench.filterStrip.value
  const hasFilters = speciesCatalogWorkbench.hasActiveFilters.value
  const filterCount = filterStrip.activeCount
  const designSpecies = useCatalogDesignSpecies()
  const query = intent.text.trim()
  const searching = speciesCatalogWorkbench.isActiveSearchText(intent.text)
  const englishNames = useEnglishFallbackNames(useMemo(() => results.items.map((item) => ({
    canonicalName: item.canonical_name,
    commonName: item.common_name,
  })), [results.items]))
  const marks = useMemo(() => searching
    ? findPlants(results.items.map((item) => plantFinderRecord({
      canonicalName: item.canonical_name,
      commonName: item.common_name || englishNames.get(item.canonical_name),
      otherNames: [item.matched_common_name],
    })), query)
    : null, [englishNames, results.items, query, searching])
  const browseSorts = speciesCatalogWorkbench.browseSorts
  const loc = locale.value

  return (
    <>
      <div className={styles.controls}>
        <PlantFinder
          value={intent.text}
          onChange={(value) => speciesCatalogWorkbench.setSearchText(value)}
          label={t('plantDb.searchLabel')}
          placeholder={t('plantDb.searchPlaceholder')}
          controls={listId}
          filters={<>
            {catalogQuickFilters(filterStrip).map((filter) => (
              <QuickFilterChip
                key={filter.id}
                pressed={filter.pressed(filterStrip.filters)}
                label={t(filter.labelKey)}
                onChange={() => speciesCatalogWorkbench.patchFilters(filter.toggle(filterStrip.filters))}
              />
            ))}
            {filterStrip.controls.length > 0 && (
              <button
                type="button"
                className={styles.filtersToggle}
                aria-expanded={filtersOpen}
                aria-controls={filtersId}
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                {t('plantDb.filters')}
                {filterCount > 0 && <span className={styles.filterBadge}>{formatCount(filterCount, loc)}</span>}
                <ControlIcon name={filtersOpen ? 'chevron-down' : 'chevron-right'} />
              </button>
            )}
          </>}
          summary={countLine(results, searching, query)}
          summaryActions={<>
            {!searching && browseSorts.length > 1 && results.items.length > 0 && (
              <Dropdown<SpeciesBrowseSort>
                trigger={<>
                  <span aria-hidden="true">{t('plantDb.sortTrigger', { sort: t(SORT_LABEL_KEYS[intent.browseSort]) })}</span>
                  <span className={row.srOnly}>{t(SORT_LABEL_KEYS[intent.browseSort])}</span>
                </>}
                ariaLabel={t('plantDb.sort')}
                value={intent.browseSort}
                items={browseSorts.map((sort) => ({ value: sort, label: t(SORT_LABEL_KEYS[sort]) }))}
                onChange={(sort) => speciesCatalogWorkbench.setBrowseSort(sort)}
                triggerClassName={styles.sortTrigger}
                floating
              />
            )}
            {hasFilters && (
              <button type="button" className={styles.linkBtn} onClick={() => speciesCatalogWorkbench.clearFilters()}>
                {t('plantDb.clearFilters')}
              </button>
            )}
          </>}
        >
          {filtersOpen && (
            <div id={filtersId} className={styles.filterRegion}>
              <FilterStrip onMoreFilters={onMoreFilters} />
            </div>
          )}
          <ActiveChips />
        </PlantFinder>
      </div>
      <ResultsList
        id={listId}
        designSpecies={designSpecies}
        englishNames={englishNames}
        highlight={marks ? (canonicalName) => finderHighlight(marks.byKey.get(canonicalName)) : undefined}
        footer={<p className={styles.hint}>
          {searching ? t('plantDb.searchedIn', { scope: searchScope }) : designSpecies.size > 0 ? t('plantDb.codesHint') : null}
        </p>}
      />
    </>
  )
}

/** "175,473 species", "50+ species" while a search has more pages, or what is happening. */
function countLine(
  results: ReturnType<typeof speciesCatalogWorkbench.results.peek>,
  searching: boolean,
  query: string,
): string {
  if (results.status === 'loading-first-page' && results.items.length === 0) return t('plantDb.loading')
  if (results.error !== null && results.items.length === 0) return ''
  if (query && !searching) return t('plantDb.tooShort')
  if (searching) {
    return results.nextCursor !== null
      ? t('plantDb.speciesAtLeast', { count: results.items.length })
      : t('plantFinder.species', { count: results.items.length })
  }
  return t('plantFinder.species', { count: results.totalEstimate || results.items.length })
}
