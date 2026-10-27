import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { t } from '../../i18n'
import { formatCount } from '../../utils/format-count'
import {
  MIN_FAVORITES_FRAME_HEIGHT,
  locale,
  savedStampsFrameHeight,
} from '../../app/settings/state'
import { speciesCatalogWorkbench } from '../../app/plant-browser'
import { savedObjectStampWorkbench } from '../../app/saved-object-stamps'
import {
  createSavedObjectStampThumbnailSignature,
  SAVED_OBJECT_STAMP_THUMBNAIL_HEIGHT,
  SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH,
} from '../../app/saved-object-stamps/thumbnail-renderer'
import {
  commitSavedStampsFrameHeight,
  saveCanvasSelectionAsObjectStamp,
} from '../../app/favorites/controller'
import {
  clearSavedObjectStampDragSource,
  writeSavedObjectStampDragData,
} from '../../canvas/saved-object-stamp-source'
import {
  isSavedObjectStampPayloadFromBefore2_0,
  parseSavedObjectStampPayload,
} from '../../canvas/saved-object-stamp-payload'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import type { SpeciesListItem } from '../../types/species'
import { useFavoriteSpeciesDetailNavigation } from '../plant-db/favorite-species-presentation'
import { PlantDetailCard } from '../plant-detail/PlantDetailCard'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { usePointerResize } from '../shared/usePointerResize'
import { usePointerReorder } from '../shared/usePointerReorder'
import plantDetailStyles from '../plant-detail/PlantDetail.module.css'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { resolvePlantSymbolId } from '../../canvas/runtime/scene'
import {
  writePlantStampDragData,
} from '../../canvas/plant-stamp-source'
import { navigateTo } from '../../app/shell/state'
import { designSessionStore } from '../../app/document-session/store'
import { useEnglishFallbackNames } from '../../app/plant-finder/catalog-names'
import { findPlants } from '../../app/plant-finder/matcher'
import { useMapSelectionSpecies } from '../../app/plant-finder/selection'
import { usePlantFinder } from '../../app/plant-finder/use-plant-finder'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { DockPanelHeader } from '../shared/DockPanelHeader'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import { PlantFinder, finderHighlight } from '../shared/PlantFinder'
import { SpeciesIdentity } from '../shared/SpeciesIdentity'
import { ActionMenu } from '../shared/ActionMenu'
import { ControlIcon } from '../shared/ControlIcon'
import row from '../shared/species-row.module.css'
import styles from './FavoritesPanel.module.css'
import { placeSpeciesOnMap } from '../plant-db/place-species'
import type { LocaleKey } from '../../generated/locale-keys'

const SAVED_STAMP_PREVIEW_DELAY_MS = 120
const SAVED_STAMP_PREVIEW_GAP = 8
const SAVED_STAMP_PREVIEW_MARGIN = 8
// Lead the pointer slightly in the drag direction so compact rows do not feel sticky.
const SAVED_STAMP_REORDER_DOWN_THRESHOLD = 0.4
const SAVED_STAMP_REORDER_UP_THRESHOLD = 0.6

type SavedStampReorderDirection = 'up' | 'down'

interface SavedStampPreview {
  readonly stamp: SavedObjectStamp
  readonly anchorRect: DOMRect
}

interface SavedStampReorderSession {
  readonly sourceId: string
  direction: SavedStampReorderDirection | null
  lastClientY: number
  /** The full library order when the gesture began; hidden (searched-out) stamps keep their slots. */
  readonly baseIds: readonly string[]
  latestIds: readonly string[]
}

