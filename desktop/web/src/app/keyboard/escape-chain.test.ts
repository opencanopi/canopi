// @vitest-environment jsdom

// The Esc chain through the key router (spec §3.7, §1.6 steps 4 and 8; fixtures I8, I10): the canvas port's layers, a
// popover and the Site data pin, each an Esc layer, and one Esc runs one of them.
import { signal } from '@preact/signals'
import { h, render, type ComponentChild } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_KEY_PLATFORM } from '../../__tests__/support/key-router'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { PlantColorMenu } from '../../components/canvas/PlantColorMenu'
import { plantColorMenuOpen } from '../../canvas/plant-color-menu-state'
import { setCurrentCanvasSession } from '../../canvas/session'
import { currentCanvasSelection } from '../../canvas/session-state'
import type { ToolHost } from '../../canvas/runtime/interaction-ports'
import type { ToolId } from '../../canvas/runtime/interaction-types'
import { createCanvasKeyboardPort } from '../../canvas/runtime/keyboard-port'
import type { CanvasEscapeLayer, CanvasKeyboardPort } from '../../canvas/runtime/runtime'
import { TOOL_ROWS } from '../command-table'
import { ESCAPE_PRIORITY, registerEscapeLayer } from './escape-chain'
import { installKeyRouter, type KeyRouterHandle } from './key-router'
import { CANVAS_KEYMAP_ROWS } from './keymap'

/** A shown Site data pin as its Esc layer (site-transients.ts registers the real one); `unpin` records each Esc. */
const unpin = vi.fn()
function pinLayer(): () => void {
  return registerEscapeLayer({ priority: ESCAPE_PRIORITY['site-pin'], isActive: () => true, escape: () => { unpin(); return true } })
}

/** The canvas as the keyboard port sees it: the armed tool, its draft or row source, a live drag, the selection. */
interface CanvasState {
  tool: ToolId
  transient: boolean
  live: boolean
  selected: boolean
  /** The map is zoomed out to overview. */
  overview?: boolean
}

let host: HTMLDivElement
let canvas: CanvasState
let port: CanvasKeyboardPort
/** The canvas layers the port ran, in order. */
let ran: CanvasEscapeLayer[]
let router: KeyRouterHandle | null
let mounts: HTMLElement[]

/** The live keyboard port over a canvas whose tool, draft, drag and selection each test sets. */
function canvasPort(): CanvasKeyboardPort {
  const toolHost = {
    command: (c: { kind: string }) => {
      if (c.kind !== 'escape' || !canvas.transient) return 'pass'
      canvas.transient = false
      return 'handled'
    },
    hasNudgeSeries: () => false,
    endNudgeSeries: () => {},
    activeToolIsSelect: () => canvas.tool === 'select',
    activeToolHasEscapeTransient: () => canvas.transient,
    activeToolEscSteps: () => TOOL_ROWS[canvas.tool].escSteps,
    openTextEntryMode: () => null,
    interrupted: () => {},
  } as unknown as ToolHost
  const live = createCanvasKeyboardPort({
    host,
    toolHost,
    hasSelection: () => canvas.selected,
    navigation: { panByPx: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), resetNorth: vi.fn(), rotateBy: vi.fn() },
    session: {
      pointerSessionLive: () => canvas.live,
      overview: () => canvas.overview ?? false,
      handleFocused: () => false,
      spaceHeld: () => false,
      keyState: () => {},
      escapeGesture: () => { canvas.live = false },
      escapeTool: () => { canvas.tool = 'select'; canvas.transient = false },
      clearSelection: () => { canvas.selected = false },
    },
  })
  return {
    ...live,
    escape(layer) {
      ran.push(layer)
      live.escape(layer)
    },
  }
}

function install(): void {
  router = installKeyRouter({
    target: window,
    keymap: CANVAS_KEYMAP_ROWS,
    commands: { run: () => false },
    canvas: () => port,
    singleKeys: signal(true),
    focus: { cycleRegion: () => false },
    isModalOpen: () => false,
    platform: TEST_KEY_PLATFORM,
    document,
  })
}

function escape(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

function mount(vnode: ComponentChild): void {
  const root = document.createElement('div')
  document.body.append(root)
  mounts.push(root)
  act(() => render(vnode, root))
}

/** A focusable element outside the map, as a side-panel list row or a rail button is. */
function outside(tag: 'li' | 'button', container?: HTMLElement): HTMLElement {
  const element = document.createElement(tag)
  element.tabIndex = 0
  ;(container ?? document.body).append(element)
  element.focus()
  return element
}

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  document.body.append(host)
  canvas = { tool: 'select', transient: false, live: false, selected: false }
  ran = []
  mounts = []
  port = canvasPort()
  router = null
  unpin.mockClear()
})

afterEach(() => {
  router?.dispose()
  for (const root of mounts) act(() => render(null, root))
  plantColorMenuOpen.value = false
  currentCanvasSelection.value = new Set()
  setCurrentCanvasSession(null)
  document.body.replaceChildren()
})

