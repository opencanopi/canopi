import { computed } from '@preact/signals'
import {
  createCanvasCommandProjection,
  isCanvasCommandDisabled,
  type CanvasCommandFrom,
  type CanvasCommandIntent,
  type CanvasCommandProjectionState,
  type CanvasEditAction,
  type CanvasViewAction,
} from '../canvas-commands'
import { gridVisible, snapToGridEnabled } from '../canvas-settings/signals'
import { requestPlaceSearchFocus } from '../geocoding/place-search-ui'
import { cyclePlantLabels } from '../plant-display/actions'
import {
  currentCanvasCommandSurface,
  currentCanvasHasSelection,
  currentCanvasKeyboardPort,
  currentCanvasQuerySurface,
  currentCanvasSelection,
  currentCanvasTool,
} from '../../canvas/session'
import type { CanvasCommandSurface } from '../../canvas/runtime/runtime'
import { selectionCommandAvailability } from '../../canvas/runtime/interaction/contextual-selection-actions'
import { openRotateSelectionDialog } from '../rotate-selection/state'
import { sceneHasLockedDesignObjects } from '../../canvas/runtime/scene'
import { t } from '../../i18n'
import { singleKeyShortcuts } from '../settings/state'
import { armCanvasTool } from '../keyboard/arming'

/**
 * The canvas half of the command graph, shared by both editions: projection
 * state read from the live canvas session, and runCanvasIntent, which runs
 * each command on the command surface current at dispatch time.
 */

/** The re-origin hold, the key guard's own predicate, so the greyed state and the run-time guards agree (U39). */
function canvasHoldsSelectionDeletes(): boolean {
  return currentCanvasKeyboardPort()?.holdsSelectionDeletes() ?? false
}

/**
 * The hold as reactive readers see it (S3b): re-read on each move of the transient history, which every tool call
 * makes, a hover included, but its readers re-run only when it flips, not at pointer rate.
 */
const projectedHold = computed(() => {
  void currentCanvasQuerySurface.value?.revision.transientHistory.value
  return canvasHoldsSelectionDeletes()
})

/** The state the projection and the palette grey with. */
export function readWorkspaceCanvasProjectionState(): CanvasCommandProjectionState {
  return readCanvasState(projectedHold.value)
}

/** The state the run-time guards read: the hold live, so one that began after the menu drew (a press) still counts. */
function readLiveCanvasState(): CanvasCommandProjectionState {
  return readCanvasState(canvasHoldsSelectionDeletes())
}

function readCanvasState(held: boolean): CanvasCommandProjectionState {
  const surface = currentCanvasCommandSurface.value
  const queries = currentCanvasQuerySurface.value
  void currentCanvasSelection.value
  const hasSelection = currentCanvasHasSelection.value
  // Locks change with Scene edits: the getSceneSnapshot() read below follows them, so a lock change re-projects.
  const selection = hasSelection ? queries?.getDesignObjectSelection() ?? null : null
  return {
    activeTool: currentCanvasTool.value,
    canvasAvailable: surface !== null,
    spatialEditingAvailable: queries?.view.mode.value !== 'overview',
    selection: selection === null ? null : withEditionCapabilities(selectionCommandAvailability(selection), surface),
    held,
    lockedObjectsPresent: queries !== null && sceneHasLockedDesignObjects(queries.getSceneSnapshot()),
    canUndo: surface?.history.canUndo.value ?? false,
    canRedo: surface?.history.canRedo.value ?? false,
    gridVisible: gridVisible.value,
    snapToGridEnabled: snapToGridEnabled.value,
  }
}

/** Save as stamp exists only where the edition saves stamps (2.1-Q150): Web greys it in the menu bar, palette and guard. */
function withEditionCapabilities(
  can: ReturnType<typeof selectionCommandAvailability>,
  surface: CanvasCommandSurface | null,
): ReturnType<typeof selectionCommandAvailability> {
  const saves = surface?.sceneEdits.saveSelectionAsObjectStamp !== undefined
  return saves || !can.saveAsStamp ? can : { ...can, saveAsStamp: false }
}

function withCanvas(run: (canvas: CanvasCommandSurface) => void): void {
  const canvas = currentCanvasCommandSurface.peek()
  if (canvas) run(canvas)
}

