import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RasterWorkerReply, RasterWorkerRequest } from './protocol'

const mockInit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
const mockOpenCog = vi.fn<(url: string) => Promise<unknown>>()

vi.mock('cog-tiler-wasm', () => ({
  init: () => mockInit(),
  openCog: (url: string) => mockOpenCog(url),
  rgbaToPng: vi.fn(),
}))

import { createRasterLane } from './lane'

describe('createRasterLane (W8 cog-tiler-wasm tileCache pin)', () => {
  afterEach(() => {
    mockInit.mockClear()
    mockOpenCog.mockReset()
  })

  // upstream: W8
  it('pin: replaces cog-tiler-wasm tileCache with a lane-budgeted cache and fails loudly if tileCache is absent (W8)', async () => {
    const replies: RasterWorkerReply[] = []
    const lane = createRasterLane((reply) => {
      replies.push(reply)
    })
    const dispatch = (request: RasterWorkerRequest) =>
      new Promise<RasterWorkerReply>((resolve) => {
        const before = replies.length
        lane.receive(request)
        const poll = () => {
          const found = replies.slice(before).find((r) => r.id === request.id)
          if (found) resolve(found)
          else queueMicrotask(poll)
        }
        queueMicrotask(poll)
      })

    await dispatch({ id: 1, op: 'init', budgetBytes: 8 })

    const originalCache = new Map<string, Promise<Uint8Array>>()
    const sourceWithCache = { boundsLonLat: [0, 0, 1, 1] as const, tileCache: originalCache }
    mockOpenCog.mockResolvedValueOnce(sourceWithCache)

    const okReply = await dispatch({ id: 2, op: 'open', handle: 1, url: 'https://example.invalid/a.tif' })
    expect(okReply).toEqual({ id: 2, ok: true, value: { boundsLonLat: [0, 0, 1, 1] } })
    expect(sourceWithCache.tileCache).toBeInstanceOf(Map)
    expect(sourceWithCache.tileCache).not.toBe(originalCache)

    // Lane byte budget (8 bytes) evicts the oldest entry once a new decoded block pushes usage over the limit.
    sourceWithCache.tileCache.set('k1', Promise.resolve(new Uint8Array(5)))
    await Promise.resolve()
    sourceWithCache.tileCache.set('k2', Promise.resolve(new Uint8Array(5)))
    await Promise.resolve()
    expect(sourceWithCache.tileCache.has('k1')).toBe(false)
    expect(sourceWithCache.tileCache.has('k2')).toBe(true)

    // When upstream stops exposing `tileCache`, open fails loudly instead of silently losing the budget.
    mockOpenCog.mockResolvedValueOnce({ boundsLonLat: [0, 0, 1, 1] })
    const failReply = await dispatch({ id: 3, op: 'open', handle: 2, url: 'https://example.invalid/b.tif' })
    expect(failReply).toEqual({
      id: 3,
      ok: false,
      error: 'cog-tiler-wasm no longer exposes its decoded tile cache; the lane budget cannot be enforced',
    })
  })
})
