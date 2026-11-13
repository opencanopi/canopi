import { describe, expect, it, vi } from 'vitest'
import {
  buildCanvasContextMenuEntries,
  type CanvasContextMenuCommand,
  type CanvasContextMenuEntry,
  type CanvasContextMenuEntryOptions,
  type CanvasContextMenuItemId,
  type CanvasContextMenuSubmenu,
} from '../app/canvas-context-menu/entries'
import type {
  CanvasContextMenuCommands,
  CanvasContextMenuRequest,
} from '../canvas/runtime/app-adapter'
import type { CanvasDesignObjectSelectionModel } from '../canvas/runtime/runtime'
import { t } from '../i18n'
import { applyRotateSelection, rotateSelectionDialog } from '../app/rotate-selection/state'
import { applyRenameZone, closeRenameZoneDialog, renameZoneDialog } from '../app/rename-zone/state'
import type { MapSelectionSummary } from '../app/map-selection/summary'
import { createCanvasCommandProjection } from '../app/canvas-commands'
import { selectionCommandAvailability } from '../canvas/runtime/interaction/contextual-selection-actions'

function createCommands(overrides: Partial<CanvasContextMenuCommands> = {}): CanvasContextMenuCommands {
  return {
    copy: vi.fn(),
    pasteAt: vi.fn(),
    canPaste: vi.fn(() => true),
    duplicateSelected: vi.fn(),
    toggleSelectedPlantNamePins: vi.fn(),
    deleteSelected: vi.fn(),
    selectAll: vi.fn(),
    selectSameSpecies: vi.fn(),
    bringToFront: vi.fn(),
    sendToBack: vi.fn(),
    lockSelected: vi.fn(),
    unlockSelected: vi.fn(),
    groupSelected: vi.fn(),
    ungroupSelected: vi.fn(),
    renameZone: vi.fn(() => true),
    rotateSelected: vi.fn(),
    ...overrides,
  }
}

function selection(overrides: Partial<CanvasDesignObjectSelectionModel> = {}): CanvasDesignObjectSelectionModel {
  return {
    editableTargets: [],
    lockedTargets: [],
    blockedTargets: [],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    sameSpeciesReferenceCanonicalName: null,
    plantNamePinning: { plantIds: [], allPinned: false },
    ...overrides,
  }
}

const TWO_APPLES = selection({
  editableTargets: [{ kind: 'plant', id: 'apple-1' }, { kind: 'plant', id: 'apple-2' }],
  sameSpeciesReferenceCanonicalName: 'Malus domestica',
  plantNamePinning: { plantIds: ['apple-1', 'apple-2'], allPinned: false },
})

const ONE_ZONE = selection({ editableTargets: [{ kind: 'zone', id: 'zone-1' }] })

const PLANT_AND_ZONE = selection({
  editableTargets: [{ kind: 'plant', id: 'apple-1' }, { kind: 'zone', id: 'zone-1' }],
  plantNamePinning: { plantIds: ['apple-1'], allPinned: true },
})

const APPLE_SUMMARY: MapSelectionSummary = {
  plantCount: 2,
  species: [{ canonicalName: 'Malus domestica', name: 'Apple', englishFallback: false, selectedCount: 2, designCount: 5 }],
  plantSpacingM: 1.5,
  zones: [],
  noteCount: 0,
  noteText: null,
  measurementCount: 0,
  measurementLengthM: null,
}

