import type { TargetedKeyboardEvent } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { currentDesign } from '../../../app/document-session/store'
import {
  addToDesign,
  cancelAnalysisJob,
  cancelLibraryImport,
  deleteLibraryItem,
  dismissLibraryImport,
  fetchDeleteImpact,
  fetchLibraryDiskUsage,
  renameLibraryItem,
  rerunAnalysis,
  retryLibraryImport,
  showDataLibraryFolder,
} from '../../../app/lidar/actions'
import { findAnalysis, registryText } from '../../../app/analyses/registry'
import {
  filterLibraryItems,
  libraryItems,
  selectionAfter,
  takenItemNames,
  type LibraryItem,
  type LibrarySort,
  type LibraryTypeFilter,
} from '../../../app/lidar/library-items'
import { installLidarLibraryObserver, lidarLibrary, lidarStatusMessage } from '../../../app/lidar/library-store'
import { analyzeItem, beginDataImport, closeDataLibrary, revealInSiteData } from '../../../app/lidar/library-navigation'
import { lidarLibraryStatus } from '../../../app/health/state'
import { locale } from '../../../app/settings/state'
import { ANALYSIS_GROUPS } from '../../../generated/analysis-registry'
import type { LibraryDeleteImpact } from '../../../generated/contracts'
import { t } from '../../../i18n'
import { ButtonTooltip } from '../../shared/ButtonTooltip'
import { Dropdown, type DropdownItem } from '../../shared/Dropdown'
import { Notice } from '../../shared/Notice'
import { SurfaceSearch } from '../../shared/SurfaceSearch'
import { WorkspaceDialog } from '../../shared/WorkspaceDialog'
import { ItemDetails } from './ItemDetails'
import { formatDiskSize, isRunning, isStale, itemStatusLabel, itemSummary } from './item-text'
import { LibraryPreview, usePreviewClient } from './LibraryPreview'
import { LibraryItemNameField, isItemNameTaken } from './LibraryItemNameField'
import styles from './data-library.module.css'

/** How long a selection rests before its details fetch their source files and history. */
const SELECTION_REST_MS = 120

type Pane = 'list' | 'details'
type DetailMode = 'details' | 'rename' | 'delete'
/** Where focus goes after a change that hides or removes the focused control: the first of these that takes it. */
type FocusTarget = 'row' | 'heading' | 'back' | 'rename' | 'delete' | 'search' | 'import'

/**
 * The Data library: terrain and height data shared by every Design, with the
 * results calculated from it, as a large sheet over the workspace. The item
 * list (results under their source; search keeps a match's sources, sort by
 * name or most recently added) and the selected item's details are two panes
 * that scroll on their own; below 760 px one pane shows at a time, with Back.
 * A click or ↑/↓ selects; the first row is selected unless an item was asked
 * for, and when the selected item goes the row that took its place is. Search,
 * filter, sort, scroll and selection are session view state and survive
 * Import and Analyze opening over the sheet. Library work keeps running when
 * the sheet closes or the Design changes; only an explicit Cancel stops it.
 * Deleting here removes an item from every Design. The footer counts the
 * items, says how much space the library takes on this computer and opens
 * its folder.
 */
