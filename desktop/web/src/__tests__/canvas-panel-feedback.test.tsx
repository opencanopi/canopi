// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signal, type Signal } from '@preact/signals'
import {
  createDefaultMapLayersForTests as createDefaultMapLayers,
  mapLayers,
  type MapLayersState,
  locale,
} from '../app/settings/state'
import { setStoryPresentationOverrides } from '../app/story-presentation/overrides'
import { storyPresentationActive } from '../app/story-presentation'
import { t } from '../i18n'
import { CanvasPanel } from '../components/panels/CanvasPanel'
import { PresentedMapNotice } from '../components/canvas/MapNotice'
import { WebCanvasWorkspace } from '../editions/web/WebCanvasWorkspace'
import { profileLineMenu } from '../app/data-library/profile'
import { IDLE_CANVAS_SURFACE_STATE, type CanvasSurfaceState } from '../app/canvas-map-surface/canvas-host'
import { installCanvasHostRuntime } from '../app/canvas-map-surface/use-canvas-host'
import type * as UseCanvasHostModule from '../app/canvas-map-surface/use-canvas-host'
import type { WorkspaceRuntimeComposition } from '../app/canvas-map-surface/workspace-runtime-composition'
import { createMapLifetimeSlot, type LayerSlotId, type LayerStatus } from '../maplibre/map-lifetime'
import { designSessionFixture } from './support/design-session-state'
import type { CanopiFile } from '../types/design'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasDocumentSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type * as StoryPresentationModule from '../app/story-presentation'

const mockSurface = signal<CanvasSurfaceState>(IDLE_CANVAS_SURFACE_STATE)
const mockReady = signal(false)
const retryMap = vi.fn(() => false)
const retryLayer = vi.fn()

function readySurface(layers: ReadonlyArray<readonly [LayerSlotId, LayerStatus]> = []): CanvasSurfaceState {
  return { kind: 'map', map: { kind: 'ready', attempt: 1, layers: new Map(layers) }, retry: 'withheld' }
}

function loadingSurface(): CanvasSurfaceState {
  return { kind: 'map', map: { kind: 'creating', attempt: 1 }, retry: 'withheld' }
}

function failedSurface(retry: 'offered' | 'never'): CanvasSurfaceState {
  return { kind: 'map', map: { kind: 'failed', attempt: 1, cause: retry === 'never' ? 'no-webgl2' : 'context-lost' }, retry }
}

const chromeProps = vi.hoisted(() => [] as Array<Readonly<Record<string, unknown>>>)

vi.mock('../components/canvas/CanvasChrome', () => ({
  CanvasChrome: (props: Readonly<Record<string, unknown>>) => {
    chromeProps.push(props)
    return <div data-testid="canvas-chrome" />
  },
}))

// Whether a story is presented: the real controller needs a Design with a story and a map; the notice reads only this.
// The presenter's own notice is `PresentedMapNotice` (story-presentation.test.tsx draws it in the real presenter).
vi.mock('../app/story-presentation', async (importOriginal) => {
  const { signal: presentationSignal } = await import('@preact/signals')
  return { ...await importOriginal<typeof StoryPresentationModule>(), storyPresentationActive: presentationSignal(false) }
})

vi.mock('../components/canvas/LayerPanel', () => ({ LayerPanel: () => <div data-testid="layer-panel" /> }))

vi.mock('../components/shared/WelcomeScreen', () => ({ WelcomeScreen: () => <div data-testid="welcome-screen" /> }))

vi.mock('../app/canvas-map-surface/use-canvas-host', async (importOriginal) => {
  const actual = await importOriginal<typeof UseCanvasHostModule>()
  return {
    ...actual,
    useCanvasHost: vi.fn((containerRef) => {
      if (useRealCanvasHost) return actual.useCanvasHost(containerRef)
      return { surface: mockSurface, ready: mockReady, retryMap, retryLayer }
    }),
  }
})

let useRealCanvasHost = false

