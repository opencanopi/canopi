// @vitest-environment jsdom

// The Site data pin end to end (canopi-f47t.42, spec §3.8, fixture J10): DOM pointer events through the real DOM source,
// recogniser, router and tool host, with the real tools, reach the app adapter's pinAt. A tap no tool uses pins: a
// Select tap on empty ground (after Select clears the selection) or any Pan-tool tap. Each press sends pointerdown
// detail 0, as WebKitGTK does. Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import { currentCanvasSelection } from '../canvas/session-state'
import type { ScenePoint, SceneStore } from '../canvas/runtime/scene'
import type { SceneInteractionSession, SceneInteractionSessionDeps } from '../canvas/runtime/interaction-session'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { createDesktopCanvasRuntimeAppAdapter } from '../app/canvas-runtime/desktop-adapter'
import { endSiteDataTransients, pin, profileLine } from '../app/lidar/site-transients'
import { selectPanel, sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from './support/canvas-interaction-events'
import { placeOnHost, type TestView } from './support/test-view'
import {
  createInteractionDeps,
  installSceneInteractionFixture,
  makePlant,
  makeRectZone,
} from './support/canvas-interaction-setup'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'
import './support/camera-tolerance'
import type * as IpcSpeciesModule from '../ipc/species'

describe('SceneInteractionSession: the Site data pin', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const fixture = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  function createPinSession(): { session: SceneInteractionSession; pinAt: ReturnType<typeof vi.fn> } {
    const pinAt = vi.fn()
    const deps: SceneInteractionSessionDeps = { ...createInteractionDeps(container, store, testView), pinAt }
    return { session: fixture.createTestSession(deps), pinAt }
  }

  /** A mouse click whose pointerdown sends detail 0, as WebKitGTK's does; `t` keeps clicks apart in time. */
  function click(at: ScenePoint, t: number): void {
    events.pointerDown(at, { button: 0, buttons: 1, detail: 0, timeStamp: t })
    events.pointerUp(at, { button: 0, buttons: 0, detail: 0, timeStamp: t + 50 })
  }

  const world = (at: ScenePoint) => testView.view().screenToWorld(at)

  it('(canopi-qd2k) a Select click on empty ground, inside a zone too, clears the selection and pins; a click on a plant or a zone\'s outline selects only', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
      draft.zones = [makeRectZone('zone-1', [{ x: 200, y: 150 }, { x: 280, y: 150 }, { x: 280, y: 210 }, { x: 200, y: 210 }])]
    })
    const { session, pinAt } = createPinSession()
    session.setTool('select')

    click({ x: 20, y: 30 }, 0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    click({ x: 240, y: 152 }, 1000)
    expect(currentCanvasSelection.value).toEqual(new Set(['zone-1']))
    expect(pinAt).not.toHaveBeenCalled()

    click({ x: 120, y: 260 }, 2000)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(pinAt).toHaveBeenCalledTimes(1)
    expect(pinAt).toHaveBeenCalledWith(world({ x: 120, y: 260 }))

    // Inside the zone, away from its outline, is empty ground: it pins (the user's decision of 2026-10-14).
    click({ x: 240, y: 152 }, 3000)
    click({ x: 240, y: 180 }, 4000)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(pinAt).toHaveBeenCalledTimes(2)
    expect(pinAt).toHaveBeenLastCalledWith(world({ x: 240, y: 180 }))
    session.dispose()
  })

  it('a band from empty ground and a Polygon corner never pin; a still Pan-tool click pins, a Pan-tool drag does not', () => {
    const { session, pinAt } = createPinSession()
    session.setTool('select')
    events.pointerDown({ x: 100, y: 100 }, { button: 0, buttons: 1, detail: 0 })
    events.pointerMove({ x: 160, y: 140 }, { buttons: 1 })
    events.pointerUp({ x: 160, y: 140 }, { button: 0 })

    session.setTool('polygon')
    click({ x: 50, y: 50 }, 1000)

    session.setTool('hand')
    events.pointerDown({ x: 100, y: 100 }, { button: 0, buttons: 1, detail: 0, timeStamp: 2000 })
    events.pointerMove({ x: 140, y: 100 }, { buttons: 1, timeStamp: 2020 })
    events.pointerUp({ x: 140, y: 100 }, { button: 0, timeStamp: 2040 })
    expect(pinAt).not.toHaveBeenCalled()

    click({ x: 300, y: 200 }, 3000)
    expect(pinAt).toHaveBeenCalledTimes(1)
    expect(pinAt).toHaveBeenCalledWith(world({ x: 300, y: 200 }))
    session.dispose()
  })

  it('a finger\'s rolling Select tap on empty ground pins at the down point', () => {
    const { session, pinAt } = createPinSession()
    session.setTool('select')
    const finger = { pointerType: 'touch', pointerId: 1, isPrimary: true, detail: 0 }

    events.pointerDown({ x: 150, y: 120 }, { ...finger, button: 0, buttons: 1 })
    events.pointerMove({ x: 154, y: 123 }, { ...finger, button: -1, buttons: 1 })
    events.pointerUp({ x: 155, y: 124 }, { ...finger, button: 0, buttons: 0 })

    expect(pinAt).toHaveBeenCalledTimes(1)
    expect(pinAt).toHaveBeenCalledWith(world({ x: 150, y: 120 }))
    session.dispose()
  })
})

