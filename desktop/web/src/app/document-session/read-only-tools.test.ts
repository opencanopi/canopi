// @vitest-environment jsdom

// The read-only Session kind arms only read tools (2.1-M478, design check F3; canopi-f47t.52.270): a Design a newer
// Canopi saved can be looked at with Select and Pan, and no drawing tool's key arms one over it. Failure state "an edit
// tool reachable by shortcut", through the real Desktop key router and armCanvasTool. The one canvas command projection
// greys the drawing tools, Undo, Redo and the edits that change an object, so the rail, menus and palette follow it.
// The right-click menu greys every entry that changes the Design or arms an edit tool ("an edit tool reachable by
// right-click menu").
// Both editions' command catalogs offer Close only (2.1-Q315): Rename, Save, Save as, Revert, the imports, the exports,
// Download a copy and the saved-view edits are off; Close and the panels stay.
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCatalogCommandDisabled, type AppCommandId } from '../../commands/graph/catalog'
import { createBrowserShellCatalog } from '../../web/browser-shell-commands'
import {
  createTestCanvasCommandSurface,
  createTestCanvasKeyboardPort,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { installDesktopKeys } from '../../__tests__/support/desktop-key-router'
import { setCurrentCanvasSession } from '../../canvas/session'
import { currentCanvasTool, setCanvasSelection } from '../../canvas/session-state'
import { dispatchWorkspaceCanvasIntent, workspaceCanvasCommandProjection } from '../workspace-commands/canvas-actions'
import { focusOwner } from '../keyboard/focus-owner'
import { singleKeyShortcuts } from '../settings/state'
import { activePanel } from '../shell/state'
import { createDesignSessionStoreTestFixture, designSessionStore, EDITING_DESIGN_SESSION } from './store'
import {
  buildCanvasContextMenuEntries,
  type CanvasContextMenuCommand,
  type CanvasContextMenuEntry,
} from '../canvas-context-menu/entries'
import { renameZoneDialog } from '../rename-zone/state'
import type { CanvasContextMenuCommands, CanvasContextMenuRequest } from '../../canvas/runtime/app-adapter'
import type { CanvasDesignObjectSelectionModel } from '../../canvas/runtime/runtime'
import { t } from '../../i18n'
import type { CanopiFile } from '../../types/design'

const fixture = createDesignSessionStoreTestFixture(designSessionStore)

const SHOWN: CanopiFile = {
  version: 9,
  name: 'Orchard 2.1',
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
  plants: [],
  zones: [],
  annotations: [],
  measurement_guides: [],
  groups: [],
  consortiums: [],
  timeline: [],
  budget: [],
  budget_currency: 'EUR',
  views: [],
  stories: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  extra: {},
}

let host: HTMLDivElement
let elsewhere: HTMLButtonElement
let setTool: ReturnType<typeof vi.fn<(name: string) => void>>
let releaseRegion: () => void

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  elsewhere = document.createElement('button')
  document.body.append(host, elsewhere)
  releaseRegion = focusOwner.registerRegion('map', host)
  setTool = vi.fn<(name: string) => void>()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({ tools: { setTool } }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
  activePanel.value = 'canvas'
  currentCanvasTool.value = 'select'
  singleKeyShortcuts.value = true
  designSessionStore.replaceCurrentDesignState(SHOWN, null, 'Orchard 2.1', {
    kind: 'read-only',
    origin: 'newer-version',
    savedByVersion: 10,
  })
})

afterEach(() => {
  releaseRegion()
  setCurrentCanvasSession(null)
  fixture.reset()
  host.remove()
  elsewhere.remove()
})

it('R1 canopi-f47t.52.270: a drawing tool\'s key arms nothing over a read-only Design; Pan\'s still arms', () => {
  elsewhere.focus()
  const keys = installDesktopKeys()
  try {
    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true }))
    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true }))
  } finally {
    keys.dispose()
  }
  expect(setTool).not.toHaveBeenCalledWith('line')
  expect(setTool).toHaveBeenCalledWith('hand')
})