describe('CanvasPanel basemap feedback', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    useRealCanvasHost = false
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    mapLayers.value = createDefaultMapLayers()
    designSessionFixture.file = null
    mockSurface.value = IDLE_CANVAS_SURFACE_STATE
    mockReady.value = false
    retryMap.mockReset().mockReturnValue(false)
    retryLayer.mockReset()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    leavePresentation()
  })

  it('shows the basemap failure with a Retry that retries this map in the presenter while a story step shows Street map over the user\'s None', async () => {
    designSessionFixture.file = demoDesign()
    mapLayers.value = mapLayersShowing('none')
    presentStepShowing('basemap')
    mockSurface.value = readySurface([['background', { kind: 'failed', reason: 'basemap' }]])

    await act(async () => {
      render(<><CanvasPanel />{presenterLayer()}</>, container)
    })

    expect(canvasNotices(container), 'the canvas draws no notice under the presenter').toEqual([])
    await expectPresentedFailureRetries(container, retryLayer)
    expect(container.querySelector('[data-map-active="true"]')).not.toBeNull()

    // Leaving the presentation shows the user's None again: no notice anywhere.
    await act(async () => { leavePresentation() })
    expect(container.querySelector('[data-map-notice]')).toBeNull()
  })

  it('shows no basemap notice while a story step shows None over the user\'s visible basemap', async () => {
    designSessionFixture.file = demoDesign()
    mapLayers.value = mapLayersShowing('basemap')
    presentStepShowing('none')
    mockSurface.value = readySurface([['background', { kind: 'failed', reason: 'basemap' }]])

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-map-notice]')).toBeNull()
    expect(container.querySelector('[data-map-active="true"]')).toBeNull()
  })

  it('does not show a Map Notice or activate the map surface without an open Design', async () => {
    designSessionFixture.file = null
    mockSurface.value = loadingSurface()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[data-map-active="true"]')).toBeNull()
  })

  it('shows loading feedback as one quiet status chip over the map with the floating chrome', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = loadingSurface()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    const status = container.querySelector<HTMLElement>('[role="status"]')!
    expect(status.textContent).toContain('Loading')
    expect(container.querySelector<HTMLElement>('[data-map-notice]')!.dataset.tone).toBe('loading')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('[data-testid="canvas-chrome"]')).not.toBeNull()
  })

  it('hands the canvas menu Site data’s Profile this line', async () => {
    designSessionFixture.file = demoDesign()
    chromeProps.length = 0
    await act(async () => {
      render(<CanvasPanel />, container)
    })
    expect(chromeProps.at(-1)?.profileLine).toBe(profileLineMenu)
  })

  it('shows a loading basemap notice until the map becomes active', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = loadingSurface()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Loading')
    expect(container.querySelector('[data-map-active="true"]')).not.toBeNull()
  })

  it('hides the clean ready Map Notice once the basemap becomes active', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = readySurface()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[data-map-active="true"]')).toBeTruthy()
  })

  it('keeps the canvas map surface active for terrain-only visibility', async () => {
    designSessionFixture.file = demoDesign()
    const defaults = createDefaultMapLayers()
    mapLayers.value = {
      ...defaults,
      basemap: { ...defaults.basemap, visible: false },
      satellite: { ...defaults.satellite, visible: false },
      hillshade: { ...defaults.hillshade, visible: true },
    }
    mockSurface.value = readySurface([['terrain', { kind: 'ready' }]])

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-map-active="true"]')).toBeTruthy()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps the canvas map surface active when only Satellite is visible', async () => {
    designSessionFixture.file = demoDesign()
    const defaults = createDefaultMapLayers()
    mapLayers.value = {
      ...defaults,
      basemap: { ...defaults.basemap, visible: false },
      satellite: { ...defaults.satellite, visible: true },
    }
    mockSurface.value = readySurface()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-map-active="true"]')).toBeTruthy()
  })

  it('shows a WebGL2-unavailable map failure with a fixed message and no Retry', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = failedSurface('never')

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toBe('WebGL2 is unavailable on this device. Canopi needs WebGL2 to draw the map.')
    expect(container.querySelector('button')).toBeNull()
  })

  it('offers Retry when the map stopped drawing and hands it to the Design session', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = failedSurface('offered')
    retryMap.mockReturnValue(true)

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    const notice = container.querySelector<HTMLElement>('[data-map-notice]')!
    expect(notice.querySelector('[role="status"]')!.textContent).toBe('The map stopped drawing. Your Design is safe.')
    await act(async () => { notice.querySelector('button')!.click() })
    expect(retryMap).toHaveBeenCalledOnce()
  })

  it('hands keyboard focus to the map container once a Retried map is back, before its session returns', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = failedSurface('offered')
    retryMap.mockReturnValue(true)
    await act(async () => {
      render(<CanvasPanel />, container)
    })
    const map = container.querySelector<HTMLElement>('[data-map-active]')!
    const retry = [...container.querySelectorAll<HTMLButtonElement>('[data-map-notice] button')]
      .find((button) => button.textContent === 'Retry')!
    retry.focus()

    // Retry rebuilds the map: the notice shows loading, then goes once the map draws, while the rebuilt interaction
    // session has not made the host a keyboard stop again yet.
    await act(async () => { retry.click() })
    await act(async () => { mockSurface.value = loadingSurface() })
    await act(async () => { mockSurface.value = readySurface() })

    expect(container.querySelector('[data-map-notice]')).toBeNull()
    expect(document.activeElement).toBe(map)
  })

  it('keeps the map notice hidden when terrain fails (shown on its Layers row instead; 2.1-Q351)', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = readySurface([['terrain', { kind: 'failed', reason: 'terrain' }]])

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-map-notice]')).toBeNull()
    expect(container.querySelector('[data-map-active="true"]')).toBeTruthy()
  })

  it('offers Retry on a basemap that couldn’t load and hands it to the Design session', async () => {
    designSessionFixture.file = demoDesign()
    mockSurface.value = readySurface([['background', { kind: 'failed', reason: 'basemap' }]])

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    const notice = container.querySelector<HTMLElement>('[data-map-notice]')!
    expect(notice.dataset.tone).toBe('error')
    expect(notice.querySelector('[role="status"]')!.textContent).toBe('Basemap couldn’t load. Check your connection.')
    const retry = [...notice.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await act(async () => { retry.click() })
    expect(retryLayer).toHaveBeenCalledWith('background')
  })
})

