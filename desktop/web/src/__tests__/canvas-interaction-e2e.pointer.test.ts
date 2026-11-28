// @vitest-environment jsdom

// The canvas interaction end to end through the session (canvas v2 plan §4): the native context menu and the overview's
// primary drag, the pointer cases phase 2's right button changes.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { currentCanvasSelection } from '../canvas/session-state'
import type { ScenePoint, SceneStore } from '../canvas/runtime/scene'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import {
  contextMenuHost,
  createInteractionDeps,
  plantTarget,
  captureWindowErrors,
  makePlant,
  makeRectZone,
  rotationHandle,
  installSceneInteractionFixture,
  enterOverview,
} from './support/canvas-interaction-setup'
import type { TestView } from './support/test-view'
import type { InputPlatform } from '../canvas/runtime/input/platform'

const MAC: InputPlatform = { os: 'mac', gestureEvents: true }
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const { createTestSession, openContextMenu } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  const world = (at: ScenePoint) => testView.view().screenToWorld(at)
  const screen = (at: ScenePoint) => testView.view().worldToScreen(at)

  it('suppresses native context menus only on canvas interaction surfaces', () => {
    // The rotation handle sits above the drawn shapes (select/selection-hull.ts), so the selected zone must exist.
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [{ x: 160, y: 100 }, { x: 220, y: 150 }])]
    })
    const deps = {
      ...createInteractionDeps(container, store, testView),
      getDesignObjectSelection: () => ({
        editableTargets: [{ kind: 'zone' as const, id: 'zone-1' }],
        lockedTargets: [],
        blockedTargets: [],
        bounds: { minX: 160, minY: 100, maxX: 220, maxY: 150 },
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    }
    const session = createTestSession(deps)
    session.refreshMeasurements()

    const canvasContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    container.dispatchEvent(canvasContext)
    expect(canvasContext.defaultPrevented).toBe(true)

    const handle = rotationHandle(container)!
    const handleContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    handle.dispatchEvent(handleContext)
    expect(handleContext.defaultPrevented).toBe(true)

    const canvasInput = document.createElement('input')
    container.appendChild(canvasInput)
    const inputContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    canvasInput.dispatchEvent(inputContext)
    expect(inputContext.defaultPrevented).toBe(false)

    const canvasMenu = document.createElement('div')
    canvasMenu.setAttribute('role', 'menu')
    container.appendChild(canvasMenu)
    const menuContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    canvasMenu.dispatchEvent(menuContext)
    expect(menuContext.defaultPrevented).toBe(false)

    const canvasDialog = document.createElement('dialog')
    container.appendChild(canvasDialog)
    const dialogContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    canvasDialog.dispatchEvent(dialogContext)
    expect(dialogContext.defaultPrevented).toBe(false)

    const outsidePanel = document.createElement('div')
    document.body.appendChild(outsidePanel)
    const outsideContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    outsidePanel.dispatchEvent(outsideContext)
    expect(outsideContext.defaultPrevented).toBe(false)

    session.dispose()
    outsidePanel.remove()
  })

  it('A11: a right press during a plant move is ignored, with no pan and no menu, and the move commits', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('plant-2', 'Pyrus communis', { x: 120, y: 30 }),
      ]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.arm('select')
    deps.setSelection([plantTarget('plant-1')])
    const before = testView.viewport()

    events.pointerDown(screen({ x: 20, y: 30 }), { pointerId: 31 })
    events.pointerMove(screen({ x: 40, y: 50 }), { pointerId: 31, buttons: 1 })
    // The right button joins the left one's pointer (a chord: no pointerdown), and Linux sends its menu at the press.
    events.pointerMove(screen({ x: 45, y: 55 }), { pointerId: 31, buttons: 3 })
    const contextPoint = events.clientPoint(screen({ x: 120, y: 30 }))
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: contextPoint.x, clientY: contextPoint.y })
    container.dispatchEvent(contextMenu)
    events.pointerMove(screen({ x: 50, y: 60 }), { pointerId: 31, buttons: 1 })
    events.pointerUp(screen({ x: 50, y: 60 }), { pointerId: 31 })

    expect(contextMenu.defaultPrevented).toBe(true)
    expect(contextMenuHost.opened).toHaveLength(0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    const moved = store.persisted.plants.find((plant) => plant.id === 'plant-1')?.position
    expect(moved?.x).toBeCloseTo(50, 6)
    expect(moved?.y).toBeCloseTo(60, 6)
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    expect(testView.viewport()).toEqual(before)
    session.dispose()
  })

  it('a still right-click on a plant opens its menu at the release, not at the press or the native contextmenu', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.arm('select')

    events.pointerDown({ x: 20, y: 30 }, { button: 2 })
    const point = events.clientPoint({ x: 20, y: 30 })
    // Linux and macOS send the native menu at the press.
    const atPress = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y })
    container.dispatchEvent(atPress)
    expect(atPress.defaultPrevented).toBe(true)
    expect(contextMenuHost.current).toBeNull()
    events.pointerUp({ x: 21, y: 30 }, { button: 2 })

    expect(contextMenuHost.opened).toHaveLength(1)
    expect(contextMenuHost.current?.anchor).toEqual({ left: 21, top: 30, right: 21, bottom: 30 })
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-1')])
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    session.dispose()
  })

  it.each([
    'select', 'hand', 'plant-stamp', 'text', 'line', 'measurement-guide', 'rectangle', 'ellipse', 'polygon', 'object-stamp',
    'saved-object-stamp', 'plant-spacing',
  ] as const)('A9: a 150 px right-drag under %s pans the map, opens no menu and edits nothing', (tool) => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.arm(tool)
    const scene = structuredClone(store.persisted)
    const before = testView.viewport()

    events.pointerDown({ x: 100, y: 100 }, { button: 2 })
    events.pointerMove({ x: 102, y: 100 }, { buttons: 2 })
    events.pointerMove({ x: 250, y: 100 }, { buttons: 2 })
    events.pointerUp({ x: 250, y: 100 }, { button: 2 })
    const trailing = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    container.dispatchEvent(trailing)

    expect(testView.viewport().x).toBeCloseTo(before.x + 150, 6)
    expect(testView.viewport().y).toBeCloseTo(before.y, 6)
    expect(trailing.defaultPrevented).toBe(true)
    expect(contextMenuHost.opened).toHaveLength(0)
    expect(store.persisted).toEqual(scene)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('A9: a polygon draft keeps its corners on the ground through a right-drag pan, and its next click adds the third', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.arm('polygon')
    const first = world({ x: 20, y: 20 })
    const second = world({ x: 80, y: 20 })
    events.pointerDown({ x: 20, y: 20 })
    events.pointerUp({ x: 20, y: 20 })
    events.pointerDown({ x: 80, y: 20 })
    events.pointerUp({ x: 80, y: 20 })

    events.pointerDown({ x: 100, y: 100 }, { button: 2 })
    events.pointerMove({ x: 200, y: 100 }, { buttons: 2 })
    events.pointerUp({ x: 200, y: 100 }, { button: 2 })
    // The corners stayed on the ground: 100 px to the right on screen.
    const third = world({ x: 180, y: 80 })
    events.pointerDown({ x: 180, y: 80 })
    events.pointerUp({ x: 180, y: 80 })
    events.keyDown({ key: 'Enter', target: container })

    expect(store.persisted.zones).toHaveLength(1)
    const points = store.persisted.zones[0]!.points
    expect(points).toEqual([first, second, third])
    expect(third.x).toBeCloseTo(second.x, 6)
    expect(contextMenuHost.opened).toHaveLength(0)
    session.dispose()
  })

  it('B1, B2: on a Mac a Control-click on a plant opens its menu with no toggle, and a Control-drag pans', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('plant-2', 'Pyrus communis', { x: 120, y: 30 }),
      ]
    })
    const deps = { ...createInteractionDeps(container, store, testView), platform: MAC }
    const session = createTestSession(deps)
    session.arm('select')
    deps.setSelection([plantTarget('plant-2')])

    events.pointerDown({ x: 20, y: 30 }, { ctrlKey: true })
    events.pointerUp({ x: 20, y: 30 }, { ctrlKey: true })
    expect(contextMenuHost.opened).toHaveLength(1)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    contextMenuHost.reset()
    const before = testView.viewport()
    events.pointerDown({ x: 200, y: 200 }, { ctrlKey: true })
    events.pointerMove({ x: 260, y: 220 }, { buttons: 1, ctrlKey: true })
    events.pointerUp({ x: 260, y: 220 }, { ctrlKey: true })
    expect(testView.viewport().x).toBeCloseTo(before.x + 60, 6)
    expect(testView.viewport().y).toBeCloseTo(before.y + 20, 6)
    expect(contextMenuHost.opened).toHaveLength(0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    session.dispose()
  })

  it('D1, D2: a pen barrel tap on a plant opens its menu, and a barrel drag pans', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.arm('polygon')
    const barrel = { pointerType: 'pen', pointerId: 7, button: 2 } as const

    events.pointerDown({ x: 20, y: 30 }, barrel)
    events.pointerUp({ x: 20, y: 30 }, barrel)
    expect(contextMenuHost.opened).toHaveLength(1)
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([plantTarget('plant-1')])

    contextMenuHost.reset()
    const before = testView.viewport()
    events.pointerDown({ x: 200, y: 200 }, barrel)
    events.pointerMove({ x: 230, y: 240 }, { pointerType: 'pen', pointerId: 7, buttons: 2 })
    events.pointerUp({ x: 230, y: 240 }, barrel)
    expect(testView.viewport().x).toBeCloseTo(before.x + 30, 6)
    expect(testView.viewport().y).toBeCloseTo(before.y + 40, 6)
    expect(contextMenuHost.opened).toHaveLength(0)
    expect(store.persisted.zones).toHaveLength(0)
    session.dispose()
  })

  it('A13: Shift+right-drag turns the view about the press, in 15° steps while mod is held', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    container.focus()
    const bearing = () => testView.view().camera.bearingDeg

    events.pointerDown({ x: 100, y: 100 }, { button: 2, shiftKey: true })
    events.pointerMove({ x: 120, y: 100 }, { buttons: 2, shiftKey: true })
    expect(bearing()).toBeCloseTo(16, 6)
    events.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true, shiftKey: true, target: container })
    expect(bearing()).toBeCloseTo(15, 6)
    events.keyUp({ key: 'Control', code: 'ControlLeft', shiftKey: true, target: container })
    expect(bearing()).toBeCloseTo(16, 6)
    events.pointerUp({ x: 120, y: 100 }, { button: 2, shiftKey: true })
    expect(contextMenuHost.opened).toHaveLength(0)
    session.dispose()
  })

  it('quarantines a press when admission recovery throws, but lets a context menu or a drop reach the app', () => {
    const admissionFailure = new Error('admission recovery failed')
    const deps = createInteractionDeps(container, store, testView, {
      commandAdmission: {
        revision: signal(0),
        runWhenSettled: () => {
          throw admissionFailure
        },
      },
    })
    createTestSession(deps)
    const downstreamPointerDown = vi.fn()
    const downstreamContextMenu = vi.fn()
    const downstreamDrop = vi.fn()
    container.addEventListener('pointerdown', downstreamPointerDown)
    container.addEventListener('contextmenu', downstreamContextMenu)
    container.addEventListener('drop', downstreamDrop)
    let pointerDown!: PointerEvent
    let contextMenu!: MouseEvent
    let drop!: DragEvent

    const errors = captureWindowErrors(() => {
      pointerDown = events.pointerDown({ x: 20, y: 30 })
      const point = events.clientPoint({ x: 20, y: 30 })
      contextMenu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      })
      container.dispatchEvent(contextMenu)
      drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperties(drop, {
        clientX: { configurable: true, value: point.x },
        clientY: { configurable: true, value: point.y },
        dataTransfer: { configurable: true, value: null },
      })
      container.dispatchEvent(drop)
    })

    // Only a press on the map host is quarantined; a drop rethrows and reaches the app. The context menu reaches no sink:
    // the source prevents it (its press is owned) and it goes on to the app.
    expect(errors).toEqual([admissionFailure, admissionFailure])
    expect(pointerDown.defaultPrevented).toBe(true)
    expect(downstreamPointerDown).not.toHaveBeenCalled()
    expect(downstreamContextMenu).toHaveBeenCalled()
    expect(downstreamDrop).toHaveBeenCalled()
  })

  it('a right press or middle pan whose release was lost leaves native menus off the map to the page (B4, A35)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const session = createTestSession(createInteractionDeps(container, store, testView))
    const panel = document.createElement('div')
    document.body.append(panel)
    const pageMenu = () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      panel.dispatchEvent(event)
      return event.defaultPrevented
    }

    // A still right press, then a move with no button: its up was lost, and the move is its release (U37), whose
    // native-menu trail ends 500 ms later.
    events.pointerDown({ x: 100, y: 100 }, { button: 2, buttons: 2 })
    expect(pageMenu()).toBe(true)
    events.pointerMove({ x: 101, y: 100 }, { buttons: 0 })
    now.mockReturnValue(1500)
    expect(pageMenu()).toBe(false)
    now.mockRestore()

    // A middle pan, then a move with no button.
    events.pointerDown({ x: 100, y: 100 }, { button: 1, buttons: 4 })
    events.pointerMove({ x: 140, y: 100 }, { buttons: 4 })
    events.pointerMove({ x: 150, y: 100 }, { buttons: 0 })
    expect(pageMenu()).toBe(false)
    panel.remove()
    session.dispose()
  })

  it('a chorded right button released first counts as its release: the native-menu trail starts at that move (U37)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const session = createTestSession(createInteractionDeps(container, store, testView))
    // WebView2's trail, retargeted to <html>, at a given time.
    const trailingMenu = (at: number) => {
      now.mockReturnValue(at)
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      document.documentElement.dispatchEvent(event)
      return event.defaultPrevented
    }

    // A still right press; the left button is chorded (buttons 3), then the right one released first (buttons 1).
    events.pointerDown({ x: 100, y: 100 }, { button: 2, buttons: 2 })
    now.mockReturnValue(1050)
    events.pointerMove({ x: 100, y: 100 }, { button: 0, buttons: 3 })
    now.mockReturnValue(1100)
    events.pointerMove({ x: 100, y: 100 }, { button: 2, buttons: 1 })

    expect(trailingMenu(1150)).toBe(true)
    expect(trailingMenu(1599)).toBe(true)
    expect(trailingMenu(1600)).toBe(false)
    expect(contextMenuHost.opened).toHaveLength(0)
    now.mockRestore()
    session.dispose()
  })

  it('a right release starts the trail only after a real chord over the canvas; one ending a stale left press starts none (U37)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const session = createTestSession(createInteractionDeps(container, store, testView))
    const panel = document.createElement('div')
    document.body.append(panel)
    const trailingMenu = (at: number) => {
      now.mockReturnValue(at)
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      document.documentElement.dispatchEvent(event)
      return event.defaultPrevented
    }

    // A real chord: a left press on the map, the right button added over it (buttons 3), the left released first and the
    // right last, whose pointerup reports button 2 (U36).
    events.pointerDown({ x: 100, y: 100 }, { button: 0, buttons: 1 })
    now.mockReturnValue(1050)
    events.pointerMove({ x: 100, y: 100 }, { button: 2, buttons: 3 })
    now.mockReturnValue(1100)
    events.pointerMove({ x: 100, y: 100 }, { button: 0, buttons: 2 })
    now.mockReturnValue(1150)
    events.pointerUp({ x: 100, y: 100 }, { button: 2, buttons: 0 })
    expect(trailingMenu(1200)).toBe(true)
    expect(trailingMenu(1650)).toBe(false)

    // A stale left press (its up lost off the window), then a right click on a panel: the right release ends the stale
    // press, but its session never saw the right button over the canvas, so the panel's own menu opens.
    now.mockReturnValue(3000)
    events.pointerDown({ x: 100, y: 100 }, { button: 0, buttons: 1 })
    now.mockReturnValue(3050)
    events.pointerMove({ x: 100, y: 100 }, { button: 2, buttons: 2, target: panel })
    now.mockReturnValue(3100)
    events.pointerUp({ x: 100, y: 100 }, { button: 2, buttons: 0, target: panel })
    expect(trailingMenu(3150)).toBe(false)
    panel.remove()
    now.mockRestore()
    session.dispose()
  })

  it('G7: in overview a left drag pans whatever the armed tool, selects nothing and draws nothing (U36)', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('bed', [{ x: 100, y: 100 }, { x: 500, y: 500 }])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.arm('rectangle')
    enterOverview(testView)
    const scene = structuredClone(store.persisted)
    const before = testView.viewport()

    // A click on the bed (at 0.05 px/m it spans (5, 5)–(25, 25) on screen) selects nothing; a drag pans.
    events.pointerDown({ x: 15, y: 15 }, { button: 0 })
    events.pointerUp({ x: 15, y: 15 }, { button: 0 })
    expect(store.session.selectedTargets).toEqual([])
    events.pointerDown({ x: 100, y: 100 }, { button: 0 })
    events.pointerMove({ x: 140, y: 125 }, { buttons: 1 })
    events.pointerUp({ x: 140, y: 125 }, { button: 0 })

    const after = testView.viewport()
    expect(after.x).toBeCloseTo(before.x + 40, 6)
    expect(after.y).toBeCloseTo(before.y + 25, 6)
    expect(after.scale).toBeCloseTo(before.scale, 9)
    expect(store.session.selectedTargets).toEqual([])
    expect(store.persisted).toEqual(scene)
    expect(onSceneEditCommit).not.toHaveBeenCalled()

    // A still right-click opens no menu there.
    const menu = openContextMenu({ x: 100, y: 100 })
    expect(menu.defaultPrevented).toBe(true)
    expect(contextMenuHost.opened).toHaveLength(0)
    session.dispose()
  })
})