export function DataLibraryView({ focusId }: { readonly focusId: string | null }) {
  useEffect(() => installLidarLibraryObserver(), [])
  const client = usePreviewClient()
  const snapshot = lidarLibrary.value
  const [sort, setSort] = useState<LibrarySort>('name')
  const items = useMemo(() => libraryItems(snapshot, sort), [snapshot, sort, locale.value])
  const references = currentDesign.value?.lidar?.entries ?? []
  const [requestedId, setRequestedId] = useState<string | null>(focusId)
  const [pane, setPane] = useState<Pane>(focusId ? 'details' : 'list')
  // Rename or Delete everywhere belongs to the item it opened for: a search or filter that moves the selection closes it.
  const [modeFor, setModeFor] = useState<{ readonly mode: DetailMode; readonly itemId: string | null }>({ mode: 'details', itemId: null })
  const [query, setQuery] = useState('')
  const [type, setType] = useState<LibraryTypeFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [diskUsage, setDiskUsage] = useState<number | null>(null)
  const listed = useRef<readonly LibraryItem[]>([])
  const pendingFocus = useRef<readonly FocusTarget[]>([])
  const root = useRef<HTMLDivElement>(null)

  // Measured again when the items change (an import, a result, a deletion),
  // never when only their order does (the sort, the locale): the key is sorted.
  const itemsKey = items.map((row) => `${row.id}:${row.generationId ?? ''}`).sort().join(',')
  useEffect(() => {
    let current = true
    void fetchLibraryDiskUsage().then((bytes) => { if (current) setDiskUsage(bytes) }, () => {})
    return () => { current = false }
  }, [itemsKey])

  const visible = filterLibraryItems(items, query, type)
  const selectedId = selectionAfter(listed.current, visible, requestedId)
  const item = visible.find((row) => row.id === selectedId) ?? null
  const mode: DetailMode = modeFor.itemId === selectedId ? modeFor.mode : 'details'
  const setMode = (next: DetailMode) => setModeFor({ mode: next, itemId: selectedId })
  useLayoutEffect(() => {
    listed.current = visible
    // Before the library's first snapshot nothing is listed: the item asked for waits for it.
    if (snapshot !== null && selectedId !== requestedId) setRequestedId(selectedId)
    if (modeFor.mode !== 'details' && modeFor.itemId !== selectedId) setModeFor({ mode: 'details', itemId: null })
    // A search or filter that leaves nothing selected returns to the list, which stays when the filters clear.
    if (snapshot !== null && !item && pane === 'details') setPane('list')
    if (pendingFocus.current.length > 0) {
      const targets = pendingFocus.current
      pendingFocus.current = []
      focusFirst(root.current, targets, selectedId)
    }
  })

  // The list pane scrolls on its own: a selection focus did not move (the item the sheet opened on, the row that took
  // a hidden item's place) is brought into it; ↑/↓ also focus the row, which scrolls it anyway.
  useLayoutEffect(() => {
    if (selectedId) document.getElementById(rowId(selectedId))?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId])

  // The details fetch, and draw their large preview, only once the selection has rested.
  const [restedId, setRestedId] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setRestedId(selectedId), SELECTION_REST_MS)
    return () => clearTimeout(timer)
  }, [selectedId])

  const isAdded = (row: LibraryItem) => references.some((entry) => entry.id === row.id)
  const nameOf = (id: string) => items.find((candidate) => candidate.id === id)?.name ?? t('canvas.lidar.library.deletedItem')

  const select = (id: string, show: boolean) => {
    setRequestedId(id)
    setModeFor({ mode: 'details', itemId: null })
    setError(null)
    if (show) setPane('details')
  }
  // Below 760 px the details pane replaces the list, hiding the focused row: focus moves to Back (hidden, so refused, when wide).
  const showDetails = () => {
    pendingFocus.current = ['back']
    setPane('details')
  }
  const showList = () => {
    pendingFocus.current = ['row']
    setPane('list')
  }
  // Rename and Delete everywhere give focus back to their trigger; after a deletion, to the row that took the item's place,
  // or, with no row left, to the search that now matches nothing or the empty library's Import….
  const endMode = (focus: readonly FocusTarget[]) => {
    pendingFocus.current = focus
    setMode('details')
  }
  // A provenance or result link can name an item the search or type filter hides: the filters clear to show it.
  const openLinked = (id: string) => {
    if (!visible.some((row) => row.id === id)) {
      setQuery('')
      setType('all')
    }
    pendingFocus.current = ['heading']
    select(id, true)
  }
  const moveSelection = (event: TargetedKeyboardEvent<HTMLElement>) => {
    const index = visible.findIndex((row) => row.id === selectedId)
    const next = event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? visible.length - 1
            : null
    if (event.key === 'Enter' && selectedId) {
      event.preventDefault()
      showDetails()
      return
    }
    if (next === null) return
    event.preventDefault()
    const target = visible[Math.max(0, Math.min(visible.length - 1, next))]
    if (!target) return
    pendingFocus.current = ['row']
    select(target.id, false)
  }
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      after?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const refresh = (row: LibraryItem) => {
    const definitionId = row.provenance?.definition_id
    if (definitionId) void run(() => rerunAnalysis(definitionId))
  }

  // "Run again with changes" analyzes the result's first input again, starting
  // from the settings and outputs of the run that produced it.
  const rerunSubject = (row: LibraryItem) => {
    const inputId = row.provenance?.inputs[0]?.item_id
    const input = inputId ? items.find((candidate) => candidate.id === inputId) : undefined
    return input?.status === 'ready' && row.provenance && findAnalysis(row.provenance.analysis_id) ? input : null
  }

  const actionsFor = (row: LibraryItem) => {
    const rerun = rerunSubject(row)
    const canDelete = row.status === 'ready' || row.role === 'Derived'
    return <>
      {row.status === 'ready' && (isAdded(row)
        ? (
          <button type="button" onClick={() => revealInSiteData(row.id)}>
            {t('analyses.dialog.showInSiteData')}
          </button>
        )
        : (
          <button
            type="button"
            disabled={!currentDesign.value}
            aria-label={t('canvas.lidar.library.addAria', { name: row.name })}
            onClick={() => addToDesign(row.role, row.id)}
          >
            {t('canvas.lidar.library.addToDesign')}
          </button>
        ))}
      {rerun && (
        <button
          type="button"
          onClick={() => analyzeItem(rerun.id, { analysisId: row.provenance!.analysis_id, from: row.id })}
        >
          {t('canvas.lidar.library.runAgainWithChanges')}
        </button>
      )}
      {canDelete && (
        <button type="button" className={styles.danger} data-focus-target="delete" onClick={() => setMode('delete')}>
          {t('canvas.lidar.library.deleteEverywhere')}
        </button>
      )}
    </>
  }
  const operation = (row: LibraryItem) => {
    if (row.status === 'preparing' && row.importJob) {
      const progress = row.importJob.progress
      return (
        <div className={styles.job}>
          <progress
            aria-label={t('canvas.lidar.library.progressAria', { name: row.name })}
            max={100}
            value={progress?.percent}
          />
          <button type="button" onClick={() => void run(() => cancelLibraryImport(row.importJob!.job_id))}>
            {t('canvas.lidar.layers.cancelImport')}
          </button>
        </div>
      )
    }
    if (isRunning(row)) {
      return (
        <div className={styles.job}>
          <span role="status" data-tone="progress">
            {row.status === 'ready' ? t('analyses.details.refreshing') : t('canvas.lidar.library.calculating')}
          </span>
          <button type="button" onClick={() => void run(() => cancelAnalysisJob(row))}>
            {t('canvas.lidar.layers.cancelCalculation')}
          </button>
        </div>
      )
    }
    if (row.status === 'failed' && row.role === 'Source') {
      return (
        <div className={styles.job}>
          <span role="status">{t('canvas.lidar.library.importFailed')}</span>
          <button type="button" disabled={busy} onClick={() => void run(() => retryLibraryImport(row.id))}>
            {t('canvas.lidar.library.retry')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => dismissLibraryImport(row.id))}>
            {t('canvas.lidar.library.dismiss')}
          </button>
        </div>
      )
    }
    if (row.status === 'failed' && row.role === 'Derived') {
      return (
        <div className={styles.job}>
          {row.run?.state !== 'Cancelled' && (
            <span role="status">{t('canvas.lidar.library.calculationFailed')}</span>
          )}
          <button type="button" disabled={busy || !row.provenance} onClick={() => refresh(row)}>
            {t('canvas.lidar.library.retry')}
          </button>
        </div>
      )
    }
    if (row.status === 'ready' && row.run?.state === 'Failed') {
      return (
        <div className={styles.job}>
          <span role="status">{t('analyses.details.refreshFailed')}</span>
        </div>
      )
    }
    return null
  }

  const count = items.length
  const headingId = 'library-details-heading'
  return (
    <WorkspaceDialog
      title={t('canvas.lidar.library.title')}
      onClose={closeDataLibrary}
      large
      footer={<>
        <span className={styles.footerNote}>
          {t('canvas.lidar.library.itemCount', { count })}
          {diskUsage !== null && ` · ${t('canvas.lidar.library.onThisComputer', { size: formatDiskSize(diskUsage, locale.value) })}`}
        </span>
        <button type="button" className={`${styles.dialogButton} ${styles.ghost}`} onClick={() => void run(showDataLibraryFolder)}>
          {t('canvas.lidar.library.showInFolder')}
        </button>
      </>}
    >
      {/* With nothing selected the list shows, with No match and Clear search and filters. */}
      <div ref={root} className={styles.library} data-pane={item ? pane : 'list'}>
        <div className={styles.sheetTop}>
          <LibraryOpenNotice />
          {(error || lidarStatusMessage.value) && mode === 'details' && (
            <p className={styles.error} role="alert">{error ?? lidarStatusMessage.value}</p>
          )}
          {count > 0 && (
            <div className={styles.filters}>
              <div className={styles.search}>
                <SurfaceSearch value={query} onChange={setQuery} label={t('canvas.lidar.library.searchLabel')} />
              </div>
              <TypeFilter value={type} onChange={setType} />
              <SortChoice value={sort} onChange={setSort} />
            </div>
          )}
        </div>
        {count === 0 ? <EmptyLibrary /> : (
          <div className={styles.panes}>
            <div className={styles.listPane}>
              <ul className={styles.list} role="listbox" aria-label={t('canvas.lidar.library.title')} onKeyDown={moveSelection}>
                {visible.map((row) => (
                  <li
                    key={row.id}
                    id={rowId(row.id)}
                    role="option"
                    tabIndex={row.id === selectedId ? 0 : -1}
                    aria-selected={row.id === selectedId}
                    className={styles.item}
                    data-nested={row.depth > 0}
                    onClick={() => {
                      select(row.id, false)
                      showDetails()
                    }}
                  >
                    <LibraryPreview item={row} client={client} width={56} height={42} />
                    <span className={styles.itemText}>
                      <strong>{row.name}</strong>
                      <small>{itemSummary(row)}{isAdded(row) && ` · ${t('canvas.lidar.library.inThisDesign')}`}</small>
                      {row.status !== 'ready' && (
                        <small data-error={row.status === 'failed'}>{itemStatusLabel(row)}</small>
                      )}
                      {isStale(row) && <small className={styles.stale}>{t('analyses.details.outOfDate')}</small>}
                    </span>
                  </li>
                ))}
              </ul>
              {visible.length === 0 && (
                <div className={styles.empty}>
                  <p role="status">{t('canvas.lidar.library.noMatch')}</p>
                  <button type="button" className={styles.dialogButton} onClick={() => { setQuery(''); setType('all') }}>
                    {t('canvas.lidar.library.clearFilters')}
                  </button>
                </div>
              )}
            </div>
            {item && (
              <section className={styles.detailPane} aria-labelledby={headingId}>
                <button type="button" className={styles.back} data-focus-target="back" onClick={showList}>← {t('canvas.lidar.library.back')}</button>
                <div className={styles.detailTitle}>
                  <h3 id={headingId} tabIndex={-1} data-focus-target="heading">{item.name}</h3>
                  {item.status === 'ready' && mode !== 'rename' && (
                    <button type="button" className={styles.link} data-focus-target="rename" onClick={() => setMode('rename')}>
                      {t('canvas.lidar.library.renameEllipsis')}
                    </button>
                  )}
                </div>
                {mode === 'rename' && (
                  <RenameForm item={item} busy={busy} error={error} onCancel={() => endMode(['rename'])}
                    onSubmit={(name) => void run(() => renameLibraryItem(item.id, name), () => endMode(['rename']))} />
                )}
                <ItemDetails
                  item={item}
                  nameOf={nameOf}
                  busy={busy}
                  rested={restedId === item.id}
                  results={items.filter((candidate) => candidate.parentId === item.id)}
                  onRefresh={() => refresh(item)}
                  onOpenInput={openLinked}
                  preview={(
                    <div className={styles.previewFrame}>
                      {/* A full-size worker render no departure cancels: only for the row the selection rests on; until then its empty frame. */}
                      {restedId === item.id
                        ? <LibraryPreview item={item} client={client} width={640} height={328} large />
                        : <span className={styles.previewLarge} data-placeholder="true" aria-hidden="true" />}
                    </div>
                  )}
                  actions={mode === 'delete'
                    ? (
                      <DeleteConfirmation
                        item={item}
                        inCurrentDesign={isAdded(item)}
                        busy={busy}
                        error={error}
                        onKeep={() => endMode(['delete'])}
                        onDelete={() => void run(() => deleteLibraryItem(item.id), () => endMode(['row', 'back', 'search', 'import']))}
                      />
                    )
                    : actionsFor(item)}
                  operation={operation(item)}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </WorkspaceDialog>
  )
}

function rowId(id: string): string {
  return `library-item-${id}`
}

/**
 * Focuses the first target that takes focus: a control hidden by the narrow layout or disabled does not, so the next is
 * tried. When none does and focus has left the sheet with the control that held it, the sheet's first enabled control
 * takes it, so Esc and the Tab trap, which the dialog handles, keep working.
 */
function focusFirst(root: HTMLElement | null, targets: readonly FocusTarget[], selectedId: string | null): void {
  for (const target of targets) {
    const element = target === 'row'
      ? (selectedId ? document.getElementById(rowId(selectedId)) : null)
      : target === 'search'
        ? root?.querySelector<HTMLElement>('input[type="search"]') ?? null
        : root?.querySelector<HTMLElement>(`[data-focus-target="${target}"]`) ?? null
    if (!element) continue
    element.focus()
    if (document.activeElement === element) return
  }
  const dialog = root?.closest<HTMLElement>('[role="dialog"]')
  if (!dialog || dialog.contains(document.activeElement)) return
  dialog.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
}

/**
 * The empty library: what it is for, and Import…, which adds the data to the
 * open Design and is disabled, saying why, with no Design open.
 */
function EmptyLibrary() {
  const noDesign = currentDesign.value === null
  const reason = t('canvas.lidar.library.importNeedsDesign')
  return (
    <div className={styles.empty}>
      <h3>{t('canvas.lidar.library.emptyTitle')}</h3>
      <p>{t('canvas.lidar.library.emptyBody')}</p>
      <p className={styles.muted}>{t('canvas.lidar.import.supported')}</p>
      <button
        type="button"
        className={styles.dialogButton}
        data-focus-target="import"
        disabled={noDesign}
        onClick={() => void beginDataImport()}
      >
        {t('canvas.lidar.library.emptyAction')}
        {noDesign && <ButtonTooltip label={reason} side="bottom" />}
      </button>
    </div>
  )
}

/**
 * How the library opened this session, when that is not simply "ready": rebuilt
 * from its originals (a warning; Retry prepares the failed items again), or
 * refused and read-only (an error) because a newer Canopi wrote it or it could
 * not be opened at all.
 */
function LibraryOpenNotice() {
  const status = lidarLibraryStatus.value
  switch (status.kind) {
    case 'ready':
      return null
    case 'recovered':
      return <Notice tone="warning">{t('canvas.lidar.library.recovered')}</Notice>
    case 'refused_newer':
      return <Notice tone="error">{t('canvas.lidar.library.refusedNewer')}</Notice>
    case 'unavailable':
      return <Notice tone="error">{t('canvas.lidar.library.unavailable')}</Notice>
  }
}

/** The library's type filter: everything, imported data, or one analysis group from the registry. */
function TypeFilter({ value, onChange }: { value: LibraryTypeFilter; onChange(next: LibraryTypeFilter): void }) {
  const items: DropdownItem<LibraryTypeFilter>[] = [
    { value: 'all', label: t('canvas.lidar.library.typeAll') },
    { value: 'sources', label: t('canvas.lidar.library.typeSources') },
    ...ANALYSIS_GROUPS.map((group) => ({ value: group.key, label: registryText(group.labelKey) })),
  ]
  return (
    <Dropdown
      className={styles.filterDropdown}
      ariaLabel={t('canvas.lidar.library.typeLabel')}
      trigger={items.find((item) => item.value === value)?.label ?? ''}
      items={items}
      value={value}
      onChange={onChange}
    />
  )
}

/** Sort by Name or Recently added; results stay under their source either way. */
function SortChoice({ value, onChange }: { value: LibrarySort; onChange(next: LibrarySort): void }) {
  const items: DropdownItem<LibrarySort>[] = [
    { value: 'name', label: t('canvas.lidar.library.name') },
    { value: 'recent', label: t('canvas.lidar.library.sortRecent') },
  ]
  return (
    <Dropdown
      className={styles.filterDropdown}
      ariaLabel={t('canvas.lidar.library.sortLabel')}
      trigger={items.find((item) => item.value === value)?.label ?? ''}
      items={items}
      value={value}
      onChange={onChange}
    />
  )
}

/** Rename in place of the name; Esc cancels only the rename, never the sheet. */
function RenameForm({ item, busy, error, onCancel, onSubmit }: {
  item: LibraryItem
  busy: boolean
  error: string | null
  onCancel(): void
  onSubmit(name: string): void
}) {
  const [name, setName] = useState(item.name)
  const form = useRef<HTMLFormElement>(null)
  const taken = takenItemNames(lidarLibrary.value, item.id)
  const ready = name.trim() !== '' && !isItemNameTaken(name, taken)
  // Focused as the form commits, not after a paint: the trigger it replaced has gone, and an Esc pressed meanwhile
  // would reach the sheet instead (canopi-kprb).
  useLayoutEffect(() => { form.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])
  return (
    <form
      ref={form}
      className={styles.form}
      onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(name.trim()) }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <LibraryItemNameField value={name} taken={taken} onInput={setName} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formActions}>
        <button type="button" className={styles.dialogButton} onClick={onCancel}>{t('canvas.lidar.library.cancel')}</button>
        <button type="submit" className={`${styles.dialogButton} ${styles.primary}`} disabled={busy || !ready}>{t('canvas.lidar.library.saveName')}</button>
      </div>
    </form>
  )
}

/**
 * Delete everywhere, confirmed in place of the actions; refused while other
 * results depend on the item. Esc keeps the item, never closes the sheet.
 */
function DeleteConfirmation({ item, inCurrentDesign, busy, error, onKeep, onDelete }: {
  item: LibraryItem
  inCurrentDesign: boolean
  busy: boolean
  error: string | null
  onKeep(): void
  onDelete(): void
}) {
  const [impact, setImpact] = useState<LibraryDeleteImpact | null>(null)
  const title = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    let current = true
    void fetchDeleteImpact(item.id).then((value) => { if (current) setImpact(value) }).catch(() => {})
    return () => { current = false }
  }, [item.id])
  // Focused as it commits, as RenameForm's field is.
  useLayoutEffect(() => { title.current?.focus() }, [])
  const dependents = impact?.dependent_item_ids.length ?? item.dependents
  return (
    <div
      className={styles.confirm}
      role="group"
      aria-labelledby="library-delete-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onKeep()
      }}
    >
      <p id="library-delete-title" className={styles.confirmTitle} tabIndex={-1} ref={title}>{t('canvas.lidar.library.deleteTitle', { name: item.name })}</p>
      {dependents > 0 ? <>
        <p>{t('canvas.lidar.library.deleteBlocked', { count: dependents })}</p>
        <div className={styles.formActions}>
          <button type="button" className={styles.dialogButton} onClick={onKeep}>{t('canvas.lidar.library.keep')}</button>
        </div>
      </> : <>
        <p>{inCurrentDesign ? t('canvas.lidar.library.deleteBodyInDesign') : t('canvas.lidar.library.deleteBody')}</p>
        <p className={styles.muted}>{t('canvas.lidar.library.deleteOtherDesigns')}</p>
        <p className={styles.muted}>{t('canvas.lidar.library.deleteNoUndo')}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.formActions}>
          <button type="button" className={styles.dialogButton} onClick={onKeep}>{t('canvas.lidar.library.keep')}</button>
          <button type="button" className={`${styles.dialogButton} ${styles.danger}`} disabled={busy || item.status === 'preparing' || isRunning(item)} onClick={onDelete}>
            {t('canvas.lidar.library.deleteEverywhere')}
          </button>
        </div>
      </>}
    </div>
  )
}