describe('SceneInteractionSession: readouts under a still pointer', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const fixture = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a camera move under a still mouse republishes the pointer once the camera settles, so row values follow the ground', () => {
    vi.useFakeTimers()
    const session = fixture.createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const points: unknown[] = []
    session.subscribePointerWorld((point) => { points.push(point) })

    events.pointerMove({ x: 120, y: 90 }, { buttons: 0 })
    const before = testView.view().screenToWorld({ x: 120, y: 90 })
    // A jump that moves the ground under the pointer (a saved view, a key pan): not at each frame, once settled.
    testView.setViewport({ x: 30, y: 10, scale: 2 })
    testView.setViewport({ x: 40, y: 10, scale: 2 })
    expect(points).toHaveLength(1)
    vi.advanceTimersByTime(150)

    const after = testView.view().screenToWorld({ x: 120, y: 90 })
    expect(after).not.toEqual(before)
    expect(points).toEqual([
      { world: before, screen: { x: 120, y: 90 }, pointerKind: 'mouse' },
      { world: after, screen: { x: 120, y: 90 }, pointerKind: 'mouse' },
    ])
    session.dispose()
  })

  it('a still mouse that goes through overview and back republishes the ground under it once settled (or null), never the ground from before', () => {
    vi.useFakeTimers()
    const session = fixture.createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const points: unknown[] = []
    session.subscribePointerWorld((point) => { points.push(point) })

    events.pointerMove({ x: 120, y: 90 }, { buttons: 0 })
    const before = { world: testView.view().screenToWorld({ x: 120, y: 90 }), screen: { x: 120, y: 90 }, pointerKind: 'mouse' }
    testView.setViewport({ x: 0, y: 0, scale: 0.01 })
    vi.advanceTimersByTime(150)
    testView.setViewport({ x: 40, y: 10, scale: 2 })
    vi.advanceTimersByTime(150)

    const after = { world: testView.view().screenToWorld({ x: 120, y: 90 }), screen: { x: 120, y: 90 }, pointerKind: 'mouse' }
    expect(after.world).not.toEqual(before.world)
    expect(points[0]).toEqual(before)
    expect(points.slice(1), 'nothing after overview is the ground from before').not.toContainEqual(before)
    expect([null, after]).toContainEqual(points.at(-1))
    session.dispose()
  })
})

