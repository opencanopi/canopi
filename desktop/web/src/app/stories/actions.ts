import { computed, signal, type ReadonlySignal } from '@preact/signals'
import { STORY_IMAGES_MAX_TOTAL_BYTES } from '../../generated/canopi-design-format'
import { currentLocale, t } from '../../i18n'
import { formatImageBytes } from './images'
import type { RichTextBlock, Story, StoryImage, StoryStep } from '../../types/design'
import { createUuid } from '../../utils/ids'
import {
  addSavedView,
  addStory,
  addStoryStep,
  duplicateStoryStep,
  moveStoryStep,
  moveStoryStepToStory,
  recaptureSavedView,
  renameStory,
  reorderStorySteps,
  updateStoryStep,
  type StoryEditOutcome,
} from '../design-edit'
import { getLiveSessionCore } from '../document-session/live-core'
import { currentDesign, designSessionStore } from '../document-session/store'
import { canShowSavedViews, captureCurrentView, goToSavedView } from '../saved-views/current-view'
import type { KeyChord } from '../keyboard/key-chord'
import { pushKeyScope } from '../keyboard/keymap'

// The Stories panel's action layer. Stories and their steps are Design Edit
// data (app/design-edit/stories.ts); each step shows a saved view, so adding
// the current view as a step saves a view first. Which story and step are
// selected, and the Undo toast after a delete, belong to the Design session
// that set them and vanish when another Design replaces it.

const EMPTY_STORIES: readonly Story[] = []

type Fenced<T> = { readonly session: object; readonly value: T }

function currentSession(): object {
  return designSessionStore.sessionIdentity.peek()
}

function fenced<T>(state: { readonly value: Fenced<T> | null }): ReadonlySignal<T | null> {
  return computed(() => {
    const entry = state.value
    return entry && entry.session === designSessionStore.sessionIdentity.value ? entry.value : null
  })
}

/** The stories of the open Design, in order. */
export const currentStories = computed<readonly Story[]>(() => currentDesign.value?.stories ?? EMPTY_STORIES)

interface StorySelection {
  readonly storyId: string | null
  readonly stepId: string | null
}

const selectionState = signal<Fenced<StorySelection> | null>(null)
const selection = fenced(selectionState)

/** The story the panel shows: the one chosen, else the first. */
export const selectedStory = computed<Story | null>(() => {
  const stories = currentStories.value
  const chosen = selection.value?.storyId
  return stories.find((story) => story.id === chosen) ?? stories[0] ?? null
})

/** The step being edited, when it is still in the selected story. */
export const selectedStep = computed<StoryStep | null>(() => {
  const story = selectedStory.value
  const chosen = selection.value?.stepId
  return story?.steps.find((step) => step.id === chosen) ?? null
})

export function selectStory(storyId: string): void {
  selectionState.value = { session: currentSession(), value: { storyId, stepId: null } }
}

/** Selects a step for editing; null closes the editor. */
export function selectStep(stepId: string | null): void {
  const storyId = selectedStory.peek()?.id ?? null
  selectionState.value = { session: currentSession(), value: { storyId, stepId } }
}

export interface StoryUndo {
  readonly message: string
  /** Null for a notice that offers no Undo, such as images that do not fit. */
  readonly undo: (() => void) | null
}

const undoState = signal<Fenced<StoryUndo> | null>(null)
/** The Undo toast after deleting a story or a step, or a notice in its place. */
export const storyUndo = fenced(undoState)

export function undoStoryDelete(): void {
  const undo = storyUndo.peek()
  undoState.value = null
  undo?.undo?.()
}

/** Dismisses the toast; given the toast being dismissed, only while it still shows. */
export function dismissStoryUndo(toast?: StoryUndo): void {
  if (toast && storyUndo.peek() !== toast) return
  undoState.value = null
}

/**
 * The Undo toast is on screen while registered: it pushes a key scope (app/keyboard), so Ctrl Z (Cmd Z) undoes the
 * delete it offers before the map's own history. The key router runs scopes outside text fields and dialogs, so a text
 * field keeps its own undo.
 */
export function registerStoryUndoToast(): () => void {
  return pushKeyScope(runStoryUndoShortcut)
}

/** True when Ctrl Z undid the delete the toast offers. */
function runStoryUndoShortcut(chord: KeyChord): boolean {
  if (chord.key !== 'z' || !chord.mod || chord.ctrl || chord.shift || chord.alt) return false
  if (!storyUndo.peek()?.undo) return false
  undoStoryDelete()
  return true
}

function offerUndo(message: string, undo: () => void): void {
  undoState.value = { session: currentSession(), value: { message, undo } }
}

/** Says why an edit changed nothing when its images would not fit in the Design. */
function reportOutcome(outcome: StoryEditOutcome): void {
  if (outcome !== 'images-do-not-fit') return
  undoState.value = {
    session: currentSession(),
    value: {
      message: t('stories.imagesDoNotFit', {
        limit: formatImageBytes(STORY_IMAGES_MAX_TOTAL_BYTES, currentLocale()),
      }),
      undo: null,
    },
  }
}

function findStory(storyId: string): Story | null {
  return currentStories.peek().find((story) => story.id === storyId) ?? null
}

function findStep(storyId: string, stepId: string): StoryStep | null {
  return findStory(storyId)?.steps.find((step) => step.id === stepId) ?? null
}