export function FavoritesPanel() {
  const [search, setSearch] = useState('')
  const [selectedOnMap, setSelectedOnMap] = useState(false)
  const mapSelection = useMapSelectionSpecies()
  const queries = currentCanvasQuerySurface.value
  void queries?.revision.scene.value
  const scene = queries?.getSceneSnapshot()
  const favoritesView = speciesCatalogWorkbench.favorites.value
  const savedStampsView = savedObjectStampWorkbench.library.value
  const savedStampSelection = savedObjectStampWorkbench.selection.value
  const lang = locale.value
  const selected = speciesCatalogWorkbench.selectedCanonicalName.value
  const mainRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  useFavoriteSpeciesDetailNavigation({ canonicalName: selected, detailRef, mainRef })
  const headerRef = useRef<HTMLDivElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const savedStampsFrameRef = useRef<HTMLElement>(null)
  const previewTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const savedStampItemsRef = useRef<readonly SavedObjectStamp[]>([])
  const savedStampsListRef = useRef<HTMLDivElement>(null)
  const [, setLayoutRevision] = useState(0)
  const [preview, setPreview] = useState<SavedStampPreview | null>(null)
  const [savedStampReorderPreviewIds, setSavedStampReorderPreviewIds] = useState<readonly string[] | null>(null)
  const [importRefusalKey, setImportRefusalKey] = useState<LocaleKey | null>(null)
  const designIdentity = designSessionStore.sessionIdentity.value

  useEffect(() => speciesCatalogWorkbench.mount('favorites'), [])

  useEffect(() => {
    void savedObjectStampWorkbench.loadLibrary()
  }, [lang])

  useEffect(() => {
    return () => clearPreviewTimer(previewTimerRef)
  }, [])

  const beginReorder = usePointerReorder<SavedStampReorderSession>({
    move: updateSavedStampReorder,
    finish: finishSavedStampReorder,
    cancel: () => setSavedStampReorderPreviewIds(null),
  })

  useEffect(() => {
    const main = mainRef.current
    if (!main) return

    setLayoutRevision((revision) => revision + 1)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      setLayoutRevision((revision) => revision + 1)
    })
    observer.observe(main)
    return () => observer.disconnect()
  }, [])

  const items = favoritesView.items
  const finderSpecies = useMemo(() => items.map((item) => ({
    canonicalName: item.canonical_name,
    commonName: item.common_name,
    code: scene?.plantSpeciesCodes[item.canonical_name],
  })), [items, scene])
  const finder = usePlantFinder(finderSpecies, search)
  const englishNames = useEnglishFallbackNames(finderSpecies)
  const visibleItems = useMemo(() => {
    const shown = items.filter((item) => (
      (!selectedOnMap || mapSelection.plantCountBySpecies.has(item.canonical_name))
      && (!finder.active || finder.byKey.has(item.canonical_name))
    ))
    if (!finder.active) return shown
    const rank = new Map(finder.hits.map((hit, index) => [hit.key, index]))
    return shown.sort((left, right) => rank.get(left.canonical_name)! - rank.get(right.canonical_name)!)
  }, [finder, items, mapSelection, selectedOnMap])
  const count = items.length
  const isLoading = favoritesView.loading
  const savedStampItems = savedStampsView.items
  savedStampItemsRef.current = savedStampItems
  const stampMatches = useMemo(() => findPlants(savedStampItems.map((stamp) => ({
    key: stamp.id,
    names: [{ text: stamp.name, kind: 'common' as const }],
  })), search), [savedStampItems, search])
  const orderedSavedStampItems = orderSavedStampsForPreview(savedStampItems, savedStampReorderPreviewIds)
    .filter((stamp) => !stampMatches.active || stampMatches.byKey.has(stamp.id))
  const savedStampsChrome = [headerRef.current, resizeHandleRef.current]

  useEffect(() => {
    clearSavedStampReorderPreviewIfLibraryMatches()
  }, [savedStampsView.revision, savedStampReorderPreviewIds])

  // A refusal notice is about the last import only: a save, any library change or another Design clears it.
  useEffect(() => {
    setImportRefusalKey(null)
  }, [savedStampsView.revision, designIdentity])

  function saveSelection(): void {
    setImportRefusalKey(null)
    saveCanvasSelectionAsObjectStamp()
  }

  async function importStampFile(): Promise<void> {
    setImportRefusalKey(null)
    try {
      const outcome = await savedObjectStampWorkbench.importStampFile()
      if (outcome.status === 'refused') setImportRefusalKey(outcome.messageKey)
    } catch (error) {
      // The workbench rejects only when saving the read stamp fails.
      console.error('Saved stamp import failed:', error)
      setImportRefusalKey('savedObjectStamps.importSaveFailed')
    }
  }

  function showStampPreview(stamp: SavedObjectStamp, anchor: HTMLElement): void {
    clearPreviewTimer(previewTimerRef)
    setPreview({
      stamp,
      anchorRect: anchor.getBoundingClientRect(),
    })
  }

  function scheduleStampPreview(stamp: SavedObjectStamp, anchor: HTMLElement): void {
    clearPreviewTimer(previewTimerRef)
    previewTimerRef.current = globalThis.setTimeout(() => {
      previewTimerRef.current = null
      setPreview({
        stamp,
        anchorRect: anchor.getBoundingClientRect(),
      })
    }, SAVED_STAMP_PREVIEW_DELAY_MS)
  }

  function hideStampPreview(): void {
    clearPreviewTimer(previewTimerRef)
    setPreview(null)
  }

  function beginSavedStampReorder(sourceId: string, event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
    event.preventDefault()
    event.stopPropagation()
    clearPreviewTimer(previewTimerRef)
    setPreview(null)

    // Reorder over the full library order so a searched list never saves a partial order.
    const ids = orderSavedStampsForPreview(savedStampItems, savedStampReorderPreviewIds).map((item) => item.id)
    beginReorder(event, {
      sourceId,
      direction: null,
      lastClientY: event.clientY,
      baseIds: ids,
      latestIds: ids,
    })
    setSavedStampReorderPreviewIds(ids)
  }

  function commitSavedStampReorder(session: SavedStampReorderSession, isCurrent: () => boolean): void {
    setSavedStampReorderPreviewIds(session.latestIds)
    void savedObjectStampWorkbench.reorderStamps([...session.latestIds]).then(
      () => {
        if (isCurrent()) clearSavedStampReorderPreviewIfLibraryMatches()
      },
      () => {
        // The Workbench presents persistence errors; discard only this gesture's preview.
        if (isCurrent()) setSavedStampReorderPreviewIds(null)
      },
    )
  }

  function clearSavedStampReorderPreviewIfLibraryMatches(): void {
    setSavedStampReorderPreviewIds((current) => {
      if (!current) return current
      if (!sameIdOrder(savedStampItemsRef.current.map((item) => item.id), current)) return current
      return null
    })
  }

  function updateSavedStampReorder(session: SavedStampReorderSession, event: PointerEvent): void {
    event.preventDefault()
    const direction = savedStampReorderDirectionForPointer(session, event.clientY)
    session.direction = direction
    session.lastClientY = event.clientY
    session.latestIds = mergeVisibleStampOrder(
      session.baseIds,
      reorderSavedStampIdsForPointer(session.sourceId, event.clientY, direction),
    )
    setSavedStampReorderPreviewIds((current) => sameIdOrder(current, session.latestIds) ? current : session.latestIds)
  }

  function finishSavedStampReorder(session: SavedStampReorderSession, event: PointerEvent, isCurrent: () => boolean): void {
    event.preventDefault()
    if (sameIdOrder(savedStampItemsRef.current.map((item) => item.id), session.latestIds)) {
      setSavedStampReorderPreviewIds(null)
      return
    }
    commitSavedStampReorder(session, isCurrent)
  }

  function savedStampReorderDirectionForPointer(
    session: SavedStampReorderSession,
    clientY: number,
  ): SavedStampReorderDirection | null {
    if (clientY > session.lastClientY) return 'down'
    if (clientY < session.lastClientY) return 'up'
    return session.direction
  }

  function reorderSavedStampIdsForPointer(
    sourceId: string,
    clientY: number,
    direction: SavedStampReorderDirection | null,
  ): readonly string[] {
    const rows = [...savedStampsListRef.current?.querySelectorAll<HTMLElement>('[data-saved-stamp-row]') ?? []]
    const visibleIds = rows
      .map((row) => row.dataset.savedStampRow)
      .filter((id): id is string => Boolean(id))
    const displayedIds = visibleIds.length > 0 ? visibleIds : orderedSavedStampItems.map((item) => item.id)
    const withoutSourceIds = displayedIds.filter((id) => id !== sourceId)
    const targetRows = rows.filter((row) => row.dataset.savedStampRow !== sourceId)
    const threshold = savedStampReorderThreshold(direction)
    let insertIndex = withoutSourceIds.length

    for (let index = 0; index < targetRows.length; index += 1) {
      const rect = targetRows[index]!.getBoundingClientRect()
      if (clientY < rect.top + rect.height * threshold) {
        insertIndex = index
        break
      }
    }

    return [
      ...withoutSourceIds.slice(0, insertIndex),
      sourceId,
      ...withoutSourceIds.slice(insertIndex),
    ]
  }

  function savedStampReorderThreshold(direction: SavedStampReorderDirection | null): number {
    if (direction === 'down') return SAVED_STAMP_REORDER_DOWN_THRESHOLD
    if (direction === 'up') return SAVED_STAMP_REORDER_UP_THRESHOLD
    return 0.5
  }

  return (
    <div className={styles.panel}>
      {/* Search + list view */}
      <div
        ref={mainRef}
        className={styles.main}
        hidden={selected !== null}
        data-favorites-main
        aria-hidden={selected !== null}
        inert={selected !== null}
      >
        <div ref={headerRef} className={styles.head}>
          <DockPanelHeader title={t('nav.favorites')} />
          <div className={styles.finder}>
            <PlantFinder
              value={search}
              onChange={setSearch}
              label={t('favorites.searchAll')}
              placeholder={t('favorites.searchAll')}
              correction={finder.correction}
              selectedOnMap={{
                pressed: selectedOnMap,
                plantCount: mapSelection.plantCount,
                onChange: setSelectedOnMap,
              }}
              summary={finder.active || selectedOnMap
                ? t('plantFinder.species', { count: visibleItems.length })
                : undefined}
            />
          </div>
        </div>

        <section
          className={styles.plantsFrame}
          data-favorites-plants-frame
          aria-labelledby="favorite-plants-title"
        >
          <div className={styles.frameHeader}>
            <span id="favorite-plants-title" className={styles.title}>{t('canvas.layers.plants')}</span>
            {count > 0 && (
              <span className={styles.count}>{formatCount(count, locale.value)}</span>
            )}
          </div>
          <div className={styles.plantsFrameBody}>
            {isLoading ? (
              <div className={styles.loading} aria-live="polite" aria-busy="true">
                {t('plantDb.loading')}
              </div>
            ) : count === 0 ? (
              <EmptyState icon={<PanelIcon panel="favorites" />} action={{ label: t('speciesKey.openCatalog'), onClick: () => navigateTo('plant-db') }}>
                {t('favorites.empty')}
              </EmptyState>
            ) : visibleItems.length === 0 ? (
              <EmptyState status>{t('speciesKey.noResults')}</EmptyState>
            ) : (
              <div className={styles.list} role="list" aria-label={t('canvas.layers.plants')}>
                {visibleItems.map((plant) => (
                  <FavoriteSpeciesRow
                    key={plant.canonical_name}
                    plant={plant}
                    englishName={englishNames.get(plant.canonical_name)}
                    code={scene?.plantSpeciesCodes[plant.canonical_name] ?? ''}
                    color={scene?.plantSpeciesColors[plant.canonical_name] ?? null}
                    symbol={scene?.plantSpeciesSymbols[plant.canonical_name]}
                    highlight={finderHighlight(finder.byKey.get(plant.canonical_name))}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <SavedStampsResizeHandle
          mainRef={mainRef}
          headerRef={headerRef}
          handleRef={resizeHandleRef}
          frameRef={savedStampsFrameRef}
        />
        <section
          ref={savedStampsFrameRef}
          className={styles.savedStampsSection}
          data-saved-stamps-frame
          aria-labelledby="saved-object-stamps-title"
          style={{ height: `${resolveSavedStampsFrameHeight(savedStampsFrameHeight.value, mainRef.current, savedStampsChrome)}px` }}
        >
          <div className={styles.frameHeader}>
            <div className={styles.savedStampsTitleGroup}>
              <span id="saved-object-stamps-title" className={styles.title} tabIndex={-1}>
                {t('savedObjectStamps.title')}
              </span>
            </div>
            {savedStampsView.items.length > 0 && (
              <span className={styles.count}>{formatCount(savedStampsView.items.length, locale.value)}</span>
            )}
            <button
              type="button"
              className={styles.importStampButton}
              aria-label={t('savedObjectStamps.import')}
              onClick={importStampFile}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 11v3h10v-3" /></svg><ButtonTooltip label={t('savedObjectStamps.import')} side="left" />
            </button>
          </div>
          <div className={styles.savedStampsActions}>
            <button
              type="button"
              className={styles.saveStampButton}
              disabled={!savedStampSelection.canSave}
              title={!savedStampSelection.canSave ? t('savedObjectStamps.selectHint') : undefined}
              onClick={saveSelection}
            >
              <PlusIcon />{t('savedObjectStamps.saveSelection')}
            </button>
            {importRefusalKey && (
              <p className={styles.savedStampsImportRefusal} role="alert">{t(importRefusalKey)}</p>
            )}
          </div>
          {savedStampsView.loading ? (
            <div className={styles.savedStampsLoading} aria-live="polite" aria-busy="true">
              {t('savedObjectStamps.loading')}
            </div>
          ) : savedStampsView.items.length === 0 ? (
            <div className={styles.savedStampsEmpty} aria-live="polite">
              {t('savedObjectStamps.empty')}
            </div>
          ) : (
            <div
              ref={savedStampsListRef}
              className={styles.savedStampsList}
              role="list"
              aria-label={t('savedObjectStamps.title')}
            >
              {orderedSavedStampItems.map((stamp) => (
                <SavedObjectStampRow
                  key={stamp.id}
                  stamp={stamp}
                  onPreviewRequest={showStampPreview}
                  onPreviewSchedule={scheduleStampPreview}
                  onPreviewClear={hideStampPreview}
                  onReorderBegin={beginSavedStampReorder}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <SavedStampRecognitionOverlay preview={selected ? null : preview} panelRef={mainRef} />

      {/* Keep the list mounted so Back restores its search and scroll position. */}
      {selected !== null && (
        <div ref={detailRef} className={plantDetailStyles.detailVisible}>
          <PlantDetailCard canonicalName={selected} />
        </div>
      )}
    </div>
  )
}

function SavedStampsResizeHandle({
  mainRef,
  headerRef,
  handleRef,
  frameRef,
}: {
  mainRef: { current: HTMLDivElement | null }
  headerRef: { current: HTMLElement | null }
  handleRef: { current: HTMLDivElement | null }
  frameRef: { current: HTMLElement | null }
}) {
  const resolveHeight = (session: SavedStampsResizeSession, clientY: number) =>
    resolveSavedStampsFrameHeight(
      session.startHeight + (session.startY - clientY),
      mainRef.current,
      [headerRef.current, handleRef.current],
    )

  const onPointerDown = usePointerResize<SavedStampsResizeSession>({
    cursor: 'row-resize',
    begin: (event) => {
      const frame = frameRef.current
      if (!frame) return null
      return {
        frame,
        startY: event.clientY,
        startHeight: currentSavedStampsFrameHeight(frame),
        previousInlineHeight: frame.style.height,
      }
    },
    preview: (session, event) => {
      const height = resolveHeight(session, event.clientY)
      session.frame.style.height = `${height}px`
      return height !== session.startHeight
    },
    commit: (session, event) => {
      commitSavedStampsFrameHeight(resolveHeight(session, event.clientY))
    },
    rollback: (session) => {
      session.frame.style.height = session.previousInlineHeight
    },
  })

  return (
    <div
      ref={handleRef}
      className={styles.savedStampsResizeHandle}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('savedObjectStamps.resizeFrame')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        if (!frameRef.current) return
        event.preventDefault()
        commitSavedStampsFrameHeight(resolveSavedStampsFrameHeight(
          currentSavedStampsFrameHeight(frameRef.current) + (event.key === 'ArrowUp' ? 20 : -20),
          mainRef.current, [headerRef.current, handleRef.current],
        ))
      }}
    />
  )
}

interface SavedStampsResizeSession {
  readonly frame: HTMLElement
  readonly startY: number
  readonly startHeight: number
  readonly previousInlineHeight: string
}

function currentSavedStampsFrameHeight(frame: HTMLElement): number {
  const styledHeight = Number.parseFloat(frame.style.height)
  if (Number.isFinite(styledHeight)) return styledHeight

  const measuredHeight = frame.getBoundingClientRect().height
  if (Number.isFinite(measuredHeight) && measuredHeight > 0) return measuredHeight

  return savedStampsFrameHeight.value
}

function resolveSavedStampsFrameHeight(
  height: number,
  container: HTMLElement | null,
  chromeElements: readonly (HTMLElement | null)[] = [],
): number {
  const roundedHeight = Number.isFinite(height)
    ? Math.round(height)
    : savedStampsFrameHeight.value
  const containerHeight = container?.getBoundingClientRect().height ?? 0
  const chromeHeight = chromeElements.reduce((sum, element) => sum + measuredElementHeight(element), 0)
  const frameSpaceHeight = containerHeight - chromeHeight
  const maxHeight = Number.isFinite(frameSpaceHeight) && frameSpaceHeight > 0
    ? Math.max(MIN_FAVORITES_FRAME_HEIGHT, Math.round(frameSpaceHeight - MIN_FAVORITES_FRAME_HEIGHT))
    : Number.POSITIVE_INFINITY

  return Math.max(MIN_FAVORITES_FRAME_HEIGHT, Math.min(maxHeight, roundedHeight))
}

function measuredElementHeight(element: HTMLElement | null): number {
  const height = element?.getBoundingClientRect().height ?? 0
  return Number.isFinite(height) && height > 0 ? height : 0
}

/** Permutes only the visible ids inside the full order; hidden ids stay in their slots. */
function mergeVisibleStampOrder(
  fullIds: readonly string[],
  visibleIds: readonly string[],
): readonly string[] {
  const visible = new Set(visibleIds)
  const queue = visibleIds.filter((id) => fullIds.includes(id))
  let next = 0
  return fullIds.map((id) => (visible.has(id) ? queue[next++] ?? id : id))
}

function orderSavedStampsForPreview(
  stamps: readonly SavedObjectStamp[],
  orderedIds: readonly string[] | null,
): readonly SavedObjectStamp[] {
  if (!orderedIds) return stamps
  const byId = new Map(stamps.map((stamp) => [stamp.id, stamp]))
  const ordered: SavedObjectStamp[] = []
  for (const id of orderedIds) {
    const stamp = byId.get(id)
    if (!stamp) continue
    ordered.push(stamp)
    byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

function clearPreviewTimer(ref: { current: ReturnType<typeof globalThis.setTimeout> | null }): void {
  if (ref.current === null) return
  globalThis.clearTimeout(ref.current)
  ref.current = null
}

/** One favourite species: star first, the row opens details, Place arms placement. */
function FavoriteSpeciesRow({ plant, englishName, code, color, symbol, highlight }: {
  plant: SpeciesListItem
  /** The English catalog name, shown marked "(en)" when the species has none in the interface language. */
  englishName: string | undefined
  code: string
  color: string | null
  symbol: string | undefined
  highlight: ((text: string) => ComponentChildren) | undefined
}) {
  const commonName = plant.common_name || englishName
  const name = commonName || plant.canonical_name
  return (
    <div className={row.row} role="listitem" data-favorite-species={plant.canonical_name}>
      <button
        type="button"
        className={styles.star}
        aria-pressed={true}
        aria-label={t('favorites.remove', { name })}
        onClick={() => { void speciesCatalogWorkbench.toggleFavorite(plant.canonical_name) }}
      >
        <ControlIcon name="star" size={18} />
        <ButtonTooltip label={t('favorites.remove', { name })} side="right" />
      </button>
      <button
        type="button"
        className={row.main}
        data-species-detail={plant.canonical_name}
        draggable={true}
        onDragStart={(event) => writePlantStampDragData(event.dataTransfer, plant)}
        onClick={() => speciesCatalogWorkbench.selectSpecies(plant.canonical_name)}
      >
        <span className={row.srOnly}>{t('favorites.detailsFor')} </span>
        <span className={row.glyph} aria-hidden="true" style={{ color: color ?? 'var(--color-text-muted)' }}>
          <PlantSymbolGlyph symbol={resolvePlantSymbolId(symbol)} size={22} />
        </span>
        <SpeciesIdentity
          commonName={commonName}
          canonicalName={plant.canonical_name}
          englishFallback={!plant.common_name && Boolean(englishName)}
          highlight={highlight}
        />
        <span className={row.code}>{code}</span>
      </button>
      <button
        type="button"
        className={styles.placeButton}
        aria-label={t('favorites.place', { name })}
        onClick={() => placeSpeciesOnMap(plant)}
      >{t('savedObjectStamps.place')}</button>
    </div>
  )
}

function SavedStampRecognitionOverlay({
  preview,
  panelRef,
}: {
  preview: SavedStampPreview | null
  panelRef: { current: HTMLElement | null }
}) {
  if (!preview) return null
  const position = savedStampPreviewPosition(preview.anchorRect, panelRef.current)

  return (
    <div
      className={styles.savedStampThumbnailOverlay}
      data-saved-stamp-thumbnail-overlay
      aria-hidden="true"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH}px`,
        height: `${SAVED_OBJECT_STAMP_THUMBNAIL_HEIGHT}px`,
      }}
    >
      <SavedStampThumbnailSvg stamp={preview.stamp} />
    </div>
  )
}

function savedStampPreviewPosition(anchorRect: DOMRect, panel: HTMLElement | null): { left: number, top: number } {
  const panelRect = panel?.getBoundingClientRect()
  const desiredLeft = (panelRect?.left ?? anchorRect.left) - SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH - SAVED_STAMP_PREVIEW_GAP
  const maxLeft = Math.max(SAVED_STAMP_PREVIEW_MARGIN, window.innerWidth - SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH - SAVED_STAMP_PREVIEW_MARGIN)
  const maxTop = Math.max(SAVED_STAMP_PREVIEW_MARGIN, window.innerHeight - SAVED_OBJECT_STAMP_THUMBNAIL_HEIGHT - SAVED_STAMP_PREVIEW_MARGIN)

  return {
    left: Math.round(Math.min(maxLeft, Math.max(SAVED_STAMP_PREVIEW_MARGIN, desiredLeft))),
    top: Math.round(Math.min(maxTop, Math.max(SAVED_STAMP_PREVIEW_MARGIN, anchorRect.top))),
  }
}

function SavedStampThumbnailSvg({ stamp }: { stamp: SavedObjectStamp }) {
  const signature = createSavedObjectStampThumbnailSignature(stamp.payload_json)
  if (signature.fallback) {
    return (
      <svg className={styles.savedStampThumbnailSvg} viewBox={`0 0 ${signature.width} ${signature.height}`} aria-hidden="true">
        <path className={styles.savedStampThumbnailFallback} d="M54 76h72M90 40v72" />
      </svg>
    )
  }

  return (
    <svg className={styles.savedStampThumbnailSvg} viewBox={`0 0 ${signature.width} ${signature.height}`} aria-hidden="true">
      {signature.zones.map((zone, index) => {
        const points = zone.points.map((point) => `${point.x},${point.y}`).join(' ')
        const ZoneElement = zone.closed ? 'polygon' : 'polyline'
        return (
          <ZoneElement
            key={`zone-${index}`}
            className={styles.savedStampThumbnailZone}
            points={points}
            style={zone.fillColor ? { fill: zone.fillColor } : undefined}
          />
        )
      })}
      {signature.plants.map((plant, index) => (
        <g key={`plant-${index}`}>
          {plant.cluster && (
            <circle
              className={styles.savedStampThumbnailPlantCluster}
              cx={plant.x}
              cy={plant.y}
              r={plant.radius + 2}
            />
          )}
          <circle
            className={styles.savedStampThumbnailPlant}
            cx={plant.x}
            cy={plant.y}
            r={plant.radius}
            style={plant.color ? { fill: plant.color } : undefined}
          />
        </g>
      ))}
      {signature.annotations.map((annotation, index) => (
        <path
          key={`annotation-${index}`}
          className={styles.savedStampThumbnailAnnotation}
          d={`M${annotation.x1} ${annotation.y1}L${annotation.x2} ${annotation.y2}`}
        />
      ))}
    </svg>
  )
}

function SavedObjectStampRow({
  stamp,
  onPreviewRequest,
  onPreviewSchedule,
  onPreviewClear,
  onReorderBegin,
}: {
  stamp: SavedObjectStamp
  onPreviewRequest: (stamp: SavedObjectStamp, anchor: HTMLElement) => void
  onPreviewSchedule: (stamp: SavedObjectStamp, anchor: HTMLElement) => void
  onPreviewClear: () => void
  onReorderBegin: (sourceId: string, event: PointerEvent) => void
}) {
  const [draftName, setDraftName] = useState(stamp.name)
  const [isRenaming, setIsRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // Set when the user opens or cancels the Delete confirmation, whose buttons replace the one that had focus.
  const deleteConfirmToggledRef = useRef(false)
  // Canopi 2.0 cannot place, drag, export or convert a stamp saved before 2.0 (ADR 0021): it offers only Delete.
  const before2_0 = useMemo(() => isSavedObjectStampPayloadFromBefore2_0(stamp.payload_json), [stamp.payload_json])
  const summaryId = useId()
  const deleteCopyId = useId()

  useEffect(() => {
    setDraftName(stamp.name)
  }, [stamp.name])

  // The field takes focus as it replaces the name, so an Esc at once ends the rename (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (!isRenaming) return
    const input = renameInputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(0, input.value.length)
  }, [isRenaming])

  // The confirmation's buttons replace the control that opened it, and back on Cancel: move focus with
  // them so a keyboard user stays on the row, as they commit (canopi-f47t.52.228.20). Cancel is the safe choice and
  // reads the question.
  useLayoutEffect(() => {
    if (!deleteConfirmToggledRef.current) return
    deleteConfirmToggledRef.current = false
    if (confirmingDelete) {
      cancelDeleteRef.current?.focus()
      return
    }
    // The row's last action opened it: Delete on a stamp saved before 2.0, otherwise the actions menu.
    const actions = actionsRef.current?.querySelectorAll<HTMLButtonElement>('button')
    actions?.[actions.length - 1]?.focus()
  }, [confirmingDelete])

  function setDeleteConfirmation(next: boolean): void {
    deleteConfirmToggledRef.current = true
    setConfirmingDelete(next)
  }

  // The deleted row takes the focused Confirm with it: once it is gone, focus the next row, else the previous
  // one, else the list's heading, unless focus has already gone somewhere else. A layout effect, so the cleanup runs as
  // the row leaves the page, not after paint (Preact 11 runs useEffect cleanups then), and the microtask finds the
  // neighbour mounted with focus not yet on the page for a painted frame (canopi-f47t.52.228.20).
  const focusAfterDeleteRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => () => {
    const target = focusAfterDeleteRef.current
    if (!target) return
    queueMicrotask(() => {
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      if (target.isConnected) target.focus()
    })
  }, [])

  function confirmDelete(): void {
    const row = rowRef.current
    const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>('[data-saved-stamp-grip]')
    focusAfterDeleteRef.current = neighbour
      ?? row?.closest('[data-saved-stamps-frame]')?.querySelector<HTMLElement>('#saved-object-stamps-title')
      ?? null
    void savedObjectStampWorkbench.deleteStamp(stamp.id).then((deleted) => {
      if (!deleted) focusAfterDeleteRef.current = null
    })
  }

  function commitRename(): void {
    const next = (renameInputRef.current?.value ?? draftName).trim()
    if (next.length === 0) {
      setDraftName(stamp.name)
      setIsRenaming(false)
      return
    }
    if (next !== stamp.name) {
      void savedObjectStampWorkbench.renameStamp(stamp.id, next)
    }
    setIsRenaming(false)
  }

  function cancelRename(): void {
    setDraftName(stamp.name)
    setIsRenaming(false)
  }

  function handleStampDragStart(event: DragEvent): void {
    const target = event.target
    if (before2_0 || (target instanceof HTMLElement && target.closest('button, input'))) {
      event.preventDefault()
      return
    }
    if (!writeSavedObjectStampDragData(event.dataTransfer, stamp)) {
      event.preventDefault()
    }
  }

  function handleStampDragEnd(): void {
    clearSavedObjectStampDragSource()
  }

  return (
    <div
      ref={rowRef}
      className={styles.savedStampRow}
      role="listitem"
      data-saved-stamp-row={stamp.id}
    >
      <button
        type="button"
        className={styles.savedStampGrip}
        aria-label={t('savedObjectStamps.reorderNamed', { name: stamp.name })}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        data-saved-stamp-grip
        onPointerDown={(event) => onReorderBegin(stamp.id, event)}
        onKeyDown={event => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          event.preventDefault()
          const ids = savedObjectStampWorkbench.library.value.items.map(item => item.id)
          const index = ids.indexOf(stamp.id)
          const target = index + (event.key === 'ArrowUp' ? -1 : 1)
          if (index < 0 || target < 0 || target >= ids.length) return
          ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
          void savedObjectStampWorkbench.reorderStamps(ids)
        }}
      >
        <SixDotGripIcon />
      </button>
      <div
        className={styles.savedStampContent}
        data-saved-stamp-body={stamp.id}
        draggable={!before2_0 && !isRenaming && !confirmingDelete}
        onDragStart={handleStampDragStart}
        onDragEnd={handleStampDragEnd}
        tabIndex={before2_0 ? undefined : confirmingDelete ? -1 : 0}
        onPointerEnter={(event) => {
          if (before2_0 || isRenaming || confirmingDelete) return
          onPreviewSchedule(stamp, event.currentTarget as HTMLElement)
        }}
        onPointerLeave={onPreviewClear}
        onFocusIn={(event) => {
          if (before2_0 || isRenaming || confirmingDelete) return
          onPreviewRequest(stamp, event.currentTarget as HTMLElement)
        }}
        onFocusOut={onPreviewClear}
      >
        {confirmingDelete ? (
          <span id={deleteCopyId} className={styles.savedStampDeleteCopy}>{t('savedObjectStamps.deleteConfirmCopy')}</span>
        ) : isRenaming ? (
          <input
            ref={renameInputRef}
            className={styles.savedStampNameInput}
            aria-label={t('savedObjectStamps.nameInput')}
            value={draftName}
            onInput={(event) => setDraftName((event.currentTarget as HTMLInputElement).value)}
            onFocusOut={(event) => {
              const relatedTarget = event.relatedTarget
              if (
                relatedTarget instanceof HTMLElement &&
                relatedTarget.closest('[data-saved-stamp-rename-cancel="true"]')
              ) {
                cancelRename()
                return
              }
              commitRename()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
          />
        ) : (
          <span className={styles.savedStampName}>{stamp.name}</span>
        )}
        {!confirmingDelete && (before2_0
          ? <span id={summaryId} className={`${styles.savedStampSummary} ${styles.savedStampSummaryBefore2_0}`}>{t('savedObjectStamps.summaryBefore2_0')}</span>
          : <span className={styles.savedStampSummary}>{savedStampSummary(stamp)}</span>)}
      </div>
      <div ref={actionsRef} className={styles.savedStampActions}>
        {confirmingDelete ? (
          <>
            <button
              type="button"
              className={styles.savedStampDangerButton}
              aria-label={t('savedObjectStamps.confirmDelete')}
              aria-describedby={deleteCopyId}
              onClick={confirmDelete}
            >
              {t('savedObjectStamps.confirmDelete')}
            </button>
            <button
              ref={cancelDeleteRef}
              type="button"
              className={styles.savedStampSecondaryButton}
              aria-label={t('savedObjectStamps.cancelDelete')}
              aria-describedby={deleteCopyId}
              onClick={() => setDeleteConfirmation(false)}
            >
              {t('savedObjectStamps.cancelDelete')}
            </button>
          </>
        ) : before2_0 ? (
          <button
            type="button"
            className={styles.savedStampSecondaryButton}
            aria-label={t('savedObjectStamps.deleteNamed', { name: stamp.name })}
            aria-describedby={summaryId}
            onClick={() => setDeleteConfirmation(true)}
          >
            {t('savedObjectStamps.delete')}
          </button>
        ) : isRenaming ? (
          <>
            <SavedStampIconButton
              label={t('savedObjectStamps.confirmRename')}
              onClick={commitRename}
              tone="success"
            >
              <CheckIcon />
            </SavedStampIconButton>
            <SavedStampIconButton
              label={t('savedObjectStamps.cancelRename')}
              onClick={cancelRename}
              tone="danger"
              renameCancel
            >
              <CancelIcon />
            </SavedStampIconButton>
          </>
        ) : (
          <>
            <SavedStampIconButton
              label={t('savedObjectStamps.placeNamed', { name: stamp.name })}
              onClick={() => { savedObjectStampWorkbench.placeStamp(stamp, 'panel') }}
              onFocus={(anchor) => onPreviewRequest(stamp, anchor)}
              onBlur={onPreviewClear}
            >
              <PlusIcon />
            </SavedStampIconButton>
            <ActionMenu label={t('savedObjectStamps.actionsFor', { name: stamp.name })} items={[
              { label: t('savedObjectStamps.export'), run: () => { void savedObjectStampWorkbench.exportStamp(stamp) } },
              { label: t('savedObjectStamps.rename'), run: () => { setConfirmingDelete(false); setDraftName(stamp.name); setIsRenaming(true) } },
              { label: t('savedObjectStamps.delete'), danger: true, run: () => { setIsRenaming(false); setDeleteConfirmation(true) } },
            ]} />
          </>
        )}
      </div>
    </div>
  )
}

function SavedStampIconButton({
  label,
  onClick,
  children,
  onFocus,
  onBlur,
  renameCancel = false,
  tone = 'default',
}: {
  label: string
  onClick: () => void
  children: ComponentChildren
  onFocus?: (anchor: HTMLElement) => void
  onBlur?: () => void
  renameCancel?: boolean
  tone?: 'default' | 'success' | 'danger'
}) {
  const toneClass = tone === 'success'
    ? styles.savedStampIconButtonSuccess
    : tone === 'danger'
      ? styles.savedStampIconButtonDanger
      : ''

  return (
    <button
      type="button"
      className={`${styles.savedStampIconButton} ${toneClass}`}
      aria-label={label}
      data-saved-stamp-rename-cancel={renameCancel ? 'true' : undefined}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      onFocusIn={(event) => onFocus?.(event.currentTarget)}
      onFocusOut={onBlur}
    >
      {children}
      <ButtonTooltip label={label} side="left" />
    </button>
  )
}

function SixDotGripIcon() {
  return (
    <span className={styles.savedStampGripDots} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

function PlusIcon() {
  return <svg className={styles.savedStampActionIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
}

function CheckIcon() {
  return (
    <svg className={styles.savedStampActionIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  )
}

function CancelIcon() {
  return (
    <svg className={styles.savedStampActionIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7" />
      <path d="m11.5 4.5-7 7" />
    </svg>
  )
}

function sameIdOrder(left: readonly string[] | null, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
}

function savedStampSummary(stamp: SavedObjectStamp): string {
  const payload = parseSavedObjectStampPayload(stamp.payload_json)
  if (!payload) return t('savedObjectStamps.summaryUnavailable')
  const parts = [
    countPart(payload.plants.length, 'savedObjectStamps.summaryPlantOne', 'savedObjectStamps.summaryPlantOther'),
    countPart(payload.zones.length, 'savedObjectStamps.summaryZoneOne', 'savedObjectStamps.summaryZoneOther'),
    countPart(payload.annotations.length, 'savedObjectStamps.summaryAnnotationOne', 'savedObjectStamps.summaryAnnotationOther'),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : t('savedObjectStamps.summaryEmpty')
}

function countPart(
  count: number,
  singularKey: LocaleKey,
  pluralKey: LocaleKey,
): string | null {
  if (count <= 0) return null
  return t(count === 1 ? singularKey : pluralKey, { count })
}
