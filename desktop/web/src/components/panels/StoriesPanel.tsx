import { useEffect, useId, useRef, useState } from 'preact/hooks'
import {
  addCurrentViewAsStep,
  canAddStorySteps,
  createStory,
  currentStories,
  dismissStoryUndo,
  duplicateStep,
  moveStepBy,
  moveStepToStory,
  renameStory,
  reorderSteps,
  requestDeleteStep,
  registerStoryUndoToast,
  requestDeleteStory,
  richTextFirstLine,
  selectedStep,
  selectedStory,
  selectStep,
  selectStory,
  storyUndo,
  undoStoryDelete,
  type StoryUndo,
} from '../../app/stories'
import { currentDesign } from '../../app/document-session/store'
import { presentStory } from '../../app/story-presentation'
import { t } from '../../i18n'
import type { SavedView, Story, StoryStep } from '../../types/design'
import { ActionMenu, type ActionMenuEntry } from '../shared/ActionMenu'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { DockPanelHeader } from '../shared/DockPanelHeader'
import { Dropdown } from '../shared/Dropdown'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import { SavedViewThumbnail } from '../shared/SavedViewThumbnail'
import { SlotToast } from '../shared/ToastSlot'
import { usePointerReorder } from '../shared/usePointerReorder'
import { StepEditor } from '../stories/StepEditor'
import styles from './StoriesPanel.module.css'

const EMPTY_VIEWS: readonly SavedView[] = []

/**
 * Stories (no Ctrl digit, U49 Q1): build a story from views of the map beside the live map.
 * A story selector, the steps with their thumbnails, Add the current view as
 * a step, and the selected step's editor. Both editions mount it.
 */
export function StoriesPanel() {
  const stories = currentStories.value
  const story = selectedStory.value
  return (
    <div className={styles.panel} data-stories-panel>
      <div className={styles.head}>
        <DockPanelHeader title={t('stories.title')} />
        {story && <StorySelector stories={stories} story={story} />}
      </div>
      <div className={styles.body}>
        {story ? <StorySteps story={story} /> : (
          <EmptyState icon={<PanelIcon panel="stories" />} action={{ label: t('stories.newStory'), onClick: () => { createStory() } }}>
            {t('stories.empty')}
          </EmptyState>
        )}
      </div>
      <StoryUndoToast />
      {story && (
        <footer className={styles.footer}>
          <span className={styles.count}>{t('stories.stepCount', { count: story.steps.length })}</span>
          <PresentButton story={story} />
        </footer>
      )}
    </div>
  )
}

function StorySelector({ stories, story }: { readonly stories: readonly Story[]; readonly story: Story }) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(story.name)
  const field = useRef<HTMLInputElement>(null)
  const menuSlot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (renaming) field.current?.select()
  }, [renaming])

  function finish(commit: boolean): void {
    if (commit) renameStory(story.id, draft)
    setRenaming(false)
    requestAnimationFrame(() => menuSlot.current?.querySelector<HTMLButtonElement>('button')?.focus())
  }

  if (renaming) {
    return (
      <form className={styles.selector} onSubmit={(event) => { event.preventDefault(); finish(true) }}>
        <input
          ref={field}
          className={styles.renameField}
          aria-label={t('stories.renameField')}
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            finish(false)
          }}
        />
        <button type="submit" className={styles.smallButton}>{t('stories.renameSave')}</button>
        <button type="button" className={`${styles.smallButton} ${styles.ghost}`} onClick={() => finish(false)}>{t('stories.cancel')}</button>
      </form>
    )
  }

  return (
    <div className={styles.selector}>
      <Dropdown
        ariaLabel={t('stories.storyLabel')}
        className={styles.storyDropdown}
        trigger={<span className={styles.storyName}>{story.name}</span>}
        items={stories.map((entry) => ({ value: entry.id, label: entry.name }))}
        value={story.id}
        onChange={selectStory}
        floating
      />
      <div ref={menuSlot} className={styles.menuSlot}>
        <ActionMenu
          label={t('stories.storyActions')}
          items={[
            { id: 'rename-story', label: t('stories.renameStory'), run: () => { setDraft(story.name); setRenaming(true) } },
            { separator: true },
            { id: 'delete-story', label: t('stories.deleteStory'), danger: true, run: () => requestDeleteStory(story.id) },
          ]}
        />
      </div>
      <button type="button" className={`${styles.smallButton} ${styles.ghost}`} onClick={() => { createStory() }}>
        <ControlIcon name="plus" size={16} />
        {t('stories.newStory')}
      </button>
    </div>
  )
}

