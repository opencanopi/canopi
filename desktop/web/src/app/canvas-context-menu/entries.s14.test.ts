import { describe, expect, it, vi } from 'vitest'
import {
  buildCanvasContextMenuEntries,
  type CanvasContextMenuCommand,
  type CanvasContextMenuEntry,
  type CanvasContextMenuItemId,
  type CanvasContextMenuSubmenu,
} from './entries'
import type {
  CanvasContextMenuCommands,
  CanvasContextMenuRequest,
} from '../../canvas/runtime/app-adapter'
import type { CanvasDesignObjectSelectionModel } from '../../canvas/runtime/runtime'
import type { MapSelectionSummary } from '../map-selection/summary'
import { capabilitiesForEdition, type EditionCapabilityId } from '../../generated/edition-capabilities'
import { t } from '../../i18n'

const DESKTOP_CAPS: readonly EditionCapabilityId[] = [...capabilitiesForEdition('desktop', 'linux')]
const WEB_CAPS: readonly EditionCapabilityId[] = [...capabilitiesForEdition('web', 'linux')]

function stubCommands(): CanvasContextMenuCommands {
  const fn = () => vi.fn()
  const ok = () => vi.fn(() => true)
  return {
    bringToFront: fn(), canPaste: ok(), copy: fn(), deleteSelected: fn(),
    duplicateSelected: fn(), groupSelected: fn(), lockSelected: fn(), pasteAt: fn(),
    renameZone: ok(), rotateSelected: fn(), selectAll: fn(), selectSameSpecies: fn(),
    sendToBack: fn(), toggleSelectedPlantNamePins: fn(), ungroupSelected: fn(), unlockSelected: fn(),
  }
}

function makeSelection(
  editableTargets: CanvasDesignObjectSelectionModel['editableTargets'],
  sameSpecies: string | null = null,
  pinIds: readonly string[] = [],
): CanvasDesignObjectSelectionModel {
  return {
    editableTargets,
    lockedTargets: [],
    blockedTargets: [],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    sameSpeciesReferenceCanonicalName: sameSpecies,
    plantNamePinning: { plantIds: [...pinIds], allPinned: false },
  }
}

const TWO_APPLES = makeSelection(
  [{ kind: 'plant', id: 'apple-1' }, { kind: 'plant', id: 'apple-2' }],
  'Malus domestica',
  ['apple-1', 'apple-2'],
)
const ONE_LINE_ZONE = makeSelection([{ kind: 'zone', id: 'line-1' }])

const BASE_SUMMARY: MapSelectionSummary = {
  plantCount: 0, species: [], plantSpacingM: null, zones: [],
  noteCount: 0, noteText: null, measurementCount: 0, measurementLengthM: null,
}
const APPLE_SUMMARY: MapSelectionSummary = {
  ...BASE_SUMMARY,
  plantCount: 2,
  plantSpacingM: 1.5,
  species: [{ canonicalName: 'Malus domestica', name: 'Apple', englishFallback: false, selectedCount: 2, designCount: 5 }],
}
const LINE_SUMMARY: MapSelectionSummary = {
  ...BASE_SUMMARY,
  zones: [{ name: 'Swale', zoneType: 'line', areaM2: null, perimeterM: 42 }],
}

function commandsOf(entries: readonly CanvasContextMenuEntry[]): CanvasContextMenuCommand[] {
  return entries.flatMap((entry) => 'submenu' in entry ? commandsOf(entry.submenu) : 'run' in entry ? [entry] : [])
}

function findItem(entries: readonly CanvasContextMenuEntry[], id: CanvasContextMenuItemId): CanvasContextMenuCommand | undefined {
  return commandsOf(entries).find((entry) => entry.id === id)
}

function findArrange(entries: readonly CanvasContextMenuEntry[]): CanvasContextMenuSubmenu {
  const found = entries.find((entry): entry is CanvasContextMenuSubmenu => 'submenu' in entry && entry.id === 'arrange')
  if (!found) throw new Error('missing Arrange submenu')
  return found
}

