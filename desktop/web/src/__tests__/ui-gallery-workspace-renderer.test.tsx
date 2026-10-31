// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentCanvasSession } from '../canvas/session'
import type { SceneRenderTarget } from '../canvas/runtime/renderers/scene-types'
import { GalleryCanvasSurface } from '../../ui-gallery/GalleryCanvasSurface'
import { designFixture } from '../../ui-gallery/fixtures'
import type * as SharedSceneRendererModule from '../maplibre/shared-scene-renderer'

const rendererConnects = vi.hoisted(() => [] as Array<(target: SceneRenderTarget) => () => void>)

vi.mock('../maplibre/shared-scene-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedSceneRendererModule>()
  return {
    ...actual,
    createSharedMapSceneRendererComposition: (connect: (target: SceneRenderTarget) => () => void) => {
      rendererConnects.push(connect)
      return actual.createSharedMapSceneRendererComposition(connect)
    },
  }
})
vi.mock('../web/WebCanvasToolbar', () => ({ WebCanvasToolbar: () => null }))
vi.mock('../components/canvas/InspectionLens', () => ({ InspectionLens: () => null }))
vi.mock('../components/canvas/SpeciesFocusChip', () => ({ SpeciesFocusChip: () => null }))
vi.mock('../components/canvas/CanvasOverview', () => ({ CanvasOverview: () => null, OverviewNotice: () => null }))
vi.mock('../components/canvas/ZoomControls', () => ({ ZoomControls: () => null }))

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('UI gallery workspace renderer', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    rendererConnects.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    setCurrentCanvasSession(null)
  })

  afterEach(async () => {
    await act(async () => {
      render(null, container)
      await flushMicrotasks()
    })
    container.remove()
    setCurrentCanvasSession(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('builds the gallery canvas on the production shared map scene layer', async () => {
    const onReadyChange = vi.fn()

    await act(async () => {
      render(
        <GalleryCanvasSurface
          activeSurface={signal('workspace')}
          design={designFixture()}
          dense={false}
          onReadyChange={onReadyChange}
        />,
        container,
      )
      await flushMicrotasks()
    })

    // jsdom has no WebGL2, so the shared workspace resolves map-unavailable
    // and keeps the Design loaded; the gallery still composed the production
    // scene layers, connected to its runtime's one target slot.
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true))

    expect(rendererConnects).toHaveLength(1)
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}
