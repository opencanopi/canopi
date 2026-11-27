// @vitest-environment jsdom

// armCanvasTool (spec §1.6, P9): the one way app code arms a canvas tool, with each caller's own `from`; the map takes
// focus after every arming but a shortcut's.
import type { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestCanvasCommandSurface,
  createTestCanvasKeyboardPort,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { installDesktopKeys } from '../../__tests__/support/desktop-key-router'
import { TEST_KEY_PLATFORM } from '../../__tests__/support/key-router'
import { recentPlantStampSources } from '../../canvas/stamp-drag-data'
import { parseSavedObjectStampPayload } from '../../canvas/saved-object-stamp-payload'
import { currentCanvasTool, currentCanvasToolState, setCurrentCanvasSession } from '../../canvas/session'
import { appCommandGraphChromeProjection } from '../../commands/registry'
import type { MenuAction, MenuEntry } from '../../commands/registry'
import { SiteOnboarding } from '../../components/canvas/SiteOnboarding'
import { ToolRail } from '../../components/canvas/ToolRail'
import { placeSpeciesOnMap } from '../../components/plant-db/place-species'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import { installWebKeyRouter } from '../../editions/web/browser-shell-commands'
import { createSavedObjectStampWorkbench } from '../saved-object-stamps/workbench'
import { singleKeyShortcuts } from '../settings/state'
import { activePanel, sidePanel } from '../shell/state'
import { workspaceCanvasCommandProjection } from '../workspace-commands/canvas-actions'
import { armCanvasTool } from './arming'
import { focusOwner } from './focus-owner'
import type * as ArmingModule from './arming'

vi.mock('./arming', async (importOriginal) => {
  const actual = await importOriginal<typeof ArmingModule>()
  return { ...actual, armCanvasTool: vi.fn(actual.armCanvasTool) }
})

const onboarding = vi.hoisted(() => ({ cardOpen: null as unknown as ReturnType<typeof signal<boolean>> }))
vi.mock('../site-onboarding/state', async () => {
  const { signal: makeSignal } = await import('@preact/signals')
  onboarding.cardOpen = makeSignal(false)
  return {
    siteLocateOpen: makeSignal(false),
    startDesignCardOpen: onboarding.cardOpen,
    foundSiteLabel: makeSignal(null),
    finishSiteLocate: () => {},
    closeStartDesignCard: () => { onboarding.cardOpen.value = false },
    searchSiteAgain: () => {},
  }
})

const arm = vi.mocked(armCanvasTool)

const PEAR: SavedObjectStamp = {
  id: 'stamp-pear',
  name: ' Pear guild ',
  sort_order: 0,
  created_at: '2026-06-19T09:00:00Z',
  updated_at: '2026-06-19T09:00:00Z',
  payload_json: JSON.stringify({
    version: 2,
    anchor: { x: 0, y: 0 },
    plants: [{
      id: 'plant-1', canonicalName: 'Pyrus communis', commonName: 'Pear', color: null, symbol: null,
      position: { x: 0, y: 0 }, rotationDeg: null,
    }],
    zones: [],
    annotations: [],
    groups: [],
  }),
}

const HAZEL = { canonical_name: 'Corylus avellana', common_name: 'European hazelnut', stratum: null, width_max_m: null }

let host: HTMLDivElement
let elsewhere: HTMLButtonElement
let mount: HTMLDivElement
let armSpy: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
let releases: (() => void)[]

function connectCanvas(): void {
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({
      tools: {
        arm: (id, source, request) => {
          armSpy(id, source, request)
          return { settled: new Promise(() => {}), cancel() {} }
        },
      },
    }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
}

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  elsewhere = document.createElement('button')
  mount = document.createElement('div')
  document.body.append(host, elsewhere, mount)
  armSpy = vi.fn()
  releases = [focusOwner.registerRegion('map', host)]
  activePanel.value = 'canvas'
  sidePanel.value = null
  singleKeyShortcuts.value = true
  connectCanvas()
  arm.mockClear()
})

