import { computed, effect, signal, untracked, type ReadonlySignal } from '@preact/signals'
import { currentCanvasQuerySurface, getCurrentCanvasCommandSurface } from '../../canvas/session'
import type { PlantLabelMode } from '../../canvas/runtime/plant-display'
import type { ViewCamera } from '../../geo/view/types'
import type { PanelTarget, SavedView, Story, StoryStep } from '../../generated/contracts'
import { currentDesign, designSessionStore } from '../document-session/store'
import { mapLayers, type MapLayersState } from '../map-layers/state'
import { goToSavedView } from '../saved-views/current-view'
import { savedViewPresentedLabels } from '../saved-views/snapshot'
import { mapLayersOfView } from '../map-layers/background-presentation'
import { focusOwner } from '../keyboard/focus-owner'
import {
  setStoryPresentationHidesEditingAids,
  setStoryPresentationOverrides,
  type StoryPresentationOverrides,
} from './overrides'

// Presenting a story full-window inside Canopi. This controller is the one
// owner of the presentation: its state, the session overrides (overrides.ts:
// the editing aids it hides and what a step shows; the runtime's presented
// layers and the Species Focus), the camera it moves (and refits when the map
// settles at another size), the full-screen request,
// the listeners it adds and where focus goes afterwards. Every one of them is
// undone by `leaveStoryPresentation()`, which also runs when another Design
// replaces this one, when the story goes away and on HMR. Applying a step
// never edits or dirties the Design.

interface ActivePresentation {
  readonly session: object
  readonly storyId: string
  readonly index: number
}

/** What was on screen before presenting, put back on leaving. */
interface Restore {
  /** The live camera, its bearing included (spec §4.10). */
  readonly camera: ViewCamera
  readonly speciesFocus: string | null
}

/**
 * Where focus goes after leaving: the Stories panel's Present button that
 * started the presentation, else the map.
 */
type PresentationReturnFocus = 'present-button' | 'map'

const active = signal<ActivePresentation | null>(null)
let restore: Restore | null = null
let returnFocus: { readonly target: PresentationReturnFocus; readonly storyId: string } | null = null
let returnFocusTimer: ReturnType<typeof setTimeout> | null = null
let disposeWatch: (() => void) | null = null
let enteredFullScreen = false

export interface PresentedStep {
  readonly story: Story
  readonly step: StoryStep
  readonly view: SavedView | null
  /** Zero-based. */
  readonly index: number
  readonly count: number
}

/** The step on screen, or null when no story is presented. */
export const presentedStep: ReadonlySignal<PresentedStep | null> = computed(() => {
  const current = active.value
  if (!current || current.session !== designSessionStore.sessionIdentity.value) return null
  const design = currentDesign.value
  const story = design?.stories?.find((entry) => entry.id === current.storyId)
  const step = story?.steps[current.index]
  if (!story || !step) return null
  return {
    story,
    step,
    view: design?.views?.find((entry) => entry.id === step.view_id) ?? null,
    index: current.index,
    count: story.steps.length,
  }
})

/** A story is presented: editing chrome hides and editing commands stand down. */
export const storyPresentationActive: ReadonlySignal<boolean> = computed(() => active.value !== null)

interface StoryPresentationOptions {
  /** Where focus goes after leaving; the map by default. */
  readonly returnFocus?: PresentationReturnFocus
}

/** Presents a story from `index` (the first step by default); false when it has no step or no map. */
export function presentStory(storyId: string, index = 0, options: StoryPresentationOptions = {}): boolean {
  const story = currentDesign.peek()?.stories?.find((entry) => entry.id === storyId)
  const queries = currentCanvasQuerySurface.peek()
  const plane = queries?.sessionPlane.peek()
  if (!story || story.steps.length === 0 || !queries || !plane) return false
  if (active.peek()) leaveStoryPresentation()
  cancelReturnFocus()
  returnFocus = { target: options.returnFocus ?? 'map', storyId }
  restore = {
    camera: queries.view.captureView().camera,
    speciesFocus: queries.getSpeciesFocus().canonicalName,
  }
  active.value = {
    session: designSessionStore.sessionIdentity.peek(),
    storyId,
    index: clampIndex(index, story.steps.length),
  }
  setStoryPresentationHidesEditingAids(true)
  presentedScreen = null
  const disposeStep = effect(watchPresentation)
  const disposeScreen = effect(watchSettledScreen)
  disposeWatch = () => {
    disposeStep()
    disposeScreen()
  }
  setPresentingAttribute(true)
  return true
}