function build(
  model: CanvasDesignObjectSelectionModel | null,
  options: {
    readonly commands?: CanvasContextMenuCommands
    readonly saveSelectionAsObjectStamp?: () => void
    readonly openPlantAppearance?: CanvasContextMenuEntryOptions['openPlantAppearance']
    readonly returnFocus?: () => void
    readonly summary?: MapSelectionSummary | null
    readonly characterKeyShortcuts?: boolean
    readonly turnViewToEdge?: () => void
    readonly finishShape?: () => void
    readonly pointActions?: CanvasContextMenuRequest['pointActions']
    readonly profileLine?: CanvasContextMenuEntryOptions['profileLine']
    /** The re-origin hold at the open (U39). */
    readonly held?: boolean
  } = {},
) {
  const commands = options.commands ?? createCommands()
  const openPlantAppearance = options.openPlantAppearance ?? vi.fn()
  const openSpeciesDetail = vi.fn()
  const addToCalendar = vi.fn()
  const setUnitCost = vi.fn()
  const request: CanvasContextMenuRequest = {
    anchor: { left: 300, top: 200, right: 300, bottom: 200 },
    world: { x: 12, y: 34 },
    selection: model,
    commands,
    ...(options.saveSelectionAsObjectStamp ? { saveSelectionAsObjectStamp: options.saveSelectionAsObjectStamp } : {}),
    placePlantsAt: vi.fn(),
    ...(options.turnViewToEdge ? { turnViewToEdge: options.turnViewToEdge } : {}),
    ...(options.finishShape ? { finishShape: options.finishShape } : {}),
    ...(options.pointActions ? { pointActions: options.pointActions } : {}),
    ...(options.held ? { holdsSelectionDeletes: true as const } : {}),
    returnFocus: options.returnFocus ?? vi.fn(),
  }
  const entries = buildCanvasContextMenuEntries(request, {
    translate: t,
    characterKeyShortcuts: options.characterKeyShortcuts ?? true,
    openPlantAppearance,
    summary: options.summary === undefined ? (model ? APPLE_SUMMARY : null) : options.summary,
    openSpeciesDetail,
    addToCalendar, setUnitCost,
    readOnly: false,
    ...(options.profileLine ? { profileLine: options.profileLine } : {}),
  })
  return { entries, commands, openPlantAppearance, openSpeciesDetail, addToCalendar, setUnitCost, request }
}

function ids(entries: readonly CanvasContextMenuEntry[]): string[] {
  return entries.map((entry) => 'separator' in entry ? '—' : entry.id)
}

/** Every command, submenus included, in menu order. */
function commandsOf(entries: readonly CanvasContextMenuEntry[]): CanvasContextMenuCommand[] {
  return entries.flatMap((entry) => 'submenu' in entry ? commandsOf(entry.submenu) : 'run' in entry ? [entry] : [])
}