interface ReorderSession {
  readonly sourceId: string
  latestIds: readonly string[]
}

function StorySteps({ story }: { readonly story: Story }) {
  const views = currentDesign.value?.views ?? EMPTY_VIEWS
  const step = selectedStep.value
  const canAdd = canAddStorySteps()
  const list = useRef<HTMLOListElement>(null)
  const [preview, setPreview] = useState<readonly string[] | null>(null)
  const ordered = preview
    ? preview.map((id) => story.steps.find((entry) => entry.id === id)).filter((entry): entry is StoryStep => !!entry)
    : story.steps

  const beginReorder = usePointerReorder<ReorderSession>({
    move(session, event) {
      event.preventDefault()
      session.latestIds = orderForPointer(session.sourceId, event.clientY)
      setPreview((current) => sameOrder(current, session.latestIds) ? current : session.latestIds)
    },
    finish(session, event) {
      event.preventDefault()
      setPreview(null)
      if (!sameOrder(story.steps.map((entry) => entry.id), session.latestIds)) reorderSteps(story.id, session.latestIds)
    },
    cancel: () => setPreview(null),
  })

  function orderForPointer(sourceId: string, clientY: number): readonly string[] {
    const rows = [...list.current?.querySelectorAll<HTMLElement>('[data-story-step]') ?? []]
    const others = rows.filter((row) => row.dataset.storyStep !== sourceId)
    let insert = others.length
    for (let index = 0; index < others.length; index += 1) {
      const rect = others[index]!.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        insert = index
        break
      }
    }
    const ids = others.map((row) => row.dataset.storyStep!)
    return [...ids.slice(0, insert), sourceId, ...ids.slice(insert)]
  }

  const selectedIndex = step ? story.steps.findIndex((entry) => entry.id === step.id) : -1
  const needsMapId = useId()

  return (
    <>
      {story.steps.length === 0 && <p className={styles.note}>{t('stories.noSteps')}</p>}
      {story.steps.length > 0 && (
        <ol ref={list} className={styles.steps} aria-label={t('stories.stepsLabel', { story: story.name })}>
          {ordered.map((entry) => {
            const index = story.steps.indexOf(entry)
            return (
              <StepRow
                key={entry.id}
                story={story}
                step={entry}
                number={index + 1}
                view={views.find((view) => view.id === entry.view_id) ?? null}
                selected={entry.id === step?.id}
                dragging={preview !== null}
                onReorderBegin={(event) => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  const ids = story.steps.map((other) => other.id)
                  beginReorder(event, { sourceId: entry.id, latestIds: ids })
                  setPreview(ids)
                }}
              />
            )
          })}
        </ol>
      )}
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.smallButton}
          disabled={!canAdd}
          aria-describedby={canAdd ? undefined : needsMapId}
          onClick={() => { addCurrentViewAsStep(story.id) }}
        >
          <ControlIcon name="plus" size={16} />
          {t('stories.addStep')}
        </button>
        {!canAdd && <span className={styles.note} id={needsMapId}>{t('stories.needsMap')}</span>}
      </div>
      {step && selectedIndex !== -1 && (
        <StepEditor
          key={step.id}
          storyId={story.id}
          step={step}
          number={selectedIndex + 1}
          view={views.find((view) => view.id === step.view_id) ?? null}
        />
      )}
    </>
  )
}