/** Adds an empty story named "Story n" and selects it. */
export function createStory(): Story | null {
  if (!currentDesign.peek()) return null
  const story: Story = {
    id: createUuid(),
    name: t('stories.defaultName', { number: currentStories.peek().length + 1 }),
    steps: [],
  }
  addStory(story)
  selectStory(story.id)
  return story
}

export { renameStory }

export function requestDeleteStory(storyId: string): void {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open) return
  const target = (open.document.stories ?? []).find((story) => story.id === storyId)
  if (!target) return
  const storyName = target.name
  const entryId = core.document(
    t('stories.deleted', { name: storyName }),
    (doc) => {
      const stories = doc.stories ?? []
      if (!stories.some((story) => story.id === storyId)) return null
      return { stories: stories.filter((story) => story.id !== storyId) }
    },
    { isDelete: true },
  )
  if (!entryId) return
  offerUndo(t('stories.deleted', { name: storyName }), () => {
    if (core.newestUndoable.peek()?.id !== entryId) return
    const outcome = core.undo({ expect: entryId })
    if (outcome.status === 'applied') selectStory(storyId)
  })
}

/** Stories can take new steps: a Design is open on a map with a settled frame. */
export function canAddStorySteps(): boolean {
  return canShowSavedViews()
}

/**
 * Saves what the map shows now as a view and adds a step showing it at the end
 * of the story, then selects the step. The view is named after the story and
 * the step's number.
 */
export function addCurrentViewAsStep(storyId: string): StoryStep | null {
  const story = findStory(storyId)
  if (!story) return null
  const number = story.steps.length + 1
  const capture = captureCurrentView({
    id: createUuid(),
    name: t('stories.stepViewName', { story: story.name, number }),
  })
  if (!capture) return null
  addSavedView(capture)
  const step: StoryStep = {
    id: createUuid(),
    view_id: capture.id,
    title: t('stories.defaultStepTitle', { number }),
    text: [],
    images: [],
  }
  addStoryStep(storyId, step)
  selectionState.value = { session: currentSession(), value: { storyId, stepId: step.id } }
  return step
}

/**
 * Points the step's view at what the map shows now. Views are shared, so every
 * step that shows the view shows the new capture.
 */
export function useCurrentViewForStep(storyId: string, stepId: string): boolean {
  const step = findStep(storyId, stepId)
  if (!step) return false
  const capture = captureCurrentView({ id: step.view_id, name: 'view' })
  if (!capture) return false
  recaptureSavedView(step.view_id, capture)
  return true
}

/** Moves the camera to the step's view (session state only). */
export function goToStepView(storyId: string, stepId: string): boolean {
  const step = findStep(storyId, stepId)
  return step ? goToSavedView(step.view_id) : false
}

/** How many steps of every story show this view. */
export function stepsShowingView(viewId: string): number {
  return currentStories.peek().reduce((count, story) => count + story.steps.filter((step) => step.view_id === viewId).length, 0)
}

export function setStepTitle(storyId: string, stepId: string, title: string): void {
  updateStoryStep(storyId, stepId, { title })
}

export function setStepText(storyId: string, stepId: string, text: RichTextBlock[]): void {
  updateStoryStep(storyId, stepId, { text })
}

export function setStepImages(storyId: string, stepId: string, images: StoryImage[]): void {
  reportOutcome(updateStoryStep(storyId, stepId, { images }))
}

/** Moves a step up (-1) or down (+1) in its story. */
export function moveStepBy(storyId: string, stepId: string, delta: -1 | 1): void {
  const story = findStory(storyId)
  const index = story?.steps.findIndex((step) => step.id === stepId) ?? -1
  if (!story || index === -1) return
  const target = index + delta
  if (target < 0 || target >= story.steps.length) return
  moveStoryStep(storyId, stepId, target)
}

export function reorderSteps(storyId: string, stepIds: readonly string[]): void {
  reorderStorySteps(storyId, stepIds)
}

/** Copies a step right after itself and selects the copy. */
export function duplicateStep(storyId: string, stepId: string): void {
  const id = createUuid()
  reportOutcome(duplicateStoryStep(storyId, stepId, id))
  if (findStep(storyId, id)) selectionState.value = { session: currentSession(), value: { storyId, stepId: id } }
}

/** Moves a step to the end of another story. */
export function moveStepToStory(storyId: string, stepId: string, toStoryId: string): void {
  moveStoryStepToStory(storyId, stepId, toStoryId, createUuid())
}

export function requestDeleteStep(storyId: string, stepId: string): void {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open) return
  const story = (open.document.stories ?? []).find((entry) => entry.id === storyId)
  const step = story?.steps.find((entry) => entry.id === stepId)
  if (!story || !step) return
  const stepName = step.title || t('stories.untitledStep')
  const entryId = core.document(
    t('stories.stepDeleted', { name: stepName }),
    (doc) => {
      const stories = doc.stories ?? []
      const storyIndex = stories.findIndex((entry) => entry.id === storyId)
      const currentStory = stories[storyIndex]
      if (!currentStory || !currentStory.steps.some((entry) => entry.id === stepId)) return null
      const nextStories = [...stories]
      nextStories[storyIndex] = {
        ...currentStory,
        steps: currentStory.steps.filter((entry) => entry.id !== stepId),
      }
      return { stories: nextStories }
    },
    { isDelete: true },
  )
  if (!entryId) return
  if (selection.peek()?.stepId === stepId) selectStep(null)
  offerUndo(t('stories.stepDeleted', { name: stepName }), () => {
    if (core.newestUndoable.peek()?.id !== entryId) return
    core.undo({ expect: entryId })
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    selectionState.value = null
    undoState.value = null
  })
}
