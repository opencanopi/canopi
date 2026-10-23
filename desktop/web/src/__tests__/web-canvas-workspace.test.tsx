// @vitest-environment jsdom

import { effect, signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesignSessionStore } from '../app/document-session/store'
import { currentCanvasSession } from '../canvas/session'
import { CanvasRuntimeCleanupError } from '../canvas/runtime/cleanup'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
} from '../canvas/runtime/runtime'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { createSessionPlane, type SessionPlane } from '../canvas/session-plane'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import { createTestViewReadSurface } from './support/canvas-query-surface'
import { createTestCanvasKeyboardPort } from './support/canvas-runtime-surfaces'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { createBrowserDesignSessionController, type BrowserDesignFileAdapter } from '../web/browser-design-session'
import { WebCanvasWorkspace } from '../web/WebCanvasWorkspace'
import { unmount } from './support/unmount'

// The floating chrome has its own tests; here it only marks where the workspace mounts it.
vi.mock('../components/canvas/CanvasChrome', () => ({
  CanvasChrome: () => <div data-testid="canvas-chrome" />,
}))
import type {
  WorkspaceRuntimeComposition,
  WorkspaceRuntimeStartOutcome,
} from '../app/canvas-map-surface/workspace-runtime-composition'

describe('Web Edition canvas workspace', () => {
  let container: HTMLDivElement

  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }

  afterEach(() => {
    if (container) unmount(container)
    container?.remove()
    currentCanvasSession.value = null
  })

  it.each<WorkspaceRuntimeStartOutcome>(['shared-ready', 'map-unavailable'])(
    'mounts the shared canvas runtime surface after %s without deferred desktop panels',
    async (outcome) => {
      container = document.createElement('div')
      document.body.appendChild(container)
      const store = createDesignSessionStore()
      const controller = createBrowserDesignSessionController({
        store,
        appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
        now: () => new Date('2026-07-04T12:00:00.000Z'),
      })
      const runtime = fakeRuntimeComposition(outcome)
      const attachCanvasSession = vi.spyOn(controller, 'attachCanvasSession')
      // Only the workspace's observer of the canvas area; floating chrome has its own.
      const observe = vi.fn<(target: Element) => void>()
      const OriginalResizeObserver = globalThis.ResizeObserver
      globalThis.ResizeObserver = class {
        observe = (target: Element) => { if (isCanvasArea(target)) observe(target) }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver
      const publishSurfaces = vi.fn()
      const disposePublicationEffect = effect(() => {
        if (currentCanvasSession.value === runtime.composition.surfaces) publishSurfaces()
      })

      try {
        await controller.newDesign()
        await act(async () => {
          render(
            <WebCanvasWorkspace
              controller={controller}
              store={store}
              createRuntimeComposition={() => runtime.composition}
            />,
            container,
          )
          await flushMicrotasks()
        })
        await flushMicrotasks()

        expect(runtime.composition.start).toHaveBeenCalledOnce()
        expect(runtime.documents.loadDocument).toHaveBeenCalledWith(expect.objectContaining({ name: 'Untitled' }))
        expect(runtime.documents.showCanvasChrome).toHaveBeenCalled()
        expect(currentCanvasSession.value).toBe(runtime.composition.surfaces)
        const startupOrder = [
          vi.mocked(runtime.composition.start).mock.invocationCallOrder[0]!,
          attachCanvasSession.mock.invocationCallOrder[0]!,
          vi.mocked(runtime.documents.resize).mock.invocationCallOrder[0]!,
          observe.mock.invocationCallOrder[0]!,
          publishSurfaces.mock.invocationCallOrder[0]!,
        ]
        expect(startupOrder).toEqual([...startupOrder].sort((left, right) => left - right))
        expect(container.querySelector('[data-testid="web-canvas-workspace"]')).not.toBeNull()
        expect(container.querySelector('[data-testid="web-canvas-workspace-surface"]')).not.toBeNull()
        expect(container.textContent).not.toContain('Timeline')
        expect(container.textContent).not.toContain('Budget')
        expect(container.textContent).not.toContain('Consortium')
        expect(container.textContent).not.toContain('Display')
        expect(container.textContent).not.toContain('Color by')
        expect(container.textContent).not.toContain('Design notebook')
        expect(container.textContent).not.toContain('Problem Report')
      } finally {
        disposePublicationEffect()
        attachCanvasSession.mockRestore()
        globalThis.ResizeObserver = OriginalResizeObserver
      }
    },
  )

  it('does not attach or publish a composition whose start is cancelled', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition('cancelled')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await controller.newDesign()

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => runtime.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      expect(runtime.documents.loadDocument).not.toHaveBeenCalled()
      expect(currentCanvasSession.value).toBeNull()
      expect(runtime.composition.dispose).toHaveBeenCalledOnce()
      expect(logError).toHaveBeenCalledWith(
        'Failed to initialize browser canvas runtime:',
        expect.objectContaining({ message: 'Shared browser workspace initialization was cancelled.' }),
      )
    } finally {
      logError.mockRestore()
    }
  })

  it('does not continue initialization after publication synchronously releases the runtime', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    // Only the workspace's observer of the canvas area; floating chrome has its own.
    const observe = vi.fn()
    const disconnect = vi.fn()
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private watchesCanvasArea = false
      observe = (target: Element) => {
        if (!isCanvasArea(target)) return
        this.watchesCanvasArea = true
        observe(target)
      }
      unobserve() {}
      disconnect = () => { if (this.watchesCanvasArea) disconnect() }
    } as unknown as typeof ResizeObserver
    let releasedFirst = false
    const disposePublicationEffect = effect(() => {
      const published = currentCanvasSession.value
      if (
        !releasedFirst
        && published === first.composition.surfaces
      ) {
        releasedFirst = true
        render(null, container)
      }
    })
    await controller.newDesign()

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => first.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      const destroyOrder = vi.mocked(first.composition.dispose).mock.invocationCallOrder[0] ?? 0
      expect(first.composition.dispose).toHaveBeenCalledOnce()
      expect(vi.mocked(first.documents.resize).mock.invocationCallOrder[0])
        .toBeLessThan(destroyOrder)
      expect(observe.mock.invocationCallOrder[0]).toBeLessThan(destroyOrder)
      expect(disconnect).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBeNull()

      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => second.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()
      expect(second.composition.start).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBe(second.composition.surfaces)
    } finally {
      disposePublicationEffect()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('releases the old owner before a refreshed composition mounts', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    const firstFactory = () => first.composition
    const secondFactory = () => second.composition
    await controller.newDesign()

    await act(async () => {
      render(
        <WebCanvasWorkspace
          controller={controller}
          store={store}
          createRuntimeComposition={firstFactory}
        />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()
    expect(currentCanvasSession.value).toBe(first.composition.surfaces)

    await act(async () => {
      render(
        <WebCanvasWorkspace
          controller={controller}
          store={store}
          createRuntimeComposition={secondFactory}
        />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    expect(first.documents.captureForPersistence).toHaveBeenCalledOnce()
    expect(first.composition.dispose).toHaveBeenCalledOnce()
    expect(second.composition.start).toHaveBeenCalledOnce()
    expect(currentCanvasSession.value).toBe(second.composition.surfaces)
  })

  it('does not construct or publish a successor until the prior release settles', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    const release = deferred<void>()
    vi.mocked(first.composition.dispose).mockImplementationOnce(() => release.promise)
    const firstFactory = vi.fn(() => first.composition)
    const secondFactory = vi.fn(() => second.composition)
    await controller.newDesign()

    await act(async () => {
      render(
        <WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={firstFactory} />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    await act(async () => {
      render(
        <WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={secondFactory} />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    expect(firstFactory).toHaveBeenCalledOnce()
    expect(secondFactory).not.toHaveBeenCalled()
    expect(currentCanvasSession.value).toBe(first.composition.surfaces)

    release.resolve()
    await flushMicrotasks()

    expect(secondFactory).toHaveBeenCalledOnce()
    expect(second.composition.start).toHaveBeenCalledOnce()
    expect(currentCanvasSession.value).toBe(second.composition.surfaces)
  })

  it('releases a composition without attaching or publishing after unmount during initialization', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()
    const initialization = deferred<void>()
    vi.mocked(runtime.composition.start).mockImplementationOnce(async () => {
      await initialization.promise
      return 'shared-ready'
    })
    await controller.newDesign()

    await act(async () => {
      render(
        <WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={() => runtime.composition} />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()
    expect(runtime.composition.start).toHaveBeenCalledOnce()

    render(null, container)
    initialization.resolve()
    await flushMicrotasks()

    // The mounted owner cannot attach or publish after the component releases
    // its lease while composition start is pending.
    expect(runtime.documents.loadDocument).not.toHaveBeenCalled()
    expect(currentCanvasSession.value).toBeNull()
    expect(runtime.composition.dispose).toHaveBeenCalledOnce()
  })

  it('Canvas, a panel, then Canvas with no effect flush between: the unmounted owner never publishes and one runtime remains (Preact 11 cleanup timing)', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    const initialization = deferred<void>()
    vi.mocked(first.composition.start).mockImplementationOnce(async () => {
      await initialization.promise
      return 'shared-ready'
    })
    const firstPublished = vi.fn()
    const disposePublicationEffect = effect(() => {
      if (currentCanvasSession.value === first.composition.surfaces) firstPublished()
    })
    const factory = vi.fn()
      .mockReturnValueOnce(first.composition)
      .mockReturnValueOnce(second.composition)
    await controller.newDesign()

    try {
      await act(async () => {
        render(<WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={factory} />, container)
        await flushMicrotasks()
      })
      expect(first.composition.start).toHaveBeenCalledOnce()

      // A side panel replaces the Canvas, as a route change does: no act, so nothing flushes after-paint work.
      render(<div data-testid="side-panel" />, container)
      initialization.resolve()
      await flushMicrotasks()

      expect(first.documents.loadDocument).not.toHaveBeenCalled()
      expect(firstPublished).not.toHaveBeenCalled()
      expect(first.composition.dispose).toHaveBeenCalledOnce()

      await act(async () => {
        render(<WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={factory} />, container)
        await flushMicrotasks()
      })
      await flushMicrotasks()

      expect(factory).toHaveBeenCalledTimes(2)
      expect(first.composition.dispose).toHaveBeenCalledOnce()
      expect(firstPublished).not.toHaveBeenCalled()
      expect(currentCanvasSession.value).toBe(second.composition.surfaces)
    } finally {
      disposePublicationEffect()
    }
  })

  it('releases a composition returned by a factory that unmounts reentrantly', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()
    const createRuntimeComposition = vi.fn(() => {
      render(null, container)
      return runtime.composition
    })
    await controller.newDesign()

    await act(async () => {
      render(
        <WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={createRuntimeComposition} />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    expect(createRuntimeComposition).toHaveBeenCalledOnce()
    expect(runtime.composition.start).not.toHaveBeenCalled()
    expect(runtime.composition.dispose).toHaveBeenCalledOnce()
    expect(currentCanvasSession.value).toBeNull()
  })

  it('waits for a reentrant browser attachment to return its disposer before teardown', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()
    const attach = controller.attachCanvasSession.bind(controller)
    const detach = vi.fn()
    vi.spyOn(controller, 'attachCanvasSession').mockImplementation((documents) => {
      const detachAttachedSession = attach(documents)
      render(null, container)
      return () => {
        detach()
        detachAttachedSession()
      }
    })
    await controller.newDesign()

    await act(async () => {
      render(
        <WebCanvasWorkspace controller={controller} store={store} createRuntimeComposition={() => runtime.composition} />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    expect(detach).toHaveBeenCalledOnce()
    expect(runtime.composition.dispose).toHaveBeenCalledOnce()
    expect(currentCanvasSession.value).toBeNull()
  })

  it('shows a desktop-style browser-safe welcome screen without recent files when no Design is active', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const fileAdapter: BrowserDesignFileAdapter = {
      openCanopiFile: vi.fn(async () => null),
      downloadCanopiFile: vi.fn(async () => undefined),
    }
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition('no-design')

    await act(async () => {
      render(
        <WebCanvasWorkspace
          controller={controller}
          store={store}
          createRuntimeComposition={() => runtime.composition}
        />,
        container,
      )
      await flushMicrotasks()
    })
    await flushMicrotasks()

    expect(runtime.documents.hideCanvasChrome).toHaveBeenCalled()
    expect(currentCanvasSession.value).toBe(runtime.composition.surfaces)
    expect(container.querySelector('[data-testid="web-welcome-screen"]')).not.toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Canopi')
    expect(container.querySelector('[data-testid="canvas-chrome"]')).toBeNull()
    expect(container.textContent).toContain('New Design')
    expect(container.textContent).toContain('Open a .canopi file…')
    expect(container.textContent).not.toContain('Recent Files')
    expect(container.textContent).not.toContain('No Design loaded')

    await act(async () => {
      buttonByText(container, 'Open a .canopi file…Ctrl O').click()
    })
    expect(fileAdapter.openCanopiFile).toHaveBeenCalledOnce()

    await act(async () => {
      buttonByText(container, 'New Design').click()
    })
    expect(store.readCurrentDesign()?.name).toBe('Untitled')
  })

  it('does not replace live canvas-owned state after a non-canvas Design edit', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()

    await controller.newDesign()
    await act(async () => {
      render(
        <WebCanvasWorkspace
          controller={controller}
          store={store}
          createRuntimeComposition={() => runtime.composition}
        />,
        container,
      )
      await flushMicrotasks()
    })
    vi.mocked(runtime.documents.replaceDocument).mockClear()

    await act(async () => {
      controller.renameDesign('Renamed outside the canvas')
      await Promise.resolve()
    })

    expect(store.readDesignName()).toBe('Renamed outside the canvas')
    expect(store.isDesignDirty()).toBe(true)
    expect(runtime.documents.replaceDocument).not.toHaveBeenCalled()
  })

  it('mounts the shared floating chrome once a Design is open', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()

    await controller.newDesign()
    await act(async () => {
      render(
        <WebCanvasWorkspace
          controller={controller}
          store={store}
          createRuntimeComposition={() => runtime.composition}
        />,
        container,
      )
      await flushMicrotasks()
    })

    expect(container.querySelector('[data-testid="canvas-chrome"]')).not.toBeNull()
  })

  it('releases a runtime whose Design attachment fails', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const runtime = fakeRuntimeComposition()
    vi.mocked(runtime.documents.loadDocument).mockImplementation(() => {
      throw new Error('canvas hydration failed')
    })
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await controller.newDesign()

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => runtime.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      await vi.waitFor(() => {
        expect(logError).toHaveBeenCalledWith(
          'Failed to initialize browser canvas runtime:',
          expect.objectContaining({ message: 'canvas hydration failed' }),
        )
      })
      expect(runtime.composition.dispose).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBeNull()
      // The open Design shows over the map notice; it never waits behind the start screen for a session that will not come.
      expect(container.querySelector('[data-design-hidden]')).toBeNull()
      expect(container.querySelector('[data-map-notice] [role="status"]')?.textContent).toBe('Map unavailable')
    } finally {
      logError.mockRestore()
    }
  })

  it('does not replace or clear an existing Canvas publication when attachment is rejected', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const existing = fakeRuntimeComposition()
    const rejected = fakeRuntimeComposition()
    await controller.newDesign()
    const detachExisting = controller.attachCanvasSession(existing.documents)
    currentCanvasSession.value = existing.composition.surfaces
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => rejected.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      await vi.waitFor(() => expect(rejected.composition.dispose).toHaveBeenCalledOnce())
      expect(currentCanvasSession.value).toBe(existing.composition.surfaces)
      expect(rejected.documents.loadDocument).not.toHaveBeenCalled()
    } finally {
      render(null, container)
      detachExisting()
      currentCanvasSession.value = null
      logError.mockRestore()
    }
  })

  it('retries a failed Canvas handoff before mounting a replacement runtime', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    const disconnect = vi.fn()
    const OriginalResizeObserver = globalThis.ResizeObserver
    // Only the workspace's observer of the canvas area; floating chrome has its own.
    globalThis.ResizeObserver = class {
      private watchesCanvasArea = false
      observe(target: Element) { if (isCanvasArea(target)) this.watchesCanvasArea = true }
      unobserve() {}
      disconnect = () => { if (this.watchesCanvasArea) disconnect() }
    } as unknown as typeof ResizeObserver
    await controller.newDesign()

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => first.composition}
          />,
          container,
        )
      })
      await flushMicrotasks()
      let handoffFailures = 4
      vi.mocked(first.documents.captureForPersistence)
        .mockImplementation((metadata, doc) => {
          if (handoffFailures > 0) {
            handoffFailures -= 1
          throw new Error('handoff capture failed')
          }
          return {
            content: { ...doc, name: metadata.name },
            isCurrent: () => true,
            acknowledgeSaved: () => 'applied' as const,
          }
        })

      render(null, container)
      await flushMicrotasks()
      expect(disconnect).not.toHaveBeenCalled()
      expect(first.composition.dispose).not.toHaveBeenCalled()
      expect(currentCanvasSession.value).toBe(first.composition.surfaces)

      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => second.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      expect(disconnect).toHaveBeenCalledOnce()
      expect(first.composition.dispose).toHaveBeenCalledOnce()
      expect(second.composition.start).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBe(second.composition.surfaces)
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('releases the lifecycle after reporting exhaustive post-handoff cleanup failures', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
    })
    const first = fakeRuntimeComposition()
    const second = fakeRuntimeComposition()
    const disconnectError = new Error('observer disconnect failed')
    const destroyError = new Error('runtime destroy failed')
    const disconnect = vi.fn()
    disconnect.mockImplementationOnce(() => {
      throw disconnectError
    })
    vi.mocked(first.composition.dispose).mockImplementationOnce(() => {
      throw destroyError
    })
    const OriginalResizeObserver = globalThis.ResizeObserver
    // Only the workspace's observer of the canvas area; floating chrome has its own.
    globalThis.ResizeObserver = class {
      private watchesCanvasArea = false
      observe(target: Element) { if (isCanvasArea(target)) this.watchesCanvasArea = true }
      unobserve() {}
      disconnect = () => { if (this.watchesCanvasArea) disconnect() }
    } as unknown as typeof ResizeObserver
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await controller.newDesign()

    try {
      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => first.composition}
          />,
          container,
      )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      render(null, container)
      await flushMicrotasks()

      expect(first.documents.captureForPersistence).toHaveBeenCalledOnce()
      expect(disconnect).toHaveBeenCalledOnce()
      expect(first.composition.dispose).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBeNull()
      const cleanupError = logError.mock.calls.find(
        ([message]) => message === 'Failed to release browser canvas runtime:',
      )?.[1]
      expect(cleanupError).toBeDefined()
      expect(cleanupError).toBeInstanceOf(CanvasRuntimeCleanupError)
      expect((cleanupError as CanvasRuntimeCleanupError).errors).toEqual([
        disconnectError,
        destroyError,
      ])

      await act(async () => {
        render(
          <WebCanvasWorkspace
            controller={controller}
            store={store}
            createRuntimeComposition={() => second.composition}
          />,
          container,
        )
        await flushMicrotasks()
      })
      await flushMicrotasks()

      expect(second.composition.start).toHaveBeenCalledOnce()
      expect(currentCanvasSession.value).toBe(second.composition.surfaces)
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver
      logError.mockRestore()
    }
  })
})

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new Error('storage unavailable')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function fakeRuntimeComposition(
  outcome: WorkspaceRuntimeStartOutcome = 'shared-ready',
): {
  composition: WorkspaceRuntimeComposition
  documents: CanvasDocumentSurface
} {
  let loaded = false
  const documents: CanvasDocumentSurface = {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(() => {
      loaded = true
    }),
    replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
      loaded = true
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    }),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    })),
    resize: vi.fn(),
    destroy: vi.fn(async () => undefined),
  }
  const composition: WorkspaceRuntimeComposition = {
    surfaces: {
      commands: fakeCommandSurface(),
      queries: fakeQuerySurface(),
      documents,
      keyboard: createTestCanvasKeyboardPort(),
    } satisfies CanvasRuntimeSurfaces,
    start: vi.fn(async () => outcome),
    retryMap: vi.fn(),
    dispose: vi.fn(),
  }
  return { composition, documents }
}

