// @vitest-environment jsdom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCurrentCanvasSession } from '../../canvas/session'
import type * as SavedViewsModule from '../../app/saved-views'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'

const mocks = vi.hoisted(() => ({
  captureSavedViewSnapshot: vi.fn(),
  createViewSnapshotMap: vi.fn(),
}))

vi.mock('../../app/saved-views', async (importOriginal) => {
  const original = await importOriginal<typeof SavedViewsModule>()
  return {
    ...original,
    captureSavedViewSnapshot: mocks.captureSavedViewSnapshot,
  }
})

vi.mock('../../maplibre/view-snapshot-map', () => ({
  createViewSnapshotMap: mocks.createViewSnapshotMap,
}))

import { GalleryViewSnapshots } from './GalleryViewSnapshots'

afterEach(() => {
  setCurrentCanvasSession(null)
  vi.restoreAllMocks()
})

describe('GalleryViewSnapshots (canopi-f47t.52.233)', () => {
  it('captures render-callback and preserve-buffer snapshots and revokes URLs on unmount', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gallery-snap')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const fakeSnapshot = {
      width: 320,
      height: 200,
      blob: new Blob(['x']),
      missingTiles: false,
      timings: { mapSetupMs: 1, settleMs: 2, readMs: 3, encodeMs: 4 },
      attribution: ['OSM'],
    }
    mocks.captureSavedViewSnapshot
      .mockResolvedValueOnce(fakeSnapshot)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(fakeSnapshot)

    const disposeMap = vi.fn(async () => {})
    const captureMap = vi.fn(async () => fakeSnapshot)
    mocks.createViewSnapshotMap.mockReturnValue({ capture: captureMap, dispose: disposeMap })

    const surfaces = createTestCanvasRuntimeSurfaces()
    setCurrentCanvasSession(surfaces)

    const container = document.createElement('div')
    document.body.appendChild(container)

    await act(async () => {
      render(<GalleryViewSnapshots ready={false} tiles={false} />, container)
    })
    expect(container.textContent).toContain('Waiting for the workspace')

    await act(async () => {
      render(<GalleryViewSnapshots ready={true} tiles={true} />, container)
      await Promise.resolve()
    })

    await vi.waitFor(() => {
      expect(container.querySelectorAll('li').length).toBeGreaterThan(0)
    })
    expect(createObjectURL).toHaveBeenCalled()
    expect(disposeMap).toHaveBeenCalled()

    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await Promise.resolve()
    })

    await act(async () => {
      render(null, container)
    })
    container.remove()
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
