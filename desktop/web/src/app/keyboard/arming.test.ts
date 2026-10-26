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
import { readPlantStampSource, clearPlantStampSource, recentPlantStampSources } from '../../canvas/plant-stamp-source'
import { clearSavedObjectStampSource, readSavedObjectStampName, readSavedObjectStampSource } from '../../canvas/saved-object-stamp-source'
import { parseSavedObjectStampPayload } from '../../canvas/saved-object-stamp-payload'
import { setCurrentCanvasSession } from '../../canvas/session'
import { currentCanvasTool } from '../../canvas/session-state'
import { appCommandGraphChromeProjection } from '../../commands/registry'
import type { MenuAction, MenuEntry } from '../../commands/registry'
import { SiteOnboarding } from '../../components/canvas/SiteOnboarding'
import { ToolRail } from '../../components/canvas/ToolRail'
import { placeSpeciesOnMap } from '../../components/plant-db/place-species'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'
import { installWebKeyRouter } from '../../web/browser-shell-commands'
import { createSavedObjectStampWorkbench } from '../saved-object-stamps/workbench'
import { singleKeyShortcuts } from '../settings/state'
import { activePanel, sidePanel } from '../shell/state'
import { workspaceCanvasCommandProjection } from '../workspace-commands/canvas-actions'
import { armCanvasTool } from './arming'
import { focusOwner } from './focus-owner'

vi.mock('./arming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./arming')>()
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
let setTool: ReturnType<typeof vi.fn<(name: string) => void>>
let releases: (() => void)[]

function connectCanvas(): void {
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface({ tools: { setTool } }),
    keyboard: createTestCanvasKeyboardPort({ host }),
  }))
}

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  elsewhere = document.createElement('button')
  mount = document.createElement('div')
  document.body.append(host, elsewhere, mount)
  setTool = vi.fn<(name: string) => void>()
  releases = [focusOwner.registerRegion('map', host)]
  activePanel.value = 'canvas'
  sidePanel.value = null
  currentCanvasTool.value = 'select'
  singleKeyShortcuts.value = true
  connectCanvas()
  arm.mockClear()
})

afterEach(async () => {
  await act(async () => { render(null, mount) })
  for (const release of releases) release()
  setCurrentCanvasSession(null)
  clearPlantStampSource()
  clearSavedObjectStampSource()
  recentPlantStampSources.value = []
  onboarding.cardOpen.value = false
  document.body.innerHTML = ''
})

describe('armCanvasTool', () => {
  it('arming from any surface except a shortcut focuses the map host', () => {
    for (const from of ['rail', 'menu', 'palette', 'panel', 'card', 'start-card'] as const) {
      elsewhere.focus()
      expect(armCanvasTool('polygon', { from })).toBe(true)
      expect(setTool).toHaveBeenLastCalledWith('polygon')
      expect(document.activeElement, from).toBe(host)
    }
    elsewhere.focus()
    expect(armCanvasTool('rectangle', { from: 'shortcut' })).toBe(true)
    expect(setTool).toHaveBeenLastCalledWith('rectangle')
    expect(document.activeElement).toBe(elsewhere)
  })

  it('selects the canvas panel for the command and Start card callers, and primes the tool without a canvas', () => {
    setCurrentCanvasSession(null)
    activePanel.value = 'plant-db'
    elsewhere.focus()
    expect(armCanvasTool('polygon', { from: 'start-card' })).toBe(false)
    expect(activePanel.value).toBe('canvas')
    expect(currentCanvasTool.value).toBe('polygon')
    expect(setTool).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(elsewhere)

    // A species from a panel is kept (and offered again by Place plants' chooser) with nothing to arm.
    currentCanvasTool.value = 'select'
    expect(armCanvasTool('plant-stamp', { from: 'panel', source: { kind: 'species', species: HAZEL } })).toBe(false)
    expect(readPlantStampSource()?.canonical_name).toBe('Corylus avellana')
    expect(recentPlantStampSources.value.map((entry) => entry.canonical_name)).toEqual(['Corylus avellana'])
    expect(currentCanvasTool.value).toBe('select')

    // A saved stamp needs a canvas: nothing is written.
    const stamp = parseSavedObjectStampPayload(PEAR.payload_json)!
    expect(armCanvasTool('saved-object-stamp', { from: 'panel', source: { kind: 'saved-stamp', stamp, name: 'Pear guild' } })).toBe(false)
    expect(readSavedObjectStampSource()).toBeNull()
  })

  it('in overview a drawing tool fits the Design first, about the view centre when the Design is empty', () => {
    const queries = createTestCanvasQuerySurface({ placement: { x: 0, y: 0, scale: 0.01 } })
    const order: string[] = []
    const returnToDesign = vi.fn((options?: { readonly around?: string }) => {
      order.push(`fit:${options?.around}`)
      queries.setPlacement({ x: 0, y: 0, scale: 3 })
    })
    setTool.mockImplementation((name) => { order.push(`arm:${name}`) })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { setTool }, viewport: { returnToDesign } }),
      queries,
      keyboard: createTestCanvasKeyboardPort({ host }),
    }))
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

  it('writes the source before arming, and arms the same tool again', () => {
    const stamp = parseSavedObjectStampPayload(PEAR.payload_json)!
    setTool.mockImplementation(() => {
      expect(readSavedObjectStampSource()).not.toBeNull()
    })
    expect(armCanvasTool('saved-object-stamp', { from: 'card', source: { kind: 'saved-stamp', stamp, name: 'Pear guild' } })).toBe(true)
    expect(readSavedObjectStampName()).toBe('Pear guild')
    expect(armCanvasTool('saved-object-stamp', { from: 'card', source: { kind: 'saved-stamp', stamp, name: 'Pear guild' } })).toBe(true)
    expect(setTool).toHaveBeenCalledTimes(2)
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
})

function flatten(entries: readonly MenuEntry[]): MenuAction[] {
  return entries.flatMap((entry) => {
    if (entry.type === 'action') return [entry]
    if (entry.type === 'submenu') return flatten(entry.items)
    return []
  })
}
