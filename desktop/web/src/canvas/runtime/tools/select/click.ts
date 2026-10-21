// canvas/runtime/tools/select/click.ts
//
// Owns what a Select press does to the selection, at the press, and what its click does at the release, with the
// history-free selection effect. A double-click (the press's click count, input/recognise.ts clickCountOf) on an unlocked
// plant selects the plant's species, and on an unlocked note opens the note for editing, when the press before it hit the
// same object, else it is a single click (U42: a finger's double tap counts within 30 px, which spans two objects); an
// additive press toggles the hit and asks no move; any other hit is selected unless it already is and starts a move-drag,
// and an Alt click on it (subtractive) removes it from the selection the press found. A hit on a locked object, directly
// or as a group holding a locked member (2.1-Q161), is selected the same way, but its move-drag is refused with the lock
// toast (2.1-Q177), so only a drag that would have moved raises it. Empty ground (an object on a locked or hidden layer is
// never hit) clears the selection unless additive and starts the band. A press inside a zone away from its outline is
// empty ground (canopi-qd2k: zones are picked by their outline, hit-testing.ts). Additive is Shift, Ctrl or Cmd
// (ToolModifiers.additive), subtractive is Alt without them.

import {
  applySpeciesSelection,
  getSelectablePlantIdsForSpecies,
} from '../../scene-runtime/species-selection'
import {
  normalizeSceneDesignObjectTargets,
  sceneTargetKey,
  type SceneDesignObjectSelection,
  type SceneDesignObjectTarget,
} from '../../scene/design-object-targets'
import { isSceneDesignObjectLocked } from '../../scene/locks'
import type { HitTarget, ToolContext, ToolPoint } from '../tool'

/** What the press goes on to do. */
export type SelectPress =
  | { readonly kind: 'band'; readonly additive: boolean }
  /** `removeFrom`: an Alt press's selection before it; its click removes the target from it. `locked`: the target is
   *  locked, so its drag is refused. */
  | {
    readonly kind: 'move'
    readonly target: SceneDesignObjectTarget
    readonly removeFrom: SceneDesignObjectSelection | null
    readonly locked: boolean
  }
  | { readonly kind: 'edit-note'; readonly annotationId: string }
  | { readonly kind: 'done' }

/** Selects for the press and says what follows. `previous` is the object the press before this one hit, or null. */
export function pressSelection(
  ctx: ToolContext,
  point: ToolPoint,
  rawHit: HitTarget | null,
  clickCount: number,
  previous: SceneDesignObjectTarget | null,
): SelectPress {
  const scene = ctx.scene.persisted
  const hit = rawHit?.kind === 'object' ? rawHit.target : null
  const additive = point.modifiers.additive
  const subtractive = point.modifiers.subtractive && !additive

  if (!hit) {
    if (!additive) ctx.effects.setSelection([])
    return { kind: 'band', additive }
  }

  const locked = isSceneDesignObjectLocked(scene, hit)
  const repeated = !locked && clickCount >= 2 && previous !== null && sceneTargetKey(previous) === sceneTargetKey(hit)
  if (repeated && hit.kind === 'plant') {
    const plant = scene.plants.find((entry) => entry.id === hit.id)
    if (!plant) return { kind: 'done' }
    const speciesPlantIds = getSelectablePlantIdsForSpecies(scene, plant.canonicalName)
    if (speciesPlantIds.length === 0) return { kind: 'done' }
    ctx.effects.setSelection(applySpeciesSelection(ctx.scene.selection(), speciesPlantIds, additive))
    return { kind: 'done' }
  }

  if (repeated && !additive && !subtractive && hit.kind === 'annotation') {
    ctx.effects.setSelection([hit])
    return { kind: 'edit-note', annotationId: hit.id }
  }

  const selection = ctx.scene.selection()
  if (additive) {
    ctx.effects.setSelection(toggleSelectionTarget(selection, hit))
    return { kind: 'done' }
  }
  if (!selection.some((candidate) => sceneTargetKey(candidate) === sceneTargetKey(hit))) {
    ctx.effects.setSelection([hit])
  }
  return { kind: 'move', target: hit, removeFrom: subtractive ? selection : null, locked }
}

/** The click of a press that did not move: an Alt press removes its target. */
export function clickSelection(ctx: ToolContext, press: SelectPress): void {
  if (press.kind === 'move' && press.removeFrom) {
    const key = sceneTargetKey(press.target)
    ctx.effects.setSelection(press.removeFrom.filter((candidate) => sceneTargetKey(candidate) !== key))
  }
}

function toggleSelectionTarget(
  selection: SceneDesignObjectSelection,
  target: SceneDesignObjectTarget,
): SceneDesignObjectTarget[] {
  const next = new Map(selection.map((candidate) => [sceneTargetKey(candidate), candidate] as const))
  const key = sceneTargetKey(target)
  if (next.has(key)) next.delete(key)
  else next.set(key, target)
  return normalizeSceneDesignObjectTargets(next.values())
}