/** Shows another step; out-of-range indexes do nothing. */
export function goToPresentedStep(index: number): void {
  const current = active.peek()
  const presented = presentedStep.peek()
  if (!current || !presented || index < 0 || index >= presented.count || index === current.index) return
  active.value = { ...current, index }
}

export function nextPresentedStep(): void {
  const current = active.peek()
  if (current) goToPresentedStep(current.index + 1)
}

export function previousPresentedStep(): void {
  const current = active.peek()
  if (current) goToPresentedStep(current.index - 1)
}

/**
 * Ends the presentation and puts back everything it changed: the map layers,
 * site data, labels, Design layers and rings as the user had them, the
 * Species Focus, the editing aids, full screen and, in the same Design, the
 * camera; then focus goes back to where the presentation started.
 */
export function leaveStoryPresentation(): void {
  const current = active.peek()
  if (!current) return
  disposeWatch?.()
  disposeWatch = null
  appliedStepKey = null
  active.value = null
  setStoryPresentationOverrides(null)
  setStoryPresentationHidesEditingAids(false)
  setPresentingAttribute(false)
  const sameDesign = current.session === designSessionStore.sessionIdentity.peek()
  const commands = getCurrentCanvasCommandSurface()
  commands?.layers.presentLayers(null)
  const saved = restore
  restore = null
  if (commands && saved && sameDesign) {
    commands.speciesFocus.focus(saved.speciesFocus)
    commands.viewport.showCamera(saved.camera, { motion: 'jump' })
  }
  exitFullScreen()
  scheduleReturnFocus(sameDesign)
}

/**
 * Focus moves once the workspace has rendered again: the dock that holds the
 * Present button comes back and the modal layer lets the chrome go.
 */
function scheduleReturnFocus(sameDesign: boolean): void {
  const target = returnFocus
  returnFocus = null
  cancelReturnFocus()
  if (!target || typeof document === 'undefined') return
  returnFocusTimer = setTimeout(() => {
    returnFocusTimer = null
    if (active.peek()) return
    const button = sameDesign && target.target === 'present-button'
      ? [...document.querySelectorAll<HTMLButtonElement>('button[data-story-present]')]
        .find((candidate) => candidate.dataset.storyPresent === target.storyId)
      : undefined
    if (button && !button.disabled && button.closest('[inert]') === null) {
      button.focus({ preventScroll: true })
      if (document.activeElement === button) return
    }
    focusOwner.focusMap()
  }, 0)
}

function cancelReturnFocus(): void {
  if (returnFocusTimer !== null) clearTimeout(returnFocusTimer)
  returnFocusTimer = null
}

/** Full screen is on while presenting; the browser or the user may end it too. */
export const presentationFullScreen = signal(false)

/** Asks the window for full screen, or leaves it. */
export async function togglePresentationFullScreen(): Promise<void> {
  if (!active.peek() || typeof document === 'undefined') return
  if (document.fullscreenElement) {
    exitFullScreen()
    return
  }
  if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function') return
  try {
    await document.documentElement.requestFullscreen()
    enteredFullScreen = true
    // The presentation ended while the window was still asking: leave again.
    if (!active.peek()) exitFullScreen()
  } catch {
    // The window refused (no user gesture, or not allowed): presenting goes on in the window.
  }
}

/** Whether this window can go full screen at all. */
export function presentationFullScreenAvailable(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true
}

