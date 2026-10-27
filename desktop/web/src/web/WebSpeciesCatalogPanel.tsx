import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { speciesCatalogWorkbench } from '../app/plant-browser'
import { useEnglishFallbackNames } from '../app/plant-finder/catalog-names'
import {
  writePlantStampDragData,
} from '../canvas/plant-stamp-source'
import type { SpeciesCatalogDetail, SpeciesCatalogDetailView } from '../app/plant-browser/workbench'
import { t } from '../i18n'
import { filterText } from '../components/plant-db/filter-text'
import { locale } from '../app/settings/state'
import type { SpeciesListItem } from '../types/species'
import { CatalogBrowser } from '../components/plant-db/CatalogBrowser'
import { interfaceLanguageName } from '../components/plant-db/language-name'
import {
  filterFavoriteSpecies,
  useFavoriteSpeciesDetailNavigation,
} from '../components/plant-db/favorite-species-presentation'
import { SpeciesKeyPanel } from '../components/panels/SpeciesKeyPanel'
import { DockPanelHeader } from '../components/shared/DockPanelHeader'
import { SpeciesCommonName } from '../components/shared/SpeciesIdentity'
import { SurfaceSearch } from '../components/shared/SurfaceSearch'
import { FactsGrid, OtherNames } from '../components/species-detail/FactsGrid'
import type { SpeciesPhoto } from '../components/species-detail/photo-attribution'
import { PhotoViewer, usePhotoList } from '../components/species-detail/PhotoViewer'
import { formatList, joinRecorded, type SpeciesFact } from '../components/species-detail/species-facts'
import { SpeciesDetailLayout } from '../components/species-detail/SpeciesDetailLayout'
import detailStyles from '../components/species-detail/SpeciesDetail.module.css'
import styles from './WebSpeciesCatalogPanel.module.css'
import { placeSpeciesOnMap } from '../components/plant-db/place-species'

interface WebSpeciesCatalogPanelProps {
  readonly mode: 'catalog' | 'favorites'
}

export function WebSpeciesCatalogPanel({ mode }: WebSpeciesCatalogPanelProps) {
  const [favoriteSearch, setFavoriteSearch] = useState('')
  const favoritesView = speciesCatalogWorkbench.favorites.value
  const sidebar = speciesCatalogWorkbench.sidebar.value
  const detailView = speciesCatalogWorkbench.detail.value
  const isCatalog = mode === 'catalog'
  const visibleItems = filterFavoriteSpecies(favoritesView.items, favoriteSearch)
  const englishNames = useEnglishFallbackNames(useMemo(() => [...favoritesView.items, ...sidebar.recentlyViewed].map((item) => ({
    canonicalName: item.canonical_name,
    commonName: item.common_name,
  })), [favoritesView.items, sidebar.recentlyViewed]))
  const title = isCatalog ? t('plantDb.title') : t('nav.favorites')
  // One Retry reloads both lists, so both wait while either loads; one alert announces each failed attempt.
  const favoritesFailed = favoritesView.failed && favoritesView.items.length === 0
  const recentFailed = sidebar.recentlyViewedFailed && sidebar.recentlyViewed.length === 0
  const listsLoading = favoritesView.loading || sidebar.recentlyViewedLoading

  const mainRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const showingDetail = detailView.canonicalName !== null
  useFavoriteSpeciesDetailNavigation({
    active: true,
    canonicalName: showingDetail ? detailView.canonicalName : null,
    detailRef,
    mainRef,
  })

  useEffect(() => speciesCatalogWorkbench.mount(mode), [mode])

  return (
    <section className={styles.panel} data-testid={`web-species-${mode}-panel`} data-mode={mode} aria-label={title}>
      <div ref={mainRef} className={styles.main} hidden={showingDetail} inert={showingDetail} data-favorites-main={!isCatalog || undefined}>
      <DockPanelHeader title={title} />
      {isCatalog ? (
        <CatalogBrowser searchScope={t('plantDb.searchScopeWeb', { language: interfaceLanguageName(locale.value) })} />
      ) : (
        <>
          <div className={styles.header}><SurfaceSearch value={favoriteSearch} onChange={setFavoriteSearch} label={t('favorites.search')} /></div>
          <div className={styles.list}>
            <h3 className={styles.sectionTitle}>{t('canvas.layers.plants')}</h3>
            <div className={styles.srOnly} role="alert">{(favoritesFailed || recentFailed) && !listsLoading ? t('plantDb.loadFailed') : ''}</div>
            {favoritesFailed ? <LoadFailed pending={listsLoading} /> : (
              <SpeciesList
                items={visibleItems}
                englishNames={englishNames}
                loading={favoritesView.loading}
                emptyLabel={t(favoriteSearch ? 'speciesKey.noResults' : 'plantDb.noFavorites')}
              />
            )}
            <h3 className={styles.sectionTitle}>{t('plantDb.recentlyViewed')}</h3>
            {recentFailed ? <LoadFailed pending={listsLoading} /> : <div className={styles.recentList} role="list">
              {sidebar.recentlyViewed.length === 0 ? (
                <div className={styles.empty}>{t('plantDb.noRecentlyViewed')}</div>
              ) : (
                sidebar.recentlyViewed.map((item) => <SpeciesRow key={item.canonical_name} item={item} englishName={englishNames.get(item.canonical_name)} />)
              )}
            </div>}
          </div>
        </>
      )}
      </div>
      {showingDetail && <div ref={detailRef} className={styles.fullDetail}>
        <WebSpeciesDetail view={detailView} />
      </div>}
    </section>
  )
}

