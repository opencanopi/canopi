import { computed, signal, type ReadonlySignal } from '@preact/signals'
import { t } from '../../i18n'
import { renameSavedView } from '../design-edit'
import { getLiveSessionCore } from '../document-session/live-core'
import { currentDesign, designSessionStore } from '../document-session/store'
import { defaultSavedViewName, saveCurrentView } from './actions'
import { canShowSavedViews, currentSavedViews } from './current-view'
import { storiesShowingView } from './model'

// View › Save current view… and View › Manage views…, shared by both editions.
// Every request remembers the Design session that opened it and vanishes when
// that session is replaced, so nothing here can act on another Design.

type Fenced<T> = { readonly session: object; readonly value: T }

function fenced<T>(state: { readonly value: Fenced<T> | null }): ReadonlySignal<T | null> {
  return computed(() => {
    const entry = state.value
    return entry && entry.session === designSessionStore.sessionIdentity.value ? entry.value : null
  })
}

function currentSession(): object {
  return designSessionStore.sessionIdentity.peek()
}

export interface SaveViewDialogRequest {
  readonly defaultName: string
}

const saveViewState = signal<Fenced<SaveViewDialogRequest> | null>(null)
export const saveViewDialog = fenced(saveViewState)

export function openSaveViewDialog(): void {
  if (!canShowSavedViews()) return
  saveViewState.value = { session: currentSession(), value: { defaultName: defaultSavedViewName() } }
}

export function closeSaveViewDialog(): void {
  saveViewState.value = null
}

/** Saves the current view; the dialog stays open when nothing was saved. */
export function confirmSaveViewDialog(input: { readonly name: string; readonly title: string }): boolean {
  if (saveViewDialog.peek() === null) return false
  const saved = saveCurrentView(input) !== null
  if (saved) closeSaveViewDialog()
  return saved
}

const manageViewsState = signal<Fenced<true> | null>(null)
const manageViewsRequest = fenced(manageViewsState)
export const manageViewsDialogOpen = computed(() => manageViewsRequest.value === true)

export function openManageViewsDialog(): void {
  if (currentDesign.peek() === null) return
  manageViewsState.value = { session: currentSession(), value: true }
}

export function closeManageViewsDialog(): void {
  manageViewsState.value = null
  deleteConfirmationState.value = null
}

/** A delete that waits for the user because stories show the view. */
export interface SavedViewDeleteConfirmation {
  readonly viewId: string
  readonly viewName: string
  /** Names of the stories whose steps show the view; those steps go with it. */
  readonly stories: readonly string[]
}

const deleteConfirmationState = signal<Fenced<SavedViewDeleteConfirmation> | null>(null)
export const savedViewDeleteConfirmation = fenced(deleteConfirmationState)

export interface SavedViewUndo {
  readonly message: string
  /** Null for a notice that offers no Undo, such as images that do not fit. */
  readonly undo: (() => void) | null
}

const undoState = signal<Fenced<SavedViewUndo> | null>(null)
/** The Undo toast after a delete; it belongs to the session that deleted. */
export const savedViewUndo = fenced(undoState)

/** Renames a view; a blank name keeps the old one. */
export function renameView(id: string, name: string): void {
  renameSavedView(id, name)
}

/** Deletes a view, first asking when stories show it. */
export function requestDeleteView(id: string): void {
  const view = currentSavedViews().find((entry) => entry.id === id)
  if (!view) return
  const stories = storiesShowingView(currentDesign.peek(), id)
  if (stories.length > 0) {
    deleteConfirmationState.value = {
      session: currentSession(),
      value: { viewId: id, viewName: view.name, stories },
    }
    return
  }
  deleteView(id)
}

export function confirmDeleteView(): void {
  const confirmation = savedViewDeleteConfirmation.peek()
  deleteConfirmationState.value = null
  if (confirmation) deleteView(confirmation.viewId)
}

export function cancelDeleteView(): void {
  deleteConfirmationState.value = null
}

export function undoDeleteView(): void {
  const undo = savedViewUndo.peek()
  undoState.value = null
  undo?.undo?.()
}

/** Dismisses the toast; given the toast being dismissed, only while it still shows. */
export function dismissDeleteViewUndo(toast?: SavedViewUndo): void {
  if (toast && savedViewUndo.peek() !== toast) return
  undoState.value = null
}

function deleteView(id: string): void {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open) return
  const target = (open.document.views ?? []).find((view) => view.id === id)
  if (!target) return
  const viewName = target.name
  const entryId = core.document(
    t('savedViews.deleted', { name: viewName }),
    (doc) => {
      const views = doc.views ?? []
      if (!views.some((view) => view.id === id)) return null
      const stories = doc.stories ?? []
      let removedAnyStep = false
      const nextStories = stories.map((story) => {
        const steps = story.steps.filter((step) => step.view_id !== id)
        if (steps.length === story.steps.length) return story
        removedAnyStep = true
        return { ...story, steps }
      })
      return removedAnyStep
        ? { views: views.filter((view) => view.id !== id), stories: nextStories }
        : { views: views.filter((view) => view.id !== id) }
    },
    { isDelete: true },
  )
  if (!entryId) return
  undoState.value = {
    session: currentSession(),
    value: {
      message: t('savedViews.deleted', { name: viewName }),
      undo: () => {
        if (core.newestUndoable.peek()?.id !== entryId) return
        core.undo({ expect: entryId })
      },
    },
  }
}

/** A saved-view dialog is open: app and canvas shortcuts stand down. */
export const savedViewDialogOpen = computed(() =>
  saveViewDialog.value !== null || manageViewsDialogOpen.value,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    closeSaveViewDialog()
    closeManageViewsDialog()
    dismissDeleteViewUndo()
  })
}
