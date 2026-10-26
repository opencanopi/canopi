// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubTool, useStubTools, type StubTool } from '../../__tests__/support/tool-harness'
import {
  captureWindowErrors,
  createInteractionDeps,
  makePlant,
  plantTarget,
  enterOverview,
} from '../../__tests__/support/canvas-interaction-setup'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from '../../__tests__/support/canvas-interaction-events'
import { createTestView, type TestView } from '../../__tests__/support/test-view'
import { installCanvasKeyRouter } from '../../__tests__/support/key-router'
import type { KeyRouterHandle } from '../../app/keyboard/key-router'
import {
  clearPlantStampSource,
  readPlantStampSource,
  selectPlantStampSource,
  writePlantStampDragData,
} from '../plant-stamp-source'
import {
  clearSavedObjectStampSource,
  readSavedObjectStampDragPreviewSource,
  readSavedObjectStampName,
  readSavedObjectStampSource,
  selectSavedObjectStampSource,
  writeSavedObjectStampDragData,
} from '../saved-object-stamp-source'
import { setCanvasTool } from '../session-state'
import type { CanvasFocusPort } from './app-adapter'
import type { InputPlatform } from './input/platform'
import type { ToolHost, ToolHostDeps,PointerWorld } from './interaction-ports'
import {
  createSceneInteractionSession,
  type SceneInteractionSession,
  type SceneInteractionSessionDeps,
} from './interaction-session'
import { SceneStore } from './scene'
import type { SceneEditCoordinator, SceneEditTransaction } from './scene-runtime/transactions'
import type { DraftPresentation } from './tools/draft'
import { createPolygonTool } from './tools/polygon'
import { createSavedObjectStampTool } from './tools/saved-object-stamp'
import type { ToolSource } from './tools/tool'
import { createZoneDragTool } from './tools/zone-drag'
import '../../__tests__/support/camera-tolerance'

vi.mock('./tools/registry', () => ({ TOOL_REGISTRY: {} }))

/** Each ToolHost the sessions build, so a test can watch the calls the session makes on it. */
const builtHosts = vi.hoisted(() => [] as ToolHost[])
vi.mock('./tools/tool-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/tool-host')>()
  return {
    ...actual,
    createToolHost: (deps: ToolHostDeps) => {
      const host = actual.createToolHost(deps)
      builtHosts.push(host)
      return host
    },
  }
})

const PLATFORM: InputPlatform = { os: 'linux', gestureEvents: false }
const SPECIES = { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: 'mid', width_max_m: 4 }
const SAVED_STAMP_MIME = 'application/x.canopi.saved-object-stamp+json'

let container: HTMLDivElement
let events: SceneInteractionEventHarness
let testView: TestView
let store: SceneStore
let sessions: SceneInteractionSession[]
let keys: KeyRouterHandle

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  events = createSceneInteractionEventHarness(container)
  testView = createTestView({ screen: { width: 400, height: 300 }, viewport: { x: 0, y: 0, scale: 1 } })
  store = new SceneStore()
  sessions = []
  // Keys reach the latest session's port through the app's key router, as in the workspace.
  keys = installCanvasKeyRouter(() => sessions.at(-1)?.keyboard ?? null)
  clearPlantStampSource()
  clearSavedObjectStampSource()
})

afterEach(() => {
  keys.dispose()
  for (const session of sessions.splice(0).reverse()) session.dispose()
  builtHosts.length = 0
  events.dispose()
  container.remove()
  useStubTools()
  setCanvasTool('select')
  document.documentElement.removeAttribute('data-story-presenting')
  clearPlantStampSource()
  clearSavedObjectStampSource()
})

function recordingRenderer() {
  const drafts: (DraftPresentation | null)[] = []
  return {
    drafts,
    lastDraft: () => drafts.at(-1) ?? null,
    setDraft: (draft: DraftPresentation | null) => { drafts.push(draft) },
  }
}

function createSession(overrides: Partial<SceneInteractionSessionDeps> = {}): { session: SceneInteractionSession, deps: SceneInteractionSessionDeps } {
  const deps: SceneInteractionSessionDeps = { ...createInteractionDeps(container, store, testView), platform: PLATFORM, ...overrides }
  const session = createSceneInteractionSession(deps)
  sessions.push(session)
  return { session, deps }
}