function runCanvasEditAction(action: CanvasEditAction): void {
  // The table the menu bar greys with, read live: a hold that began after the menu drew (a press) still refuses Cut and
  // Delete, as the keys and the canvas menu do (U39).
  if (isCanvasCommandDisabled({ type: 'edit', action }, readLiveCanvasState())) return
  withCanvas(({ sceneEdits }) => {
    switch (action) {
      case 'cut':
        sceneEdits.copy()
        sceneEdits.deleteSelected()
        return
      case 'copy': sceneEdits.copy(); return
      case 'paste': sceneEdits.paste(); return
      case 'duplicate': sceneEdits.duplicateSelected(); return
      case 'delete': sceneEdits.deleteSelected(); return
      case 'select-all': sceneEdits.selectAll(); return
      case 'select-same-species': sceneEdits.selectSameSpecies(); return
      case 'deselect': sceneEdits.clearSelection(); return
      case 'group': sceneEdits.groupSelected(); return
      case 'ungroup': sceneEdits.ungroupSelected(); return
      case 'bring-to-front': sceneEdits.bringToFront(); return
      case 'send-to-back': sceneEdits.sendToBack(); return
      case 'rotate':
        // Rotate… asks for the angle; the dialog turns whatever canvas is current then.
        openRotateSelectionDialog({
          rotate: (degrees) => currentCanvasCommandSurface.peek()?.sceneEdits.rotateSelected(degrees),
        })
        return
      case 'lock': sceneEdits.lockSelected(); return
      case 'unlock': sceneEdits.unlockSelected(); return
      case 'unlock-all': sceneEdits.unlockAll(); return
      case 'save-as-stamp': sceneEdits.saveSelectionAsObjectStamp?.()
    }
  })
}

function runCanvasViewAction(action: CanvasViewAction): void {
  if (action === 'search-place') {
    if (currentCanvasCommandSurface.peek()) requestPlaceSearchFocus()
    return
  }
  if (action === 'cycle-labels') {
    if (currentCanvasCommandSurface.peek()) cyclePlantLabels()
    return
  }
  withCanvas(({ viewport }) => {
    switch (action) {
      case 'zoom-in': viewport.zoomIn(); return
      case 'zoom-out': viewport.zoomOut(); return
      case 'fit-to-design': viewport.zoomToFit(); return
      case 'zoom-to-selection': viewport.zoomToSelection(); return
      case 'reset-north': viewport.resetNorth(); return
      case 'turn-view-left': viewport.rotateBy(-1); return
      case 'turn-view-right': viewport.rotateBy(1)
    }
  })
}

/**
 * Runs one intent on the surface current at dispatch time: the projection's actions, the palette and both editions'
 * key sinks all come here. Each surface arms a tool with its own `from` (the rail, a menu, the palette, a key).
 */
export function runCanvasIntent(intent: CanvasCommandIntent, from: CanvasCommandFrom): void {
  switch (intent.type) {
    case 'select-tool':
      armCanvasTool(intent.tool, { from })
      return
    case 'undo':
      withCanvas((canvas) => { if (canvas.history.canUndo.peek()) canvas.history.undo() })
      return
    case 'redo':
      withCanvas((canvas) => { if (canvas.history.canRedo.peek()) canvas.history.redo() })
      return
    case 'toggle-grid':
      withCanvas((canvas) => canvas.chrome.toggleGrid())
      return
    case 'toggle-snap-to-grid':
      withCanvas((canvas) => canvas.chrome.toggleSnapToGrid())
      return
    case 'edit':
      runCanvasEditAction(intent.action)
      return
    case 'view':
      runCanvasViewAction(intent.action)
  }
}

/**
 * Dispatch one intent unless the live state disables it; true when its key is spent: it ran, or it is an Edit command
 * while the map has a selection. A disabled Group or Duplicate on one plant or a locked one still keeps Ctrl+G and
 * Ctrl+D from the browser's find bar and bookmark dialog; with nothing selected, Copy leaves its key to the page.
 */
export function dispatchWorkspaceCanvasIntent(intent: CanvasCommandIntent, from: CanvasCommandFrom): boolean {
  const state = readLiveCanvasState()
  if (isCanvasCommandDisabled(intent, state)) return intent.type === 'edit' && state.selection !== null
  runCanvasIntent(intent, from)
  return true
}

/** The canvas command projection both editions render: tool rail, view chip, zoom group, menus. */
export const workspaceCanvasCommandProjection = computed(() => createCanvasCommandProjection({
  state: readWorkspaceCanvasProjectionState(),
  run: runCanvasIntent,
  translate: t,
  characterKeys: singleKeyShortcuts.value,
}))
