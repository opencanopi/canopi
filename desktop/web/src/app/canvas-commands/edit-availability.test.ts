// The one table of when an Edit command can run (canopi-f47t.52.2, S3b; unified into app/command-table/ in M163):
// the menu bar, the palette, the canvas menu and the run-time guard all read `commandApplicability`, so none keeps a
// rule of its own (U39).
import { describe, expect, it } from 'vitest'
import {
  isCanvasCommandDisabled,
  type CanvasCommandId,
  type CanvasCommandProjectionState,
  type CanvasEditAction,
} from './index'
import {
  commandApplicability,
  commandRowFor,
  EDITION_CAPABILITIES,
  type CommandContext,
  type SelectionAvailabilityContext,
} from '../command-table'

interface CanvasEditAvailabilityInput {
  readonly canvasAvailable: boolean
  readonly overview: boolean
  readonly readOnly: boolean
  readonly selection: SelectionAvailabilityContext | null
  readonly held: boolean
  readonly lockedObjectsPresent: boolean
  readonly canPaste: boolean
}

const ALL_CAPABILITIES = EDITION_CAPABILITIES.map((row) => row.id)

const EDIT_COMMAND_ID: Readonly<Record<CanvasEditAction, CanvasCommandId>> = {
  cut: 'canvas.cut',
  copy: 'canvas.copy',
  paste: 'canvas.paste',
  duplicate: 'canvas.duplicateSelected',
  delete: 'canvas.deleteSelected',
  'select-all': 'canvas.selectAll',
  'select-same-species': 'canvas.selectSameSpecies',
  deselect: 'canvas.clearSelection',
  group: 'canvas.groupSelected',
  ungroup: 'canvas.ungroupSelected',
  'bring-to-front': 'canvas.bringToFront',
  'send-to-back': 'canvas.sendToBack',
  rotate: 'canvas.rotateSelected',
  lock: 'canvas.lockSelected',
  unlock: 'canvas.unlockSelected',
  'unlock-all': 'canvas.unlockAll',
  'save-as-stamp': 'canvas.saveSelectionAsStamp',
}

function canvasEditAvailable(action: CanvasEditAction, state: CanvasEditAvailabilityInput): boolean {
  const ctx: CommandContext = {
    capabilities: ALL_CAPABILITIES,
    hasDesign: true,
    revertAvailable: false,
    canvasAvailable: state.canvasAvailable,
    spatialEditingAvailable: !state.overview,
    readOnly: state.readOnly,
    selection: state.selection,
    held: state.held,
    lockedObjectsPresent: state.lockedObjectsPresent,
    canPaste: state.canPaste,
    canUndo: false,
    canRedo: false,
  }
  return commandApplicability(commandRowFor(EDIT_COMMAND_ID[action]), ctx) === 'enabled'
}

const ALL_EDITS: readonly CanvasEditAction[] = [
  'cut', 'copy', 'paste', 'duplicate', 'delete', 'select-all', 'select-same-species', 'deselect', 'group', 'ungroup',
  'bring-to-front', 'send-to-back', 'rotate', 'lock', 'unlock', 'unlock-all', 'save-as-stamp',
]

/** Everything a selection's commands can do: two editable plants of one species, nothing locked. */
const EVERYTHING: SelectionAvailabilityContext = {
  copy: true,
  edit: true,
  group: true,
  ungroup: true,
  rotate: true,
  unlock: true,
  selectSameSpecies: true,
  saveAsStamp: true,
}

function input(overrides: Partial<CanvasEditAvailabilityInput> = {}): CanvasEditAvailabilityInput {
  return {
    canvasAvailable: true,
    overview: false,
    readOnly: false,
    selection: EVERYTHING,
    held: false,
    lockedObjectsPresent: true,
    canPaste: true,
    ...overrides,
  }
}

const unavailable = (state: CanvasEditAvailabilityInput) =>
  ALL_EDITS.filter((action) => !canvasEditAvailable(action, state))

