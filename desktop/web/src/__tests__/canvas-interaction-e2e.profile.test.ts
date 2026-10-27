// @vitest-environment jsdom

// The Profile tool end to end (canopi-f47t.42, spec §1.10, §3.2, §3.7; fixture J10): DOM pointer and key events through
// the real DOM source, recogniser, router and tool host, with the real tools, reach ToolEffects.finishProfile. Each press
// sends pointerdown detail 0, as WebKitGTK does (and Chromium for touch), so the recogniser counts a double-click or a
// finger's double tap itself. On Desktop the finished line becomes the Site data profile in lon/lat. Shared fakes,
// helpers and fixture: support/canvas-interaction-setup.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof IpcSpeciesModule>(),
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))

import type { ScenePoint, SceneStore } from '../canvas/runtime/scene'
import type { SceneInteractionSession, SceneInteractionSessionDeps } from '../canvas/runtime/interaction-session'
import { createDesktopCanvasRuntimeAppAdapter } from '../app/canvas-runtime/desktop-adapter'
import { armProfile } from '../app/lidar/profile'
import { endSiteDataTransients, pin, profileLine } from '../app/lidar/site-transients'
import { selectPanel, sidePanel } from '../app/shell/state'
import { currentCanvasTool } from '../canvas/session-state'
import { setCurrentCanvasSession } from '../canvas/session'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from './support/canvas-interaction-events'
import { placeOnHost, type TestView } from './support/test-view'
import { createInteractionDeps, installSceneInteractionFixture } from './support/canvas-interaction-setup'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'
import './support/camera-tolerance'
import type * as IpcSpeciesModule from '../ipc/species'

describe('SceneInteractionSession: the Profile tool', () => {
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

  function createProfileSession(): {
    session: SceneInteractionSession
    finishProfile: ReturnType<typeof vi.fn>
    pinAt: ReturnType<typeof vi.fn>
  } {
    const finishProfile = vi.fn()
    const pinAt = vi.fn()
    const deps: SceneInteractionSessionDeps = { ...createInteractionDeps(container, store, testView), finishProfile, pinAt }
    const session = fixture.createTestSession(deps)
    session.setTool('profile')
    return { session, finishProfile, pinAt }
  }

  /** A mouse click whose pointerdown sends detail 0, as WebKitGTK's does; `t` keeps clicks apart in time. */
  function click(at: ScenePoint, t: number): void {
    events.pointerDown(at, { button: 0, buttons: 1, detail: 0, timeStamp: t })
    events.pointerUp(at, { button: 0, buttons: 0, detail: 0, timeStamp: t + 50 })
  }

  /** A finger's tap with detail 0, as WebKitGTK's and Chromium's touch pointerdowns send. */
  function tap(at: ScenePoint, t: number): void {
    const finger = { pointerType: 'touch', pointerId: 1, isPrimary: true, detail: 0 }
    events.pointerDown(at, { ...finger, button: 0, buttons: 1, timeStamp: t })
    events.pointerUp(at, { ...finger, button: 0, buttons: 0, timeStamp: t + 40 })
  }

  const world = (at: ScenePoint) => testView.view().screenToWorld(at)

  it('a double-click at detail 0 finishes the line, arms Select and pins nothing', () => {
    const { session, finishProfile, pinAt } = createProfileSession()

    click({ x: 20, y: 20 }, 0)
    click({ x: 120, y: 20 }, 1000)
    click({ x: 120, y: 100 }, 2000)
    click({ x: 120, y: 100 }, 2200)

    expect(finishProfile).toHaveBeenCalledTimes(1)
    expect(finishProfile).toHaveBeenCalledWith([world({ x: 20, y: 20 }), world({ x: 120, y: 20 }), world({ x: 120, y: 100 })])
    expect(session.tool).toBe('select')
    expect(pinAt).not.toHaveBeenCalled()
    expect(store.persisted.zones).toEqual([])
    session.dispose()
  })

  it('a finger\'s double tap 20 px apart finishes the line', () => {
    const { session, finishProfile, pinAt } = createProfileSession()

    tap({ x: 20, y: 20 }, 0)
    tap({ x: 120, y: 20 }, 1000)
    tap({ x: 120, y: 40 }, 1300)

    expect(finishProfile).toHaveBeenCalledWith([world({ x: 20, y: 20 }), world({ x: 120, y: 20 })])
    expect(session.tool).toBe('select')
    expect(pinAt).not.toHaveBeenCalled()
    session.dispose()
  })

  it('Backspace takes the last point back, and Enter finishes', () => {
    const { session, finishProfile } = createProfileSession()

    click({ x: 20, y: 20 }, 0)
    click({ x: 120, y: 20 }, 1000)
    click({ x: 120, y: 100 }, 2000)
    events.keyDown({ key: 'Backspace', target: container })
    events.keyDown({ key: 'Enter', cancelable: true })

    expect(finishProfile).toHaveBeenCalledWith([world({ x: 20, y: 20 }), world({ x: 120, y: 20 })])
    expect(session.tool).toBe('select')
    session.dispose()
  })

  it('Esc removes the last point and steps back to nothing, then leaves the tool, finishing nothing (A17)', () => {
    const { session, finishProfile } = createProfileSession()

    click({ x: 20, y: 20 }, 0)
    click({ x: 120, y: 20 }, 1000)
    events.keyDown({ key: 'Escape' })
    expect(session.tool).toBe('profile')
    events.keyDown({ key: 'Escape' })
    expect(session.tool).toBe('profile')
    events.keyDown({ key: 'Escape' })

    expect(session.tool).toBe('select')
    expect(finishProfile).not.toHaveBeenCalled()
    session.dispose()
  })

  it('Esc removes only the last point: Enter then finishes the rest (A17)', () => {
    const { session, finishProfile } = createProfileSession()

    click({ x: 20, y: 20 }, 0)
    click({ x: 120, y: 20 }, 1000)
    click({ x: 120, y: 100 }, 2000)
    events.keyDown({ key: 'Escape' })
    events.keyDown({ key: 'Enter', cancelable: true })

    expect(finishProfile).toHaveBeenCalledWith([world({ x: 20, y: 20 }), world({ x: 120, y: 20 })])
    expect(session.tool).toBe('select')
    session.dispose()
  })
})

