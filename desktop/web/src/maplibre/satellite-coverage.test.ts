// 2.1-Q350 (canopi-qv53): Satellite stays on where Google's coverage is partial, its deepest tiles
// stretched, and is blank where there are none: a viewport only half covered, or not covered at
// all, stays Ready rather than turning unavailable.

import { describe, expect, it, vi } from 'vitest'
import {
  readViewportMetadata,
  SatelliteImageryProvider,
  type SatelliteHttp,
  type SatelliteHttpResponse,
} from './satellite-provider-session'

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
  it('Q350 (2d-2): Satellite stays on past the provider deepest tiles where coverage is partial', async () => {
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

  it('Q350 (2d-2): Satellite stays on, blank, where the provider has no tiles at all', async () => {
    const http = scripted([
      ok({ session: 'fake-session-token', expiry: '4000000000', tileWidth: 256, tileHeight: 256 }),
      ok({ copyright: '', maxZoomRects: [] }),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'fake-key' }))
    provider.update(VIEWPORT)

    expect((await settle(provider)).state, 'no coverage is blank imagery, not Satellite off').toBe('ready')
    provider.dispose()
  })

  it('Q350 (#644 M1): empty or blank viewport copyright preserves Google default attribution', async () => {
    for (const blank of ['', '   ']) {
      const http = scripted([
        ok({ session: 'fake-session-token', expiry: '4000000000', tileWidth: 256, tileHeight: 256 }),
        ok({ copyright: blank, maxZoomRects: [] }),
      ])
      const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'fake-key' }))
      provider.update(VIEWPORT)

      const settled = await settle(provider)
      expect(settled.state).toBe('ready')
      if (settled.state === 'ready') {
        expect(settled.descriptor.attribution).toContain('Google')
      }
      provider.dispose()
    }
  })

  it('Q350 (#644 N1): a malformed coverage rectangle is skipped when valid coverage is present', () => {
    const result = readViewportMetadata(
      {
        copyright: 'Imagery © Google',
        maxZoomRects: [
          null,
          { north: 49, south: 48, west: Number.NaN, east: 1, maxZoom: 18 },
          { north: 49, south: 48, west: -1, east: 1, maxZoom: 18 },
        ],
      },
      VIEWPORT,
    )
    expect(result).toEqual({ copyright: 'Imagery © Google', maxZoom: 18 })
  })
})