describe('CanvasPanel opening a Design', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    useRealCanvasHost = false
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    mapLayers.value = createDefaultMapLayers()
    designSessionFixture.file = null
    mockSurface.value = readySurface()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    designSessionFixture.file = null
  })

  it('keeps the start screen up and the chrome laid out but hidden until the Design\'s first scene is drawn', async () => {
    const presented = signal(false)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface({ presented }) }))
    await act(async () => {
      render(<CanvasPanel />, container)
    })
    expect(container.querySelector('[data-testid="welcome-screen"]')).not.toBeNull()

    await act(async () => { designSessionFixture.file = demoDesign() })

    const area = container.querySelector<HTMLElement>('[data-design-hidden]')
    expect(area, 'the canvas area hides everything but the start screen').not.toBeNull()
    expect(container.querySelector('[data-testid="welcome-screen"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="canvas-chrome"]'), 'mounted, so it registers what it covers').not.toBeNull()

    await act(async () => { presented.value = true })

    expect(container.querySelector('[data-design-hidden]')).toBeNull()
    expect(container.querySelector('[data-testid="welcome-screen"]')).toBeNull()
    expect(container.querySelector('[data-testid="canvas-chrome"]')).not.toBeNull()
  })

  it('keeps an open Design shown while another opens over it: the start screen comes back only after Close Design', async () => {
    const presented = signal(true)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface({ presented }) }))
    designSessionFixture.file = demoDesign()
    await act(async () => {
      render(<CanvasPanel />, container)
    })
    expect(container.querySelector('[data-testid="welcome-screen"]')).toBeNull()

    await act(async () => {
      designSessionFixture.file = { ...demoDesign(), name: 'Other' }
      presented.value = false
    })

    expect(container.querySelector('[data-design-hidden]')).toBeNull()
    expect(container.querySelector('[data-testid="welcome-screen"]')).toBeNull()

    await act(async () => { designSessionFixture.file = null })
    expect(container.querySelector('[data-testid="welcome-screen"]')).not.toBeNull()
    await act(async () => { designSessionFixture.file = demoDesign() })
    expect(container.querySelector('[data-design-hidden]'), 'opened from the start screen: hidden until drawn').not.toBeNull()
  })

  it('never shows the start screen for a Design already open when the canvas mounts, as a reload restoring a Draft', async () => {
    const presented = signal(false)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface({ presented }) }))
    designSessionFixture.file = demoDesign()

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-testid="welcome-screen"]'), 'its buttons would replace the open Design').toBeNull()
    expect(container.querySelector('[data-design-hidden]'), 'no chrome over an empty map either').not.toBeNull()

    await act(async () => { presented.value = true })
    expect(container.querySelector('[data-design-hidden]')).toBeNull()
    expect(container.querySelector('[data-testid="welcome-screen"]')).toBeNull()
  })

  it('shows the Design at once on a map that failed: nothing will draw its scene', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface({ presented: signal(false) }) }))
    designSessionFixture.file = demoDesign()
    mockSurface.value = failedSurface('offered')

    await act(async () => {
      render(<CanvasPanel />, container)
    })

    expect(container.querySelector('[data-design-hidden]')).toBeNull()
    expect(container.querySelector('[data-testid="welcome-screen"]')).toBeNull()
  })
})