it('R1 canopi-f47t.52.270: the one command projection greys the drawing tools, Undo and the object edits over a read-only Design', () => {
  const deleteSelected = vi.fn()
  const undo = vi.fn()
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({
      tools: { setTool },
      history: { canUndo: signal(true), canRedo: signal(true), undo },
      sceneEdits: { deleteSelected },
    }),
    queries: createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }] }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
  setCanvasSelection(['plant-1'])
  try {
    const projection = workspaceCanvasCommandProjection.value
    const enabledTools = projection.toolGroups.flatMap((group) => group.tools).filter((tool) => !tool.disabled)
    expect(enabledTools.map((tool) => tool.tool)).toEqual(['select', 'hand'])
    expect(projection.historyActions.filter((action) => !action.disabled)).toEqual([])
    const enabledEdits = projection.editActions.filter((action) => !action.disabled).map((action) => action.id)
    expect(enabledEdits).toEqual(['copy', 'select-all', 'deselect'])
    dispatchWorkspaceCanvasIntent({ type: 'edit', action: 'delete' }, 'shortcut')
    dispatchWorkspaceCanvasIntent({ type: 'undo' }, 'shortcut')
    expect(deleteSelected).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
  } finally {
    setCanvasSelection([])
  }
})

/** The right-click menu over `targets` (none: the empty map, or a point menu with `pointRun`), its commands spied. */
function contextMenu(targets: CanvasDesignObjectSelectionModel['editableTargets'] | null, pointRun?: () => void) {
  const spy = () => vi.fn()
  const commands: CanvasContextMenuCommands = {
    copy: spy(), pasteAt: spy(), canPaste: vi.fn(() => true), duplicateSelected: spy(), toggleSelectedPlantNamePins: spy(),
    deleteSelected: spy(), selectAll: spy(), selectSameSpecies: spy(), bringToFront: spy(), sendToBack: spy(),
    lockSelected: spy(), unlockSelected: spy(), groupSelected: spy(), ungroupSelected: spy(),
    renameZone: vi.fn(() => true), rotateSelected: spy(),
  }
  const plantIds = targets?.filter((target) => target.kind === 'plant').map((target) => target.id) ?? []
  const request: CanvasContextMenuRequest = {
    anchor: { left: 300, top: 200, right: 300, bottom: 200 },
    world: { x: 12, y: 34 },
    selection: targets && {
      editableTargets: targets,
      lockedTargets: [],
      blockedTargets: [],
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sameSpeciesReferenceCanonicalName: plantIds.length > 0 ? 'Malus domestica' : null,
      plantNamePinning: { plantIds, allPinned: false },
    },
    commands,
    saveSelectionAsObjectStamp: spy(),
    placePlantsAt: spy(),
    ...(pointRun ? { pointActions: [{ action: 'delete-point' as const, disabled: false, run: pointRun }] } : {}),
    returnFocus: spy(),
  }
  const options = {
    translate: t,
    characterKeyShortcuts: true,
    openPlantAppearance: spy(),
    summary: plantIds.length > 0
      ? {
          plantCount: plantIds.length,
          species: [{ canonicalName: 'Malus domestica', name: 'Apple', englishFallback: false, selectedCount: 2, designCount: 2 }],
          plantSpacingM: 1.5, zones: [], noteCount: 0, noteText: null, measurementCount: 0, measurementLengthM: null,
        }
      : null,
    openSpeciesDetail: spy(),
    addToCalendar: spy(),
    setUnitCost: spy(),
    // What components/canvas/CanvasContextMenu.tsx passes: the Design session's kind.
    readOnly: designSessionStore.isReadOnly(),
  }
  const flat = (entries: readonly CanvasContextMenuEntry[]): CanvasContextMenuCommand[] =>
    entries.flatMap((entry) => 'submenu' in entry ? flat(entry.submenu) : 'run' in entry ? [entry] : [])
  const entries = flat(buildCanvasContextMenuEntries(request, options))
  return { entries, enabled: entries.filter((entry) => !entry.disabled).map((entry) => entry.id), commands, request, options }
}

