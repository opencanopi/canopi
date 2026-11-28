// canvas/runtime/tools/select/note-edit.ts
//
// Owns the in-place editing of a text note under Select, whose field is the host's text entry, drawn at the note's font
// size where the note draws (TextEntryRequest has one mode): opening a note's entry, and its submit on Enter or blur. The
// submit writes the text as one 'interaction-annotation-text' Scene Edit, deletes the note (and its group membership)
// when the text is blank, and changes nothing for the same text or a note that can no longer be edited (gone, locked,
// grouped, or on a hidden or locked layer), closing the entry in each case; while the scene refuses the edit the same
// entry stays open with its text.

import { getSceneGroupedMemberKeys, pruneGroupDeletedMembers, sceneObjectGroupMemberKey } from '../../scene/group-members'
import { isSceneDesignObjectLocked } from '../../scene/locks'
import { singleEditableTarget } from '../../scene-runtime/selection'
import type { SceneAnnotationEntity, ScenePersistedState } from '../../scene/types'
import type { TextEntryRequest, ToolContext } from '../tool'

const EDIT_TYPE = 'interaction-annotation-text'

/** The note Enter or F2 edits: the one editable text note selected, nothing locked or blocked. */
export function selectedEditableNoteId(ctx: ToolContext): string | null {
  return singleEditableTarget(ctx.scene.selectionModel(), 'annotation')?.id ?? null
}

/** Opens the entry of the text note `annotationId`; false when there is no such note. */
export function openNoteEntry(ctx: ToolContext, annotationId: string, onClosed: () => void): boolean {
  const annotation = findAnnotation(ctx.scene.persisted, annotationId)
  if (!annotation || annotation.annotationType !== 'text') return false
  const request: TextEntryRequest = {
    anchor: annotation.position,
    rotationDeg: annotation.rotationDeg ?? 0,
    initialText: annotation.text,
    placeholderKey: 'canvas.textNote.placeholder',
    fontSizePx: annotation.fontSize,
  }
  ctx.effects.requestTextEntry(request, (text) => {
    const reply = submitNote(ctx, annotationId, text)
    if (reply === 'close') onClosed()
    return reply
  })
  return true
}

/** True while the scene still holds the note: the editor closes once its note is gone. */
export function noteExists(scene: Readonly<ScenePersistedState>, annotationId: string): boolean {
  return findAnnotation(scene, annotationId) !== null
}

function submitNote(ctx: ToolContext, annotationId: string, text: string): 'close' | 'keep' {
  const scene = ctx.scene.persisted
  const annotation = findAnnotation(scene, annotationId)
  if (!annotation || !isNoteEditable(scene, annotation)) return 'close'
  if (text.trim().length === 0) {
    return ctx.effects.edits.run(EDIT_TYPE, (tx) => {
      tx.mutate((draft) => {
        draft.annotations = draft.annotations.filter((entry) => entry.id !== annotationId)
        draft.groups = draft.groups
          .map((group) => pruneGroupDeletedMembers(group, { annotationIds: new Set([annotationId]) }))
          .filter((group): group is NonNullable<typeof group> => group !== null)
      })
      tx.setSelection([])
    }) ? 'close' : 'keep'
  }
  if (text === annotation.text) return 'close'
  return ctx.effects.edits.run(EDIT_TYPE, (tx) => {
    tx.mutate((draft) => {
      draft.annotations = draft.annotations.map((entry) => (entry.id === annotationId ? { ...entry, text } : entry))
    })
  }) ? 'close' : 'keep'
}

/** The note alone would be editable (not grouped, on a visible unlocked layer, not locked). */
function isNoteEditable(scene: Readonly<ScenePersistedState>, annotation: SceneAnnotationEntity): boolean {
  const target = { kind: 'annotation', id: annotation.id } as const
  if (getSceneGroupedMemberKeys(scene).has(sceneObjectGroupMemberKey(target))) return false
  const layer = scene.layers.find((entry) => entry.name === 'annotations')
  if (layer?.visible === false || (layer?.opacity ?? 1) <= 0 || layer?.locked === true) return false
  return !isSceneDesignObjectLocked(scene, target)
}

function findAnnotation(scene: Readonly<ScenePersistedState>, annotationId: string): SceneAnnotationEntity | null {
  return scene.annotations.find((entry) => entry.id === annotationId) ?? null
}
