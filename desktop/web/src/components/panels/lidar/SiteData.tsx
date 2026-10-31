import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { currentDesign, designSessionStore } from '../../../app/document-session/store'
import {
  attachmentFailure,
  cancelAnalysisJob,
  cancelLibraryImport,
  dismissAttachmentFailure,
  moveReferenceTo,
  pendingAttachments,
  removeFromDesign,
  rerunAnalysis,
  setLidarEntryVisibility,
  setSiteDataShown,
} from '../../../app/lidar/actions'
import { siteDataLines, type SiteDataLine } from '../../../app/lidar/analysis-groups'
import { analysisTitle } from '../../../app/analyses/registry'
import { viewDesignLocation, viewLidarCoverage } from '../../../app/lidar/camera-request'
import { lidarDisplayStyle, readLidarEntryDisplay } from '../../../app/lidar/display'
import { formatRasterRange, legendGradient } from '../../../app/lidar/display-legend'
import { itemTypeLabel } from '../../../app/lidar/item-types'
import { beginDataImport, openDataLibrary } from '../../../app/lidar/library-navigation'
import {
  isMissing,
  libraryItemName,
  lidarLibrary,
  readCurrentLidarPresentation,
  type LidarMissingReason,
  type LidarPresentationItem,
} from '../../../app/lidar/library-store'
import {
  filterKeepingAncestors,
  referenceRows,
  siblingMoveOrders,
  siblingNeighbour,
  siblingUnits,
  type ReferenceRow,
} from '../../../app/lidar/reference-tree'
import type { SiteDataView } from '../../../app/lidar/site-data-view'
import { siteValues } from '../../../app/lidar/site-values'
import { formatRowValue } from '../../../app/lidar/value-format'
import { locale } from '../../../app/settings/state'
import type { LibraryItemSummary } from '../../../generated/contracts'
import { t } from '../../../i18n'
import { ButtonTooltip } from '../../shared/ButtonTooltip'
import { ControlIcon } from '../../shared/ControlIcon'
import { LayerVisibilityIcon } from '../../shared/LayerVisibilityIcon'
import layerRow from '../../shared/layer-row.module.css'
import { Notice } from '../../shared/Notice'
import { PanelIcon } from '../../shared/PanelIcon'
import { SurfaceSearch } from '../../shared/SurfaceSearch'
import { usePointerReorder } from '../../shared/usePointerReorder'
import { staleReasonText } from '../analyze/analysis-text'
import { RasterDisplayControls } from './RasterDisplayControls'
import { unitWords } from './item-text'
import styles from './site-data.module.css'
import type { LocaleKey } from '../../../generated/locale-keys'

type SiteRow = ReferenceRow<LidarPresentationItem>

/** The filter appears once the Design holds more than this many entries (U49 decision 3). */
const FILTER_ABOVE = 8
/** Indent per nesting depth, in px (spec §1.10 "Rows"). */
const INDENT_PX = 16

/** One listed line: an item, an analysis run's heading, or library work joining the Design. */
type ListLine =
  | (SiteDataLine<LidarPresentationItem> & { readonly collapsible: boolean })
  | { readonly kind: 'pending'; readonly key: string; readonly work: 'import' | 'analysis'; readonly items: readonly LibraryItemSummary[]; readonly depth: number }

interface DragSession {
  readonly sourceId: string
  /** The units the row moves among, front first, as stored when the drag began. */
  readonly units: readonly (readonly string[])[]
  readonly from: number
  target: string | null
}

function collapseKey(line: SiteDataLine<LidarPresentationItem>): string {
  return line.kind === 'analysis' ? `analysis:${line.definitionId}` : line.row.id
}

function nameOfItem(id: string): string {
  const library = lidarLibrary.value
  const item = library?.items.find((candidate) => candidate.id === id)
  return item ? libraryItemName(item, library) : t('canvas.lidar.library.dataUnavailable')
}

/** The library's match rule: trimmed, case-folded, anywhere in the name. */
function matches(item: LidarPresentationItem, query: string): boolean {
  return item.name.toLocaleLowerCase(locale.value).includes(query.toLocaleLowerCase(locale.value))
}