function exitFullScreen(): void {
  if (enteredFullScreen && typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => undefined)
  }
  enteredFullScreen = false
}

function onFullScreenChange(): void {
  presentationFullScreen.value = typeof document !== 'undefined' && document.fullscreenElement !== null
  if (!presentationFullScreen.peek()) enteredFullScreen = false
}

if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', onFullScreenChange)

let appliedStepKey: string | null = null
/** The map's size when the presentation last settled, as `width×height` CSS px. */
let presentedScreen: string | null = null

/** Applies the presented step, and ends the presentation when its Design or story goes away. */
function watchPresentation(): void {
  const current = active.value
  if (!current) return
  const presented = presentedStep.value
  if (!presented) {
    // Another Design replaced this one, or the story or step went away.
    queueMicrotask(leaveStoryPresentation)
    return
  }
  // A Design object that changed elsewhere (a save stamping it) is the same step: apply once.
  const key = `${presented.story.id}:${presented.step.id}:${presented.index}:${presented.view ? JSON.stringify(presented.view) : ''}`
  if (key === appliedStepKey) return
  appliedStepKey = key
  applyStep(presented)
}

/**
 * The step on screen keeps its frame: when the map settles at another size
 * (full screen ends, the window is resized), the step's view is fitted again
 * to its framed ground, with a jump.
 */
function watchSettledScreen(): void {
  const view = currentCanvasQuerySurface.value?.view
  if (!view) return
  void view.settledRevision.value
  const { width, height } = view.captureView().screen
  const size = `${width}×${height}`
  const previous = presentedScreen
  presentedScreen = size
  if (previous === null || previous === size) return
  const shown = presentedStep.peek()?.view
  if (shown) goToSavedView(shown.id, 'jump')
}

function applyStep({ view }: PresentedStep): void {
  const commands = getCurrentCanvasCommandSurface()
  if (!view || !commands) return
  setStoryPresentationOverrides(stepOverrides(view, mapLayers.peek(), savedViewPresentedLabels(view)))
  commands.layers.presentLayers(view.visible_layers.scene_layers)
  commands.speciesFocus.focus(plantedSpeciesToFocus(view))
  goToSavedView(view.id)
}

/** What a view shows, over the user's own map layer settings (opacities, style choices). */
function stepOverrides(view: SavedView, layers: MapLayersState, plantLabels: PlantLabelMode): StoryPresentationOverrides {
  return {
    mapLayers: mapLayersOfView(view, layers),
    siteDataIds: new Set(view.visible_layers.site_data),
    plantLabels,
    targets: highlightTargets(view),
  }
}

/**
 * The step's first highlighted species that still has plants. The runtime
 * keeps the current focus for a species with no plants, which would carry the
 * previous step's (or the user's) focus into this one.
 */
function plantedSpeciesToFocus(view: SavedView): string | null {
  // Read untracked: the step's effect focuses the species next, which bumps the Scene revision this read follows.
  const plants = untracked(() => currentCanvasQuerySurface.peek()?.getSceneSnapshot().plants) ?? []
  return view.highlighted.species.find((name) => plants.some((plant) => plant.canonicalName === name)) ?? null
}

function highlightTargets(view: SavedView): PanelTarget[] {
  const targets: PanelTarget[] = view.highlighted.species.map((canonicalName) => ({ kind: 'species', canonical_name: canonicalName }))
  for (const object of view.highlighted.objects) {
    if (object.kind === 'plant') targets.push({ kind: 'placed_plant', plant_id: object.id })
    else if (object.kind === 'zone') targets.push({ kind: 'zone', zone_id: object.id })
  }
  return targets
}


/** Hides the runtime's editing overlays on the map (styles/global.css). */
function setPresentingAttribute(presenting: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.toggleAttribute('data-story-presenting', presenting)
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Number.isInteger(index) ? index : 0, count - 1))
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    leaveStoryPresentation()
    cancelReturnFocus()
    if (typeof document !== 'undefined') document.removeEventListener('fullscreenchange', onFullScreenChange)
  })
}
