// Phase 2 commit 0: 2.1-Q350, written before 2d-2 builds it (it.fails until then). Satellite stays on where Google's
// coverage is partial, its deepest tiles stretched, and is blank where there are none: a viewport only half covered,
// or not covered at all, stays Ready rather than turning unavailable (the coverage probe's off state goes). 2d-2 turns
// each it.fails into it and deletes the 'unavailable' snapshot variant and its notice keys with the probe.

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

async function settle(provider: SatelliteImageryProvider) {
  await vi.waitFor(() => {
    if (provider.snapshot().state === 'loading') throw new Error('not settled')
  })
  return provider.snapshot()
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

    const settled = await settle(provider)
    expect(settled.state).toBe('ready')
    if (settled.state === 'ready') expect(settled.descriptor.maxzoom).toBe(18)
    provider.dispose()
  })

  it.fails('Q350 (2d-2): Satellite stays on, blank, where the provider has no tiles at all', async () => {
    const http = scripted([
      ok({ session: 'fake-session-token', expiry: '4000000000', tileWidth: 256, tileHeight: 256 }),
      ok({ copyright: '', maxZoomRects: [] }),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'fake-key' }))
    provider.update(VIEWPORT)

    expect((await settle(provider)).state, 'no coverage is blank imagery, not Satellite off').toBe('ready')
    provider.dispose()
  })
})