/**
 * The Design's site data (canopi-f47t.42, spec §1.10): one line per item,
 * front first (the list is the draw order), results under their source and a
 * run's outputs under one analysis line; pending imports and calculations
 * where they will land; the open item's settings under its row. Order,
 * visibility and display are Design presentation; they never change an
 * item's values or source priority. Collapse, the filter and the open item
 * are the session's view (`site-data-view.ts`), never stored.
 */
export function SiteDataList({ view }: { readonly view: SiteDataView }) {
  const items = readCurrentLidarPresentation()
  const sectionShown = currentDesign.value?.lidar?.visible ?? true
  const identity = designSessionStore.sessionIdentity.value
  const pending = pendingAttachments.value.filter((entry) => entry.identity === identity)
  const failure = attachmentFailure.value
  const openItem = view.openItem.value
  const collapsed = view.collapsed.value
  const query = view.filter.value.trim()
  const filtering = query !== ''
  const list = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ readonly sourceId: string; readonly target: string | null } | null>(null)

  useExpandForNewResults(items, view)

  const beginDrag = usePointerReorder<DragSession>({
    move(session, event) {
      event.preventDefault()
      const target = dropTarget(list.current, session, event.clientY)
      if (target === session.target) return
      session.target = target
      setDrag({ sourceId: session.sourceId, target })
    },
    finish(session, event) {
      event.preventDefault()
      setDrag(null)
      if (session.target) moveReferenceTo(session.sourceId, session.target)
    },
    cancel: () => setDrag(null),
  })

  // While dragging, the list shows the order the drop would write: the same rule writes it.
  const preview = drag?.target ? siblingMoveOrders(items, drag.sourceId, drag.target) : null
  const nodes = preview ? items.map((item) => ({ ...item, order: preview.get(item.id) ?? item.order })) : items
  const rows = referenceRows(nodes)
  const shownRows = filtering ? filterKeepingAncestors(rows, (row) => row.id === openItem || matches(row, query)) : rows
  const lines = withPending(visibleLines(siteDataLines(shownRows), filtering ? new Set() : collapsed), pending, rows)

  function toggleCollapsed(key: string, ids: readonly string[]): void {
    const next = new Set(collapsed)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
      // Collapsing a parent closes an open item it hides.
      if (openItem && ids.includes(openItem)) view.openItem.value = null
    }
    view.collapsed.value = next
  }

  function move(row: SiteRow, towards: 'front' | 'back', control: 'grip' | 'name'): void {
    if (filtering) return
    const target = siblingNeighbour(items, row.id, towards)
    if (!target) return
    moveReferenceTo(row.id, target)
    // The row moved: keep focus on the same control (the Stories precedent).
    requestAnimationFrame(() => rowElement(list.current, row.id)?.querySelector<HTMLElement>(`[data-control="${control}"]`)?.focus())
  }

  return (
    <div className={styles.band}>
      {!sectionShown && items.length > 0 && (
        <div className={styles.strip} role="status">
          <span>{t('siteData.hiddenFromMap')}</span>
          <button type="button" className={styles.stripButton} onClick={() => setSiteDataShown(true)}>{t('siteData.show')}</button>
        </div>
      )}
      {failure && (
        <Notice
          tone="warning"
          action={<>
            <button type="button" className={styles.noticeButton} onClick={() => { dismissAttachmentFailure(); openDataLibrary(failure.itemId) }}>
              {t('canvas.lidar.layers.showInLibrary')}
            </button>
            <button type="button" className={styles.noticeButton} onClick={dismissAttachmentFailure}>{t('canvas.lidar.library.dismiss')}</button>
          </>}
        >
          {t('canvas.lidar.layers.failedNoMessage', { name: nameOfItem(failure.itemId) })}
        </Notice>
      )}
      {(items.length > FILTER_ABOVE || filtering) && (
        <div className={styles.filter}>
          <SurfaceSearch
            value={view.filter.value}
            onChange={(value) => { view.filter.value = value }}
            label={t('siteData.filterLabel')}
            placeholder={t('siteData.filterPlaceholder')}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !view.filter.value) return
              event.preventDefault()
              event.stopPropagation()
              view.filter.value = ''
            }}
          />
        </div>
      )}
      {items.length === 0 && pending.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon} aria-hidden="true"><PanelIcon panel="site-data" /></span>
          <strong>{t('canvas.lidar.layers.emptyTitle')}</strong>
          <p>{t('canvas.lidar.layers.emptyBody')}</p>
          <div className={styles.emptyActions}>
            <button type="button" onClick={() => { void beginDataImport() }}>{t('canvas.lidar.layers.emptyImport')}</button>
            <button type="button" onClick={() => openDataLibrary()}>{t('canvas.lidar.layers.emptyLibrary')}</button>
          </div>
        </div>
      )}
      {filtering && shownRows.length === 0 && <p className={styles.noMatch} role="status">{t('canvas.lidar.library.noMatch')}</p>}
      {lines.length > 0 && (
        <ul ref={list} className={styles.list} data-dragging={drag ? 'true' : undefined}>
          {lines.map((line) => {
            if (line.kind === 'pending') return <PendingLine key={`pending:${line.key}`} line={line} />
            const key = collapseKey(line)
            const expanded = !collapsed.has(key)
            // Every row the chevron hides: a run's outputs and all nested under them, or a row's descendants.
            const heads = line.kind === 'analysis' ? line.members.map((member) => member.id) : [line.row.id]
            const descendants = rows
              .filter((candidate) => (line.kind === 'analysis' && heads.includes(candidate.id))
                || heads.some((head) => isDescendant(rows, candidate, head)))
              .map((candidate) => candidate.id)
            const chevron = line.collapsible && !filtering
              ? { expanded, toggle: () => toggleCollapsed(key, descendants) }
              : null
            if (line.kind === 'analysis') return <AnalysisLine key={key} line={line} chevron={chevron} />
            return (
              <SiteDataRow
                key={key}
                row={line.row}
                depth={line.depth}
                open={line.row.id === openItem}
                reorder={!filtering}
                chevron={chevron}
                onToggleOpen={() => { view.openItem.value = openItem === line.row.id ? null : line.row.id }}
                onMove={(towards, control) => move(line.row, towards, control)}
                onDragBegin={(event) => {
                  if (event.button !== 0 || filtering) return
                  const units = siblingUnits(items, line.row.id)
                  if (!units) return
                  event.preventDefault()
                  beginDrag(event, { sourceId: line.row.id, units, from: units.findIndex((unit) => unit.includes(line.row.id)), target: null })
                }}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Where a drop at `clientY` puts the dragged unit: before the first other
 * unit whose first row's middle is below the pointer; a run collapsed under
 * its analysis line is measured by that line. Returns the row whose place it
 * takes (`siblingMoveOrders`), or null where it started.
 */
function dropTarget(list: HTMLUListElement | null, session: DragSession, clientY: number): string | null {
  const others = session.units.filter((_, index) => index !== session.from)
  let insert = others.length
  for (let index = 0; index < others.length; index += 1) {
    const unit = others[index]!
    const head = rowElement(list, unit[0]!) ?? runElement(list, unit)
    if (!head) continue
    const rect = head.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      insert = index
      break
    }
  }
  return insert === session.from ? null : session.units[insert]![0]!
}

/** The list item of one Site data row; ids are matched as data, never as selector text. */
export function rowElement(root: ParentNode | null, id: string): HTMLElement | null {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-site-row]') ?? []).find((element) => element.dataset.siteRow === id) ?? null
}

/** The analysis line of a run, found by any of its outputs; ids are matched as data. */
function runElement(root: ParentNode | null, unit: readonly string[]): HTMLElement | null {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-site-run]') ?? [])
    .find((element) => unit.includes(element.dataset.siteRun ?? '')) ?? null
}

function isDescendant(rows: readonly SiteRow[], row: SiteRow, ancestorId: string): boolean {
  const byId = new Map(rows.map((candidate) => [candidate.id, candidate]))
  for (let parent = row.parentId; parent; parent = byId.get(parent)?.parentId ?? null) {
    if (parent === ancestorId) return true
  }
  return false
}

/** The lines left once collapsed parents hide theirs (in the panel only; the map is unchanged), each told whether it has any. */
function visibleLines(
  all: readonly SiteDataLine<LidarPresentationItem>[],
  collapsed: ReadonlySet<string>,
): (SiteDataLine<LidarPresentationItem> & { readonly collapsible: boolean })[] {
  const shown: (SiteDataLine<LidarPresentationItem> & { readonly collapsible: boolean })[] = []
  let hiddenBelow: number | null = null
  all.forEach((line, index) => {
    if (hiddenBelow !== null && line.depth > hiddenBelow) return
    hiddenBelow = null
    const collapsible = line.kind === 'analysis' || (all[index + 1]?.depth ?? -1) > line.depth
    shown.push({ ...line, collapsible })
    if (collapsible && collapsed.has(collapseKey(line))) hiddenBelow = line.depth
  })
  return shown
}

/**
 * Library work joining this Design, where it will land (U49 Q11): an import
 * at the top of the list, a calculation as the first line under its source,
 * or at the top when its source is not listed.
 */
function withPending(
  lines: readonly (SiteDataLine<LidarPresentationItem> & { readonly collapsible: boolean })[],
  pending: readonly { readonly key: string; readonly kind: 'import' | 'analysis'; readonly itemIds: readonly string[] }[],
  rows: readonly SiteRow[],
): ListLine[] {
  const snapshot = lidarLibrary.value
  const out: ListLine[] = [...lines]
  for (const entry of pending) {
    const work = entry.itemIds
      .map((id) => snapshot?.items.find((candidate) => candidate.id === id))
      .filter((item): item is LibraryItemSummary => item !== undefined)
    if (work.length === 0) continue
    const inputId = entry.kind === 'analysis' ? work[0]!.provenance?.inputs[0]?.item_id ?? null : null
    const parent = inputId ? out.findIndex((line) => line.kind === 'item' && line.row.id === inputId) : -1
    const parentLine = parent >= 0 ? out[parent] as SiteDataLine<LidarPresentationItem> : null
    const line: ListLine = { kind: 'pending', key: entry.key, work: entry.kind, items: work, depth: parentLine ? parentLine.depth + 1 : 0 }
    if (parentLine && rows.some((row) => row.id === inputId)) out.splice(parent + 1, 0, line)
    else out.unshift(line)
  }
  return out
}

/** A result that joins this Design opens the collapsed rows above it, so it is seen landing. */
function useExpandForNewResults(items: readonly LidarPresentationItem[], view: SiteDataView): void {
  const known = useRef<ReadonlySet<string> | null>(null)
  const ids = items.map((item) => item.id).join('\n')
  useEffect(() => {
    const previous = known.current
    known.current = new Set(items.map((item) => item.id))
    if (!previous) return
    const byId = new Map(items.map((item) => [item.id, item]))
    const expand = new Set<string>()
    for (const item of items) {
      if (previous.has(item.id) || !item.parentId) continue
      for (let parent = byId.get(item.parentId); parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
        expand.add(parent.id)
        if (parent.definitionId) expand.add(`analysis:${parent.definitionId}`)
      }
      if (item.definitionId) expand.add(`analysis:${item.definitionId}`)
    }
    const collapsed = view.collapsed.peek()
    if ([...expand].some((key) => collapsed.has(key))) {
      view.collapsed.value = new Set([...collapsed].filter((key) => !expand.has(key)))
    }
  }, [ids])
}

function Chevron({ name, chevron }: {
  readonly name: string
  readonly chevron: { readonly expanded: boolean; toggle(): void } | null
}) {
  if (!chevron) return <span className={styles.chevronSlot} aria-hidden="true" />
  const label = chevron.expanded ? t('siteData.collapse', { name }) : t('siteData.expand', { name })
  return (
    <button type="button" className={styles.chevron} aria-label={label} aria-expanded={chevron.expanded} onClick={chevron.toggle}>
      <ControlIcon name={chevron.expanded ? 'chevron-down' : 'chevron-right'} size={16} />
    </button>
  )
}

function Indent({ depth }: { readonly depth: number }) {
  return depth > 0 ? <span className={styles.indent} style={{ width: `${depth * INDENT_PX}px` }} aria-hidden="true" /> : null
}

/**
 * The heading of an analysis run with several outputs in this Design (kept
 * for hydrology 2.1): its title, a chevron and one eye for every output; no
 * grip, since the run moves with its outputs.
 */
function AnalysisLine({ line, chevron }: {
  readonly line: Extract<SiteDataLine<LidarPresentationItem>, { kind: 'analysis' }>
  readonly chevron: { readonly expanded: boolean; toggle(): void } | null
}) {
  const first = line.members[0]!
  const label = first.analysisId ? analysisTitle(first.analysisId) : first.name
  const visible = line.members.some((member) => member.visible)
  const shown = line.members.some((member) => member.shown)
  const eyeLabel = visible ? t('canvas.lidar.layers.hide', { name: label }) : t('canvas.lidar.layers.show', { name: label })
  return (
    <li className={`${layerRow.row} ${styles.row}`} data-site-line={`analysis:${line.definitionId}`} data-site-run={first.id} data-depth={line.depth} data-hidden={!shown}>
      <div className={styles.line}>
        <span className={styles.gripSlot} aria-hidden="true" />
        <Indent depth={line.depth} />
        <Chevron name={label} chevron={chevron} />
        <button type="button" className={layerRow.eye} aria-pressed={visible} aria-label={eyeLabel}
          onClick={() => { for (const member of line.members) setLidarEntryVisibility(member.id, !visible) }}>
          <LayerVisibilityIcon open={visible} />
          <ButtonTooltip label={eyeLabel} side="left" />
        </button>
        <span className={styles.groupName} title={label}>{label}</span>
      </div>
    </li>
  )
}

function SiteDataRow({ row, depth, open, reorder, chevron, onToggleOpen, onMove, onDragBegin }: {
  readonly row: SiteRow
  readonly depth: number
  readonly open: boolean
  readonly reorder: boolean
  readonly chevron: { readonly expanded: boolean; toggle(): void } | null
  onToggleOpen(): void
  onMove(towards: 'front' | 'back', control: 'grip' | 'name'): void
  onDragBegin(event: PointerEvent): void
}) {
  const element = useRef<HTMLLIElement>(null)
  const missing = isMissing(row)
  const style = missing ? null : lidarDisplayStyle(row)
  const eyeLabel = row.visible ? t('canvas.lidar.layers.hide', { name: row.name }) : t('canvas.lidar.layers.show', { name: row.name })
  const reorderLabel = t('siteData.reorder', { name: row.name })
  const altArrows = (control: 'grip' | 'name') => (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    onMove(event.key === 'ArrowUp' ? 'front' : 'back', control)
  }

  useLayoutEffect(() => {
    if (open) element.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  return (
    <li ref={element} className={`${layerRow.row} ${styles.row}`} data-site-line="item" data-site-row={row.id} data-depth={depth} data-hidden={!row.shown}>
      <div className={styles.line}>
        {reorder
          ? (
            <button
              type="button"
              className={styles.grip}
              data-control="grip"
              aria-label={reorderLabel}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onPointerDown={onDragBegin}
              onKeyDown={altArrows('grip')}
            >
              <ControlIcon name="grip" size={16} />
              <ButtonTooltip label={reorderLabel} description={t('stories.reorderHint')} side="right" />
            </button>
          )
          : <span className={styles.gripSlot} aria-hidden="true" />}
        <Indent depth={depth} />
        <Chevron name={row.name} chevron={chevron} />
        {missing
          ? <span className={styles.alert} aria-hidden="true"><ControlIcon name="alert" size={16} /></span>
          : (
            <button type="button" className={layerRow.eye} aria-pressed={row.visible} aria-label={eyeLabel}
              onClick={() => setLidarEntryVisibility(row.id, !row.visible)}>
              <LayerVisibilityIcon open={row.visible} />
              <ButtonTooltip label={eyeLabel} side="left" />
            </button>
          )}
        <span className={styles.swatch} data-swatch
          style={style ? { backgroundImage: legendGradient(style.ramp, style.reversed) } : undefined} />
        <button
          type="button"
          className={`${layerRow.name} ${styles.name}`}
          data-control="name"
          title={row.name}
          aria-expanded={open}
          aria-keyshortcuts={reorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onClick={onToggleOpen}
          onKeyDown={altArrows('name')}
        >
          {row.name}
        </button>
        <Trailing row={row} />
      </div>
      {open && <ItemBody row={row} />}
    </li>
  )
}

function isStale(item: LidarPresentationItem): boolean {
  return item.state === 'Ready' && item.freshness.state === 'Stale'
}

function refresh(item: LidarPresentationItem): void {
  if (item.definitionId) void rerunAnalysis(item.definitionId).catch(() => {})
}

/**
 * The one thing at a row's end: Missing, Refreshing or Refresh on an
 * out-of-date result, Preparing, Display failed, or the value under the
 * pointer or the pin ("—" where the data has none). Hidden rows show none.
 */
function Trailing({ row }: { readonly row: LidarPresentationItem }) {
  if (isMissing(row)) return <span className={`${styles.trailing} ${styles.warning}`} data-trailing>{t('siteData.missing')}</span>
  if (row.availability !== 'present') return <span className={styles.trailing} data-trailing />
  if (isStale(row)) {
    if (row.run?.state === 'Preparing') return <span className={`${styles.trailing} ${styles.muted}`} data-trailing>{t('analyses.details.refreshing')}</span>
    return (
      <span className={styles.trailing} data-trailing>
        <button type="button" className={styles.refresh} aria-label={t('analyses.details.refreshAria', { name: row.name })} onClick={() => refresh(row)}>
          {t('analyses.details.refresh')}
          <ButtonTooltip label={t('analyses.details.outOfDate')} side="left" />
        </button>
      </span>
    )
  }
  if (row.state !== 'Ready') return <span className={`${styles.trailing} ${styles.muted}`} data-trailing>{t('canvas.lidar.library.preparing')}</span>
  if (!row.shown) return <span className={styles.trailing} data-trailing />
  const display = readLidarEntryDisplay(row)
  if (display?.state === 'Failed') return <span className={`${styles.trailing} ${styles.warning}`} data-trailing>{t('canvas.lidar.library.displayFailed')}</span>
  if (display?.state === 'Preparing') return <span className={`${styles.trailing} ${styles.muted}`} data-trailing>{t('canvas.lidar.library.preparing')}</span>
  const value = siteValues.value?.rows.get(row.id)
  if (!value) return <span className={styles.trailing} data-trailing />
  if (value.kind === 'no-data') {
    return <span className={`${styles.trailing} ${styles.muted}`} data-trailing role="img" aria-label={t('siteData.noData')}>—</span>
  }
  return <span className={styles.trailing} data-trailing>{formatRowValue(value.value, row.units, locale.value)}</span>
}

const MISSING_REASON_KEYS: Readonly<Record<LidarMissingReason, LocaleKey>> = {
  'not-in-library': 'siteData.missingReason.not-in-library',
  'needs-newer-canopi': 'siteData.missingReason.needs-newer-canopi',
  'library-unopened': 'siteData.missingReason.library-unopened',
}

/** What a row is: a source's type and range, or where a result comes from, with its units. */
function caption(item: LidarPresentationItem): string {
  if (!item.itemType) return ''
  if (item.inputId) return [t('canvas.lidar.layers.fromItem', { name: nameOfItem(item.inputId) }), unitWords(item.units)].filter(Boolean).join(' · ')
  return [itemTypeLabel(item.itemType), item.displayRange ? formatRasterRange(item.displayRange, item.units, locale.value) : null]
    .filter(Boolean).join(' · ')
}

/**
 * The open item's body under its row: what it is, why it is out of date, its
 * display, then Fit to data, Details and Remove from Design. A missing item
 * shows its reason and Remove from Design only (U49 decision 7).
 */
function ItemBody({ row }: { readonly row: LidarPresentationItem }) {
  const [focused, setFocused] = useState(false)
  const remove = (
    <div className={styles.remove}>
      <button type="button" className={styles.link} aria-label={t('canvas.lidar.layers.removeAria', { name: row.name })}
        onClick={() => removeFromDesign(row.id)}>
        {t('canvas.lidar.layers.removeFromDesign')}
      </button>
      <span>{t('canvas.lidar.layers.removeKeeps')}</span>
    </div>
  )
  if (isMissing(row)) {
    return (
      <div className={styles.itemBody}>
        <p className={styles.reason}>{t(MISSING_REASON_KEYS[row.availability as LidarMissingReason])}</p>
        {remove}
      </div>
    )
  }
  const present = row.availability === 'present'
  return (
    <div className={styles.itemBody}>
      {present && <p className={styles.caption}>{caption(row)}</p>}
      {isStale(row) && row.freshness.state === 'Stale' && (
        <Notice tone="warning">
          <strong>{t('analyses.details.outOfDate')}</strong>
          <ul className={styles.reasons}>
            {row.freshness.reasons.map((reason, index) => <li key={index}>{staleReasonText(reason, nameOfItem)}</li>)}
          </ul>
        </Notice>
      )}
      <RasterDisplayControls item={row} />
      <div className={styles.actions}>
        {focused
          ? <button type="button" onClick={() => { viewDesignLocation(); setFocused(false) }}>{t('canvas.lidar.layers.returnToDesign')}</button>
          : (
            <button type="button" disabled={row.state !== 'Ready' || !row.bounds}
              onClick={() => { if (row.bounds && viewLidarCoverage(row.bounds)) setFocused(true) }}>
              {t('canvas.lidar.layers.fit')}
            </button>
          )}
        {present && <button type="button" onClick={() => openDataLibrary(row.id)}>{t('canvas.lidar.layers.details')}</button>}
      </div>
      {remove}
    </div>
  )
}

/** Library work joining this Design: its name, progress and Cancel, with no grip and no eye. */
function PendingLine({ line }: { readonly line: Extract<ListLine, { kind: 'pending' }> }) {
  const first = line.items[0]!
  const name = libraryItemName(first, lidarLibrary.value)
  const percent = line.work === 'import' ? first.import_job?.progress?.percent : undefined
  const status = line.work === 'import' ? t('canvas.lidar.layers.importing') : t('canvas.lidar.library.calculating')
  const cancel = line.work === 'import' ? t('canvas.lidar.layers.cancelImport') : t('canvas.lidar.layers.cancelCalculation')
  return (
    <li className={`${layerRow.row} ${styles.row} ${styles.pending}`} data-site-line={`pending:${line.key}`} data-depth={line.depth}>
      <div className={styles.line}>
        <span className={styles.gripSlot} aria-hidden="true" />
        <Indent depth={line.depth} />
        <span className={styles.chevronSlot} aria-hidden="true" />
        <span className={styles.name}>{name}</span>
        <span className={`${styles.trailing} ${styles.muted}`}>
          {percent !== undefined ? `${status} · ${new Intl.NumberFormat(locale.value, { style: 'percent' }).format(percent / 100)}` : status}
        </span>
        {(line.work === 'analysis' || first.import_job) && (
          <button
            type="button"
            className={styles.cancel}
            aria-label={cancel}
            onClick={() => {
              if (line.work === 'import') void cancelLibraryImport(first.import_job!.job_id).catch(() => {})
              else void cancelAnalysisJob(first).catch(() => {})
            }}
          >
            <ControlIcon name="close" size={16} />
            <ButtonTooltip label={cancel} side="left" />
          </button>
        )}
      </div>
      {line.work === 'import' && (
        <progress className={styles.progress} max={100} value={percent} aria-label={t('canvas.lidar.library.progressAria', { name })} />
      )}
    </li>
  )
}
