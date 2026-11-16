// Phase 2 commit 0: 2.1-Q350, written before 2d-2 builds it (it.fails until then). Satellite stays on where Google's
// coverage is partial, its deepest tiles stretched, and is blank where there are none: a viewport only half covered
// stays Ready rather than turning unavailable. 2d-2 turns it.fails into it.

import { describe, expect, it, vi } from 'vitest'
import { SatelliteImageryProvider, type SatelliteHttp, type SatelliteHttpResponse } from './satellite-provider-session'

const VIEWPORT = { west: -1, south: 48, east: 1, north: 49, zoom: 19 }

function ok(json: unknown): SatelliteHttpResponse {
  return { ok: true, status: 200, json }
}

function scripted(answers: SatelliteHttpResponse[]): SatelliteHttp {
  let index = 0
  return {
    async request() {
      const answer = answers[Math.min(index, answers.length - 1)]!
      index += 1
      return answer
    },
  }
}

describe('2.1-Q350 satellite coverage', () => {
  it.fails('Q350 (2d-2): Satellite stays on past the provider deepest tiles where coverage is partial', async () => {
    const http = scripted([
      ok({ session: 'fake-session-token', expiry: '4000000000', tileWidth: 256, tileHeight: 256 }),
      // Only the west half of the viewport has imagery, at most zoom 18; the viewport asks for 19.
      ok({ copyright: 'Imagery &copy; Google', maxZoomRects: [{ north: 49, south: 48, west: -1, east: 0, maxZoom: 18 }] }),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'fake-key' }))
    provider.update(VIEWPORT)

    await vi.waitFor(() => {
      if (provider.snapshot().state === 'loading') throw new Error('not settled')
    })
    const settled = provider.snapshot()
    expect(settled.state).toBe('ready')
    if (settled.state === 'ready') expect(settled.descriptor.maxzoom).toBe(18)
    provider.dispose()
  })
})