/** The microtask after a species pick (the plant source reaches the tool once the picker's own update is done). */
async function afterPick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('the interaction session', () => {
  it('every raw pointerdown on the map host reaches rawPress before it is routed', () => {
    const order: string[] = []
    const select = stubTool('select', {
      gesture: (gesture) => {
        if (gesture.kind === 'press') order.push('press')
        return 'pass'
      },
    })
    useStubTools(select)
    const focus: CanvasFocusPort = {
      focusMap: vi.fn(() => { order.push('focus') }),
    }
    const nudge = { nudgeSelected: vi.fn(() => true), endNudge: vi.fn() }
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
    })
    const { deps } = createSession({ focus, nudge })
    deps.setSelection([plantTarget('plant-1')])
    container.focus()
    events.keyDown({ key: 'ArrowRight', target: container })
    expect(nudge.nudgeSelected).toHaveBeenCalledOnce()

    // A right press never reaches the host as a gesture, yet it commits the nudge series and, like any press, moves focus to the map (A33).
    events.pointerDown({ x: 10, y: 10 }, { button: 2 })
    events.pointerUp({ x: 10, y: 10 }, { button: 2 })
    expect(nudge.endNudge).toHaveBeenCalledExactlyOnceWith()
    expect(focus.focusMap).toHaveBeenCalledOnce()

    // A middle press pans, and still moves focus to the map.
    events.pointerDown({ x: 10, y: 10 }, { button: 1 })
    events.pointerUp({ x: 10, y: 10 }, { button: 1 })
    expect(focus.focusMap).toHaveBeenCalledTimes(2)
    expect(select.count('press')).toBe(0)

    order.length = 0
    events.pointerDown({ x: 30, y: 30 })
    expect(order).toEqual(['focus', 'press'])
  })

  it('a raw press carries its pointer id to rawPress', () => {
    useStubTools(stubTool('select'))
    createSession()
    const rawPress = vi.spyOn(builtHosts.at(-1)!, 'rawPress')

    events.pointerDown({ x: 30, y: 30 }, { pointerId: 7 })
    events.pointerDown({ x: 60, y: 30 }, { pointerId: 9, button: 1 })
    // The host skips the menu close and focus only for a live press from another pointer (today's _onPointerDown).
    expect(rawPress.mock.calls).toEqual([
      ['primary', { kind: 'surface' }, 7],
      ['middle', { kind: 'surface' }, 9],
    ])
  })

  it('a window blur feeds the recogniser, then calls interrupted', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 20 })
    events.pointerMove({ x: 60, y: 40 })
    rectangle.calls.length = 0
    events.windowBlur()
    // The recogniser ended the live drag (cancel 'blur'), then the host's interruption reached the tool.
    expect(rectangle.last('cancel')).toEqual({ kind: 'cancel', reason: 'blur' })
    expect(rectangle.calls).toEqual(['cancelTransient:navigate'])
    events.pointerUp({ x: 60, y: 40 })
    expect(rectangle.count('drag-end')).toBe(0)

    // Space held before the blur is released by it: the next primary drag draws instead of panning.
    events.holdSpace()
    events.windowBlur()
    const before = testView.viewport()
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 140, y: 120 })
    expect(rectangle.last('drag-start')).toBeDefined()
    expect(testView.viewport()).toEqual(before)
  })

  it('after a pointercancel during a Space drag, Space\'s auto-repeat re-arms the pan, so the next press pans', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    events.holdSpace()
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 120, y: 100 })
    events.pointerCancel({ x: 120, y: 100 })
    // The key is still down: its auto-repeat arrives before the next press.
    events.keyDown({ key: ' ', code: 'Space', repeat: true })
    const before = testView.viewport()
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 140, y: 120 })

    expect(rectangle.count('drag-start')).toBe(0)
    expect(testView.viewport()).not.toEqual(before)
  })

  it('a plant source chosen while armed reaches sourceChanged', async () => {
    const sources: (ToolSource | null)[] = []
    const stamp = stubTool('plant-stamp', {
      activate: (_ctx, source) => { sources.push(source) },
      sourceChanged: (source) => { sources.push(source) },
    })
    useStubTools(stamp)
    const { session } = createSession()
    session.setTool('plant-stamp')
    expect(sources).toEqual([null])

    const chosen = selectPlantStampSource(SPECIES)
    // The pick reaches the tool after the chooser's own update (a microtask), as today's Place plants here.
    expect(stamp.calls).not.toContain('sourceChanged')
    await afterPick()
    expect(sources).toEqual([null, { kind: 'species', species: chosen }])

    // Armed again with a source, the tool gets it at activation.
    session.setTool('select')
    selectPlantStampSource(SPECIES)
    session.setTool('plant-stamp')
    expect(sources.at(-1)).toEqual({ kind: 'species', species: readPlantStampSource() })
  })

  it('leaving Place plants clears its source', () => {
    useStubTools(stubTool('plant-stamp'))
    const { session } = createSession()
    selectPlantStampSource(SPECIES)
    session.setTool('plant-stamp')
    expect(readPlantStampSource()).not.toBeNull()

    session.setTool('select')
    expect(readPlantStampSource()).toBeNull()
  })

  it('a presented story shows no draft or handles', async () => {
    const draft: DraftPresentation = {
      shapes: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], style: { token: 'draft', widthPx: 2 } }],
    }
    const rectangle = stubTool('rectangle', {
      gesture: (gesture) => {
        if (gesture.kind === 'drag-move') rectangle.ctx().effects.setDraft(draft)
        return 'pass'
      },
    })
    useStubTools(rectangle)
    const renderer = recordingRenderer()
    const { session } = createSession({ renderer })
    session.setTool('rectangle')
    events.pointerDown({ x: 20, y: 20 })
    events.pointerMove({ x: 40, y: 40 })
    events.pointerMove({ x: 60, y: 60 })
    expect(renderer.lastDraft()).toEqual(draft)

    // Today's CSS hid every DOM preview while a story is presented (html[data-story-presenting]).
    document.documentElement.setAttribute('data-story-presenting', '')
    await Promise.resolve()
    expect(renderer.lastDraft()).toBeNull()
    events.pointerMove({ x: 80, y: 80 })
    expect(renderer.lastDraft()).toBeNull()

    document.documentElement.removeAttribute('data-story-presenting')
    await Promise.resolve()
    expect(renderer.lastDraft()).toEqual(draft)
  })

  it('a handled saved-stamp drop clears the drag source', () => {
    createSession().session.setTool('line')
    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() { return Array.from(dragData.keys()) },
      setData(type: string, value: string) { dragData.set(type, value) },
      getData(type: string) { return dragData.get(type) ?? '' },
    }
    writeSavedObjectStampDragData(dataTransfer, {
      id: 'stamp-1',
      name: 'Apple',
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
        }],
        zones: [],
        annotations: [],
        groups: [],
      }),
    })
    // During a drag the browser shows the drop target the type only: the preview reads the drag source.
    const hiddenData = { types: [SAVED_STAMP_MIME], getData: () => '' }
    expect(readSavedObjectStampDragPreviewSource(hiddenData)).not.toBeNull()

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    const point = events.clientPoint({ x: 120, y: 90 })
    Object.defineProperties(drop, {
      clientX: { configurable: true, value: point.x },
      clientY: { configurable: true, value: point.y },
      dataTransfer: { configurable: true, value: dataTransfer },
    })
    container.dispatchEvent(drop)

    expect(store.persisted.plants).toHaveLength(1)
    expect(readSavedObjectStampDragPreviewSource(hiddenData)).toBeNull()
  })

  it('a plant or saved stamp dropped on the overview fits the Design, places nothing and stays picked (canopi-n2cg)', async () => {
    useStubTools(stubTool('rectangle'), stubTool('plant-stamp'), stubTool('saved-object-stamp'))
    const returnToDesign = vi.fn(testView.navigation.returnToDesign)
    const { session } = createSession({ viewNavigation: { ...testView.navigation, returnToDesign } })
    session.setTool('rectangle')
    enterOverview(testView)
    const species = (transfer: DataTransferLike) => writePlantStampDragData(transfer, PEAR)

    expect(dispatchDrag('dragover', { x: 60, y: 60 }, species).dataTransfer!.dropEffect).toBe('copy')
    const drop = dispatchDrag('drop', { x: 60, y: 60 }, species)

    expect(drop.defaultPrevented).toBe(true)
    expect(returnToDesign).toHaveBeenCalledExactlyOnceWith({ around: 'view-centre' })
    expect(testView.viewport().scale).toBeGreaterThanOrEqual(0.1)
    expect(store.persisted.plants).toHaveLength(0)
    expect(readPlantStampSource()?.canonical_name).toBe('Pyrus communis')
    expect(session.tool).toBe('plant-stamp')

    // A saved stamp follows the plant rule.
    enterOverview(testView)
    const stamp = { version: 2, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }
    dispatchDrag('drop', { x: 60, y: 60 }, (transfer) => writeSavedObjectStampDragData(transfer, {
      id: 'stamp-1', name: '  Bed ', sort_order: 0, created_at: '2026-06-19T09:00:00Z', updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify(stamp),
    }))
    expect(returnToDesign).toHaveBeenCalledTimes(2)
    expect(readSavedObjectStampSource()).not.toBeNull()
    expect(readSavedObjectStampName(), 'the tool card names the dropped stamp, as when it is picked with Place').toBe('Bed')
    expect(session.tool).toBe('saved-object-stamp')
    expect(store.persisted.zones).toHaveLength(0)

    // A blank name reads as none, as with Place (stamp.name.trim() || null).
    enterOverview(testView)
    dispatchDrag('drop', { x: 60, y: 60 }, (transfer) => writeSavedObjectStampDragData(transfer, {
      id: 'stamp-2', name: '   ', sort_order: 1, created_at: '2026-06-19T09:00:00Z', updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify(stamp),
    }))
    expect(readSavedObjectStampName()).toBeNull()
  })

  describe('the Design pin in overview (canopi-n2cg)', () => {
    /** The pin's point is the plane origin, at (200, 150) on screen; its box, as CanvasOverview measures it, runs 20 px
     *  left and 16 px up of it, 120 px right and 16 px down. */
    const ON_PIN = { x: 190, y: 150 }
    const OFF_PIN = { x: 80, y: 60 }

    function overviewWithPin(overrides: Partial<SceneInteractionSessionDeps> = {}, tool: StubTool = stubTool('select')) {
      useStubTools(tool)
      const returnToDesign = vi.fn(testView.navigation.returnToDesign)
      const { session } = createSession({ viewNavigation: { ...testView.navigation, returnToDesign }, ...overrides })
      testView.setViewport({ x: 200, y: 150, scale: 0.05 })
      testView.navigation.setDesignPinExtent({ left: -20, top: -16, right: 120, bottom: 16 })
      expect(testView.frames.viewFrame.peek().mode).toBe('overview')
      return { session, returnToDesign }
    }

    const mouse = (buttons: number) => ({ pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons, timeStamp: 0 })
    const finger = (id: number, buttons: number) => ({ pointerType: 'touch', pointerId: id, isPrimary: id === 1, button: 0, buttons, timeStamp: 0 })

    it('a click on the pin fits the Design and gives the map focus; a click off it does nothing', () => {
      const { returnToDesign } = overviewWithPin()

      events.pointerDown(OFF_PIN, mouse(1))
      events.pointerUp(OFF_PIN, mouse(0))
      expect(returnToDesign).not.toHaveBeenCalled()
      expect(testView.frames.viewFrame.peek().mode).toBe('overview')

      container.blur()
      events.pointerDown(ON_PIN, mouse(1))
      events.pointerMove({ x: ON_PIN.x + 2, y: ON_PIN.y + 1 }, mouse(1))
      events.pointerUp({ x: ON_PIN.x + 2, y: ON_PIN.y + 1 }, mouse(0))
      expect(returnToDesign).toHaveBeenCalledExactlyOnceWith()
      expect(testView.frames.viewFrame.peek().mode).toBe('site')
      expect(document.activeElement).toBe(container)
    })

    it('a double-click on the pin fits the Design, and no press of its click series reaches the tool; a fresh click does', () => {
      const presses: number[] = []
      const tool = stubTool('select', {
        gesture: (gesture) => {
          if (gesture.kind === 'press') presses.push(gesture.clickCount)
          return 'pass'
        },
      })
      const { returnToDesign } = overviewWithPin({}, tool)
      const click = (detail: number, timeStamp: number) => {
        events.pointerDown(ON_PIN, { ...mouse(1), detail, timeStamp })
        events.pointerUp(ON_PIN, { ...mouse(0), detail, timeStamp: timeStamp + 40 })
      }

      click(1, 1000)
      expect(returnToDesign).toHaveBeenCalledOnce()
      expect(testView.frames.viewFrame.peek().mode).toBe('site')
      click(2, 1150)
      click(3, 1300)
      expect(presses).toEqual([])

      click(1, 3000)
      expect(presses).toEqual([1])
    })

    it('a drag that starts on the pin pans the map and fits nothing', () => {
      const { returnToDesign } = overviewWithPin()
      const before = testView.viewport()

      events.pointerDown(ON_PIN, mouse(1))
      events.pointerMove({ x: ON_PIN.x + 30, y: ON_PIN.y + 20 }, mouse(1))
      events.pointerUp({ x: ON_PIN.x + 30, y: ON_PIN.y + 20 }, mouse(0))

      expect(returnToDesign).not.toHaveBeenCalled()
      expect(testView.viewport().x - before.x).toBeCloseTo(30, 6)
      expect(testView.viewport().y - before.y).toBeCloseTo(20, 6)
    })

    it('a finger\'s tap on the pin fits the Design', () => {
      const { returnToDesign } = overviewWithPin()

      events.pointerDown(ON_PIN, finger(1, 1))
      events.pointerUp(ON_PIN, finger(1, 0))

      expect(returnToDesign).toHaveBeenCalledOnce()
    })

    it('a pinch with a still finger on the pin fits nothing, whichever finger lands or lifts first', () => {
      const { returnToDesign } = overviewWithPin()

      // The still finger on the pin lands first and lifts last.
      events.pointerDown(ON_PIN, finger(1, 1))
      events.pointerDown(OFF_PIN, finger(2, 1))
      events.pointerMove({ x: OFF_PIN.x - 30, y: OFF_PIN.y - 20 }, finger(2, 1))
      events.pointerUp({ x: OFF_PIN.x - 30, y: OFF_PIN.y - 20 }, finger(2, 0))
      events.pointerUp(ON_PIN, finger(1, 0))
      expect(returnToDesign).not.toHaveBeenCalled()

      // The finger on the pin lands second and lifts first.
      const pin = { x: ON_PIN.x + 60, y: ON_PIN.y + 10 }
      events.pointerDown(OFF_PIN, finger(3, 1))
      events.pointerDown(pin, finger(4, 1))
      events.pointerMove({ x: OFF_PIN.x - 30, y: OFF_PIN.y - 20 }, finger(3, 1))
      events.pointerUp(pin, finger(4, 0))
      events.pointerUp({ x: OFF_PIN.x - 30, y: OFF_PIN.y - 20 }, finger(3, 0))
      expect(returnToDesign).not.toHaveBeenCalled()
      expect(testView.frames.viewFrame.peek().mode).toBe('overview')
    })

    it('a mouse over the pin shows the pointer cursor and the pin\'s tooltip, until it moves off or leaves the map', () => {
      const hovers: boolean[] = []
      overviewWithPin({ publishDesignPinHover: (hovered) => { hovers.push(hovered) } })

      events.pointerMove(OFF_PIN, mouse(0))
      expect(hovers).toEqual([])
      events.pointerMove(ON_PIN, mouse(0))
      expect(hovers).toEqual([true])
      expect(container.style.cursor).toBe('pointer')
      events.pointerMove(OFF_PIN, mouse(0))
      expect(hovers).toEqual([true, false])
      expect(container.style.cursor).toBe('default')

      events.pointerMove(ON_PIN, mouse(0))
      events.pointerLeave(ON_PIN, mouse(0))
      expect(hovers).toEqual([true, false, true, false])
      expect(container.style.cursor).toBe('default')

      // A finger never hovers it.
      events.pointerMove(ON_PIN, finger(5, 0))
      expect(hovers).toEqual([true, false, true, false])
    })
  })

  it('a registered tool\'s transient history and spacing field go through the host', () => {
    const row = stubTool('plant-spacing', {
      canUndoTransient: () => true,
      canRedoTransient: () => false,
      command: (command) => command.kind === 'undo-transient' ? 'handled' : 'pass',
    })
    useStubTools(row)
    const { session } = createSession()
    session.setTool('plant-spacing')

    expect(session.canUndoTransientHistory()).toBe(true)
    expect(session.canRedoTransientHistory()).toBe(false)
    expect(session.undoTransientHistory()).toBe(true)
    expect(session.redoTransientHistory()).toBe(false)
    session.plantRowSpacing.input('2')
    session.plantRowSpacing.commit('2.5')
    session.plantRowSpacing.blur('3')
    session.plantRowSpacing.cancel()
    expect(row.commands).toEqual([
      { kind: 'undo-transient' },
      { kind: 'spacing-input', text: '2' },
      { kind: 'spacing-input', text: '2.5' },
      { kind: 'spacing-commit', via: 'enter' },
      { kind: 'spacing-input', text: '3' },
      { kind: 'spacing-commit', via: 'blur' },
      { kind: 'spacing-cancel' },
    ])
  })

  it('Space and a pointer pan show the navigation cursor over a registered tool\'s', () => {
    useStubTools(stubTool('rectangle'))
    const { session } = createSession()
    session.setTool('rectangle')
    expect(container.style.cursor).toBe('crosshair')

    container.focus()
    events.holdSpace()
    expect(container.style.cursor).toBe('grab')
    const before = testView.viewport()
    events.pointerDown({ x: 100, y: 100 })
    expect(container.style.cursor).toBe('grabbing')
    events.pointerMove({ x: 130, y: 110 })
    expect(testView.viewport()).toEqual({ x: before.x + 30, y: before.y + 10, scale: before.scale })
    events.pointerUp({ x: 130, y: 110 })
    // Today's cancel after a pan: the tool's cursor comes back even with Space still held.
    expect(container.style.cursor).toBe('crosshair')
    events.releaseSpace()
    expect(container.style.cursor).toBe('crosshair')
  })

  it('Esc cancels a registered tool\'s live press before the tool hears it', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')
    container.focus()

    events.pointerDown({ x: 20, y: 20 })
    events.pointerMove({ x: 60, y: 60 })
    const escape = events.keyDown({ key: 'Escape', cancelable: true, target: container })
    expect(escape.defaultPrevented).toBe(true)
    expect(rectangle.commands).toEqual([])
    expect(rectangle.last('cancel')).toEqual({ kind: 'cancel', reason: 'escape' })
    events.pointerUp({ x: 60, y: 60 })
    expect(rectangle.count('drag-end')).toBe(0)
  })

  it('a saved stamp chosen while armed reaches sourceChanged at once', () => {
    const sources: (ToolSource | null)[] = []
    useStubTools(stubTool('saved-object-stamp', { sourceChanged: (source) => { sources.push(source) } }))
    const { session } = createSession()
    session.setTool('saved-object-stamp')

    const stamp = selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [],
      zones: [],
      annotations: [],
      groups: [],
    } as unknown as Parameters<typeof selectSavedObjectStampSource>[0])
    expect(sources).toEqual([{ kind: 'saved-stamp', stamp }])
    session.setTool('select')
    expect(sources).toHaveLength(1)
  })

  it('the keyboard port\'s zoom and view keys move the camera through the view\'s navigation', () => {
    const render = vi.fn()
    const { session } = createSession({ render })
    const scale = testView.viewport().scale

    expect(session.keyboard.command({ kind: 'zoom-step', direction: 1 })).toBe(true)
    expect(testView.viewport().scale).toBeGreaterThan(scale)
    expect(render, 'the camera frame repaints the layer, not the session').not.toHaveBeenCalled()
    session.keyboard.command({ kind: 'zoom-step', direction: -1 })
    expect(testView.viewport().scale).toBeCloseTo(scale, 9)
    // The view keys answer here; navigation.test.ts holds the 15° turn and the turn back to north they start.
    expect(session.keyboard.command({ kind: 'reset-north' })).toBe(true)
    expect(session.keyboard.command({ kind: 'rotate-view', direction: 1 })).toBe(true)
  })

  it('mod pressed and released through the key router during a still Shift+middle rotate steps the view, then frees it (A8)', () => {
    createSession()
    const bearing = () => testView.view().camera.bearingDeg

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 4, button: 1, buttons: 4, shiftKey: true })
    events.pointerMove({ x: 140, y: 100 }, { pointerId: 4, buttons: 4, shiftKey: true })
    expect(bearing()).toBeCloseTo(32, 6)

    // The mouse stays still: only the key reaches the canvas, through the router and the session's keyboard port.
    events.keyDown({ key: 'Control', code: 'ControlLeft', ctrlKey: true, shiftKey: true })
    expect(bearing()).toBeCloseTo(30, 6)
    events.keyUp({ key: 'Control', code: 'ControlLeft', shiftKey: true })
    expect(bearing()).toBeCloseTo(32, 6)

    events.pointerUp({ x: 140, y: 100 }, { pointerId: 4, button: 1, buttons: 0 })
    // Released without moving, the turn ends where the freed view shows it, not at the stepped bearing.
    expect(bearing()).toBeCloseTo(32, 6)
  })

  it('on a Mac, Cmd pressed and released during a still Shift+middle rotate steps the view, then frees it (A8)', () => {
    createSession({ platform: { os: 'mac', gestureEvents: true } })
    const bearing = () => testView.view().camera.bearingDeg

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 4, button: 1, buttons: 4, shiftKey: true })
    events.pointerMove({ x: 140, y: 100 }, { pointerId: 4, buttons: 4, shiftKey: true })
    expect(bearing()).toBeCloseTo(32, 6)

    events.keyDown({ key: 'Meta', code: 'MetaLeft', metaKey: true, shiftKey: true })
    expect(bearing()).toBeCloseTo(30, 6)
    events.keyUp({ key: 'Meta', code: 'MetaLeft', shiftKey: true })
    expect(bearing()).toBeCloseTo(32, 6)

    events.pointerUp({ x: 140, y: 100 }, { pointerId: 4, button: 1, buttons: 0 })
    // Released without moving, the turn ends where the freed view shows it, not at the stepped bearing.
    expect(bearing()).toBeCloseTo(32, 6)
  })

  it('a Shift+middle rotate\'s release and its Esc run the tool\'s cleanup, as the pan it replaced did', () => {
    createSession()
    const released = vi.spyOn(builtHosts.at(-1)!, 'released')

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 4, button: 1, buttons: 4, shiftKey: true })
    events.pointerMove({ x: 140, y: 100 }, { pointerId: 4, buttons: 4, shiftKey: true })
    expect(released).not.toHaveBeenCalled()
    events.pointerUp({ x: 140, y: 100 }, { pointerId: 4, button: 1, buttons: 0 })
    expect(released).toHaveBeenCalledTimes(1)

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 5, button: 1, buttons: 4, shiftKey: true })
    events.pointerMove({ x: 140, y: 100 }, { pointerId: 5, buttons: 4, shiftKey: true })
    events.keyDown({ key: 'Escape', code: 'Escape' })
    expect(released).toHaveBeenCalledTimes(2)
    events.pointerUp({ x: 140, y: 100 }, { pointerId: 5, button: 1, buttons: 0 })
  })

  it('a right-drag whose release was lost ends at the move without its button and runs the cleanup its release would (A35)', () => {
    createSession()
    const released = vi.spyOn(builtHosts.at(-1)!, 'released')
    const before = testView.viewport()

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 6, button: 2 })
    events.pointerMove({ x: 140, y: 100 }, { pointerId: 6, buttons: 2 })
    events.pointerMove({ x: 160, y: 100 }, { pointerId: 6, buttons: 0 })
    expect(released).toHaveBeenCalledTimes(1)
    expect(testView.viewport().x).toBeCloseTo(before.x + 40, 6)
    expect(container.style.cursor).not.toBe('grabbing')
  })

  it('a WebKit pinch is no live pointer session until its twist passes 10°: Esc and the arrows keep working', () => {
    const { session } = createSession({ platform: { os: 'mac', gestureEvents: true } })
    const gesture = (type: string, rotation: number) => {
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        clientX: 200, clientY: 150, scale: 1.2, rotation, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      })
      container.dispatchEvent(event)
    }

    gesture('gesturestart', 0)
    gesture('gesturechange', 4)
    // A plain pinch: nothing is turning, so the keys act as without it.
    expect(session.keyboard.escapeLayers()).not.toContain('gesture')
    expect(session.keyboard.keyState({
      type: 'keydown', key: 'Shift', code: 'ShiftLeft', mods: { shift: true, ctrl: false, alt: false, meta: false },
      text: false, onCanvas: true,
    })).toBe('pass')
    // Past 10° the twist turns the view and is live: Esc cancels it first.
    gesture('gesturechange', 14)
    expect(session.keyboard.escapeLayers()[0]).toBe('gesture')
    gesture('gestureend', 14)
    expect(session.keyboard.escapeLayers()).not.toContain('gesture')
  })

  it('Profile\'s finished line and the Site data pin leave through the session deps (canopi-f47t.42)', () => {
    const line = [{ x: 10, y: 20 }, { x: 60, y: 20 }]
    const profile: StubTool = stubTool('profile', {
      gesture: (g) => {
        if (g.kind === 'tap') profile.ctx().effects.finishProfile(line)
        return 'pass'
      },
    })
    useStubTools(profile)
    const finishProfile = vi.fn()
    const pinAt = vi.fn()
    const { session } = createSession({ finishProfile, pinAt })
    session.setTool('profile')

    events.pointerDown({ x: 60, y: 20 }, { button: 0, detail: 0 })
    events.pointerUp({ x: 60, y: 20 }, { button: 0, detail: 0 })
    expect(finishProfile).toHaveBeenCalledWith(line)
    expect(pinAt).not.toHaveBeenCalled()

    session.setTool('hand')
    events.pointerDown({ x: 100, y: 100 }, { button: 0, detail: 0, timeStamp: 5000 })
    events.pointerUp({ x: 100, y: 100 }, { button: 0, detail: 0, timeStamp: 5050 })
    expect(pinAt).toHaveBeenCalledWith(testView.view().screenToWorld({ x: 100, y: 100 }))
  })

  it('a move with a button held and no press on the map publishes no pointer world point', () => {
    const { session } = createSession()
    session.setTool('line')
    const points: (PointerWorld | null)[] = []
    session.subscribePointerWorld((point) => { points.push(point) })

    events.pointerMove({ x: 100, y: 100 }, { target: container, buttons: 0 })
    expect(points).toHaveLength(1)
    // A press on a panel or a map control dragged across the map: today's lens skipped every move with a button held (the
    // held-button move that inspection-lens-ui.test.tsx dispatched on the host before the lens read subscribePointerWorld).
    events.pointerMove({ x: 120, y: 120 }, { target: container, buttons: 1 })
    // A right drag pans or turns the map, so the lens ignores its moves and keeps its point through them too.
    events.pointerDown({ x: 140, y: 140 }, { button: 2 })
    events.pointerMove({ x: 180, y: 160 }, { target: container, buttons: 2 })
    events.pointerUp({ x: 180, y: 160 }, { button: 2 })
    expect(points).toHaveLength(1)
    // A pen hovering with its barrel (the secondary button) or eraser held: the lens ignores both moves too.
    events.pointerMove({ x: 130, y: 130 }, { target: container, pointerType: 'pen', pointerId: 9, buttons: 2 })
    events.pointerMove({ x: 135, y: 130 }, { target: container, pointerType: 'pen', pointerId: 9, buttons: 32 })
    expect(points).toHaveLength(1)
    events.pointerMove({ x: 150, y: 150 }, { target: container, buttons: 0 })
    expect(points).toHaveLength(2)

    // A registered tool still hears such a move as a hover (today's hover ran), and the lens still keeps its point.
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    session.setTool('rectangle')
    events.pointerMove({ x: 160, y: 150 }, { target: container, buttons: 1 })
    expect(rectangle.count('hover')).toBe(1)
    expect(points).toHaveLength(2)
    events.pointerMove({ x: 170, y: 150 }, { target: container, buttons: 0 })
    expect(rectangle.count('hover')).toBe(2)
    expect(points).toHaveLength(3)
  })

  it('a pen drag that ends on the barrel commits its move, as today', () => {
    // Today's Line, on the host as the app registers it.
    useStubTools(createZoneDragTool('line'))
    const onSceneEditCommit = vi.fn()
    const { session } = createSession(createInteractionDeps(container, store, testView, { onSceneEditCommit }))
    session.setTool('line')
    const pen = { pointerId: 40, pointerType: 'pen' } as const

    events.pointerDown({ x: 20, y: 30 }, { ...pen, button: 0, buttons: 1 })
    // The barrel goes down mid-drag and the tip lifts first: the pointerup reports the barrel (button 2), and an up ends
    // its pointer's session whatever its button, as today's pointerup ended the drag.
    events.pointerMove({ x: 35, y: 45 }, { ...pen, buttons: 3 })
    events.pointerMove({ x: 35, y: 45 }, { ...pen, buttons: 2 })
    events.pointerUp({ x: 35, y: 45 }, { ...pen, button: 2, buttons: 0 })
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
    expect(store.persisted.zones).toHaveLength(1)
    const released = store.persisted.zones[0]!.points.map((point) => ({ ...point }))
    expect(released.at(-1)).not.toEqual(released[0])

    // The pen hovers on, then the browser's implicit capture release arrives: the line stays as it was released.
    events.pointerMove({ x: 80, y: 90 }, { ...pen, buttons: 0 })
    events.lostPointerCapture(40)
    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]?.points).toEqual(released)
    expect(onSceneEditCommit).toHaveBeenCalledOnce()
  })

  it('a hover that throws leaves the move to the rest of the app, under today\'s Line and a stub tool', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 100, y: 100 })]
    })
    useStubTools(createZoneDragTool('line'))
    let broken = false
    const { session } = createSession({
      setHoveredTarget: () => {
        if (broken) throw new Error('hover failed')
      },
    })
    session.setTool('line')
    const panel = document.createElement('div')
    document.body.appendChild(panel)
    const panelMoves = vi.fn()
    panel.addEventListener('pointermove', panelMoves)
    /** A hover over the plant (its restyle throws), then a move over a panel beside the map. */
    const failingHover = (x: number): unknown[] => {
      broken = true
      try {
        return captureWindowErrors(() => {
          events.pointerMove({ x, y: 100 }, { buttons: 0 })
          events.pointerMove({ x, y: 100 }, { target: panel, buttons: 0 })
        })
      } finally {
        broken = false
      }
    }

    try {
      // A failing hover over the map is reported without a quarantine, and the move over the panel never reaches the
      // canvas (no window listener without a press on the map): the panel hears it either way.
      expect(failingHover(100)).toHaveLength(1)
      expect(panelMoves).toHaveBeenCalledOnce()

      useStubTools(stubTool('rectangle'))
      session.setTool('rectangle')
      expect(failingHover(101)).toHaveLength(1)
      expect(panelMoves).toHaveBeenCalledTimes(2)
    } finally {
      panel.remove()
    }
  })

  it('a wheel whose zoom or pan fails under a registered tool is still default-prevented, as today', () => {
    useStubTools(stubTool('rectangle'))
    let broken = false
    const fail = <T extends unknown[]>(move: (...args: T) => void) => (...args: T) => {
      if (broken) throw new Error('camera move failed')
      move(...args)
    }
    const { session } = createSession({
      viewNavigation: {
        ...testView.navigation,
        panByPx: fail(testView.navigation.panByPx),
        zoomAroundPx: fail(testView.navigation.zoomAroundPx),
      },
    })
    session.setTool('rectangle')

    broken = true
    try {
      // Today's _onWheel prevented the wheel before it moved the camera: a failing zoom never let the page zoom.
      let zoom: WheelEvent | null = null
      expect(captureWindowErrors(() => { zoom = events.wheel({ x: 50, y: 50 }, { deltaY: -40, ctrlKey: true }) })).toHaveLength(1)
      expect(zoom!.defaultPrevented).toBe(true)
      let pan: WheelEvent | null = null
      expect(captureWindowErrors(() => { pan = events.wheel({ x: 50, y: 50 }, { deltaY: 40, shiftKey: true }) })).toHaveLength(1)
      expect(pan!.defaultPrevented).toBe(true)
    } finally {
      broken = false
    }
  })

  it('a session built with a stamp tool armed hands the tool its pick', () => {
    const sources: (ToolSource | null)[] = []
    const record = {
      activate: (_ctx: unknown, source: ToolSource | null) => { sources.push(source) },
      sourceChanged: (source: ToolSource | null) => { sources.push(source) },
    }
    useStubTools(stubTool('plant-stamp', record), stubTool('saved-object-stamp', record))

    // The map mounts (or mounts again) with Place plants armed and a species picked: today's tool read the pick live.
    const chosen = selectPlantStampSource(SPECIES)
    setCanvasTool('plant-stamp')
    const { session } = createSession()
    expect(sources.at(-1)).toEqual({ kind: 'species', species: chosen })
    session.dispose()

    const stamp = selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [],
      zones: [],
      annotations: [],
      groups: [],
    } as unknown as Parameters<typeof selectSavedObjectStampSource>[0])
    setCanvasTool('saved-object-stamp')
    createSession()
    expect(sources.at(-1)).toEqual({ kind: 'saved-stamp', stamp })
  })

  it('arming another tool during a registered tool\'s press ends the press with its capture and its pan', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle, stubTool('ellipse'))
    const { session } = createSession()
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 20 }, { pointerId: 4 })
    events.pointerMove({ x: 60, y: 40 }, { pointerId: 4 })
    expect(events.pointerCapture.has(4)).toBe(true)
    // The capture the host's press took goes at once, as today's tool change released it.
    session.setTool('ellipse')
    expect(events.pointerCapture.has(4)).toBe(false)
    events.pointerUp({ x: 60, y: 40 }, { pointerId: 4 })

    // A middle pan cut short the same way leaves no 'grabbing' behind for Space over the next registered tool.
    session.setTool('rectangle')
    events.pointerDown({ x: 100, y: 100 }, { pointerId: 5, button: 1 })
    events.pointerMove({ x: 130, y: 110 }, { pointerId: 5, button: 1 })
    expect(container.style.cursor).toBe('grabbing')
    session.setTool('ellipse')
    events.pointerUp({ x: 130, y: 110 }, { pointerId: 5, button: 1 })
    session.setTool('rectangle')
    container.focus()
    events.holdSpace()
    expect(container.style.cursor).toBe('grab')
    events.releaseSpace()
  })
})

