// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentCanvasSession, setCurrentCanvasSession } from '../../canvas/session'
import { createMapLifetimeSlot } from '../../maplibre/map-lifetime'
import {
  createTestCanvasDocumentSurface,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestSessionCore, makeTestDesign, type TestSessionCoreHandle } from '../../__tests__/support/session-core-fixture'
import { mountCanvasHost, type CanvasHostHandle } from './canvas-host'
import { createDesktopCanvasHostCore, createDesktopCanvasHostRuntime } from './desktop-workspace-runtime'
import type { WorkspaceRuntimeComposition } from './workspace-runtime-composition'

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

function makeContainer(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  return el
}

function makeFakeComposition() {
  const documents = createTestCanvasDocumentSurface()
  const surfaces = createTestCanvasRuntimeSurfaces({ documents })
  const mapSlot = createMapLifetimeSlot(
    { restart: () => true, retryLayer: () => {}, release: () => {} },
    { kind: 'ready', attempt: 1, layers: new Map() },
  )
  const dispose = vi.fn(async () => undefined)
  const composition: WorkspaceRuntimeComposition = {
    surfaces,
    mapLifetime: mapSlot.handle,
    start: vi.fn(async () => 'shared-ready' as const),
    dispose,
  }
  return { composition, documents, surfaces, dispose }
}

describe('createDesktopCanvasHostCore through mountCanvasHost', () => {
  let handles: CanvasHostHandle[] = []
  let session: TestSessionCoreHandle | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    setCurrentCanvasSession(null)
    handles = []
    session = createTestSessionCore({ file: makeTestDesign(), path: '/orchard.canopi' })
  })

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose()
    setCurrentCanvasSession(null)
    session?.dispose()
    session = null
  })

  it('attaches ScenePort on mount and detaches ScenePort on teardown', async () => {
    const attachSpy = vi.spyOn(session!.core, 'attachScene')
    const detachSpy = vi.spyOn(session!.core, 'detachScene')
    const fake = makeFakeComposition()
    const loadSpy = vi.spyOn(fake.documents, 'replaceDocument')
    const showChromeSpy = vi.spyOn(fake.documents, 'showCanvasChrome')
    const zoomToFitSpy = vi.spyOn(fake.documents, 'zoomToFit')
    const serializeSpy = vi.spyOn(fake.documents, 'serializeSceneFields')

    const host = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(showChromeSpy).toHaveBeenCalledTimes(1)
    expect(zoomToFitSpy).toHaveBeenCalledTimes(1)
    expect(session!.core.currentDesign.value?.scene.kind).toBe('attached')
    expect(host.ready.value).toBe(true)

    await host.dispose()
    expect(detachSpy).toHaveBeenCalledTimes(1)
    expect(serializeSpy).toHaveBeenCalledTimes(1)
    expect(session!.core.currentDesign.value?.scene.kind).toBe('detached')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('canopi-272xn: ScenePort.load shows canvas chrome before zoomToFit', async () => {
    const fake = makeFakeComposition()
    const replaceSpy = vi.spyOn(fake.documents, 'replaceDocument')
    const showChromeSpy = vi.spyOn(fake.documents, 'showCanvasChrome')
    const zoomToFitSpy = vi.spyOn(fake.documents, 'zoomToFit')

    const host = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(showChromeSpy).toHaveBeenCalledTimes(1)
    expect(zoomToFitSpy).toHaveBeenCalledTimes(1)
    const [replaceOrder] = replaceSpy.mock.invocationCallOrder
    const [showOrder] = showChromeSpy.mock.invocationCallOrder
    const [fitOrder] = zoomToFitSpy.mock.invocationCallOrder
    if (replaceOrder === undefined || showOrder === undefined || fitOrder === undefined) {
      throw new Error('expected ScenePort.load to invoke replaceDocument, showCanvasChrome, and zoomToFit')
    }
    expect(replaceOrder).toBeLessThan(showOrder)
    expect(showOrder).toBeLessThan(fitOrder)
  })

  it('detaches and reports runtime-failed when ScenePort.load throws during attachScene', async () => {
    const startError = new Error('load failed')
    const detachSpy = vi.spyOn(session!.core, 'detachScene')
    const fake = makeFakeComposition()
    vi.spyOn(fake.documents, 'replaceDocument').mockImplementation(() => { throw startError })
    const reportFailure = vi.fn()

    const host = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure,
    })
    handles.push(host)
    await flushMicrotasks()

    expect(detachSpy).not.toHaveBeenCalled()
    expect(host.surface.value).toEqual({ kind: 'unavailable', cause: 'runtime-failed' })
    expect(reportFailure).toHaveBeenCalledWith(startError, { code: 'canvas-start-failed', source: 'canvas-host' })
  })

  it('returns no-design without loading when SessionCore has no open Design', async () => {
    session!.dispose()
    session = createTestSessionCore()
    const attachSpy = vi.spyOn(session.core, 'attachScene')
    const fake = makeFakeComposition()
    const loadSpy = vi.spyOn(fake.documents, 'replaceDocument')

    const host = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveReturnedWith('no-design')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(host.ready.value).toBe(true)
  })

  it('retries teardown when detachScene serialize throws and binds shared adapters without per-edition createComposition', async () => {
    const handoffError = new Error('handoff capture blocked')
    let failOnce = true
    const fake1 = makeFakeComposition()
    vi.spyOn(fake1.documents, 'serializeSceneFields').mockImplementation(() => {
      if (failOnce) {
        failOnce = false
        throw handoffError
      }
      return { plants: [] }
    })

    const host1 = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake1.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host1)
    await flushMicrotasks()

    await host1.dispose()
    expect(fake1.dispose).not.toHaveBeenCalled()
    expect(getCurrentCanvasSession()).toBe(fake1.surfaces)

    const fake2 = makeFakeComposition()
    const host2 = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake2.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host2)
    await flushMicrotasks()

    expect(fake1.dispose).toHaveBeenCalledOnce()
    expect(getCurrentCanvasSession()).toBe(fake2.surfaces)

    const runtime = createDesktopCanvasHostRuntime({ locationEnabled: true })
    expect(runtime.adapters).toBeDefined()
    expect(runtime.createComposition).toBeUndefined()
  })
})