describe('canvas edit availability', () => {
  it('runs every edit on an editable selection with a clipboard and a locked object somewhere', () => {
    expect(unavailable(input())).toEqual([])
  })

  it('runs nothing without a canvas', () => {
    expect(unavailable(input({ canvasAvailable: false }))).toEqual(ALL_EDITS)
  })

  it('keeps Copy and the selection edits that change no object in overview, where objects cannot change', () => {
    expect(ALL_EDITS.filter((action) => !unavailable(input({ overview: true })).includes(action)))
      .toEqual(['copy', 'select-all', 'select-same-species', 'deselect'])
  })

  it('holds only Cut and Delete while a press, a tool transient or a text entry is live', () => {
    expect(unavailable(input({ held: true }))).toEqual(['cut', 'delete'])
  })

  it('offers Paste, Select all and Unlock all with nothing selected, Paste only with a clipboard', () => {
    expect(ALL_EDITS.filter((action) => canvasEditAvailable(action, input({ selection: null }))))
      .toEqual(['paste', 'select-all', 'unlock-all'])
    expect(canvasEditAvailable('paste', input({ canPaste: false }))).toBe(false)
    expect(canvasEditAvailable('unlock-all', input({ selection: null, lockedObjectsPresent: false }))).toBe(false)
  })

  it('takes each selection edit from what the selection can do', () => {
    const lockedPlant: SelectionAvailabilityContext = {
      ...EVERYTHING,
      copy: false,
      edit: false,
      group: false,
      ungroup: false,
      rotate: false,
      selectSameSpecies: false,
      saveAsStamp: false,
    }
    expect(unavailable(input({ selection: lockedPlant }))).toEqual([
      'cut', 'copy', 'duplicate', 'delete', 'select-same-species', 'group', 'ungroup', 'bring-to-front', 'send-to-back',
      'rotate', 'lock', 'save-as-stamp',
    ])
    expect(unavailable(input({ selection: { ...EVERYTHING, unlock: false } }))).toEqual(['unlock'])
  })

  it('on a mixed locked and unlocked selection runs the edits that act on the unlocked part; group and rotate stay strict (U59)', () => {
    // What selectionCommandAvailability gives two unlocked plants and a locked zone (the canvas menu seam test,
    // canvas-interaction-e2e.select.test.ts): Delete, Cut, Copy, Duplicate, Bring to front, Send to back and Lock act on
    // the plants and silently leave the zone (U55 overturned, 2026-10-13); Group and Rotate… refuse a locked member.
    const mixed: SelectionAvailabilityContext = {
      ...EVERYTHING,
      group: false,
      ungroup: false,
      rotate: false,
      selectSameSpecies: false,
    }
    expect(ALL_EDITS.filter((action) => canvasEditAvailable(action, input({ selection: mixed })))).toEqual([
      'cut', 'copy', 'paste', 'duplicate', 'delete', 'select-all', 'deselect', 'bring-to-front', 'send-to-back', 'lock',
      'unlock', 'unlock-all', 'save-as-stamp',
    ])
  })

  it('routes isCanvasCommandDisabled through commandApplicability with the same edit rules (M163)', () => {
    const toProjectionState = (s: CanvasEditAvailabilityInput): CanvasCommandProjectionState => ({
      activeTool: 'select',
      canvasAvailable: s.canvasAvailable,
      spatialEditingAvailable: !s.overview,
      readOnly: s.readOnly,
      selection: s.selection,
      held: s.held,
      lockedObjectsPresent: s.lockedObjectsPresent,
      canUndo: false,
      canRedo: false,
      gridVisible: false,
      snapToGridEnabled: false,
    })
    for (const overrides of [
      {},
      { canvasAvailable: false },
      { overview: true },
      { readOnly: true },
      { held: true },
      { selection: null, lockedObjectsPresent: false },
    ]) {
      const s = input({ ...overrides, canPaste: true })
      const proj = toProjectionState(s)
      for (const action of ALL_EDITS) {
        expect(isCanvasCommandDisabled({ type: 'edit', action }, proj), action).toBe(!canvasEditAvailable(action, s))
      }
    }
  })
})