/** A panel drag event over the map at a container point, carrying `data` (a species, by default nothing of ours). */
function dispatchDrag(type: 'dragover' | 'dragleave' | 'drop', at: { x: number, y: number }, data?: (transfer: DataTransferLike) => void): DragEvent {
  const dragData = new Map<string, string>()
  const dataTransfer: DataTransferLike = {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() { return Array.from(dragData.keys()) },
    setData(format: string, value: string) { dragData.set(format, value) },
    getData(format: string) { return dragData.get(format) ?? '' },
  }
  data?.(dataTransfer)
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const point = events.clientPoint(at)
  Object.defineProperties(event, {
    clientX: { configurable: true, value: point.x },
    clientY: { configurable: true, value: point.y },
    dataTransfer: { configurable: true, value: dataTransfer },
  })
  container.dispatchEvent(event)
  return event
}

interface DataTransferLike {
  effectAllowed: string
  dropEffect: string
  readonly types: readonly string[]
  setData(format: string, value: string): void
  getData(format: string): string
}

const PEAR = { canonical_name: 'Pyrus communis', common_name: 'Pear', stratum: 'mid', width_max_m: 3 }

/** A registered tool whose press opens a Scene Edit that its cancelTransient aborts. */
function editingTool(id: 'rectangle' | 'hand'): { readonly tool: StubTool, readonly open: () => boolean } {
  let edit: SceneEditTransaction | null = null
  const tool: StubTool = stubTool(id, {
    gesture: (gesture) => {
      if (gesture.kind === 'press') edit = tool.ctx().effects.edits.begin(`interaction-${id}`)
      return 'pass'
    },
    cancelTransient: () => {
      edit?.abort()
      edit = null
    },
  })
  return { tool, open: () => edit !== null }
}

