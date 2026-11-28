// canvas/runtime/tools/text-note.ts
//
// Owns the Text tool (spec §1.4, §3.2): a press on the map opens a new note's text entry where it lands (the host's
// text entry in 'create' mode), level with the screen:
// the note stores the bearing at the press as its rotation (spec §4.7; 0 when north is up). Enter or a blur hands
// the text to the submit, which writes the note as one 'interaction-text' Scene Edit, selects it and closes the entry
// once the edit has committed (a commit that settles later closes it then); blank text, or an Annotations layer hidden
// or locked by then, writes nothing and closes it; while the scene refuses the edit the entry stays open with its text.
// Esc in the entry discards it (onCancel). The tool card shows a gesture while the entry is open. The click that
// commits an open note places nothing (spec §3.2): the host keeps a press that finds a new note's entry open from every
// tool (tool-host.ts, rawPress). The entry survives the host's cancellations; entering overview
// commits it, or discards a refused one through cancelTextEntry so the tool resets (U34, B5); a tool change closes it,
// and so does a document replacement (before v2, at a4c86d39, the field survived it to commit into the new
// document; a recorded tiny deviation).

import { appendTextAnnotationToDraft } from './tool-actions'
import type { CanvasTool, ToolContext, ToolReply } from './tool'
import type { WorldPoint } from '../../../geo/view/types'

const EDIT_TYPE = 'interaction-text'

export function createTextNoteTool(): CanvasTool {
  let context: ToolContext | null = null
  /** Where the open entry's note goes; null while no entry of this tool is open. */
  let anchor: WorldPoint | null = null

  function ctx(): ToolContext {
    if (!context) throw new Error('The Text tool is not active.')
    return context
  }

  function open(at: WorldPoint): void {
    const c = ctx()
    anchor = at
    // A new note is level with the screen: it stores the bearing (spec §4.7), 0 when north is up.
    const rotationDeg = c.view.bearingDeg
    c.effects.requestTextEntry(
      { anchor: at, rotationDeg, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
      (text) => submit(at, text, rotationDeg),
      () => {
        if (anchor === at) entryClosed()
      },
    )
    c.effects.setGuidance({ gesture: true })
  }

  function submit(at: WorldPoint, text: string, rotationDeg: number): 'close' | 'keep' {
    if (!context || anchor !== at) return 'close'
    const c = context
    const note = text.trim()
    if (note.length === 0 || !c.scene.isLayerOpenForCreation('annotations')) {
      entryClosed()
      return 'close'
    }
    let committed = false
    c.effects.edits.run(EDIT_TYPE, (tx) => {
      let id = ''
      tx.mutate((draft) => {
        id = appendTextAnnotationToDraft(draft, at, note, rotationDeg)
      })
      tx.setSelection([{ kind: 'annotation', id }])
    }, {
      onCommitted: () => {
        committed = true
        if (anchor !== at) return
        entryClosed()
        c.effects.closeTextEntry()
      },
    })
    return committed ? 'close' : 'keep'
  }

  /** The entry is gone (committed, discarded or cancelled): the tool card's gesture ends. */
  function entryClosed(): void {
    anchor = null
    ctx().effects.setGuidance({ gesture: false })
  }

  return {
    id: 'text',
    activate(c) {
      context = c
      c.effects.setGuidance({ gesture: false })
    },
    gesture(g): ToolReply {
      // A press keeps its pointer gesture: no passive hover over the held moves.
      if (g.kind === 'drag-start' || g.kind === 'drag-move') return 'handled'
      // The host keeps the click that commits an open note from the tool; one that reaches it anyway places nothing.
      if (g.kind !== 'press' || anchor) return 'pass'
      if (ctx().scene.isLayerOpenForCreation('annotations')) open(g.point.world)
      return 'pass'
    },
    command: () => 'pass',
    hasTransient: () => false,
    cancelTransient() {
      // The text entry outlives every cancellation; the host closes it itself on a tool change or replacement.
    },
    deactivate() {
      if (anchor) context?.effects.closeTextEntry()
      anchor = null
      context = null
    },
  }
}