function WebSpeciesDetail({ view }: { readonly view: SpeciesCatalogDetailView }) {
  const detail = view.detail
  const photos = useMemo<SpeciesPhoto[]>(() => detail?.image
    ? [{
        url: detail.image.url,
        source: detail.image.source,
        sourcePageUrl: detail.image.source_page_url,
        credit: detail.image.credit,
        license: detail.image.license,
      }]
    : [], [detail?.image])
  const photoModel = usePhotoList(photos)
  const [namesExpanded, setNamesExpanded] = useState(false)

  if (!view.canonicalName) return null

  const commonName = detail?.common_name?.trim() || null
  const englishName = view.englishName ?? null
  const title = commonName ?? englishName ?? view.canonicalName
  const favorite = speciesCatalogWorkbench.sidebar.value.favoriteNames.includes(view.canonicalName)
  const canonicalName = view.canonicalName

  return (
    <SpeciesDetailLayout
      identity={{ canonicalName, commonName, englishName, family: null, habitKey: detail?.habit ?? null }}
      favorite={favorite}
      onToggleFavorite={() => { void speciesCatalogWorkbench.toggleFavorite(canonicalName) }}
      onBack={() => speciesCatalogWorkbench.closeSpeciesDetail()}
      place={detail ? { canonical_name: detail.canonical_name, common_name: detail.common_name, stratum: null, width_max_m: null } : null}
    >
      {view.loading && <p className={detailStyles.status} aria-live="polite" aria-busy="true">{t('plantDetail.loading')}</p>}
      {view.error && (
        <div className={detailStyles.statusError} role="alert" data-species-detail-error>
          <span>{t('plantDb.loadFailed')}</span>
          <button type="button" className={styles.retryButton} onClick={() => speciesCatalogWorkbench.retrySpeciesDetail()}>
            {t('plantDb.retry')}
          </button>
        </div>
      )}
      {detail && (
        <>
          <PhotoViewer model={photoModel} name={title} linkSources={true} />
          <OtherNames
            names={detail.common_names.filter((name) => name !== title)}
            expanded={namesExpanded}
            onToggle={() => setNamesExpanded(!namesExpanded)}
          />
          <FactsGrid facts={webSpeciesFacts(detail, locale.value)} />
        </>
      )}
    </SpeciesDetailLayout>
  )
}

/** The Web catalog carries only form, life cycle and climate zone (see the species catalog guide). */
function webSpeciesFacts(detail: SpeciesCatalogDetail, currentLocale: string): SpeciesFact[] {
  const habit = detail.habit ? filterText(`filters.habit_${detail.habit}`, detail.habit) : null
  const lifeCycles = detail.life_cycles.map((value) => filterText(`filters.lifeCycle_${value}`, value))
  const zones = detail.climate_zones.map((value) => filterText(`filters.climateZone_${value}`, value))
  return [
    { id: 'habit', label: t('plantDetail.habit'), value: joinRecorded([habit, detail.growth_form]) },
    { id: 'lifeCycle', label: t('filters.lifecycle'), value: lifeCycles.length > 0 ? formatList(lifeCycles, currentLocale) : null },
    { id: 'climateZones', label: t('plantDetail.climateZones'), value: zones.length > 0 ? formatList(zones, currentLocale) : null },
  ]
}

/** A Favorites or Recently viewed list the catalog could not load: the translated message and Retry, which waits while a
 *  load is pending (aria-disabled and ignoring clicks, never `disabled`, so a focused Retry keeps keyboard focus through a
 *  pending and a failed attempt); the panel's one alert announces the failure (canopi-etzh). */