function buildMenu(opts: {
  readonly selection: CanvasDesignObjectSelectionModel | null
  readonly summary: MapSelectionSummary | null
  readonly capabilities: readonly EditionCapabilityId[]
  readonly readOnly?: boolean
  readonly holdsSelectionDeletes?: true
  readonly saveSelectionAsObjectStamp?: () => void
  readonly profileLine?: { readonly available: boolean; profile: (target: { readonly kind: 'zone' | 'measurement-guide'; readonly id: string }) => void }
  readonly turnViewToEdge?: () => void
}) {
  const commands = stubCommands()
  const request: CanvasContextMenuRequest = {
    anchor: { left: 100, top: 100, right: 100, bottom: 100 },
    world: { x: 1, y: 2 },
    selection: opts.selection,
    commands,
    placePlantsAt: vi.fn(),
    returnFocus: vi.fn(),
    ...(opts.saveSelectionAsObjectStamp ? { saveSelectionAsObjectStamp: opts.saveSelectionAsObjectStamp } : {}),
    ...(opts.holdsSelectionDeletes ? { holdsSelectionDeletes: true as const } : {}),
    ...(opts.turnViewToEdge ? { turnViewToEdge: opts.turnViewToEdge } : {}),
  }
  const entries = buildCanvasContextMenuEntries(request, {
    translate: t,
    characterKeyShortcuts: true,
    openPlantAppearance: vi.fn(),
    summary: opts.summary,
    openSpeciesDetail: vi.fn(),
    addToCalendar: vi.fn(),
    setUnitCost: vi.fn(),
    readOnly: opts.readOnly ?? false,
    capabilities: opts.capabilities,
    ...(opts.profileLine ? { profileLine: opts.profileLine } : {}),
  })
  return { entries, commands }
}