function item(entries: readonly CanvasContextMenuEntry[], id: CanvasContextMenuItemId): CanvasContextMenuCommand {
  const found = commandsOf(entries).find((entry) => entry.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}

function arrange(entries: readonly CanvasContextMenuEntry[]): CanvasContextMenuSubmenu {
  const found = entries.find((entry): entry is CanvasContextMenuSubmenu => 'submenu' in entry && entry.id === 'arrange')
  if (!found) throw new Error('missing Arrange')
  return found
}

describe('canvas context menu entries', () => {
  it('lists plant commands in plain words, grouped, with Delete last and in red', () => {
    const { entries } = build(TWO_APPLES, { saveSelectionAsObjectStamp: vi.fn() })

    // Stacking and grouping share Arrange ▸, so the plant menu fits a 800 px window.
    expect(ids(entries)).toEqual([
      'cut', 'copy', 'paste', 'duplicate', '—',
      'select-same-species', 'plant-color', 'plant-symbol', 'toggle-plant-names', 'species-details', '—',
      'add-to-calendar', 'set-unit-cost', '—',
      'arrange', 'rotate', 'save-as-stamp', '—',
      'lock', 'unlock', '—',
      'delete',
    ])
    expect(ids(arrange(entries).submenu)).toEqual(['bring-to-front', 'send-to-back', '—', 'group', 'ungroup'])
    const labels = entries.flatMap((entry) => 'label' in entry ? [entry.label] : [])
    expect(labels).toEqual([
      'Cut', 'Copy', 'Paste', 'Duplicate',
      'Select all of this species', 'Plant color', 'Plant symbol', 'Show name', 'Species details',
      'Add to calendar…', 'Set unit cost…',
      'Arrange', 'Rotate…', 'Save as stamp',
      'Lock', 'Unlock',
      'Delete',
    ])
    expect(commandsOf(arrange(entries).submenu).map((entry) => entry.label))
      .toEqual(['Bring to front', 'Send to back', 'Group', 'Ungroup'])
    expect(arrange(entries).disabled).toBe(false)
    expect(item(entries, 'delete').danger).toBe(true)
    expect(entries.filter((entry) => 'danger' in entry && entry.danger)).toHaveLength(1)
    expect(item(entries, 'plant-color').opensDialog).toBe(true)
    expect(item(entries, 'plant-symbol').opensDialog).toBe(true)
    // Rotate… opens a modal dialog, not a popover beside the menu: its ellipsis says so, no chevron.
    expect(item(entries, 'rotate').opensDialog).toBeUndefined()
  })

  it('shows the menu-bar shortcuts beside each command', () => {
    const { entries } = build(TWO_APPLES)

    expect(item(entries, 'cut').shortcut).toBe('Ctrl X')
    expect(item(entries, 'copy').shortcut).toBe('Ctrl C')
    expect(item(entries, 'paste').shortcut).toBe('Ctrl V')
    expect(item(entries, 'duplicate').shortcut).toBe('Ctrl D')
    expect(item(entries, 'select-same-species').shortcut).toBe('Ctrl Shift A')
    expect(item(entries, 'bring-to-front').shortcut).toBe(']')
    expect(item(entries, 'group').shortcut).toBe('Ctrl G')
    expect(item(entries, 'rotate').shortcut).toBe('Ctrl Alt R')
    expect(item(entries, 'lock').shortcut).toBe('Ctrl Shift L')
    expect(item(entries, 'lock').keyShortcuts).toBe('Control+Shift+L Meta+Shift+L')
    expect(item(entries, 'delete').shortcut).toBe('Del')
    expect(item(entries, 'delete').keyShortcuts).toBe('Delete Backspace')
    expect(item(entries, 'copy').keyShortcuts).toBe('Control+C Meta+C')
  })

  it('hides single-key shortcuts that Settings › Keyboard turned off', () => {
    const { entries } = build(TWO_APPLES, { characterKeyShortcuts: false })

    expect(item(entries, 'bring-to-front').shortcut).toBeUndefined()
    expect(item(entries, 'bring-to-front').keyShortcuts).toBeUndefined()
    expect(item(entries, 'send-to-back').shortcut).toBeUndefined()
    expect(item(entries, 'copy').shortcut).toBe('Ctrl C')
    expect(item(entries, 'delete').shortcut).toBe('Del')
  })

  it('leaves plant commands out for zones', () => {
    const { entries } = build(ONE_ZONE)

    expect(ids(entries)).not.toContain('select-same-species')
    expect(ids(entries)).not.toContain('plant-color')
    expect(ids(entries)).not.toContain('plant-symbol')
    expect(ids(entries)).not.toContain('toggle-plant-names')
    expect(ids(entries)).not.toContain('save-as-stamp')
    expect(item(entries, 'duplicate').disabled).toBe(false)
    expect(item(entries, 'group').disabled).toBe(true)
    expect(item(entries, 'ungroup').disabled).toBe(true)
    expect(item(entries, 'unlock').disabled).toBe(true)
  })

  it('keeps plant commands for a mixed selection, disabling Select all of this species', () => {
    const { entries } = build(PLANT_AND_ZONE)

    expect(item(entries, 'select-same-species').disabled).toBe(true)
    expect(item(entries, 'plant-color').disabled).toBe(false)
    expect(item(entries, 'plant-symbol').disabled).toBe(false)
    expect(item(entries, 'toggle-plant-names').label).toBe('Hide name')
    expect(item(entries, 'group').disabled).toBe(false)
  })

  it('offers Place plants here, Paste and Select all on the empty map', () => {
    const { entries, commands, request } = build(null)

    expect(ids(entries)).toEqual(['place-plants-here', '—', 'paste', 'select-all'])
    expect(item(entries, 'place-plants-here').label).toBe('Place plants here')
    item(entries, 'place-plants-here').run()
    expect(request.placePlantsAt).toHaveBeenCalledWith({ x: 12, y: 34 })
    item(entries, 'paste').run()
    item(entries, 'select-all').run()
    expect(commands.pasteAt).toHaveBeenCalledWith({ x: 12, y: 34 })
    expect(commands.selectAll).toHaveBeenCalledOnce()
    expect(item(build(null, { commands: createCommands({ canPaste: () => false }) }).entries, 'paste').disabled)
      .toBe(true)
  })

  it('the entry is the empty-map menu\'s first group and sits before Lock in the selection menu', () => {
    const turnViewToEdge = vi.fn()

    const empty = build(null, { turnViewToEdge }).entries
    expect(ids(empty)).toEqual(['turn-view-to-edge', '—', 'place-plants-here', '—', 'paste', 'select-all'])
    expect(item(empty, 'turn-view-to-edge')).toMatchObject({ label: 'Turn view to this edge', disabled: false })
    expect(item(empty, 'turn-view-to-edge').shortcut).toBeUndefined()
    item(empty, 'turn-view-to-edge').run()
    expect(turnViewToEdge).toHaveBeenCalledOnce()

    // Its own group before Lock and Unlock, enabled for a locked zone too: it moves only the view.
    const locked = build(selection({ lockedTargets: [{ kind: 'zone', id: 'zone-1' }] }), { turnViewToEdge }).entries
    expect(ids(locked).slice(-7)).toEqual(['—', 'turn-view-to-edge', '—', 'lock', 'unlock', '—', 'delete'])
    expect(item(locked, 'turn-view-to-edge').disabled).toBe(false)
    expect(item(locked, 'lock').disabled).toBe(true)

    // Without an edge under the pointer, neither menu offers it.
    expect(ids(build(null).entries)).not.toContain('turn-view-to-edge')
    expect(ids(build(ONE_ZONE).entries)).not.toContain('turn-view-to-edge')
  })

  it('Finish shape is the first entry of a polygon draft\'s menu, on the empty map and over a selection', () => {
    const finishShape = vi.fn()

    const empty = build(null, { finishShape, turnViewToEdge: vi.fn() }).entries
    expect(ids(empty).slice(0, 4)).toEqual(['finish-shape', '—', 'turn-view-to-edge', '—'])
    expect(item(empty, 'finish-shape')).toMatchObject({ label: 'Finish shape', disabled: false })
    item(empty, 'finish-shape').run()
    expect(finishShape).toHaveBeenCalledOnce()

    expect(ids(build(ONE_ZONE, { finishShape }).entries).slice(0, 2)).toEqual(['finish-shape', '—'])
    expect(ids(build(null).entries)).not.toContain('finish-shape')
  })

  it('a point menu is its point entries only, after Finish shape while drafting; a refused entry does nothing (A16)', () => {
    const remove = vi.fn()
    const sharpen = vi.fn()
    const corner = build(null, { pointActions: [{ action: 'delete-point', disabled: false, run: remove }], turnViewToEdge: vi.fn() }).entries
    expect(ids(corner)).toEqual(['delete-point'])
    expect(item(corner, 'delete-point')).toMatchObject({ label: 'Delete point', disabled: false })
    item(corner, 'delete-point').run()
    expect(remove).toHaveBeenCalledOnce()

    const finishShape = vi.fn()
    const rowPoint = build(TWO_APPLES, {
      finishShape,
      pointActions: [{ action: 'delete-point', disabled: true, run: remove }, { action: 'sharp-corner', disabled: false, run: sharpen }],
    }).entries
    expect(ids(rowPoint)).toEqual(['finish-shape', '—', 'delete-point', 'sharp-corner'])
    expect(item(rowPoint, 'sharp-corner')).toMatchObject({ label: 'Sharp corner', disabled: false })
    item(rowPoint, 'delete-point').run()
    expect(remove).toHaveBeenCalledOnce()
    item(rowPoint, 'sharp-corner').run()
    expect(sharpen).toHaveBeenCalledOnce()

    const smooth = build(null, { pointActions: [{ action: 'smooth-corner', disabled: false, run: vi.fn() }] }).entries
    expect(item(smooth, 'smooth-corner').label).toBe('Smooth corner')
  })

  it('keeps inapplicable commands visible but disabled, and running them does nothing', () => {
    const locked = selection({
      lockedTargets: [{ kind: 'plant', id: 'locked-apple' }],
      blockedTargets: [{
        target: { kind: 'plant', id: 'locked-apple' },
        reason: 'locked-design-object',
      }],
      plantNamePinning: { plantIds: [], allPinned: false },
    })
    const commands = createCommands({ canPaste: () => false })
    const { entries } = build(locked, { commands, saveSelectionAsObjectStamp: vi.fn() })

    const enabled = entries.flatMap((entry) => 'id' in entry && !entry.disabled ? [entry.id] : [])
    // Species details and the Budget price read or plan, never move the locked plant.
    expect(enabled).toEqual(['species-details', 'set-unit-cost', 'save-as-stamp', 'unlock'])
    // Arrange ▸ stays listed, disabled, while nothing in it applies.
    expect(arrange(entries).disabled).toBe(true)
    for (const entry of commandsOf(entries)) {
      if (entry.disabled) entry.run()
    }
    for (const command of Object.values(commands)) {
      if (command !== commands.canPaste) expect(command).not.toHaveBeenCalled()
    }
  })

  it('runs each command on the request’s scene-edit surface', () => {
    const save = vi.fn()
    const commands = createCommands()
    const withGroups = selection({
      editableTargets: [{ kind: 'group', id: 'group-1' }, { kind: 'plant', id: 'apple-1' }],
      sameSpeciesReferenceCanonicalName: 'Malus domestica',
      plantNamePinning: { plantIds: ['apple-1'], allPinned: false },
    })
    const { entries } = build(withGroups, { commands, saveSelectionAsObjectStamp: save })
    const run = (id: CanvasContextMenuItemId) => item(entries, id).run()

    run('copy')
    expect(commands.copy).toHaveBeenCalledOnce()
    run('cut')
    expect(commands.copy).toHaveBeenCalledTimes(2)
    expect(commands.deleteSelected).toHaveBeenCalledOnce()
    run('paste')
    expect(commands.pasteAt).toHaveBeenCalledWith({ x: 12, y: 34 })
    run('duplicate')
    expect(commands.duplicateSelected).toHaveBeenCalledOnce()
    run('select-same-species')
    expect(commands.selectSameSpecies).toHaveBeenCalledOnce()
    run('toggle-plant-names')
    expect(commands.toggleSelectedPlantNamePins).toHaveBeenCalledOnce()
    run('bring-to-front')
    expect(commands.bringToFront).toHaveBeenCalledOnce()
    run('send-to-back')
    expect(commands.sendToBack).toHaveBeenCalledOnce()
    run('group')
    expect(commands.groupSelected).toHaveBeenCalledOnce()
    run('ungroup')
    expect(commands.ungroupSelected).toHaveBeenCalledOnce()
    run('save-as-stamp')
    expect(save).toHaveBeenCalledOnce()
    run('lock')
    expect(commands.lockSelected).toHaveBeenCalledOnce()
    run('delete')
    expect(commands.deleteSelected).toHaveBeenCalledTimes(2)
  })

  it('opens the species detail, the Calendar editor and the Budget price for the selection’s one species', () => {
    const { entries, openSpeciesDetail, addToCalendar, setUnitCost } = build(TWO_APPLES)

    item(entries, 'species-details').run()
    item(entries, 'add-to-calendar').run()
    item(entries, 'set-unit-cost').run()

    expect(openSpeciesDetail).toHaveBeenCalledWith('Malus domestica')
    expect(addToCalendar).toHaveBeenCalledWith({ kind: 'selected-plants' })
    expect(setUnitCost).toHaveBeenCalledWith('Malus domestica')
    expect(item(entries, 'add-to-calendar').opensDialog).toBeUndefined()
  })

  it('keeps Species details and Set unit cost… for one species only, and aims Add to calendar… at a lone zone', () => {
    const mixed = build(TWO_APPLES, {
      summary: { ...APPLE_SUMMARY, species: [...APPLE_SUMMARY.species, { canonicalName: 'Pyrus communis', name: 'Pear', englishFallback: false, selectedCount: 1, designCount: 1 }] },
    })
    expect(item(mixed.entries, 'species-details').disabled).toBe(true)
    expect(item(mixed.entries, 'set-unit-cost').disabled).toBe(true)
    item(mixed.entries, 'species-details').run()
    expect(mixed.openSpeciesDetail).not.toHaveBeenCalled()

    const zone = build(ONE_ZONE, { summary: null })
    expect(ids(zone.entries)).not.toContain('set-unit-cost')
    expect(ids(zone.entries)).not.toContain('species-details')
    item(zone.entries, 'add-to-calendar').run()
    expect(zone.addToCalendar).toHaveBeenCalledWith({ kind: 'zone', zoneId: 'zone-1' })

    const twoZones = build(selection({ editableTargets: [{ kind: 'zone', id: 'a' }, { kind: 'zone', id: 'b' }] }), { summary: null })
    expect(item(twoZones.entries, 'add-to-calendar').disabled).toBe(true)
  })

  it('offers Rename zone… for a lone zone and renames it by id on the request’s surface', () => {
    const returnFocus = vi.fn()
    const summary: MapSelectionSummary = {
      ...APPLE_SUMMARY, plantCount: 0, species: [], plantSpacingM: null,
      zones: [{ name: 'North bed', zoneType: 'rect', areaM2: 12, perimeterM: 14 }],
    }
    const { entries, commands } = build(ONE_ZONE, { returnFocus, summary })

    expect(ids(entries).slice(0, 7)).toEqual(['cut', 'copy', 'paste', 'duplicate', '—', 'rename-zone', '—'])
    expect(item(entries, 'rename-zone').label).toBe('Rename zone…')
    // A modal dialog, like Rotate…: an ellipsis, no popover chevron.
    expect(item(entries, 'rename-zone').opensDialog).toBeUndefined()
    item(entries, 'rename-zone').run()
    expect(renameZoneDialog.value).toMatchObject({ zoneId: 'zone-1', name: 'North bed' })
    applyRenameZone('  Kitchen bed  ')

    expect(commands.renameZone).toHaveBeenCalledWith('zone-1', 'Kitchen bed')
    expect(returnFocus).toHaveBeenCalledOnce()
    expect(renameZoneDialog.value).toBeNull()
  })

  it('clears a zone’s name from an empty field, and leaves Cancel without an edit', () => {
    const { entries, commands } = build(ONE_ZONE, { summary: null })

    item(entries, 'rename-zone').run()
    expect(renameZoneDialog.value?.name).toBeNull()
    closeRenameZoneDialog()
    expect(commands.renameZone).not.toHaveBeenCalled()

    item(entries, 'rename-zone').run()
    applyRenameZone('   ')
    expect(commands.renameZone).toHaveBeenCalledWith('zone-1', null)
  })

  it('keeps Rename zone… for a lone zone only, disabled while it is locked', () => {
    expect(ids(build(TWO_APPLES).entries)).not.toContain('rename-zone')
    expect(ids(build(PLANT_AND_ZONE).entries)).not.toContain('rename-zone')
    expect(ids(build(selection({ editableTargets: [{ kind: 'zone', id: 'a' }, { kind: 'zone', id: 'b' }] })).entries))
      .not.toContain('rename-zone')

    const locked = build(selection({
      lockedTargets: [{ kind: 'zone', id: 'zone-1' }],
      blockedTargets: [{ target: { kind: 'zone', id: 'zone-1' }, reason: 'locked-design-object' }],
    })).entries
    expect(item(locked, 'rename-zone').disabled).toBe(true)
    item(locked, 'rename-zone').run()
    expect(renameZoneDialog.value).toBeNull()
  })

  it('asks for an angle with Rotate… and turns the selection on the request’s surface', () => {
    const returnFocus = vi.fn()
    const { entries, commands } = build(ONE_ZONE, { returnFocus })

    item(entries, 'rotate').run()
    expect(rotateSelectionDialog.value).not.toBeNull()
    expect(applyRotateSelection('45')).toBe(true)

    expect(commands.rotateSelected).toHaveBeenCalledWith(45)
    expect(returnFocus).toHaveBeenCalledOnce()
    expect(rotateSelectionDialog.value).toBeNull()
  })

  it('keeps Rotate… disabled for a lone plant and for a selection with a locked object', () => {
    const lonePlant = build(selection({ editableTargets: [{ kind: 'plant', id: 'apple-1' }] })).entries
    expect(item(lonePlant, 'rotate').disabled).toBe(true)
    const withLocked = build(selection({
      editableTargets: [{ kind: 'zone', id: 'zone-1' }],
      lockedTargets: [{ kind: 'plant', id: 'locked-apple' }],
      blockedTargets: [{ target: { kind: 'plant', id: 'locked-apple' }, reason: 'locked-design-object' }],
    })).entries
    item(withLocked, 'rotate').run()
    expect(item(withLocked, 'rotate').disabled).toBe(true)
    expect(rotateSelectionDialog.value).toBeNull()
  })

  it('opens the plant color and symbol popovers beside the item, returning focus to the map', () => {
    const openPlantAppearance = vi.fn<CanvasContextMenuEntryOptions['openPlantAppearance']>()
    const returnFocus = vi.fn()
    const { entries } = build(TWO_APPLES, { openPlantAppearance, returnFocus })

    item(entries, 'plant-color').run({ left: 400, top: 250, right: 600, bottom: 280 } as DOMRect)
    expect(openPlantAppearance).toHaveBeenCalledWith('color', expect.anything())
    const anchor = openPlantAppearance.mock.calls[0]![1]
    expect(anchor.getBoundingClientRect()).toEqual({ top: 250, right: 600 })
    anchor.focus()
    expect(returnFocus).toHaveBeenCalledOnce()

    item(entries, 'plant-symbol').run()
    expect(openPlantAppearance).toHaveBeenLastCalledWith('symbol', expect.anything())
    expect(openPlantAppearance.mock.calls[1]![1].getBoundingClientRect()).toEqual({ top: 200, right: 300 })
  })

  it('disables Group for measurement guides and blocked selections, and offers Ungroup only for groups', () => {
    const guide = build(selection({
      editableTargets: [{ kind: 'plant', id: 'p' }, { kind: 'measurement-guide', id: 'g' }],
    })).entries
    expect(item(guide, 'group').disabled).toBe(true)

    const blocked = build(selection({
      editableTargets: [{ kind: 'group', id: 'group-1' }, { kind: 'plant', id: 'p' }],
      blockedTargets: [{ target: { kind: 'plant', id: 'missing' }, reason: 'structural' }],
    })).entries
    expect(item(blocked, 'group').disabled).toBe(true)
    expect(item(blocked, 'ungroup').disabled).toBe(true)

    const group = build(selection({ editableTargets: [{ kind: 'group', id: 'group-1' }] })).entries
    expect(item(group, 'group').disabled).toBe(true)
    expect(item(group, 'ungroup').disabled).toBe(false)
  })
  it('greys exactly what the menu bar greys, Paste the one difference, during a draft too (S3b)', () => {
    const lockedApple = selection({
      editableTargets: [{ kind: 'zone', id: 'zone-1' }],
      lockedTargets: [{ kind: 'plant', id: 'locked-apple' }],
      blockedTargets: [{ target: { kind: 'plant', id: 'locked-apple' }, reason: 'locked-design-object' }],
      plantNamePinning: { plantIds: [], allPinned: false },
    })
    const cases = [
      { model: TWO_APPLES, held: false },
      { model: TWO_APPLES, held: true },
      { model: ONE_ZONE, held: true },
      { model: PLANT_AND_ZONE, held: false },
      { model: lockedApple, held: false },
    ]
    for (const { model, held } of cases) {
      const menu = commandsOf(build(model, {
        held,
        commands: createCommands({ canPaste: () => false }),
        saveSelectionAsObjectStamp: vi.fn(),
      }).entries)
      const menuBar = createCanvasCommandProjection({
        state: {
          activeTool: 'polygon',
          canvasAvailable: true,
          spatialEditingAvailable: true, readOnly: false,
          selection: selectionCommandAvailability(model),
          held,
          lockedObjectsPresent: false,
          canUndo: false,
          canRedo: false,
          gridVisible: false,
          snapToGridEnabled: false,
        },
        run: vi.fn(),
        translate: t,
        characterKeys: true,
      }).editActions
      const greyed = (id: string) => menuBar.find((command) => command.id === id)?.disabled
      const shared = menu.filter((command) => command.id !== 'paste' && menuBar.some((edit) => edit.id === command.id))
      expect(shared.map((command) => [command.id, command.disabled]))
        .toEqual(shared.map((command) => [command.id, greyed(command.id)]))
      // The canvas menu follows the clipboard; the menu bar keeps Paste enabled as a no-op (U54 Q5).
      expect([item(build(model).entries, 'paste').disabled, greyed('paste')]).toEqual([false, false])
      expect(item(menu, 'paste').disabled).toBe(true)
    }
    expect(item(build(TWO_APPLES, { held: true }).entries, 'cut').disabled).toBe(true)
    expect(item(build(TWO_APPLES, { held: true }).entries, 'copy').disabled).toBe(false)
  })

  describe('Profile this line (Desktop, U49 Q29)', () => {
    const LINE_SUMMARY: MapSelectionSummary = {
      ...APPLE_SUMMARY, plantCount: 0, species: [], plantSpacingM: null,
      zones: [{ name: null, zoneType: 'line', areaM2: null, perimeterM: 46 }],
    }
    const GUIDE_SUMMARY: MapSelectionSummary = {
      ...APPLE_SUMMARY, plantCount: 0, species: [], plantSpacingM: null, measurementCount: 1, measurementLengthM: 12,
    }
    const profiler = (available = true) => ({ available, profile: vi.fn() })

    it('a Line zone\'s menu offers it after Rename zone…, and running it profiles that zone', () => {
      const profileLine = profiler()
      const { entries } = build(ONE_ZONE, { summary: LINE_SUMMARY, profileLine })

      expect(ids(entries).slice(5, 9)).toEqual(['rename-zone', '—', 'profile-line', '—'])
      expect(item(entries, 'profile-line').label).toBe('Profile this line')
      expect(item(entries, 'profile-line').disabled).toBe(false)
      item(entries, 'profile-line').run()
      expect(profileLine.profile).toHaveBeenCalledWith({ kind: 'zone', id: 'zone-1' })
    })

    it('a Measure guide\'s menu offers it, a locked one too, since a profile edits nothing', () => {
      const profileLine = profiler()
      const guide = selection({ editableTargets: [{ kind: 'measurement-guide', id: 'guide-1' }] })
      item(build(guide, { summary: GUIDE_SUMMARY, profileLine }).entries, 'profile-line').run()
      expect(profileLine.profile).toHaveBeenCalledWith({ kind: 'measurement-guide', id: 'guide-1' })

      const locked = selection({
        lockedTargets: [{ kind: 'zone', id: 'zone-1' }],
        blockedTargets: [{ target: { kind: 'zone', id: 'zone-1' }, reason: 'locked-design-object' }],
      })
      expect(item(build(locked, { summary: LINE_SUMMARY, profileLine }).entries, 'profile-line').disabled).toBe(false)
    })

    it('is disabled like the Profile button while no elevation or height layer is shown', () => {
      const profileLine = profiler(false)
      const { entries } = build(ONE_ZONE, { summary: LINE_SUMMARY, profileLine })

      expect(item(entries, 'profile-line').disabled).toBe(true)
      item(entries, 'profile-line').run()
      expect(profileLine.profile).not.toHaveBeenCalled()
    })

    it('only a lone Line zone or Measure guide offers it, and only where Site data exists', () => {
      const profileLine = profiler()
      const rectangle = { ...LINE_SUMMARY, zones: [{ name: null, zoneType: 'rect', areaM2: 12, perimeterM: 14 }] }
      const twoGuides = selection({ editableTargets: [{ kind: 'measurement-guide', id: 'a' }, { kind: 'measurement-guide', id: 'b' }] })
      expect(ids(build(ONE_ZONE, { summary: rectangle, profileLine }).entries)).not.toContain('profile-line')
      expect(ids(build(TWO_APPLES, { profileLine }).entries)).not.toContain('profile-line')
      expect(ids(build(twoGuides, { summary: GUIDE_SUMMARY, profileLine }).entries)).not.toContain('profile-line')
      expect(ids(build(null, { profileLine }).entries)).not.toContain('profile-line')
      expect(ids(build(ONE_ZONE, { summary: LINE_SUMMARY }).entries)).not.toContain('profile-line')
    })
  })
})
