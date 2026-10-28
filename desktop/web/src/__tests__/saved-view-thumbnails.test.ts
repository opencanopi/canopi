import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSavedViewThumbnailCache,
  type SavedViewThumbnailCacheOptions,
} from '../app/saved-views/thumbnails'
import { ViewSnapshotSceneBusyError } from '../app/saved-views/snapshot'
import type { SavedView } from '../types/design'

const VIEW: SavedView = {
  id: 'hedges',
  name: 'Hedges',
  camera: { lon: 13, lat: 23, zoom: 19, bearing: 0, ground_size_m: { width: 20, height: 15 } },
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
const POND: SavedView = { ...VIEW, id: 'pond', name: 'Pond' }

function harness(capture: SavedViewThumbnailCacheOptions['capture']) {
  let next = 0
  const created: string[] = []
  const revoked: string[] = []
  const cache = createSavedViewThumbnailCache({
    capture,
    createUrl: () => {
      next += 1
      const url = `blob:thumb-${next}`
      created.push(url)
      return url
    },
    revokeUrl: (url) => { revoked.push(url) },
    settleMs: 100,
    busyRetryMs: 50,
    maxBusyRetries: 3,
  })
  return { cache, created, revoked }
}

const png = () => new Blob(['png'], { type: 'image/png' })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('saved view thumbnails', () => {
  it('draws a view once for a key, after the change settles, and never again on a repeated request', async () => {
    const capture = vi.fn(async () => png())
    const { cache } = harness(capture)

    const state = cache.request(VIEW, 'rev-1')
    expect(state.value).toEqual({ url: null, status: 'loading' })
    cache.request(VIEW, 'rev-1')
    await vi.advanceTimersByTimeAsync(99)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(state.value).toEqual({ url: 'blob:thumb-1', status: 'ready' })
    cache.request({ ...VIEW, name: 'Renamed' }, 'rev-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('draws again when the Scene revision moves, keeps the old image meanwhile and revokes it after', async () => {
    const capture = vi.fn(async () => png())
    const { cache, revoked } = harness(capture)
    const state = cache.request(VIEW, 'rev-1')
    await vi.advanceTimersByTimeAsync(100)

    cache.request(VIEW, 'rev-2')
    expect(state.value).toEqual({ url: 'blob:thumb-1', status: 'loading' })
    await vi.advanceTimersByTimeAsync(100)

    expect(capture).toHaveBeenCalledTimes(2)
    expect(state.value).toEqual({ url: 'blob:thumb-2', status: 'ready' })
    expect(revoked).toEqual(['blob:thumb-1'])
  })

  it('draws one view at a time', async () => {
    let release: (() => void) | null = null
    const capture = vi.fn((view: SavedView) => new Promise<Blob>((resolve) => {
      release = () => resolve(png())
      void view
    }))
    const { cache } = harness(capture)
    const hedges = cache.request(VIEW, 'k')
    const pond = cache.request(POND, 'k')
    await vi.advanceTimersByTimeAsync(100)
    expect(capture).toHaveBeenCalledTimes(1)

    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(hedges.value.status).toBe('ready')
    expect(capture).toHaveBeenCalledTimes(2)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(pond.value.status).toBe('ready')
  })

  it('tries again while an edit owns the Scene, then gives up', async () => {
    const capture = vi.fn(async (): Promise<Blob> => { throw new ViewSnapshotSceneBusyError() })
    const { cache } = harness(capture)
    const state = cache.request(VIEW, 'k')
    await vi.advanceTimersByTimeAsync(100)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(state.value.status).toBe('loading')

    capture.mockImplementationOnce(async () => png())
    await vi.advanceTimersByTimeAsync(50)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(state.value.status).toBe('ready')

    cache.request(VIEW, 'k2')
    await vi.advanceTimersByTimeAsync(100 + 50 * 3)
    expect(capture).toHaveBeenCalledTimes(6)
    expect(state.value).toEqual({ url: 'blob:thumb-1', status: 'failed' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).toHaveBeenCalledTimes(6)
  })

  it('marks a view that cannot be drawn and does not retry it for the same key', async () => {
    const capture = vi.fn(async () => null)
    const { cache } = harness(capture)
    const state = cache.request(VIEW, 'k')
    await vi.advanceTimersByTimeAsync(100)
    expect(state.value).toEqual({ url: null, status: 'failed' })
    cache.request(VIEW, 'k')
    await vi.advanceTimersByTimeAsync(500)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('revokes the images of views that went away, and of everything on clear', async () => {
    const capture = vi.fn(async () => png())
    const { cache, revoked } = harness(capture)
    const hedges = cache.request(VIEW, 'k')
    cache.request(POND, 'k')
    await vi.advanceTimersByTimeAsync(200)

    cache.retain(new Set(['pond']))
    expect(revoked).toEqual(['blob:thumb-1'])
    expect(hedges.value.url).toBeNull()

    cache.clear()
    expect(revoked).toEqual(['blob:thumb-1', 'blob:thumb-2'])
  })

  it('drops a capture that finishes after clear', async () => {
    let release: (() => void) | null = null
    const capture = vi.fn(() => new Promise<Blob>((resolve) => { release = () => resolve(png()) }))
    const { cache, created } = harness(capture)
    cache.request(VIEW, 'k')
    await vi.advanceTimersByTimeAsync(100)

    cache.clear()
    release!()
    await vi.advanceTimersByTimeAsync(0)

    expect(created).toEqual([])
    expect(cache.read(VIEW.id).value).toEqual({ url: null, status: 'loading' })
  })

  it('shares one state between a reader and a later request', async () => {
    const { cache } = harness(async () => png())
    const read = cache.read(VIEW.id)
    cache.request(VIEW, 'k')
    await vi.advanceTimersByTimeAsync(100)
    expect(read.value.status).toBe('ready')
  })
})