function LoadFailed({ pending }: { readonly pending: boolean }) {
  return (
    <div className={styles.loadFailed} data-list-load-failed aria-busy={pending}>
      <span>{t('plantDb.loadFailed')}</span>
      <button
        type="button"
        className={styles.retryButton}
        aria-disabled={pending || undefined}
        onClick={() => { if (!pending) speciesCatalogWorkbench.retryFavorites() }}
      >
        {t('plantDb.retry')}
      </button>
    </div>
  )
}

function SpeciesList({
  items,
  englishNames,
  loading,
  emptyLabel,
}: {
  readonly items: readonly SpeciesListItem[]
  readonly englishNames: ReadonlyMap<string, string>
  readonly loading: boolean
  readonly emptyLabel: string
}) {
  if (loading && items.length === 0) {
    return <div className={styles.loading}>{t('plantDb.loading')}</div>
  }

  if (items.length === 0) {
    return <div className={styles.empty}>{emptyLabel}</div>
  }

  return (
    <div className={styles.list} role="list">
      {items.map((item) => <SpeciesRow key={item.canonical_name} item={item} englishName={englishNames.get(item.canonical_name)} />)}
    </div>
  )
}

/**
 * A Favorites or Recently viewed row: names, Place, star and Details. A species with no
 * name in the interface language shows its English catalog name marked "(en)".
 */
function SpeciesRow({ item, englishName }: { readonly item: SpeciesListItem; readonly englishName?: string }) {
  const localized = item.common_name?.trim() ?? ''
  const english = localized ? '' : englishName ?? ''
  const commonName = localized || english
  const displayName = commonName.length > 0 ? commonName : item.canonical_name
  const showCanonicalName = displayName !== item.canonical_name
  const handleDragStart = (event: DragEvent) => {
    writePlantStampDragData(event.dataTransfer, item)
    const preview = document.createElement('div')
    preview.textContent = displayName
    Object.assign(preview.style, {
      position: 'absolute',
      top: '-1000px',
      left: '-1000px',
      padding: '3px 8px',
      background: 'var(--color-accent, #A06B1F)',
      color: '#fff',
      fontSize: '11px',
      fontFamily: 'Inter, sans-serif',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    })
    document.body.appendChild(preview)
    event.dataTransfer?.setDragImage?.(preview, -12, -12)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => preview.remove())
    } else {
      preview.remove()
    }
  }
  const handlePlace = (event: MouseEvent) => {
    event.stopPropagation()
    placeSpeciesOnMap(item)
  }

  return (
    <div
      className={styles.row}
      draggable={true}
      onDragStart={handleDragStart}
      role="listitem"
      data-favorite-row
      data-testid="web-species-row"
    >
      <span className={styles.nameBlock}>
        <span className={styles.nameLine} data-testid="web-species-name-line">
          <span className={styles.commonName}>
            {english ? <SpeciesCommonName name={english} englishFallback /> : displayName}
          </span>
          {showCanonicalName && (
            <>
              <span className={styles.nameSeparator} aria-hidden="true">·</span>
              <span className={styles.botanicalName} lang="la">{item.canonical_name}</span>
            </>
          )}
        </span>
      </span>
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.placeButton}
          aria-label={t('plantDb.placeSpecies', { name: displayName })}
          data-testid="web-species-place"
          onClick={handlePlace}
        >
          {t('plantDb.place')}
        </button>
        <button
          type="button"
          className={`${styles.favoriteButton} ${item.is_favorite ? styles.favoriteButtonActive : ''}`}
          aria-label={item.is_favorite ? t('plantDb.removeFavorite') : t('plantDb.addFavorite')}
          aria-pressed={item.is_favorite}
          onClick={(event) => {
            event.stopPropagation()
            void speciesCatalogWorkbench.toggleFavorite(item.canonical_name)
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            event.stopPropagation()
            void speciesCatalogWorkbench.toggleFavorite(item.canonical_name)
          }}
        >
          {item.is_favorite ? '★' : '☆'}
        </button>
        <button type="button" className={styles.favoriteButton} data-species-detail={item.canonical_name}
          aria-label={t('speciesKey.details', { name: displayName })}
          onClick={() => speciesCatalogWorkbench.selectSpecies(item.canonical_name)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
        </button>
      </span>
    </div>
  )
}

export function WebSpeciesKeyPanel() {
  const view = speciesCatalogWorkbench.detail.value
  return <SpeciesKeyPanel renderDetail={() => <div className={styles.panel}><WebSpeciesDetail view={view} /></div>} />
}
