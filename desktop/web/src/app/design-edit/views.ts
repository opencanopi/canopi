import type { SavedView } from '../../types/design'
import { normaliseObjectName } from '../contracts/object-name'
import { editCurrentDesign } from './core'

// Saved views are Design Edit data (ADR 0011): every command dirties the Design
// for continuous save, none is in the scene history, and a command that changes
// nothing returns the Design untouched. Story commands live in stories.ts.

/** Adds a view as one edit. */
export function addSavedView(view: SavedView): void {
  editCurrentDesign((design) => {
    const views = design.views ?? []
    if (views.some((existing) => existing.id === view.id)) return design
    return { ...design, views: [...views, view] }
  }, 'views.add')
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
  }, 'views.recapture')
}

export function renameSavedView(id: string, name: string): void {
  const normalised = normaliseObjectName(name)
  if (!normalised.ok) return
  const nextName = normalised.name
  editCurrentDesign((design) => {
    const views = design.views ?? []
    const index = views.findIndex((view) => view.id === id)
    if (index === -1 || views[index]!.name === nextName) return design
    const next = [...views]
    next[index] = { ...views[index]!, name: nextName }
    return { ...design, views: next }
  }, 'views.rename')
}

/**
 * Deletes a view and every story step that shows it, so no step dangles.
 * Callers confirm first when stories use the view. Returns the deleted view's
 * name, or null when no such view exists.
 */
export function deleteSavedView(id: string): { readonly name: string } | null {
  let deleted: { readonly name: string } | null = null
  editCurrentDesign((design) => {
    const views = design.views ?? []
    const target = views.find((view) => view.id === id)
    if (!target) return design
    const stories = design.stories ?? []
    let removedAnyStep = false
    const nextStories = stories.map((story) => {
      const steps = story.steps.filter((step) => step.view_id !== id)
      if (steps.length === story.steps.length) return story
      removedAnyStep = true
      return { ...story, steps }
    })
    deleted = { name: target.name }
    return {
      ...design,
      views: views.filter((view) => view.id !== id),
      stories: removedAnyStep ? nextStories : stories,
    }
  }, 'views.delete')
  return deleted
}
