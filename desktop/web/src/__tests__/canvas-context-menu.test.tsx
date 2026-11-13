// @vitest-environment jsdom

import { createRef, render } from 'preact'
import { profileLineMenu } from '../app/lidar/profile'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasContextMenu } from '../components/canvas/CanvasContextMenu'
import { PlantAppearancePopovers } from '../components/canvas/PlantAppearancePopovers'
import {
  canvasContextMenuRequest,
  closeCanvasContextMenu,
  openCanvasContextMenu,
  plantAppearanceAnchor,
} from '../app/canvas-context-menu/state'
import { plantColorMenuOpen } from '../canvas/plant-color-menu-state'
import { plantSymbolMenuOpen } from '../canvas/plant-symbol-menu-state'
import { setCurrentCanvasSession } from '../canvas/session'
import { createDesignSessionStoreTestFixture, designSessionStore } from '../app/document-session/store'
import type { CanopiFile } from '../types/design'
import type { CanvasContextMenuEntryOptions } from '../app/canvas-context-menu/entries'
import { currentCanvasSelection } from '../canvas/session-state'
import type {
  CanvasContextMenuCommands,
  CanvasContextMenuRequest,
} from '../canvas/runtime/app-adapter'
import type { CanvasDesignObjectSelectionModel } from '../canvas/runtime/runtime'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestView } from './support/test-view'
import { createCanvasContextMenu } from '../canvas/runtime/interaction/canvas-context-menu'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

const APPLES: CanvasDesignObjectSelectionModel = {
  editableTargets: [{ kind: 'plant', id: 'plant-1' }],
  lockedTargets: [],
  blockedTargets: [],
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  sameSpeciesReferenceCanonicalName: 'Malus domestica',
  plantNamePinning: { plantIds: ['plant-1'], allPinned: false },
}

function createCommands(): CanvasContextMenuCommands {
  return {
    copy: vi.fn(),
    pasteAt: vi.fn(),
    canPaste: vi.fn(() => false),
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
  }
}