describe('WebCanvasWorkspace map notice', () => {
  let container: HTMLDivElement
  let uninstallRuntime: (() => void) | null = null

  beforeEach(() => {
    useRealCanvasHost = true
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    mapLayers.value = createDefaultMapLayers()
    designSessionFixture.file = demoDesign()
    uninstallRuntime = null
  })

  afterEach(async () => {
    await act(async () => { render(null, container) })
    uninstallRuntime?.()
    uninstallRuntime = null
    useRealCanvasHost = false
    container.remove()
    designSessionFixture.file = null
    leavePresentation()
  })

  function installFailingBasemapRuntime(retry: () => void) {
    const createComposition = vi.fn(() => {
      const slot = createMapLifetimeSlot(
        { restart: () => false, retryLayer: () => retry(), release: () => {} },
        { kind: 'ready', attempt: 1, layers: new Map([['background', { kind: 'failed', reason: 'basemap' }]]) },
      )
      return {
        surfaces: createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface() }),
        mapLifetime: slot.handle,
        start: () => new Promise<never>(() => {}),
        dispose: async () => {},
      } satisfies WorkspaceRuntimeComposition
    })
    uninstallRuntime = installCanvasHostRuntime(() => ({
      core: { attachScene: async () => 'attached' as const, detachScene: () => {} },
      createComposition,
    }))
    return createComposition
  }

  it('shows the basemap failure with a Retry that reaches its composition in the presenter while a story step shows Street map over the user\'s None', async () => {
    mapLayers.value = mapLayersShowing('none')
    presentStepShowing('basemap')
    const retry = vi.fn()
    const createComposition = installFailingBasemapRuntime(retry)

    await act(async () => {
      render(<><WebCanvasWorkspace />{presenterLayer()}</>, container)
    })
    await act(async () => { await vi.waitFor(() => expect(createComposition).toHaveBeenCalledOnce()) })

    expect(canvasNotices(container), 'the canvas draws no notice under the presenter').toEqual([])
    await expectPresentedFailureRetries(container, retry)

    await act(async () => { leavePresentation() })
    expect(container.querySelector('[data-map-notice]')).toBeNull()
  })

  it('shows no basemap notice while a story step shows None over the user\'s visible basemap', async () => {
    mapLayers.value = mapLayersShowing('basemap')
    presentStepShowing('none')
    const createComposition = installFailingBasemapRuntime(() => {})

    await act(async () => {
      render(<WebCanvasWorkspace />, container)
    })
    await act(async () => { await vi.waitFor(() => expect(createComposition).toHaveBeenCalledOnce()) })

    expect(container.querySelector('[data-map-notice]')).toBeNull()
  })

  it('shows the same basemap notice as the desktop and Retry reaches its composition', async () => {
    const retry = vi.fn()
    const createComposition = installFailingBasemapRuntime(retry)

    await act(async () => {
      render(<WebCanvasWorkspace />, container)
    })
    await act(async () => { await vi.waitFor(() => expect(createComposition).toHaveBeenCalledOnce()) })

    const notice = container.querySelector<HTMLElement>('[data-map-notice]')!
    expect(notice.querySelector('[role="status"]')!.textContent).toBe('Basemap couldn’t load. Check your connection.')
    const button = [...notice.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Retry')!
    await act(async () => { button.click() })
    expect(retry).toHaveBeenCalledOnce()
    // Web has no Site data, so its canvas menu offers no Profile this line.
    expect(chromeProps.at(-1)).toBeDefined()
    expect(chromeProps.at(-1)?.profileLine).toBeUndefined()
  })

  it('hands keyboard focus to the map container once a Retried map is back, before its session returns', async () => {
    const slot = createMapLifetimeSlot(
      { restart: () => true, retryLayer: () => {}, release: () => {} },
      { kind: 'failed', attempt: 1, cause: 'context-lost' },
    )
    const createComposition = vi.fn((opts) => {
      // Queue settling right after mount sets lease.map.
      queueMicrotask(() => opts.onMapFailureStateChange('settled'))
      return {
        surfaces: createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface() }),
        mapLifetime: slot.handle,
        start: () => new Promise<never>(() => {}),
        dispose: async () => {},
      } satisfies WorkspaceRuntimeComposition
    })
    uninstallRuntime = installCanvasHostRuntime(() => ({
      core: { attachScene: async () => 'attached' as const, detachScene: () => {} },
      createComposition,
    }))
    await act(async () => {
      render(<WebCanvasWorkspace />, container)
    })
    await act(async () => {
      await vi.waitFor(() => {
        const retryBtn = [...container.querySelectorAll<HTMLButtonElement>('[data-map-notice] button')]
          .find((b) => b.textContent === 'Retry')
        expect(retryBtn).toBeDefined()
      })
    })
    const map = container.querySelector<HTMLElement>('[data-testid="web-canvas-workspace-surface"]')!
    const retry = [...container.querySelectorAll<HTMLButtonElement>('[data-map-notice] button')]
      .find((button) => button.textContent === 'Retry')!
    retry.focus()

    await act(async () => { retry.click() })
    await act(async () => { slot.setState({ kind: 'creating', attempt: 2 }) })
    await act(async () => { slot.setState({ kind: 'ready', attempt: 2, layers: new Map() }) })

    expect(container.querySelector('[data-map-notice]')).toBeNull()
    expect(document.activeElement).toBe(map)
  })
})