describe('Desktop: a drawn profile line becomes the Site data profile', () => {
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

  it('armed from Site data, a double-click at detail 0 shows the profile in lon/lat and arms Select, pinning nothing', async () => {
    const host = createLiveTestCanvasRuntimeHost({ screen: { width: 400, height: 300 }, appAdapter: createDesktopCanvasRuntimeAppAdapter() })
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

    armProfile('panel')
    expect(sidePanel.value).toBe('site-data')
    expect(currentCanvasTool.value).toBe('profile')
    for (const [at, t] of [[{ x: 40, y: 40 }, 0], [{ x: 200, y: 120 }, 1000], [{ x: 200, y: 120 }, 1200]] as const) {
      events.pointerDown(at, { button: 0, buttons: 1, detail: 0, timeStamp: t })
      events.pointerUp(at, { button: 0, buttons: 0, detail: 0, timeStamp: t + 50 })
    }

    const view = host.cameraHost.frames.viewFrame.peek().view
    const expected = [{ x: 40, y: 40 }, { x: 200, y: 120 }].map((at) => plane.toGeo(view.screenToWorld(at)))
    expect(profileLine.value).toHaveLength(2)
    profileLine.value!.forEach((point, index) => {
      expect(point.lon).toBeCloseTo(expected[index]!.lon, 9)
      expect(point.lat).toBeCloseTo(expected[index]!.lat, 9)
    })
    expect(currentCanvasTool.value).toBe('select')
    expect(pin.value).toBeNull()
  })

  it('a line finished after the side panel switched away opens Site data again and shows its profile', async () => {
    const host = createLiveTestCanvasRuntimeHost({ screen: { width: 400, height: 300 }, appAdapter: createDesktopCanvasRuntimeAppAdapter() })
    hosts.push(host)
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    await host.init(container)
    setCurrentCanvasSession(host.surfaces)
    const events = createSceneInteractionEventHarness(container)
    harnesses.push(events)
    placeOnHost(host.cameraHost, host.surfaces.queries.sessionPlane.peek()!, { x: 0, y: 0, scale: 1 })

    armProfile('panel')
    selectPanel('layers')
    expect(currentCanvasTool.value).toBe('profile')
    for (const [at, t] of [[{ x: 40, y: 40 }, 0], [{ x: 200, y: 120 }, 1000], [{ x: 200, y: 120 }, 1200]] as const) {
      events.pointerDown(at, { button: 0, buttons: 1, detail: 0, timeStamp: t })
      events.pointerUp(at, { button: 0, buttons: 0, detail: 0, timeStamp: t + 50 })
    }

    expect(sidePanel.value).toBe('site-data')
    expect(profileLine.value).toHaveLength(2)
    expect(currentCanvasTool.value).toBe('select')
  })
})
