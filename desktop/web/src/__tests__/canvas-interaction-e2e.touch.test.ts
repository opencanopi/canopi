// @vitest-environment jsdom

// The canvas interaction end to end through the session with touch input (canvas v2 phase 3, spec §2.2 "Touch" and
// §3.4): the recogniser holds every touch press until 8 px, the lift or 500 ms, so a tap acts at the lift at the down
// point and a pinch never reaches a tool. Real tools, the real recogniser and the real DOM source, in jsdom.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectPlantStampSource } from '../canvas/plant-stamp-source'
import { currentCanvasSelection } from '../canvas/session-state'
import type { SceneStore,ScenePoint } from '../canvas/runtime/scene'
import type {
  SceneInteractionSession,
  SceneInteractionSessionDeps,
} from '../canvas/runtime/interaction-session'
import { createRecordingRenderer, type RecordingRenderer } from './support/recording-renderer'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import type { PointerWorld } from '../canvas/runtime/interaction-ports'
import {
  contextMenuHost,
  createInteractionDeps,
  installSceneInteractionFixture,
  makePlant,
  makeRectZone,
  plantTarget,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

describe('SceneInteractionSession: touch', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness
  let renderer: RecordingRenderer

  const fixture = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  beforeEach(() => {
    renderer = createRecordingRenderer()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createTestSession(deps: SceneInteractionSessionDeps): SceneInteractionSession {
    return fixture.createTestSession({ ...deps, renderer })
  }

  /** A finger, as a browser sends it: pointerType touch, the primary button, contact while it moves. */
  const finger = (id: number, timeStamp?: number) => ({ pointerType: 'touch', pointerId: id, isPrimary: id === 1, timeStamp })
  const touchDown = (at: ScenePoint, id = 1, timeStamp?: number) => events.pointerDown(at, { ...finger(id, timeStamp), button: 0, buttons: 1 })
  const touchMove = (at: ScenePoint, id = 1, timeStamp?: number) => events.pointerMove(at, { ...finger(id, timeStamp), button: -1, buttons: 1 })
  const touchUp = (at: ScenePoint, id = 1, timeStamp?: number) => events.pointerUp(at, { ...finger(id, timeStamp), button: 0, buttons: 0 })

  /** Two fingers spread apart, then lifted: a pinch with nothing armed for it. */
  function pinch(first: ScenePoint, second: ScenePoint): void {
    touchDown(first, 1, 0)
    touchDown(second, 2, 40)
    touchMove({ x: first.x - 10, y: first.y }, 1, 60)
    touchMove({ x: second.x + 20, y: second.y }, 2, 70)
    touchMove({ x: first.x - 20, y: first.y }, 1, 80)
    touchMove({ x: second.x + 40, y: second.y }, 2, 90)
    touchUp({ x: second.x + 40, y: second.y }, 2, 100)
    touchUp({ x: first.x - 20, y: first.y }, 1, 110)
  }

  /** The polygon draft's corner markers. */
  function draftCorners(): number {
    return (renderer.lastDraft()?.shapes ?? []).filter((shape) => shape.kind === 'circle-px').length
  }

  function choosePlant(): void {
    selectPlantStampSource({ canonical_name: 'Malus domestica', common_name: 'Apple', stratum: 'high', width_max_m: 4 })
  }

  it('a touch tap with Plant stamp places one plant at the down point', () => {
    choosePlant()
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('plant-stamp')

    // A rolling tap: the finger moves 5 px and lifts 4 px from where it landed, within the 8 px touch slop.
    touchDown({ x: 100, y: 100 })
    touchMove({ x: 104, y: 103 })
    touchUp({ x: 103, y: 104 })

    expect(store.persisted.plants).toHaveLength(1)
    expect(store.persisted.plants[0]!.position).toEqual({ x: 100, y: 100 })
    session.dispose()
  })

  it('a finger that slides past 8 px with Plant stamp places one plant at the press point', () => {
    choosePlant()
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('plant-stamp')

    touchDown({ x: 100, y: 100 })
    expect(store.persisted.plants).toHaveLength(0)
    touchMove({ x: 112, y: 100 })
    touchUp({ x: 112, y: 100 })

    expect(store.persisted.plants.map((plant) => plant.position)).toEqual([{ x: 100, y: 100 }])
    session.dispose()
  })

  it('A16 a finger\'s tap moves the inspection lens to the tap, as a touch publish; a Pan-tool drag or a pinch moves it nowhere', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    // The lens's consumer (InspectionLens): it samples at each published point and keeps its point on null.
    const points: (PointerWorld | null)[] = []
    session.subscribePointerWorld((point) => { points.push(point) })
    const published = () => points.filter((point): point is PointerWorld => point !== null)

    events.pointerMove({ x: 76, y: 30 }, { buttons: 0 })
    expect(published().at(-1)?.pointerKind).toBe('mouse')
    // A rolling tap: the lens samples at the resolved press, the down point, as a mouse's hover before its press.
    touchDown({ x: 300, y: 250 })
    touchMove({ x: 303, y: 252 })
    touchUp({ x: 304, y: 253 })
    // Its kind says touch: Site data values read a finger through the pin, never as a hover (canopi-f47t.42).
    expect(published().at(-1)).toEqual({
      world: testView.view().screenToWorld({ x: 300, y: 250 }),
      screen: { x: 300, y: 250 },
      pointerKind: 'touch',
    })

    // A finger dragging past its slop under the Pan tool pans the map; a pinch navigates: neither moves the lens.
    const before = published().length
    session.setTool('hand')
    touchDown({ x: 100, y: 100 })
    touchMove({ x: 115, y: 100 })
    touchMove({ x: 130, y: 100 })
    touchUp({ x: 130, y: 100 })
    pinch({ x: 100, y: 100 }, { x: 200, y: 100 })
    expect(published()).toHaveLength(before)
    session.dispose()
  })

  it('E13 a pinch with Plant stamp places nothing', () => {
    choosePlant()
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('plant-stamp')
    const scale = testView.view().pixelsPerMetre

    pinch({ x: 100, y: 100 }, { x: 200, y: 100 })

    expect(store.persisted.plants).toHaveLength(0)
    // The fingers spread from 100 px to 160 px apart: the view zooms in by their ratio.
    expect(testView.view().pixelsPerMetre / scale).toBeCloseTo(1.6, 6)
    session.dispose()
  })

  it('E13 a pinch during a Polygon draft adds no corner', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('polygon')
    events.pointerDown({ x: 20, y: 20 }, { timeStamp: 0 })
    events.pointerUp({ x: 20, y: 20 }, { timeStamp: 10 })
    events.pointerDown({ x: 80, y: 20 }, { timeStamp: 1000 })
    events.pointerUp({ x: 80, y: 20 }, { timeStamp: 1010 })
    expect(draftCorners()).toBe(2)

    pinch({ x: 150, y: 150 }, { x: 250, y: 150 })

    expect(draftCorners()).toBe(2)
    expect(store.persisted.zones).toHaveLength(0)
    session.dispose()
  })

  it('a finger\'s double tap 20 px apart finishes a polygon with pointerdown detail 0, as Profile finishes (canopi-f47t.42 probe)', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('polygon')
    // Each down sends detail 0, as WebKitGTK's and Chromium's touch pointerdowns do; the recogniser counts the clicks.
    const tap = (at: ScenePoint, t: number) => {
      events.pointerDown(at, { ...finger(1, t), button: 0, buttons: 1, detail: 0 })
      events.pointerUp(at, { ...finger(1, t + 40), button: 0, buttons: 0, detail: 0 })
    }
    tap({ x: 20, y: 20 }, 0)
    tap({ x: 120, y: 20 }, 1000)
    tap({ x: 120, y: 100 }, 2000)
    expect(draftCorners()).toBe(3)

    tap({ x: 120, y: 120 }, 2300)

    expect(store.persisted.zones).toHaveLength(1)
    expect(store.persisted.zones[0]!.points).toEqual([{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 100 }])
    session.dispose()
  })

  it('E13 a pinch from empty ground with Select keeps the selection', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('select')
    deps.setSelection([plantTarget('plant-1')])

    pinch({ x: 200, y: 200 }, { x: 300, y: 200 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    session.dispose()
  })

  it('a double tap selects a species only on one plant: taps 25 px apart on two plants of it select the second alone (U42)', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('plant-1', 'Malus domestica', { x: 100, y: 100 }),
        makePlant('plant-2', 'Malus domestica', { x: 125, y: 100 }),
        makePlant('plant-3', 'Malus domestica', { x: 300, y: 300 }),
      ]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')

    touchDown({ x: 100, y: 100 }, 1, 0)
    touchUp({ x: 100, y: 100 }, 1, 60)
    touchDown({ x: 125, y: 100 }, 1, 200)
    touchUp({ x: 125, y: 100 }, 1, 260)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-2']))

    touchDown({ x: 300, y: 300 }, 1, 2000)
    touchUp({ x: 300, y: 300 }, 1, 2060)
    touchDown({ x: 302, y: 301 }, 1, 2200)
    touchUp({ x: 302, y: 301 }, 1, 2260)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1', 'plant-2', 'plant-3']))
    session.dispose()
  })

  it('E14 a long press with Plant stamp opens the menu at the finger and places nothing, the lift included', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    choosePlant()
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('plant-stamp')

    touchDown({ x: 100, y: 100 })
    vi.advanceTimersByTime(499)
    expect(contextMenuHost.current).toBeNull()
    vi.advanceTimersByTime(101)
    expect(contextMenuHost.current?.world).toEqual({ x: 100, y: 100 })
    touchMove({ x: 104, y: 100 })
    touchUp({ x: 104, y: 100 })

    expect(store.persisted.plants).toHaveLength(0)
    expect(contextMenuHost.opened).toHaveLength(1)
    session.dispose()
  })

  it('E14 a long press during a Polygon draft opens the menu and adds no corner', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('polygon')
    events.pointerDown({ x: 20, y: 20 }, { timeStamp: 0 })
    events.pointerUp({ x: 20, y: 20 }, { timeStamp: 10 })
    events.pointerDown({ x: 80, y: 20 }, { timeStamp: 1000 })
    events.pointerUp({ x: 80, y: 20 }, { timeStamp: 1010 })

    touchDown({ x: 150, y: 150 })
    vi.advanceTimersByTime(600)
    touchUp({ x: 150, y: 150 })

    expect(contextMenuHost.current).not.toBeNull()
    expect(draftCorners()).toBe(2)
    session.dispose()
  })

  it('a Text tap with a finger opens the note field focused at once, within the tap, so iOS shows its keyboard (A15)', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('text')

    touchDown({ x: 120, y: 90 })
    touchUp({ x: 121, y: 90 })

    const field = container.querySelector<HTMLTextAreaElement>('[data-canvas-text-entry]')
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(field)
    session.dispose()
  })

  it('blur during a pinch-twist keeps the view: the turn ends where it is, never restored (A6)', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const at = (deg: number, sign: 1 | -1) => ({
      x: 200 + sign * 50 * Math.cos((deg * Math.PI) / 180),
      y: 150 + sign * 50 * Math.sin((deg * Math.PI) / 180),
    })

    touchDown(at(0, 1), 1, 0)
    touchDown(at(0, -1), 2, 10)
    touchMove(at(40, 1), 1, 20)
    touchMove(at(40, -1), 2, 30)
    const turned = testView.view().camera.bearingDeg
    expect(turned).toBeGreaterThan(300)
    expect(turned).toBeLessThan(353)

    events.windowBlur()

    expect(testView.view().camera.bearingDeg).toBeCloseTo(turned, 6)
    session.dispose()
  })

  it('a pinch out across the overview threshold keeps zooming to the fingers\' end', () => {
    // 0.12 px/m is just above overview (0.1 px/m): the pinch's first step enters it, and the camera publishes that frame mid-pinch.
    testView.setViewport({ x: 200, y: 150, scale: 0.12 })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')

    touchDown({ x: 100, y: 150 }, 1, 0)
    touchDown({ x: 300, y: 150 }, 2, 10)
    touchMove({ x: 140, y: 150 }, 1, 20)
    expect(testView.frames.viewFrame.peek().mode).toBe('overview')
    touchMove({ x: 260, y: 150 }, 2, 30)
    touchMove({ x: 150, y: 150 }, 1, 40)
    touchUp({ x: 150, y: 150 }, 1, 50)
    touchUp({ x: 260, y: 150 }, 2, 60)

    // 200 px apart to 110: the scale follows the fingers the whole way.
    expect(testView.viewport().scale).toBeCloseTo(0.12 * (110 / 200), 6)
    session.dispose()
  })

  it('a finger that drifts inside its slop before the second lands starts the pinch with no jump', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const before = testView.viewport()

    touchDown({ x: 100, y: 100 }, 1, 0)
    touchMove({ x: 107, y: 100 }, 1, 10)
    touchDown({ x: 160, y: 100 }, 2, 20)
    touchMove({ x: 108, y: 100 }, 1, 30)

    // The centroid moved 0.5 px and the fingers 53 px to 52 px apart: under the 0.1 zoom-level start.
    expect(testView.viewport().scale).toBeCloseTo(before.scale, 9)
    expect(testView.viewport().x - before.x).toBeCloseTo(0.5, 6)
    session.dispose()
  })

  it('a finger\'s tap on a polygon gives it 44 px handle boxes and dots on 132 px edges; a mouse move makes them 20 px again (Q1, Q2, Q4)', () => {
    store.updatePersisted((draft) => {
      draft.zones = [{
        kind: 'zone', locked: false, id: 'polygon-1', name: 'polygon-1', zoneType: 'polygon', rotationDeg: 0,
        points: [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }], fillColor: null, notes: null,
      }]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const box = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map((element) =>
      `${element.style.width}×${element.style.height}`)

    // 10 px inside the outline: beyond a mouse's 6 px, within a finger's 16 px (canopi-qd2k).
    touchDown({ x: 140, y: 70 })
    touchUp({ x: 141, y: 71 })

    expect(currentCanvasSelection.value).toEqual(new Set(['polygon-1']))
    expect(box('[data-canvas-handle^="vertex:"]')).toEqual(['44px×44px', '44px×44px', '44px×44px', '44px×44px'])
    // The 200 px edges show their 44 px dots; the 100 px ones are under 132 px.
    expect(box('[data-canvas-handle^="edge-mid:"]')).toEqual(['44px×44px', '44px×44px'])
    const rotate = container.querySelector<HTMLElement>('[data-canvas-handle="rotate"]')!
    expect(`${rotate.style.width}×${rotate.style.height}`).toBe('44px×44px')
    expect((rotate.firstElementChild as HTMLElement).style.width).toBe('28px')

    events.pointerMove({ x: 300, y: 250 }, { pointerType: 'mouse', buttons: 0 })

    expect(box('[data-canvas-handle^="vertex:"]')).toEqual(['20px×20px', '20px×20px', '20px×20px', '20px×20px'])
    expect(box('[data-canvas-handle^="edge-mid:"]')).toEqual(['16px×16px', '16px×16px', '16px×16px', '16px×16px'])
    expect(rotate.style.width).toBe('28px')
    session.dispose()
  })

  it('a new Select keeps a finger\'s 44 px handles: a tool switch and back, then a selection made off the map (Q1)', () => {
    store.updatePersisted((draft) => {
      draft.zones = [
        makeRectZone('zone-1', [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }]),
        makeRectZone('zone-2', [{ x: 300, y: 60 }, { x: 400, y: 60 }, { x: 400, y: 160 }, { x: 300, y: 160 }]),
      ]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const widths = () => [...container.querySelectorAll<HTMLElement>('[data-canvas-handle^="rect-corner:"]')].map((element) => element.style.width)

    touchDown({ x: 140, y: 70 })
    touchUp({ x: 140, y: 70 })
    expect(widths()).toEqual(['44px', '44px', '44px', '44px'])

    session.setTool('measurement-guide')
    session.setTool('select')
    expect(widths()).toEqual(['44px', '44px', '44px', '44px'])

    // A panel selects the other zone: the host hears no press.
    currentCanvasSelection.value = new Set(['zone-2'])
    session.refreshMeasurements()
    expect(widths()).toEqual(['44px', '44px', '44px', '44px'])
    session.dispose()
  })

  it('on Android a selection made before any press on the map shows 44 px handles', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }])]
    })
    const deps = { ...createInteractionDeps(container, store, testView), platform: { os: 'android', gestureEvents: false } as const }
    const session = createTestSession(deps)
    session.setTool('select')

    // A panel selects the zone: the host has heard no pointer yet.
    deps.setSelection([{ kind: 'zone', id: 'zone-1' }])
    session.refreshMeasurements()

    const widths = [...container.querySelectorAll<HTMLElement>('[data-canvas-handle^="rect-corner:"]')].map((element) => element.style.width)
    expect(widths).toEqual(['44px', '44px', '44px', '44px'])
    session.dispose()
  })

  it('a long press after a mouse hover gives the object it selects 44 px handles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    store.updatePersisted((draft) => {
      draft.zones = [
        makeRectZone('zone-1', [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }]),
        makeRectZone('zone-2', [{ x: 300, y: 60 }, { x: 400, y: 60 }, { x: 400, y: 160 }, { x: 300, y: 160 }]),
      ]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const widths = () => [...container.querySelectorAll<HTMLElement>('[data-canvas-handle^="rect-corner:"]')].map((element) => element.style.width)

    events.pointerMove({ x: 140, y: 63 }, { pointerType: 'mouse', buttons: 0 })
    events.pointerDown({ x: 140, y: 63 }, { pointerType: 'mouse', button: 0, buttons: 1 })
    events.pointerUp({ x: 140, y: 63 }, { pointerType: 'mouse', button: 0, buttons: 0 })
    expect(widths()).toEqual(['20px', '20px', '20px', '20px'])

    // On zone-2's outline: the menu retargets to it.
    touchDown({ x: 300, y: 110 })
    vi.advanceTimersByTime(600)
    touchUp({ x: 300, y: 110 })

    expect(currentCanvasSelection.value).toEqual(new Set(['zone-2']))
    expect(widths()).toEqual(['44px', '44px', '44px', '44px'])
    session.dispose()
  })

  it('a long press 15 px from a rectangle\'s edge offers Turn view to this edge (A11)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }])]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')

    touchDown({ x: 140, y: 45 })
    vi.advanceTimersByTime(600)
    touchUp({ x: 140, y: 45 })

    expect(contextMenuHost.current?.turnViewToEdge).toBeTypeOf('function')
    session.dispose()
  })

  // A finger's drag and long press, which Playwright's WebKit cannot drive (e2e/canvas/zone-picking.spec.ts covers them
  // in Chromium): zones are picked by their outline only (canopi-qd2k, the user's decision of 2026-10-14).
  it('(canopi-qd2k) a finger: a tap inside a zone clears, a drag inside bands the plants only, a long press inside opens the empty map\'s menu and one near the outline the zone\'s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const corners = [{ x: 40, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 160 }, { x: 40, y: 160 }]
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', corners)]
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 180, y: 120 })]
    })
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')

    // A tap 12 px inside the outline selects the zone; one 40 px inside clears it.
    touchDown({ x: 140, y: 72 }, 1, 0)
    touchUp({ x: 140, y: 72 }, 1, 50)
    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1']))
    touchDown({ x: 140, y: 100 }, 1, 1000)
    touchUp({ x: 140, y: 100 }, 1, 1050)
    expect(currentCanvasSelection.value).toEqual(new Set())

    // A drag from inside draws a band: the plant alone, the zone unmoved.
    touchDown({ x: 100, y: 100 }, 1, 2000)
    touchMove({ x: 150, y: 120 }, 1, 2020)
    touchMove({ x: 200, y: 140 }, 1, 2040)
    touchUp({ x: 200, y: 140 }, 1, 2060)
    expect(store.persisted.zones[0]!.points).toEqual(corners)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    // A long press inside: the empty map's menu, the selection kept.
    touchDown({ x: 100, y: 110 }, 1, 3000)
    vi.advanceTimersByTime(600)
    touchUp({ x: 100, y: 110 }, 1, 3700)
    expect(contextMenuHost.current?.selection).toBeNull()
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    // A long press 12 px inside the outline: the zone's menu, the zone selected.
    touchDown({ x: 52, y: 110 }, 1, 5000)
    vi.advanceTimersByTime(600)
    touchUp({ x: 52, y: 110 }, 1, 5700)
    expect(contextMenuHost.current?.selection?.editableTargets).toEqual([{ kind: 'zone', id: 'zone-1' }])
    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1']))
    session.dispose()
  })
})