describe('S14 context menu projection from command-table applicability', () => {
  it('drops entries lacking an edition capability on Web even when callbacks are supplied, and keeps them on Desktop', () => {
    const saveStamp = vi.fn()
    const profile = vi.fn()

    const desktopPlant = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: DESKTOP_CAPS,
      saveSelectionAsObjectStamp: saveStamp,
    })
    const webPlant = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: WEB_CAPS,
      saveSelectionAsObjectStamp: saveStamp,
    })

    // saved-stamps capability gates save-as-stamp
    expect(findItem(desktopPlant.entries, 'save-as-stamp')).toMatchObject({ disabled: false })
    findItem(desktopPlant.entries, 'save-as-stamp')!.run()
    expect(saveStamp).toHaveBeenCalledOnce()
    expect(findItem(webPlant.entries, 'save-as-stamp')).toBeUndefined()

    const desktopLine = buildMenu({
      selection: ONE_LINE_ZONE,
      summary: LINE_SUMMARY,
      capabilities: DESKTOP_CAPS,
      profileLine: { available: true, profile },
    })
    const webLine = buildMenu({
      selection: ONE_LINE_ZONE,
      summary: LINE_SUMMARY,
      capabilities: WEB_CAPS,
      profileLine: { available: true, profile },
    })

    // site-data-below-limit capability gates profile-line
    expect(findItem(desktopLine.entries, 'profile-line')).toMatchObject({ disabled: false })
    findItem(desktopLine.entries, 'profile-line')!.run()
    expect(profile).toHaveBeenCalledWith({ kind: 'zone', id: 'line-1' })
    expect(findItem(webLine.entries, 'profile-line')).toBeUndefined()
  })

  it('drops hidden entries (context-absent items)', () => {
    const { entries } = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: DESKTOP_CAPS,
    })

    expect(findItem(entries, 'finish-shape')).toBeUndefined()
    expect(findItem(entries, 'turn-view-to-edge')).toBeUndefined()
    expect(findItem(entries, 'rename-zone')).toBeUndefined()
    expect(findItem(entries, 'profile-line')).toBeUndefined()
    expect(findItem(entries, 'save-as-stamp')).toBeUndefined()
  })

  it('disables Cut and Delete when holdsSelectionDeletes is true while keeping Copy enabled', () => {
    const { entries, commands } = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: DESKTOP_CAPS,
      holdsSelectionDeletes: true,
    })

    expect(findItem(entries, 'cut')).toMatchObject({ disabled: true })
    expect(findItem(entries, 'delete')).toMatchObject({ disabled: true })
    expect(findItem(entries, 'copy')).toMatchObject({ disabled: false })

    findItem(entries, 'cut')!.run()
    findItem(entries, 'delete')!.run()
    expect(commands.deleteSelected).not.toHaveBeenCalled()

    findItem(entries, 'copy')!.run()
    expect(commands.copy).toHaveBeenCalledOnce()
  })

  it('disables mutating entries in readOnly mode while keeping read-only entries enabled', () => {
    const saveStamp = vi.fn()
    const profile = vi.fn()
    const turnViewToEdge = vi.fn()

    const plantMenu = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: DESKTOP_CAPS,
      readOnly: true,
      saveSelectionAsObjectStamp: saveStamp,
      turnViewToEdge,
    })

    // Mutating entries are present but disabled and inert
    for (const id of [
      'cut', 'paste', 'duplicate', 'delete', 'lock', 'unlock', 'rotate', 'save-as-stamp',
      'bring-to-front', 'send-to-back', 'group', 'ungroup',
      'plant-color', 'plant-symbol', 'toggle-plant-names', 'add-to-calendar', 'set-unit-cost',
    ] as const) {
      const entry = findItem(plantMenu.entries, id)
      expect(entry, id).toBeDefined()
      expect(entry!.disabled, id).toBe(true)
      entry!.run()
    }
    expect(findArrange(plantMenu.entries).disabled).toBe(true)
    expect(saveStamp).not.toHaveBeenCalled()
    expect(plantMenu.commands.deleteSelected).not.toHaveBeenCalled()

    // Read-only entries stay enabled
    for (const id of ['copy', 'select-same-species', 'species-details', 'turn-view-to-edge'] as const) {
      expect(findItem(plantMenu.entries, id), id).toMatchObject({ disabled: false })
    }
    findItem(plantMenu.entries, 'turn-view-to-edge')!.run()
    expect(turnViewToEdge).toHaveBeenCalledOnce()

    // Profile this line stays enabled in readOnly mode on Desktop
    const lineMenu = buildMenu({
      selection: ONE_LINE_ZONE,
      summary: LINE_SUMMARY,
      capabilities: DESKTOP_CAPS,
      readOnly: true,
      profileLine: { available: true, profile },
    })
    expect(findItem(lineMenu.entries, 'profile-line')).toMatchObject({ disabled: false })
    expect(findItem(lineMenu.entries, 'rename-zone')).toMatchObject({ disabled: true })

    // Empty map in readOnly mode: Select all stays enabled, Paste and Place plants here are disabled
    const emptyMenu = buildMenu({
      selection: null,
      summary: null,
      capabilities: DESKTOP_CAPS,
      readOnly: true,
    })
    expect(findItem(emptyMenu.entries, 'select-all')).toMatchObject({ disabled: false })
    expect(findItem(emptyMenu.entries, 'paste')).toMatchObject({ disabled: true })
    expect(findItem(emptyMenu.entries, 'place-plants-here')).toMatchObject({ disabled: true })
  })

  it('keeps enabled entries active and invokes their commands', () => {
    const { entries, commands } = buildMenu({
      selection: TWO_APPLES,
      summary: APPLE_SUMMARY,
      capabilities: DESKTOP_CAPS,
    })

    expect(findItem(entries, 'duplicate')).toMatchObject({ disabled: false })
    findItem(entries, 'duplicate')!.run()
    expect(commands.duplicateSelected).toHaveBeenCalledOnce()
  })
})