function fakeCommandSurface(): CanvasCommandSurface {
  return {
    speciesFocus: { focus: () => {} },
    tools: { setTool: vi.fn(), plantRowSpacing: { input: vi.fn(), commit: vi.fn(), blur: vi.fn(), cancel: vi.fn() } },
    viewport: {
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomToFit: vi.fn(),
      returnToDesign: vi.fn(),
      focusTemporaryBounds: vi.fn(() => false),
      frameBounds: vi.fn(() => false),
      returnFromTemporaryFocus: vi.fn(() => false),
      showPlace: vi.fn(() => false),
      zoomBy: vi.fn(),
      setFramingInsets: vi.fn(),
      setDesignPinExtent: vi.fn(),
      zoomToSelection: vi.fn(),
      resetNorth: vi.fn(),
      rotateBy: vi.fn(),
      beginRotation: vi.fn(() => ({ update: vi.fn(), end: vi.fn(), cancel: vi.fn() })),
      showCamera: vi.fn(),
    },
    history: {
      canUndo: signal(false),
      canRedo: signal(false),
      undo: vi.fn(),
      redo: vi.fn(),
    },
    sceneEdits: {
      saveSelectionAsObjectStamp: vi.fn(),
      importDesignObjects: vi.fn(() => ({ committed: false, createdCount: 0 })),
      copy: vi.fn(),
      paste: vi.fn(),
      pasteAt: vi.fn(),
      canPaste: vi.fn(() => false),
      duplicateSelected: vi.fn(),
      toggleSelectedPlantNamePins: vi.fn(),
      deleteSelected: vi.fn(),
      selectAll: vi.fn(),
      selectSameSpecies: vi.fn(),
      selectSpecies: vi.fn(),
      clearSelection: vi.fn(),
      bringToFront: vi.fn(),
      sendToBack: vi.fn(),
      lockSelected: vi.fn(),
      unlockSelected: vi.fn(),
      groupSelected: vi.fn(),
      ungroupSelected: vi.fn(),
      renameZone: vi.fn(() => true),
      rotateSelected: vi.fn(),
      unlockAll: vi.fn(),
      nudgeSelected: vi.fn(() => false),
      endNudge: vi.fn(),
    },
    chrome: {
      toggleGrid: vi.fn(),
      toggleSnapToGrid: vi.fn(),
    },
    layers: {
      setSceneLayerVisibility: vi.fn(() => true),
      setSceneLayerOpacity: vi.fn(() => true),
      setSceneLayerLocked: vi.fn(() => true),
      presentLayers: vi.fn(),
    },
    plantPresentation: {
      ensureSpeciesCacheEntries: vi.fn(async () => false),
      setSelectedPlantColor: vi.fn(() => 0),
      setSelectedPlantSymbol: vi.fn(() => 0),
      setPlantColorForSpecies: vi.fn(() => 0),
      setPlantSymbolForSpecies: vi.fn(() => 0),
    },
  }
}