it('R1 canopi-f47t.52.270: the right-click menu greys every edit and edit tool over a read-only Design and runs none', () => {
  const pointRun = vi.fn()
  const apples = contextMenu([{ kind: 'plant', id: 'apple-1' }, { kind: 'plant', id: 'apple-2' }])
  const zone = contextMenu([{ kind: 'zone', id: 'zone-1' }])
  const emptyMap = contextMenu(null)
  const corner = contextMenu(null, pointRun)

  // Copy, selecting and Species details look; Cut, Delete, Duplicate, Group, Lock, Paste and the rest change the Design.
  expect(apples.enabled).toEqual(['copy', 'select-same-species', 'species-details'])
  expect(zone.enabled).toEqual(['copy'])
  // Place plants here would arm an edit tool on the empty map.
  expect(emptyMap.enabled).toEqual(['select-all'])
  expect(corner.enabled).toEqual([])
  for (const menu of [apples, zone, emptyMap, corner]) {
    for (const entry of menu.entries) {
      if (entry.disabled) entry.run()
    }
    for (const command of Object.values(menu.commands)) {
      if (command !== menu.commands.canPaste) expect(command).not.toHaveBeenCalled()
    }
    expect(menu.request.placePlantsAt).not.toHaveBeenCalled()
    expect(menu.options.openPlantAppearance).not.toHaveBeenCalled()
    expect(menu.options.addToCalendar).not.toHaveBeenCalled()
    expect(menu.options.setUnitCost).not.toHaveBeenCalled()
  }
  expect(pointRun).not.toHaveBeenCalled()
  expect(renameZoneDialog.value).toBeNull()

  // The same menu over an editing Design offers the edits.
  designSessionStore.replaceCurrentDesignState(SHOWN, '/designs/orchard.canopi', 'Orchard', EDITING_DESIGN_SESSION)
  expect(contextMenu([{ kind: 'plant', id: 'apple-1' }]).enabled).toEqual(expect.arrayContaining(['cut', 'delete', 'lock']))
  expect(contextMenu(null).enabled).toEqual(['place-plants-here', 'paste', 'select-all'])
})

/** Every command that changes, writes or carries the Design out. */
const CHANGES_OR_EXPORTS = [
  'file.rename',
  'file.save',
  'file.saveAs',
  'file.revert',
  'file.addData',
  'file.importGeoJson',
  'file.exportCanvasPdf',
  'file.exportGeoJson',
  'file.exportBudgetCsv',
  'view.saveCurrentView',
  'view.manageViews',
] as const

/** The Web catalog's commands a click runs now, over the Design the store shows. */
function webEnabled(): string[] {
  const run = vi.fn()
  const catalog = createBrowserShellCatalog({
    newDesign: run, openCanopi: run, downloadCanopi: run, revertDesign: run, importGeoJson: run, exportGeoJson: run,
    exportBudgetCsv: run, closeDesign: run, navigate: run,
  }, { templatesEnabled: false, canvasReady: () => true })
  const state = { hasDesign: true, revertAvailable: true, activePanel: 'canvas', sidePanel: null } as const
  return catalog.filter((entry) => !entry.isExecutionDisabled(state)).map((entry) => entry.id)
}

describe('R1 canopi-f47t.52.270: a read-only Design offers Close only', () => {
  it('Desktop: the catalog turns off every change, save and export, and keeps Close', () => {
    const enabled = CHANGES_OR_EXPORTS.filter((id) => !isCatalogCommandDisabled(id as AppCommandId))
    expect(enabled).toEqual([])
    expect(isCatalogCommandDisabled('file.close')).toBe(false)
    expect(isCatalogCommandDisabled('nav.layers')).toBe(false)
  })

  it('Desktop: an editing Design of the same content keeps Rename, Save and Save as', () => {
    designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, EDITING_DESIGN_SESSION)
    expect(isCatalogCommandDisabled('file.rename')).toBe(false)
    expect(isCatalogCommandDisabled('file.save')).toBe(false)
    expect(isCatalogCommandDisabled('file.saveAs')).toBe(false)
  })

  it('Web: the catalog turns off Rename, Download a copy, Revert, the imports and the exports, and keeps Close', () => {
    const enabled = webEnabled()
    for (const id of ['file.rename', 'file.downloadCanopi', 'file.revert', 'file.importGeoJson', 'file.exportGeoJson', 'file.exportBudgetCsv', 'file.exportCanvasPdf', 'view.saveCurrentView']) {
      expect(enabled, id).not.toContain(id)
    }
    expect(enabled).toContain('file.close')
  })

  it('R3 canopi-f47t.52.272: a Web Draft opened while 2.1\'s Drafts could not be listed keeps Download a copy, and nothing else (2.1-Q334)', () => {
    designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, { kind: 'read-only', origin: 'storage-unchecked' })
    const enabled = webEnabled()
    expect(enabled).toContain('file.downloadCanopi')
    for (const id of ['file.rename', 'file.revert', 'file.importGeoJson', 'file.exportGeoJson', 'file.exportBudgetCsv', 'file.exportCanvasPdf', 'view.saveCurrentView']) {
      expect(enabled, id).not.toContain(id)
    }
  })
})
