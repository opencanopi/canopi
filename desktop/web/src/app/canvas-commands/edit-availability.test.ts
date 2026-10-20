// The one table of when an Edit command can run (canopi-f47t.52.2, S3b): the menu bar, the palette, the canvas menu and
// the run-time guard all read it, so none keeps a rule of its own (U39).
import { describe, expect, it } from 'vitest'
import type { CanvasEditAction } from './index'
import { canvasEditAvailable, type CanvasEditSelectionAvailability } from './edit-availability'

type CanvasEditAvailabilityInput = Parameters<typeof canvasEditAvailable>[1]

const ALL_EDITS: readonly CanvasEditAction[] = [
  'cut', 'copy', 'paste', 'duplicate', 'delete', 'select-all', 'select-same-species', 'deselect', 'group', 'ungroup',
  'bring-to-front', 'send-to-back', 'rotate', 'lock', 'unlock', 'unlock-all', 'save-as-stamp',
]

/** Everything a selection's commands can do: two editable plants of one species, nothing locked. */
const EVERYTHING: CanvasEditSelectionAvailability = {
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
    const lockedPlant: CanvasEditSelectionAvailability = {
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
    const mixed: CanvasEditSelectionAvailability = {
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
})