describe('registered tools against today\'s session (0B-3 host rulings)', () => {
  it('a registered tool\'s press takes its capture after admission and before the tool hears it', () => {
    const captured: boolean[] = []
    const rectangle = stubTool('rectangle', {
      gesture: (gesture) => {
        if (gesture.kind === 'press') captured.push(events.pointerCapture.has(6))
        return 'pass'
      },
    })
    useStubTools(rectangle)
    const { session, deps } = createSession()
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 20 }, { pointerId: 6 })
    expect(captured).toEqual([true])
    events.pointerUp({ x: 20, y: 20 }, { pointerId: 6 })

    // A press the scene refuses takes no capture.
    const busy = deps.sceneEdits.begin('elsewhere')
    events.pointerDown({ x: 30, y: 30 }, { pointerId: 7 })
    expect(events.pointerCapture.setCalls).not.toHaveBeenCalledWith(7)
    expect(rectangle.count('press')).toBe(1)
    busy.abort()
  })

  it('a press whose pointer\'s last up was lost keeps the capture it takes; a refused one keeps neither capture', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    const { session, deps } = createSession()
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 20 }, { pointerId: 6 })
    events.pointerMove({ x: 40, y: 40 }, { pointerId: 6 })
    // The up is lost: pointer 6 presses again, ending its old session first.
    events.pointerDown({ x: 60, y: 60 }, { pointerId: 6 })
    expect(rectangle.count('press')).toBe(2)
    expect(events.pointerCapture.has(6)).toBe(true)
    events.pointerUp({ x: 60, y: 60 }, { pointerId: 6 })

    events.pointerDown({ x: 20, y: 20 }, { pointerId: 8 })
    const busy = deps.sceneEdits.begin('elsewhere')
    events.pointerDown({ x: 60, y: 60 }, { pointerId: 8 })
    expect(rectangle.count('press')).toBe(3)
    expect(events.pointerCapture.has(8)).toBe(false)
    busy.abort()
  })

  it('a capture lost synchronously while it is taken stops the press before the tool, as today', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, { pointerCapture: { synchronousLossOnSet: true } })
    const { tool: rectangle, open } = editingTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    events.pointerDown({ x: 20, y: 30 }, { pointerId: 24 })
    expect(events.pointerCapture.setCalls).toHaveBeenCalledWith(24)
    expect(events.pointerCapture.has(24)).toBe(false)
    expect(rectangle.count('press')).toBe(0)
    expect(open()).toBe(false)
    events.pointerMove({ x: 40, y: 50 }, { pointerId: 24 })
    events.pointerUp({ x: 40, y: 50 }, { pointerId: 24 })
    expect(rectangle.count('drag-start')).toBe(0)
  })

  it('leaving a registered tool cancels its press through the host even when the hover clear fails, and arms Select', () => {
    const { tool: rectangle, open } = editingTool('rectangle')
    useStubTools(rectangle, stubTool('select'))
    let failHover = false
    const { session } = createSession({
      setHoveredTarget: () => {
        if (failHover) throw new Error('hover cleanup failed')
      },
    })
    session.setTool('rectangle')
    events.pointerDown({ x: 20, y: 30 }, { pointerId: 15 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 15 })
    expect(open()).toBe(true)

    failHover = true
    expect(() => session.setTool('ellipse')).toThrow('hover cleanup failed')
    failHover = false
    expect(rectangle.last('cancel')).toEqual({ kind: 'cancel', reason: 'tool-change' })
    expect(open()).toBe(false)
    expect(events.pointerCapture.has(15)).toBe(false)
    expect(session.tool).toBe('select')
    expect(container.style.cursor).toBe('default')
  })

  it('entering a registered tool whose activation fails leaves Select armed', () => {
    let failActivation = true
    const rectangle = stubTool('rectangle', {
      activate: () => {
        if (failActivation) throw new Error('activation failed')
      },
    })
    // Today's Line, on the host as the app registers it.
    useStubTools(rectangle, createZoneDragTool('line'))
    const { session } = createSession()
    session.setTool('line')

    expect(() => session.setTool('rectangle')).toThrow('activation failed')
    failActivation = false
    expect(session.tool).toBe('select')
    // Select is armed again: a drag selects, it does not draw a line.
    events.pointerDown({ x: 20, y: 30 })
    events.pointerMove({ x: 60, y: 30 }, { buttons: 1 })
    events.pointerUp({ x: 60, y: 30 })
    expect(store.persisted.zones).toHaveLength(0)
    expect(rectangle.count('press')).toBe(0)

    session.setTool('rectangle')
    expect(session.tool).toBe('rectangle')
  })

  it('a fallback to Select after a failed activation clears the tool left\'s source', () => {
    let failActivation = true
    const rectangle = stubTool('rectangle', {
      activate: () => {
        if (failActivation) throw new Error('activation failed')
      },
    })
    useStubTools(stubTool('plant-stamp'), rectangle)
    const { session } = createSession()
    selectPlantStampSource(SPECIES)
    session.setTool('plant-stamp')
    expect(readPlantStampSource()).not.toBeNull()

    expect(() => session.setTool('rectangle')).toThrow('activation failed')
    failActivation = false
    expect(session.tool).toBe('select')
    expect(readPlantStampSource()).toBeNull()
  })

  it('a failed tool switch during a Shift+middle rotate cancels the turn, so the view keys work again', () => {
    let failActivation = true
    const rectangle = stubTool('rectangle', {
      activate: () => {
        if (failActivation) throw new Error('activation failed')
      },
    })
    useStubTools(rectangle)
    const { session } = createSession()
    const bearing = () => testView.view().camera.bearingDeg

    events.pointerDown({ x: 100, y: 100 }, { pointerId: 4, button: 1, buttons: 4, shiftKey: true })
    events.pointerMove({ x: 120, y: 100 }, { pointerId: 4, buttons: 4, shiftKey: true })
    expect(bearing()).toBeCloseTo(16, 6)

    expect(() => session.setTool('rectangle')).toThrow('activation failed')
    failActivation = false
    // The rotate's session is cancelled: the camera is back at the press bearing.
    expect(bearing()).toBeCloseTo(0, 6)
    // No stale rotation holds the view keys back.
    expect(session.keyboard.command({ kind: 'rotate-view', direction: 1 })).toBe(true)
    expect(testView.host.current().bearingTarget()).toBeCloseTo(15, 6)
    events.pointerUp({ x: 120, y: 100 }, { pointerId: 4, button: 1, buttons: 0 })
  })

  it('disposal releases the capture of a registered tool\'s live press and rolls its edit back', () => {
    const { tool: rectangle, open } = editingTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')
    events.pointerDown({ x: 20, y: 30 }, { pointerId: 25 })
    events.pointerMove({ x: 35, y: 45 }, { pointerId: 25 })
    expect(events.pointerCapture.has(25)).toBe(true)

    session.dispose()
    expect(events.pointerCapture.releaseCalls).toHaveBeenCalledWith(25)
    expect(events.pointerCapture.has(25)).toBe(false)
    expect(open()).toBe(false)
  })

  it('a dragover or a drop is admitted right after a cancellation failure, with no edit left open to wait for', () => {
    let failing = true
    let edit: SceneEditTransaction | null = null
    const rectangle: StubTool = stubTool('rectangle', {
      gesture: (gesture) => {
        if (gesture.kind === 'press') edit = rectangle.ctx().effects.edits.begin('interaction-rectangle')
        return 'pass'
      },
      cancelTransient: () => {
        if (failing) throw new Error('cancel failed')
        edit?.abort()
        edit = null
      },
    })
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')
    const species = (transfer: DataTransferLike) => writePlantStampDragData(transfer, PEAR)

    events.pointerDown({ x: 20, y: 20 })
    expect(captureWindowErrors(() => { events.windowBlur() })).toHaveLength(1)
    failing = false

    const over = dispatchDrag('dragover', { x: 60, y: 60 }, species)
    expect(over.dataTransfer!.dropEffect).toBe('copy')

    dispatchDrag('drop', { x: 60, y: 60 }, species)
    expect(store.persisted.plants).toHaveLength(1)
  })

  it('a drop whose route throws still prevents the browser\'s own drop', () => {
    const baseDeps = createInteractionDeps(container, store, testView)
    const realEdits = baseDeps.sceneEdits
    const dropFails: SceneEditCoordinator = {
      begin: (type, options) => realEdits.begin(type, options),
      run: (type, edit, options) => {
        if (type === 'interaction-drop') throw new Error('drop route failed')
        return realEdits.run(type, edit, options)
      },
    }
    useStubTools(stubTool('select'))
    const { session } = createSession({ sceneEdits: dropFails })
    session.setTool('select')
    const species = (transfer: DataTransferLike) => writePlantStampDragData(transfer, PEAR)

    let drop!: DragEvent
    const errors = captureWindowErrors(() => { drop = dispatchDrag('drop', { x: 60, y: 60 }, species) })

    expect(errors).toHaveLength(1)
    // Rethrown before the recogniser's prevent-default (recognise.ts) was applied, it would reach the browser's own
    // drop handler, which for a species drag inserts its payload into whatever focused text field (spec §1.4 "Drops").
    expect(drop.defaultPrevented).toBe(true)
    expect(store.persisted.plants).toHaveLength(0)
  })

  it('a dragover hides a registered tool\'s draft until the pointer moves over the map again', () => {
    const ghost: DraftPresentation = {
      shapes: [{ kind: 'circle-px', center: { x: 50, y: 50 }, radiusPx: 4, style: { token: 'draft', widthPx: 1 } }],
    }
    const stamp: StubTool = stubTool('object-stamp', {
      gesture: (gesture) => {
        if (gesture.kind === 'hover') stamp.ctx().effects.setDraft(ghost)
        return 'handled'
      },
    })
    useStubTools(stamp)
    const renderer = recordingRenderer()
    const { session } = createSession({ renderer })
    session.setTool('object-stamp')
    events.pointerMove({ x: 50, y: 50 }, { buttons: 0 })
    expect(renderer.lastDraft()).toEqual(ghost)

    // The species' drop cue takes the ghost's place, as today's one preview element.
    dispatchDrag('dragover', { x: 60, y: 60 }, (transfer) => writePlantStampDragData(transfer, PEAR))
    expect(renderer.lastDraft()?.shapes.map((shape) => shape.kind)).toEqual(['quad'])
    dispatchDrag('dragleave', { x: 60, y: 60 })
    expect(renderer.lastDraft()).toBeNull()
    events.pointerMove({ x: 70, y: 70 }, { buttons: 0 })
    expect(renderer.lastDraft()).toEqual(ghost)
  })
})

