import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import {
  designNotebookWorkbench,
  type DesignNotebookWorkbench,
} from '../../app/design-notebook'
import type { DesignNotebookEntry, DesignNotebookSection } from '../../types/design'
import { DockPanelHeader } from '../shared/DockPanelHeader'
import styles from './DesignNotebookPanel.module.css'
import { usePointerReorder } from '../shared/usePointerReorder'

const NOTEBOOK_DRAG_THRESHOLD_PX = 4

interface DesignNotebookPanelProps {
  readonly workbench?: DesignNotebookWorkbench
}

type NotebookDropPosition = 'before' | 'after' | 'inside'

interface NotebookDropTarget {
  readonly sectionId: string | null
  readonly beforePath: string | null
  readonly rowPath: string | null
  readonly position: NotebookDropPosition
}

interface NotebookPointerDragSession {
  readonly kind: 'entry' | 'section'
  readonly sourceId: string
  readonly startClientX: number
  readonly startClientY: number
  readonly baseEntries: readonly DesignNotebookEntry[]
  readonly baseSections: readonly DesignNotebookSection[]
  readonly baseSectionIds: readonly string[]
  dragging: boolean
  latestEntries: readonly DesignNotebookEntry[]
  latestSectionIds: readonly string[]
  latestDropTarget: NotebookDropTarget | null
}

