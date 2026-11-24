import type { SavedView, StoryStep } from '../../generated/contracts'
import { editCurrentDesign, readCurrentDesign } from './core'
import { editWithinImageLimit, parkStepsAwaitingView, takeStepsAwaitingView, type StoryEditOutcome } from './stories'

// Saved views are Design Edit data (ADR 0011): every command dirties the Design
// for continuous save, none is in the scene history, and a command that changes
// nothing returns the Design untouched. Story commands live in stories.ts.

/** What deleting a view removed, so Undo can put it back where it was. */
export interface SavedViewDeletion {
  readonly view: SavedView
  readonly index: number
  /** Story steps that showed the view, in story order, with their positions. */
  readonly steps: readonly { readonly storyId: string; readonly step: StoryStep; readonly index: number }[]
}

/** Adds a view as one edit. */
export function addSavedView(view: SavedView): void {
  editCurrentDesign((design) => {
    const views = design.views ?? []
    if (views.some((existing) => existing.id === view.id)) return design
    return { ...design, views: [...views, view] }
  })
}

/**
 * A view as stored JSON, with `null` fields left out: Desktop's loader writes
 * an absent optional field (a view's `labels`) as `null`, which reads the same
 * as a missing key.
 */
function savedViewJson(view: SavedView): string {
  return JSON.stringify(view, (_key, value: unknown) => (value === null ? undefined : value))
}

/**
 * Points an existing view at what the map shows now: camera (with the ground
 * it frames), layers, highlights and labels. Its name, title and text stay.
 * Every step that shows the view shows the new capture. The view is built from
 * its named fields, so nothing it carried from elsewhere is written back.
 */
export function recaptureSavedView(id: string, capture: SavedView): void {
  editCurrentDesign((design) => {
    const views = design.views ?? []
    const index = views.findIndex((view) => view.id === id)
    if (index === -1) return design
    const current = views[index]!
    const next: SavedView = {
      id: current.id,
      name: current.name,
      camera: capture.camera,
      visible_layers: capture.visible_layers,
      highlighted: capture.highlighted,
      title: current.title,
      ...(current.text === undefined ? {} : { text: current.text }),
      ...((capture.labels ?? current.labels) == null ? {} : { labels: capture.labels ?? current.labels }),
    }
    if (savedViewJson(next) === savedViewJson(current)) return design
    const nextViews = [...views]
    nextViews[index] = next
    return { ...design, views: nextViews }
  })
}

export function renameSavedView(id: string, name: string): void {
  const nextName = name.trim()
  if (nextName.length === 0) return
  editCurrentDesign((design) => {
    const views = design.views ?? []
    const index = views.findIndex((view) => view.id === id)
    if (index === -1 || views[index]!.name === nextName) return design
    const next = [...views]
    next[index] = { ...views[index]!, name: nextName }
    return { ...design, views: next }
  })
}

/**
 * Deletes a view and every story step that shows it, so no step dangles.
 * Callers confirm first when stories use the view. Returns what was removed.
 */
export function deleteSavedView(id: string): SavedViewDeletion | null {
  let deletion: SavedViewDeletion | null = null
  editCurrentDesign((design) => {
    const views = design.views ?? []
    const index = views.findIndex((view) => view.id === id)
    if (index === -1) return design
    const removedSteps: SavedViewDeletion['steps'][number][] = []
    const stories = design.stories ?? []
    const nextStories = stories.map((story) => {
      const steps = story.steps.filter((step, stepIndex) => {
        if (step.view_id !== id) return true
        removedSteps.push({ storyId: story.id, step, index: stepIndex })
        return false
      })
      return steps.length === story.steps.length ? story : { ...story, steps }
    })
    deletion = { view: views[index]!, index, steps: removedSteps }
    return {
      ...design,
      views: views.filter((view) => view.id !== id),
      stories: removedSteps.length === 0 ? stories : nextStories,
    }
  })
  return deletion
}

/**
 * Undo for `deleteSavedView`: puts the view and its steps back at their
 * positions, with any step a story or step Undo had parked while the view was
 * gone. Steps whose story is gone stay deleted; a view that exists again is
 * left alone.
 */
export function restoreSavedView(deletion: SavedViewDeletion): StoryEditOutcome {
  const current = readCurrentDesign()
  if (!current || (current.views ?? []).some((view) => view.id === deletion.view.id)) return 'unchanged'
  const parked = takeStepsAwaitingView(deletion.view.id)
  const restoredSteps = [...deletion.steps, ...parked]
  const outcome = editWithinImageLimit((design) => {
    const views = design.views ?? []
    if (views.some((view) => view.id === deletion.view.id)) return design
    const nextViews = [...views]
    nextViews.splice(Math.min(deletion.index, views.length), 0, deletion.view)
    const stories = design.stories ?? []
    const nextStories = stories.map((story) => {
      const removed = restoredSteps.filter((entry) => entry.storyId === story.id)
      if (removed.length === 0) return story
      const steps = [...story.steps]
      for (const entry of removed) {
        if (steps.some((step) => step.id === entry.step.id)) continue
        steps.splice(Math.min(entry.index, steps.length), 0, entry.step)
      }
      return { ...story, steps }
    })
    return { ...design, views: nextViews, stories: nextStories }
  })
  if (outcome !== 'applied') parkStepsAwaitingView(parked)
  return outcome
}