afterEach(async () => {
  await act(async () => { render(null, mount) })
  for (const release of releases) release()
  setCurrentCanvasSession(null)
  recentPlantStampSources.value = []
  onboarding.cardOpen.value = false
  document.body.innerHTML = ''
})

describe('armCanvasTool', () => {
  it('arming from any surface except a shortcut focuses the map host', () => {
    for (const from of ['rail', 'menu', 'palette', 'panel', 'card', 'start-card'] as const) {
      elsewhere.focus()
      expect(armCanvasTool('polygon', { from })).toBe(true)
      expect(armSpy).toHaveBeenLastCalledWith('polygon', undefined, undefined)
      expect(document.activeElement, from).toBe(host)
    }
    elsewhere.focus()
    expect(armCanvasTool('rectangle', { from: 'shortcut' })).toBe(true)
    expect(armSpy).toHaveBeenLastCalledWith('rectangle', undefined, undefined)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('selects the canvas panel for the command and Start card callers, and drops the tool without a canvas (2.1-Q41)', () => {
    setCurrentCanvasSession(null)
    activePanel.value = 'plant-db'
    elsewhere.focus()
    expect(armCanvasTool('polygon', { from: 'start-card' })).toBe(false)
    expect(activePanel.value).toBe('canvas')
    expect(currentCanvasTool.value).toBe('select')
    expect(armSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(elsewhere)

    // A species from a panel is recorded in recents (offered again by Place plants' chooser) with nothing to arm.
    expect(armCanvasTool('plant-stamp', { from: 'panel', source: { kind: 'species', species: HAZEL } })).toBe(false)
    expect(recentPlantStampSources.value.map((entry) => entry.canonical_name)).toEqual(['Corylus avellana'])
    expect(currentCanvasTool.value).toBe('select')
    expect(currentCanvasToolState.value.source).toBeNull()

    // A saved stamp needs a canvas: nothing is written.
    const stamp = parseSavedObjectStampPayload(PEAR.payload_json)!
    expect(armCanvasTool('saved-object-stamp', { from: 'panel', source: { kind: 'saved-stamp', stamp, name: 'Pear guild' } })).toBe(false)
    expect(currentCanvasToolState.value.source).toBeNull()
  })

  it('in overview a drawing tool fits the Design first, about the view centre when the Design is empty', () => {
    const { queries, order } = connectOverviewCanvas()
    for (const from of ['rail', 'shortcut', 'menu', 'palette', 'panel', 'card', 'start-card'] as const) {
      queries.setPlacement({ x: 0, y: 0, scale: 0.01 })
      order.length = 0
      expect(armCanvasTool('polygon', { from })).toBe(true)
      expect(order, from).toEqual(['fit:view-centre', 'arm:polygon'])
    }
    // Select and Pan work in overview as they are; site scale needs no fit.
    order.length = 0
    queries.setPlacement({ x: 0, y: 0, scale: 0.01 })
    armCanvasTool('select', { from: 'rail' })
    armCanvasTool('hand', { from: 'rail' })
    queries.setPlacement({ x: 0, y: 0, scale: 3 })
    armCanvasTool('plant-stamp', { from: 'panel' })
    expect(order).toEqual(['arm:select', 'arm:hand', 'arm:plant-stamp'])
  })

  // canopi-xs1l: the browser spec keeps one test per tool; every tool's button and key path is pinned here.
  it.each([
    ['plantStamp', 'plant-stamp', 'p'],
    ['plantSpacing', 'plant-spacing', 'w'],
    ['objectStamp', 'object-stamp', 'k'],
    ['polygon', 'polygon', 'z'],
    ['rectangle', 'rectangle', 'r'],
    ['ellipse', 'ellipse', 'e'],
    ['line', 'line', 'l'],
    ['text', 'text', 't'],
    ['measurementGuide', 'measurement-guide', 'm'],
  ] as const)('canopi-xs1l: in overview the %s tool, by its rail button and by its key %s, fits the Design and then arms it', async (command, toolId, key) => {
    const { queries, order } = connectOverviewCanvas()
    await act(async () => {
      render(h(ToolRail, { projection: workspaceCanvasCommandProjection.value, showNames: false }), mount)
    })

    elsewhere.focus()
    await act(async () => { mount.querySelector<HTMLButtonElement>(`[data-command="canvas.tool.${command}"]`)!.click() })
    expect(arm).toHaveBeenLastCalledWith(toolId, { from: 'rail' })
    expect(order, 'rail button').toEqual(['fit:view-centre', `arm:${toolId}`])
    expect(document.activeElement, 'the button focuses the map').toBe(host)

    queries.setPlacement({ x: 0, y: 0, scale: 0.01 })
    order.length = 0
    const desktop = installDesktopKeys()
    try {
      host.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }))
    } finally {
      desktop.dispose()
    }
    expect(arm).toHaveBeenLastCalledWith(toolId, { from: 'shortcut' })
    expect(order, 'key').toEqual(['fit:view-centre', `arm:${toolId}`])
  })

  it('hands the source and stampId to ToolHost, and re-arming without a source preserves the armed species (#880 B2)', () => {
    const stamp = parseSavedObjectStampPayload(PEAR.payload_json)!
    expect(armCanvasTool('saved-object-stamp', {
      from: 'card',
      source: { kind: 'saved-stamp', stamp, name: 'Pear guild' },
      request: { stampId: 'stamp-pear' },
    })).toBe(true)
    expect(currentCanvasToolState.value).toEqual({
      id: 'saved-object-stamp',
      source: { kind: 'saved-stamp', stamp, name: 'Pear guild' },
      stampId: 'stamp-pear',
    })
    expect(armCanvasTool('saved-object-stamp', { from: 'card', source: { kind: 'saved-stamp', stamp, name: 'Pear guild' } })).toBe(true)
    expect(armSpy).toHaveBeenCalledTimes(2)

    // Re-arming Place plants with no source passes undefined (not null) so ToolHost preserves the chosen species.
    expect(armCanvasTool('plant-stamp', { from: 'panel', source: { kind: 'species', species: HAZEL } })).toBe(true)
    expect(currentCanvasToolState.value.source).toEqual({ kind: 'species', species: HAZEL })
    expect(armCanvasTool('plant-stamp', { from: 'shortcut' })).toBe(true)
    expect(armSpy).toHaveBeenLastCalledWith('plant-stamp', undefined, undefined)
    expect(currentCanvasToolState.value.source).toEqual({ kind: 'species', species: HAZEL })
  })

  it('every caller arms through armCanvasTool with its own from', async () => {
    // A catalog panel's Place button.
    placeSpeciesOnMap(HAZEL)
    expect(arm).toHaveBeenLastCalledWith('plant-stamp', { from: 'panel', source: { kind: 'species', species: HAZEL } })

    // Favorites' Place stamp (panel) and the tool card's chooser (card), both through the workbench.
    const workbench = createSavedObjectStampWorkbench({ getSavedObjectStamps: async () => [PEAR], getCanvasQuerySurface: () => null })
    const payload = parseSavedObjectStampPayload(PEAR.payload_json)
    expect(workbench.placeStamp(PEAR, 'panel')).toBe(true)
    expect(arm).toHaveBeenLastCalledWith('saved-object-stamp', {
      from: 'panel',
      source: { kind: 'saved-stamp', stamp: payload, name: 'Pear guild' },
      request: { stampId: 'stamp-pear' },
    })
    expect(workbench.placeStamp(PEAR, 'card')).toBe(true)
    expect(arm.mock.lastCall?.[1].from).toBe('card')
    workbench.dispose()

    // The Start card's Draw a zone.
    onboarding.cardOpen.value = true
    await act(async () => { render(h(SiteOnboarding, null), mount) })
    await act(async () => { mount.querySelector<HTMLButtonElement>('[data-start-primary]')!.click() })
    expect(arm).toHaveBeenLastCalledWith('polygon', { from: 'start-card' })
    expect(document.activeElement).toBe(host)
  })

  it('the rail, a menu, the palette and a key reach arming with their own from through shared dispatch', async () => {
    // The rail.
    await act(async () => {
      render(h(ToolRail, { projection: workspaceCanvasCommandProjection.value, showNames: false }), mount)
    })
    await act(async () => { mount.querySelector<HTMLButtonElement>('[data-command="canvas.tool.polygon"]')!.click() })
    expect(arm).toHaveBeenLastCalledWith('polygon', { from: 'rail' })
    expect(document.activeElement).toBe(host)

    // A menu: Tools › Rectangle.
    const toolsMenu = appCommandGraphChromeProjection.value.menus.find((menu) => menu.id === 'tools')!
    const rectangle = flatten(toolsMenu.items).find((entry) => entry.id === 'canvas.tool.rectangle')!
    rectangle.action()
    expect(arm).toHaveBeenLastCalledWith('rectangle', { from: 'menu' })

    // The command palette.
    appCommandGraphChromeProjection.value.paletteCommands.find((command) => command.id === 'canvas.tool.ellipse')!.action()
    expect(arm).toHaveBeenLastCalledWith('ellipse', { from: 'palette' })

    // A key, on Desktop and on the Web: focus stays where it was.
    elsewhere.focus()
    const desktop = installDesktopKeys()
    try {
      elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true }))
    } finally {
      desktop.dispose()
    }
    expect(arm).toHaveBeenLastCalledWith('line', { from: 'shortcut' })
    expect(document.activeElement).toBe(elsewhere)

    const web = installWebKeyRouter({
      catalog: [],
      readState: () => ({ hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }),
    }, TEST_KEY_PLATFORM)
    try {
      elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true, cancelable: true }))
    } finally {
      web.dispose()
    }
    expect(arm).toHaveBeenLastCalledWith('text', { from: 'shortcut' })
    expect(document.activeElement).toBe(elsewhere)
  })

  it('fits in overview for read-only Profile (worksInOverview absent), and refuses tools whose row.requires capability is missing (#880 S4)', async () => {
    const { queries, order } = connectOverviewCanvas()
    expect(armCanvasTool('profile', { from: 'panel' })).toBe(true)
    expect(order).toEqual(['fit:view-centre', 'arm:profile'])

    const { setToolCapabilityReader } = await import('./arming')
    setToolCapabilityReader(() => new Set())
    try {
      queries.setPlacement({ x: 0, y: 0, scale: 3 })
      order.length = 0
      expect(armCanvasTool('siteData.pin', { from: 'panel' })).toBe(false)
      expect(order).toEqual([])
    } finally {
      setToolCapabilityReader(null)
    }
  })
})

/** A canvas in overview whose Return to Design and tool arming log their order; the fit lands at site scale. */
function connectOverviewCanvas() {
  const queries = createTestCanvasQuerySurface({ placement: { x: 0, y: 0, scale: 0.01 } })
  const order: string[] = []
  const returnToDesign = vi.fn((options?: { readonly around?: string }) => {
    order.push(`fit:${options?.around}`)
    queries.setPlacement({ x: 0, y: 0, scale: 3 })
  })
  armSpy.mockImplementation((name: unknown) => { order.push(`arm:${String(name)}`) })
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({
      tools: {
        arm: (id, source, request) => {
          armSpy(id, source, request)
          return { settled: new Promise(() => {}), cancel() {} }
        },
      },
      viewport: { returnToDesign },
    }),
    queries,
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
  return { queries, order }
}

function flatten(entries: readonly MenuEntry[]): MenuAction[] {
  return entries.flatMap((entry) => {
    if (entry.type === 'action') return [entry]
    if (entry.type === 'submenu') return flatten(entry.items)
    return []
  })
}