/** The user's own map layers with only the given background, terrain off. */
function mapLayersShowing(background: 'basemap' | 'none'): MapLayersState {
  const defaults = createDefaultMapLayers()
  return {
    ...defaults,
    basemap: { ...defaults.basemap, visible: background === 'basemap' },
    satellite: { ...defaults.satellite, visible: false },
    contours: { ...defaults.contours, visible: false },
    hillshade: { ...defaults.hillshade, visible: false },
  }
}

/** A presented story step whose view shows the given background. */
function presentStepShowing(background: 'basemap' | 'none'): void {
  ;(storyPresentationActive as Signal<boolean>).value = true
  setStoryPresentationOverrides({
    mapLayers: mapLayersShowing(background),
    siteDataIds: new Set(),
    plantLabels: 'none',
    targets: [],
  })
}

/** The story presenter's layer, as far as the notice goes: the presenter draws the canvas's notice there. */
function presenterLayer() {
  return <div data-presenter-layer><PresentedMapNotice focusHome={{ current: null }} /></div>
}

function canvasNotices(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-map-notice]')].filter((notice) => !notice.closest('[data-presenter-layer]'))
}

async function expectPresentedFailureRetries(container: HTMLElement, retry: () => void): Promise<void> {
  const notice = container.querySelector<HTMLElement>('[data-presenter-layer] [data-map-notice]')
  expect(notice?.querySelector('[role="status"]')?.textContent).toBe(t('canvas.layers.basemapFailed'))
  const button = [...notice!.querySelectorAll('button')].find((candidate) => candidate.textContent === t('canvas.layers.retryMap'))
  await act(async () => { button!.click() })
  expect(retry).toHaveBeenCalledOnce()
}

function leavePresentation(): void {
  ;(storyPresentationActive as Signal<boolean>).value = false
  setStoryPresentationOverrides(null)
}

function demoDesign(): CanopiFile {
  return {
    version: 9, name: 'Demo', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR',
    created_at: '2026-04-12T00:00:00.000Z', updated_at: '2026-04-12T00:00:00.000Z', extra: {},
  }
}