describe('releases the tool did not hear (today\'s pointerup cleanup)', () => {
  /** A saved stamp of one apple, held through the read model as Favorites arms it. */
  function holdAppleStamp(): void {
    selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 0, y: 0 },
      plants: [{
        id: 'plant-1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null, symbol: null,
        position: { x: 0, y: 0 }, rotationDeg: null, scale: null,
      }],
      zones: [],
      annotations: [],
      groups: [],
    } as unknown as Parameters<typeof selectSavedObjectStampSource>[0])
  }

  function ghostShown(renderer: ReturnType<typeof recordingRenderer>): boolean {
    return renderer.lastDraft()?.shapes.some((shape) => shape.kind === 'ghost') ?? false
  }

  it('a middle-button or Space pan drops a redo-only polygon history at its release or cancel and keeps a draft with corners', () => {
    useStubTools(createPolygonTool())
    const { session } = createSession()
    session.setTool('polygon')
    const corner = (at: { x: number, y: number }): void => {
      events.pointerDown(at)
      events.pointerUp(at)
    }
    const pans: readonly [string, () => void][] = [
      ['a middle drag', () => {
        events.pointerDown({ x: 100, y: 100 }, { button: 1 })
        events.pointerMove({ x: 140, y: 120 }, { button: 1 })
        events.pointerUp({ x: 140, y: 120 }, { button: 1 })
      }],
      ['a Space drag', () => {
        events.holdSpace()
        events.pointerDown({ x: 100, y: 100 })
        events.pointerMove({ x: 140, y: 120 })
        events.pointerUp({ x: 140, y: 120 })
        events.releaseSpace()
      }],
      ['a cancelled middle drag', () => {
        events.pointerDown({ x: 100, y: 100 }, { button: 1 })
        events.pointerMove({ x: 140, y: 120 }, { button: 1 })
        events.pointerCancel({ x: 140, y: 120 })
      }],
    ]

    for (const [name, pan] of pans) {
      corner({ x: 20, y: 20 })
      expect(session.undoTransientHistory(), name).toBe(true)
      expect(session.canRedoTransientHistory(), name).toBe(true)
      // Today's pointerup ran the cancellation, keeping the draft after a pan only while it had corners.
      pan()
      expect(session.canRedoTransientHistory(), name).toBe(false)

      corner({ x: 20, y: 20 })
      corner({ x: 60, y: 20 })
      expect(session.undoTransientHistory(), name).toBe(true)
      pan()
      expect(session.canUndoTransientHistory(), name).toBe(true)
      expect(session.canRedoTransientHistory(), name).toBe(true)
      events.keyDown({ key: 'Escape', target: container })
      expect(session.canUndoTransientHistory(), name).toBe(false)
    }
  })

  it('a right-click release hides a held stamp\'s ghost until the next hover, and a click on a panel leaves it', () => {
    holdAppleStamp()
    useStubTools(createSavedObjectStampTool())
    const renderer = recordingRenderer()
    const { session } = createSession({ renderer })
    session.setTool('saved-object-stamp')
    const panel = document.createElement('button')
    document.body.appendChild(panel)

    try {
      events.pointerMove({ x: 100, y: 100 }, { buttons: 0 })
      expect(ghostShown(renderer)).toBe(true)
      events.pointerDown({ x: 100, y: 100 }, { button: 2 })
      events.pointerUp({ x: 100, y: 100 }, { button: 2 })
      expect(ghostShown(renderer)).toBe(false)

      events.pointerMove({ x: 110, y: 110 }, { buttons: 0 })
      expect(ghostShown(renderer)).toBe(true)
      // A click on a panel is the page's: neither its press nor its release reaches the map (phase F).
      events.pointerDown({ x: 500, y: 400 }, { target: panel })
      events.pointerUp({ x: 500, y: 400 }, { target: panel })
      expect(ghostShown(renderer)).toBe(true)
    } finally {
      panel.remove()
    }
  })

  it('a release over the note editor or a handle, of another pointer, in overview or off the map runs nothing', () => {
    const rectangle = stubTool('rectangle')
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')
    const owned = ['data-canvas-text-entry', 'data-canvas-handle'].map((attribute) => {
      const element = document.createElement('div')
      element.setAttribute(attribute, 'create')
      container.appendChild(element)
      return element
    })
    const navigates = (): number => rectangle.calls.filter((call) => call === 'cancelTransient:navigate').length

    for (const target of owned) {
      events.pointerDown({ x: 50, y: 50 }, { target, pointerId: 2 })
      events.pointerUp({ x: 50, y: 50 }, { target, pointerId: 2 })
    }
    expect(navigates()).toBe(0)

    // A press of the tool's is live: another pointer's release is not the tool's to end (today's pointerId check).
    events.pointerDown({ x: 20, y: 20 }, { pointerId: 3 })
    events.pointerDown({ x: 50, y: 50 }, { pointerId: 4, button: 2 })
    events.pointerUp({ x: 50, y: 50 }, { pointerId: 4, button: 2 })
    expect(navigates()).toBe(0)
    events.pointerUp({ x: 20, y: 20 }, { pointerId: 3 })
    expect(navigates()).toBe(0)

    // Overview swallows a release with no session instead.
    const leaveOverview = enterOverview(testView)
    const before = rectangle.calls.length
    events.pointerDown({ x: 50, y: 50 }, { button: 2 })
    events.pointerUp({ x: 50, y: 50 }, { button: 2 })
    expect(rectangle.calls.slice(before)).toEqual([])
    leaveOverview()

    // A press and release beside the map are the page's (phase F: no window listener without a press on the map).
    const panel = document.createElement('div')
    document.body.appendChild(panel)
    events.pointerDown({ x: 500, y: 50 }, { target: panel })
    events.pointerUp({ x: 500, y: 50 }, { target: panel })
    panel.remove()
    expect(navigates()).toBe(0)

    // A right-click on the map, a release with no press of the tool's, runs the cleanup, as today.
    events.pointerDown({ x: 50, y: 50 }, { button: 2 })
    events.pointerUp({ x: 50, y: 50 }, { button: 2 })
    expect(navigates()).toBe(1)
  })

  it('a fault whose re-arm falls back to Select names Select as the session\'s tool (B6)', () => {
    let activations = 0
    const select = stubTool('select')
    const rectangle = stubTool('rectangle', {
      activate: () => {
        activations += 1
        if (activations > 1) throw new Error('re-arm failed')
      },
      gesture: (gesture) => {
        if (gesture.kind === 'press') throw new Error('press failed')
        return 'pass'
      },
    })
    useStubTools(select, rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    expect(captureWindowErrors(() => { events.pointerDown({ x: 20, y: 20 }) })).toHaveLength(1)
    expect(select.calls).toContain('activate')
    expect(session.tool).toBe('select')
  })

  it('an activation that throws while preparing a document replacement names Select as the session\'s tool (B6)', () => {
    let activations = 0
    const select = stubTool('select')
    const rectangle = stubTool('rectangle', {
      activate: () => {
        activations += 1
        if (activations > 1) throw new Error('activation failed')
      },
    })
    useStubTools(select, rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    expect(() => session.prepareForDocumentReplacement()).toThrow()
    expect(select.calls).toContain('activate')
    expect(session.tool).toBe('select')
  })

  it('a tool whose overview cleanup throws still leaves the session in overview: the release is swallowed', () => {
    const rectangle = stubTool('rectangle', {
      cancelTransient: (reason) => {
        if (reason === 'overview') throw new Error('overview cleanup failed')
      },
    })
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')

    expect(() => enterOverview(testView)).toThrow('overview cleanup failed')
    expect(testView.viewport().scale).toBeCloseTo(0.05, 9)
    const before = rectangle.calls.length
    events.pointerDown({ x: 50, y: 50 }, { button: 2 })
    events.pointerUp({ x: 50, y: 50 }, { button: 2 })
    expect(rectangle.calls.slice(before)).toEqual([])
  })

  it('a tool whose cancel throws mid-drag still lets both the session and the host enter overview', () => {
    const rectangle = stubTool('rectangle', {
      gesture: (gesture) => {
        if (gesture.kind === 'cancel') throw new Error('cancel failed')
        return 'pass'
      },
    })
    useStubTools(rectangle)
    const { session } = createSession()
    session.setTool('rectangle')
    container.focus()
    events.pointerDown({ x: 20, y: 20 })
    events.pointerMove({ x: 60, y: 40 })
    events.holdSpace()

    expect(() => enterOverview(testView)).toThrow('cancel failed')
    // The host met overview: the tool's overview cleanup ran.
    expect(rectangle.calls).toContain('cancelTransient:overview')
    // The session released Space with the recogniser: a modifier key brings no grab back in overview.
    events.keyDown({ key: 'Shift', code: 'ShiftLeft', target: container })
    expect(container.style.cursor).not.toBe('grab')
  })
})

