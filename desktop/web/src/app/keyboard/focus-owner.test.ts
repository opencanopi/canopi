// @vitest-environment jsdom

// The focus owner (spec §1.6, ADR 0020): the F6 regions, the map's focus and the focus a user-opened component takes.
import { createRef, h, render } from 'preact'
import { useRef } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { clearCurrentDesignState, replaceCurrentDesignState } from '../../__tests__/support/design-session-state'
import { installDesktopKeys } from '../../__tests__/support/desktop-key-router'
import { TEST_GEO_ORIGIN } from '../../__tests__/support/geo-design'
import { plantColorMenuOpen } from '../../canvas/plant-color-menu-state'
import { setCurrentCanvasSession } from '../../canvas/session'
import { createSessionPlane } from '../../geo/session-plane'
import { currentCanvasSelection } from '../../canvas/session-state'
import { PlantAppearancePopovers } from '../../components/canvas/PlantAppearancePopovers'
import { useFocusRegion } from '../../components/shared/useFocusRegion'
import type { CanopiFile } from '../../types/design'
import { holdModalLayer } from '../shell/modal-layer'
import { leaveStoryPresentation, presentStory } from '../story-presentation'
import { focusOwner } from './focus-owner'

describe('F6 regions through the focus owner', () => {
  let releases: (() => void)[]
  let keys: ReturnType<typeof installDesktopKeys>
  let titleBar: HTMLElement
  let menu: HTMLButtonElement
  let rail: HTMLElement
  let railTool: HTMLButtonElement
  let map: HTMLElement
  let dock: HTMLElement
  let dockField: HTMLInputElement

  function region(tag: string, html: string): HTMLElement {
    const element = document.createElement(tag)
    element.innerHTML = html
    document.body.append(element)
    return element
  }

  function press(shiftKey = false, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'F6', shiftKey, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  beforeEach(() => {
    titleBar = region('header', '<button>File</button><button>Edit</button>')
    menu = titleBar.querySelector('button')!
    // The tool rail keeps one tab stop (roving tabindex): the active tool.
    rail = region('div', '<button tabindex="-1">Select</button><button tabindex="0">Polygon zone</button>')
    railTool = rail.querySelectorAll('button')[1]!
    map = region('div', '')
    map.tabIndex = 0
    dock = region('aside', '<button>Close panel</button><input aria-label="Find plants">')
    dockField = dock.querySelector('input')!
    releases = [
      // Registered out of order: the cycle follows title bar, tools, map, panel.
      focusOwner.registerRegion('dock', dock),
      focusOwner.registerRegion('map', map),
      focusOwner.registerRegion('title-bar', titleBar),
      focusOwner.registerRegion('tool-rail', rail),
    ]
    // F6 runs in the key router's capture listener (app/keyboard/key-router.ts), which calls the owner.
    keys = installDesktopKeys()
  })

  afterEach(() => {
    keys.dispose()
    for (const release of releases) release()
    document.body.innerHTML = ''
  })

  it('F6 cycles title bar, tools, map and dock', () => {
    map.focus()
    const event = press()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dock.querySelector('button'))
    press()
    expect(document.activeElement).toBe(menu)
    press()
    expect(document.activeElement).toBe(railTool)
    press()
    expect(document.activeElement).toBe(map)

    press(true)
    expect(document.activeElement).toBe(railTool)
    press(true)
    expect(document.activeElement).toBe(menu)
    press(true)
    expect(document.activeElement).toBe(dock.querySelector('button'))
  })

  it('F6 skips a control hidden by a display:none parent: the compact Menu button in the title bar', () => {
    // The compact title bar's Menu button sits in a wrapper the wide layout hides; a browser cannot focus it.
    const compact = document.createElement('div')
    compact.style.display = 'none'
    compact.innerHTML = '<button>Menu</button>'
    titleBar.prepend(compact)
    map.focus()
    press()
    expect(document.activeElement).toBe(dock.querySelector('button'))
    press()
    expect(document.activeElement).toBe(menu)
    press()
    expect(document.activeElement).toBe(railTool)
    press()
    expect(document.activeElement).toBe(map)
    press(true)
    press(true)
    expect(document.activeElement).toBe(menu)
  })

  it('returns to the control last focused in a region', () => {
    dockField.focus()
    press()
    expect(document.activeElement).toBe(menu)
    press(true)
    expect(document.activeElement).toBe(dockField)
  })

  it('starts at the title bar from outside every region and skips a closed panel', () => {
    releases.shift()!()
    dock.remove()
    document.body.focus()
    press()
    expect(document.activeElement).toBe(menu)
    map.focus()
    press()
    expect(document.activeElement).toBe(menu)
  })

  it('stands aside while a dialog is open, and for Ctrl or Alt F6', () => {
    map.focus()
    const release = holdModalLayer()
    try {
      expect(focusOwner.cycleRegion(1)).toBe(false)
      expect(press().defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(map)
    } finally {
      release()
    }
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true, bubbles: true }))
    expect(document.activeElement).toBe(map)
  })

  it('F6 to the map focuses the host', () => {
    // A handle beside the selection lives inside the map host; F6 never lands on it.
    map.innerHTML = '<div data-canvas-handle-layer="true"><button type="button" data-canvas-handle="rotate">Rotate</button></div>'
    const handle = map.querySelector('button')!
    handle.focus()
    press()
    expect(document.activeElement).toBe(dock.querySelector('button'))
    press(true)
    expect(document.activeElement).toBe(map)

    // From outside the map too.
    handle.focus()
    menu.focus()
    press()
    press()
    expect(document.activeElement).toBe(map)
  })

  it('F6 reaches a region registered through useFocusRegion until it unmounts', async () => {
    // The title bar, tool rail, map, dock and phone sheet register through useFocusRegion, which registers with the owner.
    for (const release of releases.splice(0)) release()
    const host = document.createElement('div')
    document.body.append(host)
    function Rail() {
      const ref = useRef<HTMLDivElement>(null)
      useFocusRegion(ref, 'tool-rail')
      return h('div', { ref }, h('button', { type: 'button', 'data-rail-tool': '' }, 'Select'))
    }
    await act(async () => { render(h(Rail, null), host) })
    const tool = host.querySelector<HTMLButtonElement>('[data-rail-tool]')!
    document.body.focus()
    expect(focusOwner.cycleRegion(1)).toBe(true)
    expect(document.activeElement).toBe(tool)

    await act(async () => { render(null, host) })
    document.body.focus()
    expect(focusOwner.cycleRegion(1)).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('focus moves go through the focus owner', () => {
  let map: HTMLDivElement
  let elsewhere: HTMLButtonElement
  let release: () => void

  beforeEach(() => {
    map = document.createElement('div')
    map.tabIndex = 0
    elsewhere = document.createElement('button')
    document.body.append(map, elsewhere)
    release = focusOwner.registerRegion('map', map)
  })

  afterEach(() => {
    release()
    vi.restoreAllMocks()
    setCurrentCanvasSession(null)
    document.body.innerHTML = ''
  })

  it('leaving a story returns focus to the map through the owner', async () => {
    replaceCurrentDesignState(storyDesign(), null, 'Stories')
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ sessionPlane: createSessionPlane(TEST_GEO_ORIGIN) }),
    }))
    const focusMap = vi.spyOn(focusOwner, 'focusMap')
    try {
      expect(presentStory('tour', 0)).toBe(true)
      elsewhere.focus()
      leaveStoryPresentation()
      await vi.waitFor(() => expect(focusMap).toHaveBeenCalledWith())
      expect(document.activeElement).toBe(map)
    } finally {
      leaveStoryPresentation()
      clearCurrentDesignState()
    }
  })

  it('a plant popover opened with no anchor gives focus back to the map through the owner', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const container = document.createElement('div')
    document.body.append(container)
    currentCanvasSelection.value = new Set(['plant-1'])
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: {
        ...createTestCanvasQuerySurface(),
        getSelectedPlantColorContext: () => ({
          plantIds: ['plant-1'],
          singleSpeciesCanonicalName: 'Malus domestica',
          singleSpeciesCommonName: 'Apple',
          sharedCurrentColor: null,
          suggestedColor: null,
          singleSpeciesDefaultColor: null,
        }),
      },
    }))
    const canvasRef = createRef<HTMLDivElement>()
    canvasRef.current = map
    const focusMap = vi.spyOn(focusOwner, 'focusMap')
    try {
      plantColorMenuOpen.value = true
      await act(async () => { render(h(PlantAppearancePopovers, { canvasRef }), container) })
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(plantColorMenuOpen.value).toBe(false)
      expect(focusMap).toHaveBeenCalledWith()
      expect(document.activeElement).toBe(map)
    } finally {
      plantColorMenuOpen.value = false
      currentCanvasSelection.value = new Set()
      await act(async () => { render(null, container) })
      vi.unstubAllGlobals()
    }
  })
})

/** A Design with one story of one step, enough to present and leave it. */
function storyDesign(): CanopiFile {
  return {
    version: 9, name: 'Stories', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR',
    views: [],
    stories: [{ id: 'tour', name: 'Client visit', steps: [{ id: 's1', view_id: 'missing', title: 'The site', text: [], images: [] }] }],
    created_at: '', updated_at: '',
    extra: {},
  }
}