function StepRow({ story, step, number, view, selected, dragging, onReorderBegin }: {
  readonly story: Story
  readonly step: StoryStep
  readonly number: number
  readonly view: SavedView | null
  readonly selected: boolean
  readonly dragging: boolean
  onReorderBegin(event: PointerEvent): void
}) {
  const stories = currentStories.value
  const others = stories.filter((entry) => entry.id !== story.id)
  const title = step.title.trim() || t('stories.untitledStep')
  const firstLine = richTextFirstLine(step.text ?? [])
  const grip = useRef<HTMLButtonElement>(null)
  const items: ActionMenuEntry[] = [
    { id: 'duplicate', label: t('stories.duplicate'), run: () => duplicateStep(story.id, step.id) },
    { id: 'move-up', label: t('stories.moveUp'), disabled: number === 1, run: () => moveStepBy(story.id, step.id, -1) },
    { id: 'move-down', label: t('stories.moveDown'), disabled: number === story.steps.length, run: () => moveStepBy(story.id, step.id, 1) },
    {
      id: 'move-to',
      label: t('stories.moveTo'),
      disabled: others.length === 0,
      submenu: others.map((other) => ({ id: `move-to:${other.id}`, label: other.name, run: () => moveStepToStory(story.id, step.id, other.id) })),
    },
    { separator: true },
    { id: 'delete', label: t('stories.delete'), danger: true, run: () => requestDeleteStep(story.id, step.id) },
  ]
  return (
    <li className={`${styles.row}${selected ? ` ${styles.selected}` : ''}`} data-story-step={step.id} data-dragging={dragging ? 'true' : undefined}>
      <button
        ref={grip}
        type="button"
        className={styles.grip}
        aria-label={t('stories.reorderStep', { number })}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onPointerDown={onReorderBegin}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          event.preventDefault()
          moveStepBy(story.id, step.id, event.key === 'ArrowUp' ? -1 : 1)
          // The row moved: keep focus on its handle.
          requestAnimationFrame(() => grip.current?.focus())
        }}
      >
        <ControlIcon name="grip" size={16} />
        <ButtonTooltip label={t('stories.reorderStep', { number })} description={t('stories.reorderHint')} side="right" />
      </button>
      <button
        type="button"
        className={styles.rowMain}
        aria-current={selected ? 'step' : undefined}
        onClick={() => selectStep(selected ? null : step.id)}
      >
        <span className={styles.number} aria-hidden="true">{number}</span>
        {view ? <SavedViewThumbnail view={view} /> : <span className={styles.missingThumb} aria-hidden="true" />}
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>
            <span className={styles.srOnly}>{t('stories.stepNumber', { number })}: </span>
            {title}
          </span>
          {firstLine && <span className={styles.rowLine}>{firstLine}</span>}
        </span>
      </button>
      <ActionMenu label={t('stories.stepActions', { number })} items={items} />
    </li>
  )
}

function StoryUndoToast() {
  const undo = storyUndo.value
  if (!undo) return null
  return <StoryUndoToastContent undo={undo} />
}

function StoryUndoToastContent({ undo }: { readonly undo: StoryUndo }) {
  // Ctrl Z reaches the toast only while it is on screen.
  useEffect(() => registerStoryUndoToast(), [])
  // In the window's one toast position (2.1-Q292).
  return (
    <SlotToast
      message={undo.message}
      icon={undo.undo ? 'check' : 'alert'}
      actionLabel={undo.undo ? t('stories.undo') : undefined}
      onAction={undo.undo ? undoStoryDelete : undefined}
      onDismiss={() => dismissStoryUndo(undo)}
    />
  )
}

function sameOrder(a: readonly string[] | null, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((id, index) => id === b[index])
}

function PresentButton({ story }: { readonly story: Story }) {
  const hintId = useId()
  const canPresent = story.steps.length > 0 && canAddStorySteps()
  return (
    <>
      <button
        type="button"
        className={`${styles.smallButton} ${styles.primary}`}
        disabled={!canPresent}
        aria-describedby={story.steps.length === 0 ? hintId : undefined}
        data-story-present={story.id}
        onClick={() => { presentStory(story.id, selectedStepIndex(story), { returnFocus: 'present-button' }) }}
      >
        <ControlIcon name="play" size={16} />
        {t('stories.present')}
      </button>
      {story.steps.length === 0 && <span className={styles.srOnly} id={hintId}>{t('stories.presentHint')}</span>}
    </>
  )
}

/** Presenting starts at the step being edited, else at the first. */
function selectedStepIndex(story: Story): number {
  const step = selectedStep.peek()
  const index = step ? story.steps.findIndex((entry) => entry.id === step.id) : -1
  return Math.max(0, index)
}
