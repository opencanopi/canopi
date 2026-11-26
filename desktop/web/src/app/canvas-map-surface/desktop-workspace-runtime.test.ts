// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentCanvasSession, setCurrentCanvasSession } from '../../canvas/session'
import { createMapLifetimeSlot } from '../../maplibre/map-lifetime'
import {
  createTestCanvasDocumentSurface,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import { mountCanvasHost, type CanvasHostHandle } from './canvas-host'
import type { WorkspaceRuntimeComposition } from './workspace-runtime-composition'

const transitionMocks = vi.hoisted(() => ({
  startAttachedDesignSession: vi.fn(),
  abortFailedAttachedDesignSessionStart: vi.fn(),
  consumeQueuedDocumentLoad: vi.fn(),
  teardownAttachedDesignSession: vi.fn(),
}))

vi.mock('../document-session/transition', () => transitionMocks)

import { createDesktopCanvasHostCore, createDesktopCanvasHostRuntime } from './desktop-workspace-runtime'

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

  beforeEach(() => {
    vi.clearAllMocks()
    setCurrentCanvasSession(null)
    handles = []
  })

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose()
    setCurrentCanvasSession(null)
  })

  it('loads on mount, snapshots with runtimeInitialized: true on teardown, and cancels queued load after snapshot', async () => {
    const order: string[] = []
    const cancelQueued = vi.fn(() => order.push('cancelQueued'))
    transitionMocks.startAttachedDesignSession.mockResolvedValue(null)
    transitionMocks.consumeQueuedDocumentLoad.mockReturnValue(cancelQueued)
    transitionMocks.teardownAttachedDesignSession.mockImplementation(() => order.push('teardown'))

    const fake = makeFakeComposition()
    const host = mountCanvasHost({
      elements: { container: makeContainer() },
      core: createDesktopCanvasHostCore(),
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    expect(transitionMocks.startAttachedDesignSession).toHaveBeenCalledWith(fake.documents)
    expect(transitionMocks.consumeQueuedDocumentLoad).toHaveBeenCalledWith(fake.documents)
    expect(host.ready.value).toBe(true)

    await host.dispose()
    expect(transitionMocks.teardownAttachedDesignSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: fake.documents, runtimeInitialized: true }),
    )
    expect(order).toEqual(['teardown', 'cancelQueued'])
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('does not snapshot before load when startAttachedDesignSession fails', async () => {
    const startError = new Error('load failed')
    transitionMocks.startAttachedDesignSession.mockResolvedValue({ status: 'failed', error: startError })
    const fake = makeFakeComposition()
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

    expect(transitionMocks.abortFailedAttachedDesignSessionStart).toHaveBeenCalledWith(
      fake.documents,
      expect.any(Function),
    )
    expect(transitionMocks.teardownAttachedDesignSession).not.toHaveBeenCalled()
    expect(host.surface.value).toEqual({ kind: 'unavailable', cause: 'runtime-failed' })
    expect(reportFailure).toHaveBeenCalledWith(startError, { code: 'canvas-start-failed', source: 'canvas-host' })
  })

  it('aborts cleanly if consumeQueuedDocumentLoad throws synchronously', async () => {
    const queueError = new Error('queued load exploded')
    transitionMocks.startAttachedDesignSession.mockResolvedValue(null)
    transitionMocks.consumeQueuedDocumentLoad.mockImplementation(() => { throw queueError })
    const fake = makeFakeComposition()
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

    expect(transitionMocks.abortFailedAttachedDesignSessionStart).toHaveBeenCalledWith(
      fake.documents,
      expect.any(Function),
    )
    expect(host.surface.value).toEqual({ kind: 'unavailable', cause: 'runtime-failed' })
    expect(reportFailure).toHaveBeenCalledWith(queueError, { code: 'canvas-start-failed', source: 'canvas-host' })
  })

  it('retains queued load cancellation and retries teardown when handoff snapshot throws', async () => {
    const handoffError = new Error('handoff capture blocked')
    const cancelQueued = vi.fn()
    let failOnce = true
    transitionMocks.startAttachedDesignSession.mockResolvedValue(null)
    transitionMocks.consumeQueuedDocumentLoad.mockReturnValue(cancelQueued)
    transitionMocks.teardownAttachedDesignSession.mockImplementation(() => {
      if (failOnce) {
        failOnce = false
        throw handoffError
      }
    })

    const fake1 = makeFakeComposition()
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
    expect(cancelQueued).not.toHaveBeenCalled()
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

    expect(transitionMocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(2)
    expect(cancelQueued).toHaveBeenCalledOnce()
    expect(fake1.dispose).toHaveBeenCalledOnce()
    expect(getCurrentCanvasSession()).toBe(fake2.surfaces)

    const runtime = createDesktopCanvasHostRuntime({ locationEnabled: true })
    expect(typeof runtime.createComposition).toBe('function')
  })
})