describe('CanvasContextMenu', () => {
  let container: HTMLDivElement
  let map: HTMLDivElement
  let commands: CanvasContextMenuCommands
  const returnFocus = vi.fn(() => map.focus())

  function request(overrides: Partial<CanvasContextMenuRequest> = {}): CanvasContextMenuRequest {
    return {
      anchor: { left: 120, top: 80, right: 120, bottom: 80 },
      world: { x: 5, y: 6 },
      selection: APPLES,
      commands,
      returnFocus,
      ...overrides,
    }
  }

  async function open(next: CanvasContextMenuRequest = request()): Promise<HTMLElement> {
    await act(async () => { openCanvasContextMenu(next) })
    return document.querySelector<HTMLElement>('[role="menu"]')!
  }

  const menuItem = (id: string) => document.querySelector<HTMLButtonElement>(`[role="menu"] [data-command="${id}"]`)!
  const key = (target: EventTarget, name: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))

  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    document.body.innerHTML = ''
    container = document.createElement('div')
    map = document.createElement('div')
    map.tabIndex = -1
    document.body.append(map, container)
    commands = createCommands()
    returnFocus.mockClear()
    currentCanvasSelection.value = new Set(['plant-1'])
    const plantContext = {
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        plantPresentation: { ensureSpeciesCacheEntries: vi.fn().mockResolvedValue(false) },
      }),
      queries: {
        ...createTestCanvasQuerySurface(),
        getSelectedPlantColorContext: () => ({
          ...plantContext,
          plantIds: currentCanvasSelection.value.size > 0 ? plantContext.plantIds : [],
          sharedCurrentColor: null,
          suggestedColor: null,
          singleSpeciesDefaultColor: null,
        }),
        getSelectedPlantSymbolContext: () => ({
          ...plantContext,
          plantIds: currentCanvasSelection.value.size > 0 ? plantContext.plantIds : [],
          sharedCurrentSymbol: null,
          sharedEffectiveSymbol: 'round',
          inheritedSymbol: null,
          singleSpeciesDefaultSymbol: null,
          canClearSelectedSymbol: false,
        }),
      },
    }))
    const canvasRef = createRef<HTMLDivElement>()
    canvasRef.current = map
    await act(async () => {
      render(<><CanvasContextMenu /><PlantAppearancePopovers canvasRef={canvasRef} /></>, container)
    })
  })

  afterEach(async () => {
    await act(async () => {
      closeCanvasContextMenu()
      plantColorMenuOpen.value = false
      plantSymbolMenuOpen.value = false
      plantAppearanceAnchor.value = null
      render(null, container)
    })
    currentCanvasSelection.value = new Set()
    setCurrentCanvasSession(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function selectTwoApples(): Promise<void> {
    const scene = createDefaultScenePersistedState()
    scene.plants = [1, 2].map((index) => ({
      kind: 'plant' as const,
      id: `plant-${index}`,
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      canopySpreadM: null,
      position: { x: index, y: 0 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: 1,
    }))
    const queries = createTestCanvasQuerySurface({
      scene,
      selection: [{ kind: 'plant', id: 'plant-1' }, { kind: 'plant', id: 'plant-2' }],
    })
    await act(async () => { setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries })) })
  }

  it('names the selection above its commands, in the selection chip’s words', async () => {
    await selectTwoApples()
    const menu = await open()

    expect(menu.querySelector('[role="presentation"]')?.textContent).toBe('2 plants · Apple · 1 m apart')
    expect(menu.getAttribute('aria-label')).toBe('2 plants · Apple · 1 m apart')
    expect(menu.querySelector('[role="menuitem"]')).toBe(document.activeElement)

    // The empty map has no selection to name.
    const empty = await open(request({ selection: null }))
    expect(empty.querySelector('[role="presentation"]')).toBeNull()
    expect(empty.getAttribute('aria-label')).toBe('Canvas edit commands')

    // An object on a locked layer opens a menu with no targets: the app's selection elsewhere is not named (canopi-f47t.39).
    const locked = await open(request({ selection: { ...APPLES, editableTargets: [], lockedTargets: [], bounds: null,
      sameSpeciesReferenceCanonicalName: null, plantNamePinning: { plantIds: [], allPinned: false } } }))
    expect(locked.querySelector('[role="presentation"]')).toBeNull()
    expect(locked.getAttribute('aria-label')).toBe('Canvas edit commands')
  })

  it('renders word labels as menu items with separators, shortcuts and a red Delete last', async () => {
    const menu = await open()

    expect(menu.getAttribute('aria-label')).toBe('Canvas edit commands')
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((entry) => entry.getAttribute('aria-label'))).toContain('Select all of this species')
    expect(items.at(-1)?.dataset.command).toBe('delete')
    expect(items.at(-1)?.dataset.danger).toBe('true')
    expect(menu.querySelectorAll('[role="separator"]').length).toBeGreaterThanOrEqual(5)
    expect(menuItem('copy').textContent).toContain('Ctrl C')
    expect(menuItem('plant-color').getAttribute('aria-haspopup')).toBe('dialog')
    expect(document.activeElement).toBe(items[0])
  })

  it('keeps disabled items focusable and inert', async () => {
    await open()
    const paste = menuItem('paste')

    expect(paste.getAttribute('aria-disabled')).toBe('true')
    await act(async () => paste.click())
    expect(commands.pasteAt).not.toHaveBeenCalled()
    expect(canvasContextMenuRequest.value).not.toBeNull()
  })

  // R1-8 failure state: an edit tool reachable by the right-click menu over a read-only Design (2.1-M478).
  it('canopi-f47t.52.270: over a read-only Session the shipped menu shows its edits disabled and runs none', async () => {
    designSessionStore.replaceCurrentDesignState({ name: 'Orchard 2.1' } as unknown as CanopiFile, null, 'Orchard 2.1', {
      kind: 'read-only', origin: 'newer-version', savedByVersion: 10,
    })
    try {
      await open()
      for (const id of ['cut', 'duplicate', 'delete', 'lock']) {
        expect(menuItem(id).getAttribute('aria-disabled'), id).toBe('true')
      }
      expect(menuItem('copy').getAttribute('aria-disabled')).not.toBe('true')
      await act(async () => menuItem('duplicate').click())
      await act(async () => menuItem('delete').click())
      expect(commands.duplicateSelected).not.toHaveBeenCalled()
      expect(commands.deleteSelected).not.toHaveBeenCalled()
      expect(canvasContextMenuRequest.value).not.toBeNull()
    } finally {
      createDesignSessionStoreTestFixture(designSessionStore).reset()
    }
  })

  it('canopi-f47t.52.270: a new menu caller cannot forget the read-only input', () => {
    const { readOnly: _forgotten, ...withoutReadOnly }: CanvasContextMenuEntryOptions = {
      translate: (key) => key, characterKeyShortcuts: true, openPlantAppearance: vi.fn(), summary: null,
      openSpeciesDetail: vi.fn(), addToCalendar: vi.fn(), setUnitCost: vi.fn(), readOnly: false,
    }
    // @ts-expect-error readOnly is required: options that leave it out do not compile
    const options: CanvasContextMenuEntryOptions = withoutReadOnly
    expect(options).not.toHaveProperty('readOnly')
  })

  it('moves with the arrow keys and returns focus to the map on Escape', async () => {
    const menu = await open()

    await act(async () => { key(menu, 'ArrowDown') })
    expect(document.activeElement).toBe(menuItem('copy'))
    await act(async () => { key(menu, 'End') })
    expect(document.activeElement).toBe(menuItem('delete'))
    await act(async () => { key(menu, 'Escape') })

    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(canvasContextMenuRequest.value).toBeNull()
    expect(returnFocus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(map)
  })

  it('runs a chosen command once, closes and returns focus to the map', async () => {
    await open()

    await act(async () => menuItem('duplicate').click())

    expect(commands.duplicateSelected).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(returnFocus).toHaveBeenCalledOnce()
  })

  it('closes on an outside press without taking focus, but not on the right-click release', async () => {
    await open()

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2 }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(returnFocus).not.toHaveBeenCalled()
  })

  it('anchors at the pointer and flips to stay inside the viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const size = this.getAttribute('role') === 'menu' ? { width: 200, height: 300 } : { width: 0, height: 0 }
      return { x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) }
    })

    let menu = await open(request({ anchor: { left: 120, top: 80, right: 120, bottom: 80 } }))
    expect(menu.style.left).toBe('120px')
    expect(menu.style.top).toBe('80px')

    menu = await open(request({ anchor: { left: 1000, top: 700, right: 1000, bottom: 700 } }))
    expect(menu.style.left).toBe('800px')
    expect(menu.style.top).toBe('400px')

    menu = await open(request({ anchor: { left: 120, top: 200, right: 120, bottom: 200 } }))
    expect(menu.style.top).toBe('200px')
    const innerHeight = window.innerHeight
    try {
      // Too tall for either side of the pointer but not for the window: it
      // slides up beside the pointer and shows every item without scrolling.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
      menu = await open(request({ anchor: { left: 120, top: 250, right: 120, bottom: 250 } }))
      expect(menu.style.left).toBe('120px')
      expect(menu.style.top).toBe('192px')
      expect(menu.style.maxHeight).toBe('484px')
      // Taller than the window: capped to it, and it scrolls.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 250 })
      menu = await open(request({ anchor: { left: 120, top: 125, right: 120, bottom: 125 } }))
      expect(menu.style.top).toBe('8px')
      expect(menu.style.maxHeight).toBe('234px')
      // Opened by the keyboard for a selection, it never slides over the selection's bounds.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
      menu = await open(request({ anchor: { left: 120, top: 240, right: 220, bottom: 260 } }))
      expect(menu.style.top).toBe('260px')
      expect(menu.style.maxHeight).toBe('232px')
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
    }
  })

  it('the keyboard menu sits beside the projected selection at 45', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const size = this.getAttribute('role') === 'menu' ? { width: 200, height: 300 } : { width: 0, height: 0 }
      return { x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) }
    })
    const view = createTestView({ screen: { width: 800, height: 600 }, camera: { bearingDeg: 45 } })
    const controller = createCanvasContextMenu({
      container: map,
      view: () => view.view(),
      adapter: { open: openCanvasContextMenu, close: closeCanvasContextMenu },
      commands,
      returnFocus,
    })
    const bounds = { minX: -40, minY: -10, maxX: 40, maxY: 10 }
    // The selection's hull (tools/select/selection-hull.ts): a world quad turned 45°, its four corners projected.
    const hull = [{ x: -40, y: -10 }, { x: 40, y: -10 }, { x: 40, y: 10 }, { x: -40, y: 10 }] as const
    const corners = view.view().worldQuadToScreen(hull)
    const xs = corners.map((corner) => corner.x)
    const ys = corners.map((corner) => corner.y)

    await act(async () => { controller.openFromKeyboard({ ...APPLES, bounds }, hull) })

    const anchor = canvasContextMenuRequest.value!.anchor
    expect(anchor.left).toBeCloseTo(Math.min(...xs), 6)
    expect(anchor.right).toBeCloseTo(Math.max(...xs), 6)
    expect(anchor.top).toBeCloseTo(Math.min(...ys), 6)
    expect(anchor.bottom).toBeCloseTo(Math.max(...ys), 6)
    // Below the selection, never over it.
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(parseFloat(menu.style.top)).toBeCloseTo(Math.max(...ys), 6)
    controller.dispose()
    view.dispose()
  })

  it('keeps its heading in view while the items scroll', async () => {
    await selectTwoApples()
    const menu = await open()
    const heading = menu.querySelector<HTMLElement>('[role="presentation"]')!
    const items = menu.querySelector<HTMLElement>('[data-menu-items]')!

    expect(heading.textContent).toBe('2 plants · Apple · 1 m apart')
    expect(items.contains(menuItem('cut'))).toBe(true)
    // The heading sits outside the scrolling items, so it never scrolls away.
    expect(items.contains(heading)).toBe(false)
    expect(menu.contains(heading)).toBe(true)
  })

  it('groups stacking and grouping under Arrange ▸: ArrowRight opens it, Escape returns to it', async () => {
    const menu = await open()
    const arrange = menuItem('arrange')

    expect(arrange.getAttribute('aria-haspopup')).toBe('menu')
    expect(arrange.getAttribute('aria-expanded')).toBe('false')
    expect(menu.querySelector('[data-command="bring-to-front"]')).toBeNull()

    await act(async () => { arrange.focus(); key(arrange, 'ArrowRight') })
    const submenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Arrange"]')!
    expect(submenu).not.toBeNull()
    expect(arrange.getAttribute('aria-expanded')).toBe('true')
    const labels = [...submenu.querySelectorAll('[role="menuitem"]')].map((entry) => entry.getAttribute('aria-label'))
    expect(labels).toEqual(['Bring to front', 'Send to back', 'Group', 'Ungroup'])
    expect(document.activeElement).toBe(submenu.querySelector('[data-command="bring-to-front"]'))

    await act(async () => { key(document.activeElement!, 'Escape') })
    expect(document.querySelector('[role="menu"][aria-label="Arrange"]')).toBeNull()
    expect(document.activeElement).toBe(menuItem('arrange'))
    expect(canvasContextMenuRequest.value).not.toBeNull()

    await act(async () => { key(arrange, 'ArrowRight') })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="menu"][aria-label="Arrange"] [data-command="bring-to-front"]')!.click()
    })
    expect(commands.bringToFront).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(returnFocus).toHaveBeenCalledOnce()
  })

  it('reopens at the new place for a new request and swallows a native menu on itself', async () => {
    await open()
    const next = await open(request({ selection: null }))

    expect(next.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
    const nativeMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    next.dispatchEvent(nativeMenu)
    expect(nativeMenu.defaultPrevented).toBe(true)
  })

  it('opens Plant color beside the menu; Escape there returns focus to the map', async () => {
    await open()

    await act(async () => menuItem('plant-color').click())

    expect(document.querySelector('[role="menu"]')).toBeNull()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Plant color"]')
    expect(dialog).not.toBeNull()
    expect(plantColorMenuOpen.value).toBe(true)
    returnFocus.mockClear()

    await act(async () => { key(dialog!, 'Escape') })

    expect(plantColorMenuOpen.value).toBe(false)
    expect(returnFocus).toHaveBeenCalled()
  })

  it('opens Plant symbol, and closes the popover when no plant stays selected', async () => {
    await open()

    await act(async () => menuItem('plant-symbol').click())
    expect(document.querySelector('[role="dialog"][aria-label="Plant symbol"]')).not.toBeNull()

    await act(async () => { currentCanvasSelection.value = new Set() })

    expect(plantSymbolMenuOpen.value).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes an open popover when a new context menu opens', async () => {
    await open()
    await act(async () => menuItem('plant-color').click())
    expect(plantColorMenuOpen.value).toBe(true)

    await open()

    expect(plantColorMenuOpen.value).toBe(false)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  async function rightClickLineZone(): Promise<void> {
    const scene = createDefaultScenePersistedState()
    scene.zones.push({
      kind: 'zone', id: 'zone-path', locked: false, fillColor: null, notes: null, name: null,
      zoneType: 'line', rotationDeg: 0, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
    })
    const queries = createTestCanvasQuerySurface({ scene, selection: [{ kind: 'zone', id: 'zone-path' }] })
    await act(async () => { setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries })) })
    await open(request({
      selection: { ...APPLES, editableTargets: [{ kind: 'zone', id: 'zone-path' }], sameSpeciesReferenceCanonicalName: null, plantNamePinning: { plantIds: [], allPinned: false } },
    }))
  }

  const profileThisLine = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    .find((item) => item.textContent?.includes('Profile this line'))

  it('offers Profile this line on a Line zone where the edition hands Site data’s profile over (Desktop)', async () => {
    await act(async () => {
      render(<CanvasContextMenu profileLine={profileLineMenu} />, container)
    })
    await rightClickLineZone()
    expect(profileThisLine()).toBeDefined()
  })

  it('offers no Profile this line where the edition has no Site data (Web)', async () => {
    await rightClickLineZone()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(profileThisLine()).toBeUndefined()
  })
})