describe('the Esc chain', () => {
  it("names spec §3.7's layers and no other: the raster inspection is gone with Read values (canopi-f47t.42)", () => {
    expect(ESCAPE_PRIORITY).toEqual({
      popover: 100,
      gesture: 70,
      'nudge-series': 65,
      'tool-transient': 60,
      tool: 50,
      selection: 30,
      profile: 25,
      'site-pin': 20,
    })
  })

  it('Esc with an open popover closes only the popover (I8)', () => {
    install()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: {
        ...createTestCanvasQuerySurface(),
        getSelectedPlantColorContext: () => ({
          plantIds: ['plant-1'],
          singleSpeciesCanonicalName: 'Malus domestica',
          singleSpeciesCommonName: 'Apple',
          sharedCurrentColor: '#C8A51E',
          suggestedColor: null,
          singleSpeciesDefaultColor: null,
        }),
      },
    }))
    currentCanvasSelection.value = new Set(['plant-1'])
    plantColorMenuOpen.value = true
    canvas = { tool: 'polygon', transient: true, live: false, selected: true }
    mount(h(PlantColorMenu, { buttonRef: { current: null } }))
    host.focus()

    expect(escape(host).defaultPrevented).toBe(true)
    expect(plantColorMenuOpen.value).toBe(false)
    expect(ran).toEqual([])
    expect(canvas).toEqual({ tool: 'polygon', transient: true, live: false, selected: true })
    escape(host)
    expect(canvas).toEqual({ tool: 'polygon', transient: false, live: false, selected: true })
    escape(host)
    expect(canvas.tool).toBe('select')
    expect(canvas.selected).toBe(true)
    expect(ran).toEqual(['tool-transient', 'tool'])
    vi.unstubAllGlobals()
  })

  it('Esc after arming from the rail cancels the tool', () => {
    install()
    const rail = document.createElement('div')
    rail.setAttribute('role', 'toolbar')
    document.body.append(rail)
    canvas = { tool: 'rectangle', transient: false, live: false, selected: false }
    const button = outside('button', rail)

    expect(escape(button).defaultPrevented).toBe(true)
    expect(canvas.tool).toBe('select')
    expect(ran).toEqual(['tool'])
  })

  it('Esc with focus in a side panel cancels the tool but keeps the selection', () => {
    install()
    canvas = { tool: 'rectangle', transient: false, live: false, selected: true }
    const row = outside('li')

    escape(row)
    expect(canvas.tool).toBe('select')
    expect(escape(row).defaultPrevented).toBe(false)
    expect(canvas.selected).toBe(true)
    // With the map focused, or nothing, the next Esc clears it.
    host.focus()
    escape(host)
    expect(canvas.selected).toBe(false)
    expect(ran).toEqual(['tool', 'selection'])
  })

  it('after the tool and the selection, an Esc clears the profile, and the next unpins the Site data point (canopi-f47t.42)', () => {
    install()
    const shown = { profile: true, 'site-pin': true }
    const site: string[] = []
    const releases = (['profile', 'site-pin'] as const).map((layer) => registerEscapeLayer({
      priority: ESCAPE_PRIORITY[layer],
      isActive: () => shown[layer],
      escape: () => {
        shown[layer] = false
        site.push(layer)
        return true
      },
    }))
    canvas = { tool: 'profile', transient: true, live: false, selected: true }
    host.focus()

    const done: string[] = []
    for (let press = 0; press < 5; press += 1) {
      const before = ran.length
      escape(host)
      done.push(ran.length > before ? `canvas.${ran[ran.length - 1]}` : site.at(-1) ?? 'none')
    }

    expect(done).toEqual(['canvas.tool-transient', 'canvas.tool', 'canvas.selection', 'profile', 'site-pin'])
    for (const release of releases) release()
  })

  it('an Esc that aborts a drag keeps the inspection lens open (I10)', () => {
    install()
    canvas = { tool: 'select', transient: false, live: true, selected: true }
    // The lens panel closes itself on an Esc it hears and stops it there (InspectionLens.tsx).
    const lens = document.createElement('section')
    lens.tabIndex = 0
    const closeLens = vi.fn()
    lens.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeLens()
    })
    document.body.append(lens)
    lens.focus()

    expect(escape(lens).defaultPrevented).toBe(true)
    expect(canvas.live).toBe(false)
    expect(closeLens).not.toHaveBeenCalled()
    expect(canvas.selected).toBe(true)
    expect(ran).toEqual(['gesture'])
    // With nothing live the lens hears the next Esc first.
    escape(lens)
    expect(closeLens).toHaveBeenCalledOnce()
    expect(ran).toEqual(['gesture'])
  })

  it('Esc in overview with nothing live unpins, from the map or a control', () => {
    install()
    const release = pinLayer()
    canvas = { tool: 'polygon', transient: false, live: false, selected: false, overview: true }
    host.focus()

    expect(escape(host).defaultPrevented).toBe(true)
    expect(unpin).toHaveBeenCalledOnce()
    expect(escape(outside('button')).defaultPrevented).toBe(true)
    expect(unpin).toHaveBeenCalledTimes(2)
    expect(ran).toEqual([])
    expect(canvas.tool).toBe('polygon')
    release()
  })

  it('Esc in overview with a pan live ends the pan and keeps the pin', () => {
    install()
    const release = pinLayer()
    canvas = { tool: 'select', transient: false, live: true, selected: false, overview: true }
    host.focus()

    expect(escape(host).defaultPrevented).toBe(true)
    expect(ran).toEqual(['gesture'])
    expect(canvas.live).toBe(false)
    expect(unpin).not.toHaveBeenCalled()
    release()
  })
})