export function DesignNotebookPanel({
  workbench = designNotebookWorkbench,
}: DesignNotebookPanelProps) {
  const lang = locale.value
  const view = workbench.view.value
  const listRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const suppressNextOpenPathRef = useRef<string | null>(null)
  const suppressOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [newSectionName, setNewSectionName] = useState('')
  const [sectionEditorOpen, setSectionEditorOpen] = useState(false)
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [draggedPath, setDraggedPath] = useState<string | null>(null)
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<NotebookDropTarget | null>(null)
  const [entryPreviewEntries, setEntryPreviewEntries] =
    useState<readonly DesignNotebookEntry[] | null>(null)
  const [sectionPreviewIds, setSectionPreviewIds] =
    useState<readonly string[] | null>(null)

  useEffect(() => {
    void workbench.load()
  }, [workbench])

  useEffect(() => () => {
    if (suppressOpenTimerRef.current !== null) clearTimeout(suppressOpenTimerRef.current)
  }, [])

  const beginReorder = usePointerReorder<NotebookPointerDragSession>({
    move: updatePointerDrag,
    finish: finishPointerDrag,
    cancel: clearDragPreview,
  })

  // The field takes focus as it replaces the title, so an Esc at once ends the rename (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (!renamingSectionId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingSectionId])

  const orderedSections = orderItemsForPreview(
    view.sections,
    sectionPreviewIds,
    (section) => section.id,
  )
  const orderedEntries = entryPreviewEntries ?? entriesInNotebookDisplayOrder(view.entries, orderedSections)
  const unsectionedEntries = entriesForSection(orderedEntries, null)
  const shouldShowUnsectioned = unsectionedEntries.length > 0 || draggedPath !== null

  function createSection(): void {
    const name = newSectionName.trim()
    if (!name) return
    void workbench.createSection(name).then(() => {
      setNewSectionName('')
      setSectionEditorOpen(false)
    })
  }

  function beginRename(section: DesignNotebookSection): void {
    setRenamingSectionId(section.id)
    setRenameDraft(section.name)
  }

  function commitRename(sectionId: string): void {
    const name = renameDraft.trim()
    if (!name) {
      cancelRename()
      return
    }
    void workbench.renameSection(sectionId, name).then(() => {
      setRenamingSectionId(null)
      setRenameDraft('')
    })
  }

  function cancelRename(): void {
    setRenamingSectionId(null)
    setRenameDraft('')
  }

  function beginEntryPointerDrag(path: string, event: PointerEvent): void {
    beginPointerDrag('entry', path, event)
  }

  function beginSectionPointerDrag(sectionId: string, event: PointerEvent): void {
    beginPointerDrag('section', sectionId, event)
  }

  function beginPointerDrag(
    kind: NotebookPointerDragSession['kind'],
    sourceId: string,
    event: PointerEvent,
  ): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
    beginReorder(event, {
      kind,
      sourceId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseEntries: orderedEntries,
      baseSections: orderedSections,
      baseSectionIds: orderedSections.map((section) => section.id),
      dragging: false,
      latestEntries: orderedEntries,
      latestSectionIds: orderedSections.map((section) => section.id),
      latestDropTarget: null,
    })
  }

  function updatePointerDrag(session: NotebookPointerDragSession, event: PointerEvent): void {
    const movedEnough = Math.abs(event.clientX - session.startClientX) >= NOTEBOOK_DRAG_THRESHOLD_PX
      || Math.abs(event.clientY - session.startClientY) >= NOTEBOOK_DRAG_THRESHOLD_PX
    if (!session.dragging && !movedEnough) return

    event.preventDefault()
    if (!session.dragging) {
      session.dragging = true
      if (session.kind === 'entry') setDraggedPath(session.sourceId)
      else setDraggedSectionId(session.sourceId)
    }

    if (session.kind === 'entry') {
      updateEntryPointerDrag(session, event.clientY)
    } else {
      updateSectionPointerDrag(session, event.clientY)
    }
  }

  function updateEntryPointerDrag(
    session: NotebookPointerDragSession,
    clientY: number,
  ): void {
    const target = dropTargetForPointer(listRef.current, session, clientY)
    if (!target) return
    const nextEntries = entriesAfterDrop(session.baseEntries, session.baseSections, session.sourceId, target)
    if (!nextEntries) return
    session.latestDropTarget = target
    session.latestEntries = nextEntries
    setDropTarget(target)
    setEntryPreviewEntries(nextEntries)
  }

  function updateSectionPointerDrag(
    session: NotebookPointerDragSession,
    clientY: number,
  ): void {
    const nextSectionIds = sectionOrderForPointer(listRef.current, session, clientY)
    session.latestSectionIds = nextSectionIds
    setSectionPreviewIds(nextSectionIds)
  }

  function finishPointerDrag(session: NotebookPointerDragSession, event: PointerEvent, isCurrent: () => boolean): void {
    if (session.dragging) event.preventDefault()
    if (!session.dragging) {
      clearDragPreview()
      return
    }

    if (session.kind === 'entry') {
      commitEntryPointerDrag(session, isCurrent)
    } else {
      commitSectionPointerDrag(session, isCurrent)
    }
  }

  function commitEntryPointerDrag(session: NotebookPointerDragSession, isCurrent: () => boolean): void {
    suppressRowOpenOnce(session.sourceId)
    const target = session.latestDropTarget
    const source = session.baseEntries.find((entry) => entry.path === session.sourceId)
    if (!target || !source) {
      clearDragPreview()
      return
    }

    const currentPaths = session.baseEntries.map((entry) => entry.path)
    const nextPaths = session.latestEntries.map((entry) => entry.path)
    const sectionChanged = source.section_id !== target.sectionId
    const orderChanged = !sameIdOrder(currentPaths, nextPaths)
    if (!sectionChanged && !orderChanged) {
      clearDragPreview()
      return
    }

    void workbench.relocateEntry(session.sourceId, target.sectionId, nextPaths)
      .catch(() => {
        // The Workbench refreshes its projection after a failed relocation.
      })
      .finally(() => { if (isCurrent()) clearDragPreview() })
  }

  function commitSectionPointerDrag(session: NotebookPointerDragSession, isCurrent: () => boolean): void {
    if (sameIdOrder(session.baseSectionIds, session.latestSectionIds)) {
      clearDragPreview()
      return
    }

    void workbench.reorderSections(session.latestSectionIds)
      .catch(() => {
        void workbench.refresh()
      })
      .finally(() => { if (isCurrent()) clearDragPreview() })
  }

  function suppressRowOpenOnce(path: string): void {
    suppressNextOpenPathRef.current = path
    if (suppressOpenTimerRef.current !== null) clearTimeout(suppressOpenTimerRef.current)
    suppressOpenTimerRef.current = setTimeout(() => {
      suppressOpenTimerRef.current = null
      if (suppressNextOpenPathRef.current === path) {
        suppressNextOpenPathRef.current = null
      }
    }, 0)
  }

  function openEntryFromRow(path: string): void {
    if (suppressNextOpenPathRef.current === path) {
      suppressNextOpenPathRef.current = null
      return
    }
    void workbench.openEntry(path)
  }

  function clearDragPreview(): void {
    setDraggedPath(null)
    setDraggedSectionId(null)
    setDropTarget(null)
    setEntryPreviewEntries(null)
    setSectionPreviewIds(null)
  }

  return (
    <section className={styles.panel} aria-label={t('designNotebook.title')}>
      <DockPanelHeader title={t('designNotebook.title')} />
      <header className={styles.header}>
        <div className={styles.headerActions}>
          <button
            disabled={!view.canAddCurrentDesign}
            className={styles.headerButton}
            type="button"
            aria-label={t('designNotebook.addCurrentDesign')}
            title={view.canAddCurrentDesign ? t(view.currentDesignPath ? 'designNotebook.addCurrentSavedHint' : 'designNotebook.addCurrentUnsavedHint') : undefined}
            onClick={() => {
              void workbench.addCurrentDesignToNotebook(view.sections[0]?.id ?? null)
            }}
          >
            <PlusIcon />
            <span>{t('designNotebook.addCurrentButton')}</span>
          </button>
          <button
            className={styles.headerButton}
            type="button"
            aria-label={t('designNotebook.newSectionAction')}
            aria-expanded={sectionEditorOpen}
            onClick={() => setSectionEditorOpen((open) => !open)}
          >
            <PlusIcon />
            <span>{t('designNotebook.newSectionAction')}</span>
          </button>
        </div>

        {sectionEditorOpen && (
          <div className={styles.headerEditor}>
            <input
              className={styles.sectionInput}
              aria-label={t('designNotebook.newSectionName')}
              value={newSectionName}
              placeholder={t('designNotebook.newSectionPlaceholder')}
              onInput={(event) => setNewSectionName((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  createSection()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSectionEditorOpen(false)
                  setNewSectionName('')
                }
              }}
            />
            <button
              className={styles.sectionCreateButton}
              type="button"
              aria-label={t('designNotebook.createSection')}
              disabled={newSectionName.trim().length === 0}
              onClick={createSection}
            >
              {t('designNotebook.createSection')}
            </button>
          </div>
        )}
      </header>

      <div ref={listRef} className={styles.list} role="list">
        {view.loading && view.entries.length === 0 ? (
          <div className={styles.feedback}>{t('designNotebook.loading')}</div>
        ) : view.loadError ? (
          <div className={styles.feedback}>{t('designNotebook.loadError')}</div>
        ) : view.entries.length === 0 && view.sections.length === 0 ? (
          <EmptyState
            title={t('designNotebook.emptyTitle')}
            text={t('designNotebook.emptyText')}
          />
        ) : (
          <>
            {shouldShowUnsectioned && (
              <NotebookSectionGroup
                sectionId={null}
                title={t('designNotebook.unsectioned')}
                dragging={false}
                dropActive={isSectionDropTarget(dropTarget, null)}
              >
                {unsectionedEntries.map((entry) => (
                  <NotebookRow
                    key={entry.path}
                    entry={entry}
                    lang={lang}
                    active={entry.path === view.activePath}
                    dragging={entry.path === draggedPath}
                    dropPosition={dropPositionForRow(dropTarget, entry.path)}
                    onOpen={() => {
                      openEntryFromRow(entry.path)
                    }}
                    onRemove={() => {
                      void workbench.removeEntry(entry.path)
                    }}
                    onPointerDown={(event) => beginEntryPointerDrag(entry.path, event)}
                  />
                ))}
                {unsectionedEntries.length === 0 && (
                  <div className={styles.sectionEmpty}>{t('designNotebook.sectionEmpty')}</div>
                )}
              </NotebookSectionGroup>
            )}

            {orderedSections.map((section) => {
              const entries = entriesForSection(orderedEntries, section.id)
              const renaming = renamingSectionId === section.id

              return (
                <NotebookSectionGroup
                  key={section.id}
                  sectionId={section.id}
                  title={section.name}
                  dragging={section.id === draggedSectionId}
                  titleEditor={renaming ? (
                    <input
                      ref={renameInputRef}
                      className={styles.sectionRenameInput}
                      aria-label={t('designNotebook.sectionName')}
                      value={renameDraft}
                      onInput={(event) => setRenameDraft((event.currentTarget as HTMLInputElement).value)}
                      onFocusOut={() => commitRename(section.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename(section.id)
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                    />
                  ) : undefined}
                  actions={!renaming && (
                    <button
                      className={styles.sectionIconButton}
                      type="button"
                      aria-label={t('designNotebook.deleteSection', { name: section.name })}
                      onClick={() => {
                        void workbench.deleteSection(section.id)
                      }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                  dropActive={isSectionDropTarget(dropTarget, section.id)}
                  onTitlePointerDown={(event) => beginSectionPointerDrag(section.id, event)}
                  onTitleDoubleClick={() => beginRename(section)}
                >
                  {entries.map((entry) => (
                    <NotebookRow
                      key={entry.path}
                      entry={entry}
                      lang={lang}
                      active={entry.path === view.activePath}
                      dragging={entry.path === draggedPath}
                      dropPosition={dropPositionForRow(dropTarget, entry.path)}
                      onOpen={() => {
                        openEntryFromRow(entry.path)
                      }}
                      onRemove={() => {
                        void workbench.removeEntry(entry.path)
                      }}
                      onPointerDown={(event) => beginEntryPointerDrag(entry.path, event)}
                    />
                  ))}
                  {entries.length === 0 && (
                    <div className={styles.sectionEmpty}>{t('designNotebook.sectionEmpty')}</div>
                  )}
                </NotebookSectionGroup>
              )
            })}
          </>
        )}
      </div>
    </section>
  )
}

function EmptyState({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyText}>{text}</p>
    </div>
  )
}

function NotebookSectionGroup({
  sectionId,
  title,
  dragging,
  titleEditor,
  actions,
  dropActive,
  onTitlePointerDown,
  onTitleDoubleClick,
  children,
}: {
  readonly sectionId: string | null
  readonly title: string
  readonly dragging: boolean
  readonly titleEditor?: ComponentChildren
  readonly actions?: ComponentChildren
  readonly dropActive: boolean
  readonly onTitlePointerDown?: (event: PointerEvent) => void
  readonly onTitleDoubleClick?: () => void
  readonly children: ComponentChildren
}) {
  return (
    <section
      className={classNames(
        styles.sectionGroup,
        dragging && styles.sectionDragging,
        dropActive && styles.sectionDropTarget,
      )}
      aria-label={title}
      data-notebook-section-id={notebookEntrySectionKey(sectionId)}
      data-notebook-section-row={sectionId ?? undefined}
    >
      <header className={styles.sectionHeader}>
        {titleEditor ?? (
          <h3
            className={styles.sectionTitle}
            onPointerDown={onTitlePointerDown}
            onDblClick={onTitleDoubleClick}
          >
            {title}
          </h3>
        )}
        {actions}
      </header>
      {children}
    </section>
  )
}

function NotebookRow({
  entry,
  lang,
  active,
  dragging,
  dropPosition,
  onOpen,
  onRemove,
  onPointerDown,
}: {
  readonly entry: DesignNotebookEntry
  readonly lang: string
  readonly active: boolean
  readonly dragging: boolean
  readonly dropPosition: NotebookDropPosition | null
  readonly onOpen: () => void
  readonly onRemove: () => void
  readonly onPointerDown: (event: PointerEvent) => void
}) {
  const date = formatDate(entry.updated_at, lang)

  return (
    <div
      className={classNames(
        styles.row,
        active && styles.rowActive,
        dragging && styles.rowDragging,
        dropPosition === 'before' && styles.rowDropBefore,
        dropPosition === 'after' && styles.rowDropAfter,
      )}
      role="listitem"
      data-notebook-entry-row={entry.path}
      data-notebook-entry-section={notebookEntrySectionKey(entry.section_id)}
    >
      <button
        className={styles.rowOpen}
        type="button"
        aria-current={active ? 'true' : undefined}
        data-design-path={entry.path}
        title={entry.path}
        onPointerDown={onPointerDown}
        onClick={onOpen}
      >
        <svg className={styles.fileIcon} width="18" height="22" viewBox="0 0 18 22" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M3 1h8l4 4v16H3ZM11 1v5h4M6 10h6M6 14h6" /></svg>
        <span className={styles.rowMain}>
          <span className={styles.rowName}>{entry.name}</span>
        </span>
        <span className={styles.rowMeta}>
          {active ? t('designNotebook.openNow') : date}
          {entry.plant_count > 0 && (
            <>
              <span className={styles.metaSeparator} aria-hidden="true">·</span>
              <span>{t('plantFinder.plants', { count: entry.plant_count })}</span>
            </>
          )}
        </span>
      </button>
      <div className={styles.rowActions}>
        <button
          className={styles.rowIconButton}
          type="button"
          aria-label={t('designNotebook.removeDesignFromNotebook', { name: entry.name })}
          onClick={onRemove}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  )
}

function dropTargetForPointer(
  list: HTMLElement | null,
  session: NotebookPointerDragSession,
  clientY: number,
): NotebookDropTarget | null {
  const rows = [...(list?.querySelectorAll<HTMLElement>('[data-notebook-entry-row]') ?? [])]
  for (const row of rows) {
    const path = row.dataset.notebookEntryRow
    if (!path || path === session.sourceId) continue

    const rect = row.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2 || clientY <= rect.bottom) {
      return dropTargetForRowElement(row, clientY, session)
    }
  }

  const sections = [...(list?.querySelectorAll<HTMLElement>('[data-notebook-section-id]') ?? [])]
  let fallback: NotebookDropTarget | null = null
  for (const section of sections) {
    const target = dropTargetForSectionElement(section)

    fallback = target
    const rect = section.getBoundingClientRect()
    if (clientY <= rect.bottom) return target
  }
  return fallback
}

function dropTargetForRowElement(
  row: HTMLElement,
  clientY: number,
  session: NotebookPointerDragSession,
): NotebookDropTarget | null {
  const path = row.dataset.notebookEntryRow
  if (!path || path === session.sourceId) return null

  const entries = session.latestEntries.length > 0
    ? session.latestEntries
    : session.baseEntries
  const entry = entries.find((candidate) => candidate.path === path)
  const sectionId = entry?.section_id ?? sectionIdFromKey(row.dataset.notebookEntrySection)
  const rect = row.getBoundingClientRect()
  const insertAfter = clientY >= rect.top + rect.height / 2
  const targetSectionEntries = entriesForSection(entries, sectionId)
    .filter((sectionEntry) => sectionEntry.path !== session.sourceId)

  if (!insertAfter) {
    return {
      sectionId,
      beforePath: path,
      rowPath: path,
      position: 'before',
    }
  }

  const targetIndex = targetSectionEntries.findIndex((sectionEntry) => sectionEntry.path === path)
  return {
    sectionId,
    beforePath: targetSectionEntries[targetIndex + 1]?.path ?? null,
    rowPath: path,
    position: 'after',
  }
}

function dropTargetForSectionElement(section: HTMLElement): NotebookDropTarget {
  return {
    sectionId: sectionIdFromKey(section.dataset.notebookSectionId),
    beforePath: null,
    rowPath: null,
    position: 'inside',
  }
}

function sectionOrderForPointer(
  list: HTMLElement | null,
  session: NotebookPointerDragSession,
  clientY: number,
): readonly string[] {
  const sectionRows = [...(list?.querySelectorAll<HTMLElement>('[data-notebook-section-row]') ?? [])]
  const visibleIds = sectionRows
    .map((section) => section.dataset.notebookSectionRow)
    .filter((sectionId): sectionId is string => Boolean(sectionId))
  const orderedIds = visibleIds.length > 0 ? visibleIds : session.latestSectionIds
  const remainingIds = orderedIds.filter((sectionId) => sectionId !== session.sourceId)
  let insertIndex = remainingIds.length

  for (const section of sectionRows) {
    const sectionId = section.dataset.notebookSectionRow
    if (!sectionId || sectionId === session.sourceId) continue

    const rect = section.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      insertIndex = Math.max(0, remainingIds.indexOf(sectionId))
      break
    }
  }

  const nextSectionIds = [...remainingIds]
  nextSectionIds.splice(insertIndex, 0, session.sourceId)
  for (const sectionId of session.baseSectionIds) {
    if (!nextSectionIds.includes(sectionId)) nextSectionIds.push(sectionId)
  }
  return nextSectionIds
}

function entriesAfterDrop(
  entries: readonly DesignNotebookEntry[],
  sections: readonly DesignNotebookSection[],
  sourcePath: string,
  target: NotebookDropTarget,
): readonly DesignNotebookEntry[] | null {
  const source = entries.find((entry) => entry.path === sourcePath)
  if (!source) return null

  const sectionOrder: Array<string | null> = [null, ...sections.map((section) => section.id)]
  const entriesBySection = new Map<string, DesignNotebookEntry[]>()
  for (const sectionId of sectionOrder) {
    entriesBySection.set(notebookEntrySectionKey(sectionId), [])
  }

  for (const entry of entries) {
    if (entry.path === sourcePath) continue
    const key = notebookEntrySectionKey(entry.section_id)
    const sectionEntries = entriesBySection.get(key) ?? []
    sectionEntries.push(entry)
    entriesBySection.set(key, sectionEntries)
  }

  const movedEntry = { ...source, section_id: target.sectionId }
  const targetKey = notebookEntrySectionKey(target.sectionId)
  const targetEntries = entriesBySection.get(targetKey) ?? []
  const insertIndex = target.beforePath
    ? targetEntries.findIndex((entry) => entry.path === target.beforePath)
    : targetEntries.length
  targetEntries.splice(insertIndex < 0 ? targetEntries.length : insertIndex, 0, movedEntry)
  entriesBySection.set(targetKey, targetEntries)

  const orderedEntries: DesignNotebookEntry[] = []
  const orderedKeys = new Set<string>()
  for (const sectionId of sectionOrder) {
    const key = notebookEntrySectionKey(sectionId)
    orderedKeys.add(key)
    orderedEntries.push(...(entriesBySection.get(key) ?? []))
  }
  for (const [key, sectionEntries] of entriesBySection.entries()) {
    if (!orderedKeys.has(key)) orderedEntries.push(...sectionEntries)
  }
  return orderedEntries
}

function entriesInNotebookDisplayOrder(
  entries: readonly DesignNotebookEntry[],
  sections: readonly DesignNotebookSection[],
): readonly DesignNotebookEntry[] {
  const orderedEntries: DesignNotebookEntry[] = [
    ...entriesForSection(entries, null),
  ]
  for (const section of sections) {
    orderedEntries.push(...entriesForSection(entries, section.id))
  }
  return orderedEntries
}

function entriesForSection(
  entries: readonly DesignNotebookEntry[],
  sectionId: string | null,
): readonly DesignNotebookEntry[] {
  return entries.filter((entry) => entry.section_id === sectionId)
}

function orderItemsForPreview<T>(
  items: readonly T[],
  orderedIds: readonly string[] | null,
  idForItem: (item: T) => string,
): readonly T[] {
  if (!orderedIds) return items

  const itemsById = new Map(items.map((item) => [idForItem(item), item]))
  const orderedItems: T[] = []
  for (const id of orderedIds) {
    const item = itemsById.get(id)
    if (!item) continue
    orderedItems.push(item)
    itemsById.delete(id)
  }
  orderedItems.push(...itemsById.values())
  return orderedItems
}

function isSectionDropTarget(target: NotebookDropTarget | null, sectionId: string | null): boolean {
  return target?.position === 'inside' && target.sectionId === sectionId
}

function dropPositionForRow(
  target: NotebookDropTarget | null,
  rowPath: string,
): NotebookDropPosition | null {
  return target?.rowPath === rowPath ? target.position : null
}

function notebookEntrySectionKey(sectionId: string | null): string {
  return sectionId ?? 'unsectioned'
}

function sectionIdFromKey(sectionKey: string | undefined): string | null {
  return sectionKey && sectionKey !== 'unsectioned' ? sectionKey : null
}

function sameIdOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M2.3 3.7h8.4M5.2 5.4v3.8M7.8 5.4v3.8M4 3.7l.5-1h4l.5 1M3.4 3.7l.4 7h5.4l.4-7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function formatDate(iso: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso))
  } catch {
    return ''
  }
}