describe('the canvas runtime: the Site data pin', () => {
  const harnesses: SceneInteractionEventHarness[] = []
  const hosts: CanvasRuntimeHost[] = []

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) harness.dispose()
    for (const host of hosts.splice(0)) await host.destroy()
    document.body.replaceChildren()
  })

  it('a Select click on empty ground reaches the edition\'s pinAt capability through the app adapter', async () => {
    const pinAt = vi.fn()
    const host = createLiveTestCanvasRuntimeHost({
      screen: { width: 400, height: 300 },
      appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {}, pinAt }),
    })
    hosts.push(host)
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    await host.init(container)
    const events = createSceneInteractionEventHarness(container)
    harnesses.push(events)
    // An empty Design opens in overview, where a press pans: show the site at 1 px/m.
    placeOnHost(host.cameraHost, host.surfaces.queries.sessionPlane.peek()!, { x: 0, y: 0, scale: 1 })
    expect(host.cameraHost.frames.viewFrame.peek().mode).toBe('site')

    events.pointerDown({ x: 100, y: 80 }, { button: 0, buttons: 1, detail: 0 })
    events.pointerUp({ x: 100, y: 80 }, { button: 0, buttons: 0, detail: 0 })

    const expected = host.cameraHost.frames.viewFrame.peek().view.screenToWorld({ x: 100, y: 80 })
    expect(pinAt).toHaveBeenCalledTimes(1)
    const [point] = pinAt.mock.calls[0]! as [ScenePoint]
    expect(point.x).toBeCloseTo(expected.x, 9)
    expect(point.y).toBeCloseTo(expected.y, 9)
  })
})

describe('Desktop: the pin and profile hand-offs reach Site data in lon/lat', () => {
  const harnesses: SceneInteractionEventHarness[] = []
  const hosts: CanvasRuntimeHost[] = []

  afterEach(async () => {
    endSiteDataTransients()
    setCurrentCanvasSession(null)
    sidePanel.value = null
    for (const harness of harnesses.splice(0)) harness.dispose()
    for (const host of hosts.splice(0)) await host.destroy()
    document.body.replaceChildren()
  })

  async function desktopRuntime() {
    const appAdapter = createDesktopCanvasRuntimeAppAdapter()
    const host = createLiveTestCanvasRuntimeHost({ screen: { width: 400, height: 300 }, appAdapter })
    hosts.push(host)
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    await host.init(container)
    setCurrentCanvasSession(host.surfaces)
    const events = createSceneInteractionEventHarness(container)
    harnesses.push(events)
    const plane = host.surfaces.queries.sessionPlane.peek()!
    placeOnHost(host.cameraHost, plane, { x: 0, y: 0, scale: 1 })
    return { appAdapter, host, events, plane }
  }

  it('a Select tap on empty ground with Site data open pins the ground it shows, and entering overview unpins', async () => {
    const { host, events, plane } = await desktopRuntime()
    selectPanel('site-data')

    events.pointerDown({ x: 100, y: 80 }, { button: 0, buttons: 1, detail: 0 })
    events.pointerUp({ x: 100, y: 80 }, { button: 0, buttons: 0, detail: 0 })

    const expected = plane.toGeo(host.cameraHost.frames.viewFrame.peek().view.screenToWorld({ x: 100, y: 80 }))
    expect(pin.value?.lon).toBeCloseTo(expected.lon, 9)
    expect(pin.value?.lat).toBeCloseTo(expected.lat, 9)

    placeOnHost(host.cameraHost, plane, { x: 0, y: 0, scale: 0.0001 })
    expect(host.cameraHost.frames.viewFrame.peek().mode).toBe('overview')
    expect(pin.value).toBeNull()
  })

  it('the same tap with Site data closed pins nothing', async () => {
    const { events } = await desktopRuntime()

    events.pointerDown({ x: 100, y: 80 }, { button: 0, buttons: 1, detail: 0 })
    events.pointerUp({ x: 100, y: 80 }, { button: 0, buttons: 0, detail: 0 })

    expect(pin.value).toBeNull()
  })

  it('a finished profile line becomes the Site data profile in lon/lat', async () => {
    const { appAdapter, plane } = await desktopRuntime()
    selectPanel('site-data')

    appAdapter.finishProfile!([{ x: 0, y: 0 }, { x: 30, y: 40 }])

    expect(profileLine.value).toEqual([plane.toGeo({ x: 0, y: 0 }), plane.toGeo({ x: 30, y: 40 })])
  })
})
