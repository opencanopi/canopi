// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentCanvasSession } from '../../canvas/session'
import type { ViewScreen } from '../../geo/view/types'
import type { SavedView } from '../../generated/contracts'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'

const capture = vi.hoisted(() => vi.fn(async () => ({ blob: new Blob(['webp'], { type: 'image/webp' }) })))

vi.mock('./snapshot', async (importOriginal) => ({
  ...await importOriginal<object>(),
  captureSavedViewSnapshot: capture,
}))

const { useSavedViewThumbnail } = await import('./thumbnails')

const VIEW: SavedView = {
  id: 'hedges',
  name: 'Hedges',
  camera: { lon: 13, lat: 23, zoom: 19, bearing: 30, ground_size_m: { width: 20, height: 15 } },
  visible_layers: {
    background: { kind: 'none' },
    terrain: { contours: false, hillshade: false },
    scene_layers: ['plants'],
    site_data: [],
  },
  highlighted: { species: [], objects: [] },
  title: null,
  text: [],
}

/** A workspace whose live screen a test resizes, and whose settled frame it settles. */
function workspace(width: number, height: number) {
  const queries = createTestCanvasQuerySurface()
  const base = queries.view
  let screen: ViewScreen = { width, height, devicePixelRatio: 1 }
  const settledRevision = signal(0)
  const view = {
    ...base,
    settledRevision,
    captureView: () => ({ ...base.captureView(), screen }),
  }
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: { ...queries, view } }))
  return {
    resize(nextWidth: number, nextHeight: number) {
      screen = { width: nextWidth, height: nextHeight, devicePixelRatio: 1 }
    },
    async settle() {
      await act(() => { settledRevision.value += 1 })
    },
  }
}

function Thumbnail({ view }: { view: SavedView }) {
  return <span>{useSavedViewThumbnail(view).status}</span>
}

let container: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:thumb', revokeObjectURL: () => {} }))
  container = document.createElement('div')
  capture.mockClear()
})

afterEach(() => {
  render(null, container)
  setCurrentCanvasSession(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('saved view thumbnails in the workspace', () => {
  it('are never drawn again for a workspace size change', async () => {
    // The image shows the ground the view framed, which no window changes (spec §4.10).
    const host = workspace(1600, 900)
    await act(() => { render(<Thumbnail view={VIEW} />, container) })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(capture).toHaveBeenCalledTimes(1)

    host.resize(800, 450)
    await host.settle()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(capture).toHaveBeenCalledTimes(1)
  })
})