function fakeQuerySurface(): CanvasQuerySurface {
  return {
    revision: {
      scene: signal(0),
      plantNames: signal(0),
      transientHistory: signal(0),
    },
    sessionPlane: signal<SessionPlane | null>(createSessionPlane(TEST_GEO_ORIGIN)),
    view: createTestViewReadSurface(),
    getSpeciesFocus: () => ({ canonicalName: null }),
    getPlantLabelCoverage: () => ({ labelled: 0, inView: 0 }),
    capturePrintSnapshot: () => null,
    captureViewScene: () => null,
    sceneHasObjects: () => false,
    getSceneSnapshot: vi.fn(() => createDefaultScenePersistedState()),
    getSelection: vi.fn(() => []),
    getDesignObjectSelection: vi.fn(() => ({
      editableTargets: [],
      lockedTargets: [],
      blockedTargets: [],
      bounds: null,
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: { plantIds: [], allPinned: false },
    })),
    getSelectedPlantColorContext: vi.fn(() => ({
      plantIds: [],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentColor: null,
      suggestedColor: null,
      singleSpeciesDefaultColor: null,
    })),
    getSelectedPlantSymbolContext: vi.fn(() => ({
      plantIds: [],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round' as const,
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })),
    getPlacedPlants: vi.fn(() => []),
    getSettledPlacedPlants: vi.fn(() => []),
    getSettledDesignObjects: vi.fn(() => null),
    getLocalizedCommonNames: vi.fn(() => new Map()),
    getEnglishFallbackNames: vi.fn(() => new Map()),
    getSpeciesCache: vi.fn(() => new Map()),
    subscribePointerWorld: () => () => {},
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button ${text}`)
  return button
}

function isCanvasArea(target: Element): boolean {
  return target.firstElementChild?.getAttribute('data-testid') === 'web-canvas-workspace-surface'
}
