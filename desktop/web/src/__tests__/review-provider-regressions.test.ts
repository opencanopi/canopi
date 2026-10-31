import { describe, expect, it, vi } from 'vitest'
import {
  SatelliteImageryProvider,
  readViewportMetadata,
  type SatelliteHttp,
  type SatelliteHttpResponse,
  type SatelliteState,
  type SatelliteViewport,
} from '../maplibre/satellite-provider-session'
import {
  reconcileSatelliteContribution,
  type SatelliteReconcileTarget,
} from '../maplibre/satellite-contribution'
import { MAPLIBRE_SATELLITE_LAYER_ID, MAPLIBRE_SATELLITE_SOURCE_ID } from '../maplibre/config'
import { readSatelliteConfig } from '../app/settings/satellite-config'
import { createSatelliteImagery, mountSatelliteLifecycle } from '../maplibre/satellite-bind'
import { BasemapTileAuth, GOOGLE_SESSION_TILES } from '../maplibre/basemap-tile-auth'
import type { SatelliteDescriptor } from '../maplibre/satellite-provider'

const VIEWPORT_A: SatelliteViewport = { west: -1, south: 48, east: 1, north: 49, zoom: 14 }
const VIEWPORT_B: SatelliteViewport = { west: 10, south: 40, east: 12, north: 42, zoom: 12 }

function sessionBody(token = 'token-a'): unknown {
  return {
    session: token,
    expiry: '4000000000',
    tileWidth: 256,
    tileHeight: 256,
  }
}

function viewportBody(maxZoom = 18, copyright = 'Imagery &copy; Google'): unknown {
  return {
    copyright,
    maxZoomRects: [{ north: 90, south: -90, east: 180, west: -180, maxZoom }],
  }
}

function ok(json: unknown): SatelliteHttpResponse {
  return { ok: true, status: 200, json }
}

function failure(status: number): SatelliteHttpResponse {
  return { ok: false, status, json: null, retryAfterSeconds: null }
}

function scriptedHttp(
  answers: Array<SatelliteHttpResponse | (() => Promise<SatelliteHttpResponse>)>,
): { http: SatelliteHttp; calls: Array<{ url: string; method?: string }> } {
  const calls: Array<{ url: string; method?: string }> = []
  let index = 0
  return {
    calls,
    http: {
      async request(input) {
        calls.push({ url: input.url, method: input.method })
        const answer = answers[Math.min(index, answers.length - 1)]!
        index += 1
        return typeof answer === 'function' ? await answer() : answer
      },
    },
  }
}

/** Reconcile options for a map whose transport resolves official tiles, and for one without that transport. */
const RESOLVABLE = { officialTilesResolvable: true, beforeLayerId: () => null }
const NO_TRANSPORT = { officialTilesResolvable: false, beforeLayerId: () => null }

/** A ready style, no layer anchor, no events: what a mount needs beyond its provider, map and viewport. */
const MOUNT_DEFAULTS = {
  styleReady: { isReady: () => true, whenReady: () => () => {} },
  beforeLayerId: () => null,
  afterApply: () => {},
  events: { on: () => {}, off: () => {} },
  replaceSatelliteAttribution: () => {},
} as const

function recorder(provider: SatelliteImageryProvider): SatelliteState[] {
  const seen: SatelliteState[] = []
  provider.subscribe((state) => seen.push(state))
  return seen
}

function recordingTarget() {
  const sources = new Map<string, Record<string, unknown>>()
  const layers = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  let attribution: string | null = null
  const target: SatelliteReconcileTarget = {
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    removeLayer: (id) => {
      order.push(`removeLayer:${id}`)
      layers.delete(id)
    },
    removeSource: (id) => {
      order.push(`removeSource:${id}`)
      sources.delete(id)
    },
    addSource: (id, source) => {
      order.push(`addSource:${id}`)
      sources.set(id, source)
    },
    addLayer: (layer) => {
      order.push(`addLayer:${layer.id}`)
      layers.set(layer.id as string, layer)
    },
    setLayoutProperty: (id, name, value) => {
      order.push(`layout:${id}:${name}:${String(value)}`)
      const layer = layers.get(id)
      if (layer && name === 'visibility') {
        layer.layout = { visibility: value }
      }
    },
    replaceSatelliteAttribution: (next) => {
      order.push(`attribution:${next}`)
      attribution = next
    },
  }
  return { target, sources, layers, order, readAttribution: () => attribution }
}

function descriptor(overrides: Partial<SatelliteDescriptor> = {}): SatelliteDescriptor {
  return {
    tiles: [GOOGLE_SESSION_TILES],
    tileSize: 256,
    maxzoom: 22,
    attribution: 'Imagery &copy; Google',
    official: true,
    ...overrides,
  }
}

describe('provider lifecycle regressions after 26eca68a', () => {
  it('R36: a key change replaces the session instead of pairing the old token with the new key', async () => {
    let key = 'key-a'
    const { http, calls } = scriptedHttp([
      ok(sessionBody('token-a')),
      ok(viewportBody()),
      ok(sessionBody('token-b')),
      ok(viewportBody()),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: key }))
    await new Promise<void>((resolve) => {
      provider.subscribe((state) => {
        if (state.state === 'ready') resolve()
      })
      provider.update(VIEWPORT_A)
    })

    key = 'key-b'
    await new Promise<void>((resolve) => {
      provider.subscribe((state) => {
        if (state.state === 'ready') resolve()
      })
      provider.update(VIEWPORT_A)
    })

    const sessionCalls = calls.filter((call) => call.url.includes('createSession'))
    expect(sessionCalls).toHaveLength(2)
    expect(sessionCalls[0]?.url).toContain('key=key-a')
    expect(sessionCalls[1]?.url).toContain('key=key-b')
    provider.dispose()
  })

  it('R37: a newer viewport supersedes an older in-flight metadata request', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const { http, calls } = scriptedHttp([
      ok(sessionBody()),
      () =>
        new Promise<SatelliteHttpResponse>((resolve) => {
          gate.release = () => resolve(ok(viewportBody(15, 'old')))
        }),
      ok(viewportBody(20, 'new')),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'key' }))
    provider.update(VIEWPORT_A)
    await vi.waitFor(() => {
      if (calls.length < 2) throw new Error('session not settled')
    })

    // Move while A's metadata is still in flight.
    provider.updateViewport(VIEWPORT_B)
    gate.release?.()
    await vi.waitFor(() => {
      const last = provider.snapshot()
      if (last.state !== 'ready') throw new Error('not ready')
      if (last.descriptor.attribution !== 'new') throw new Error('stale viewport published')
    })
    const viewportCalls = calls.filter((call) => call.url.includes('viewport'))
    expect(viewportCalls.length).toBeGreaterThanOrEqual(2)
    provider.dispose()
  })

  it('R38: imagery is not Ready until validated viewport metadata arrives', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const { http, calls } = scriptedHttp([
      ok(sessionBody()),
      () =>
        new Promise<SatelliteHttpResponse>((resolve) => {
          gate.release = () => resolve(ok(viewportBody()))
        }),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'key' }))
    const seen = recorder(provider)
    provider.update(VIEWPORT_A)
    await vi.waitFor(() => {
      if (!gate.release) throw new Error('viewport request not started')
    })
    // Session alone is not Ready: official imagery needs metadata too.
    expect(seen.map((s) => s.state)).not.toContain('ready')
    expect(provider.snapshot().state).toBe('loading')
    const release = gate.release
    expect(release).not.toBeNull()
    release?.()
    await vi.waitFor(() => {
      if (provider.snapshot().state !== 'ready') throw new Error('not ready')
    })
    expect(calls.filter((c) => c.url.includes('viewport'))).toHaveLength(1)
    provider.dispose()
  })

  it('R38: empty metadata is not established', () => {
    expect(readViewportMetadata({}, VIEWPORT_A)).toBeNull()
    expect(readViewportMetadata({ copyright: 'x' }, VIEWPORT_A)).toBeNull()
    expect(readViewportMetadata({ maxZoomRects: [] }, VIEWPORT_A)).toBeNull()
  })

  it('R39: a later valid viewport restores credentials and Ready after metadata failure', async () => {
    const { http, calls } = scriptedHttp([
      ok(sessionBody()),
      failure(500),
      failure(500),
      failure(500),
      ok(viewportBody(18, 'recovered')),
    ])
    const provider = new SatelliteImageryProvider(
      http,
      () => ({ googleMapsApiKey: 'key' }),
      () => 0,
      async () => {},
    )
    provider.update(VIEWPORT_A)
    await vi.waitFor(() => {
      if (provider.snapshot().state !== 'unavailable') throw new Error('not failed')
    })

    // A distinct settled viewport may recover through the same bounded policy.
    provider.updateViewport(VIEWPORT_B)
    await vi.waitFor(() => {
      const last = provider.snapshot()
      if (last.state !== 'ready') throw new Error('not recovered')
      if (last.descriptor.attribution !== 'recovered') throw new Error('wrong copyright')
    })
    expect(calls.filter((c) => c.url.includes('viewport')).length).toBeGreaterThanOrEqual(2)
    provider.dispose()
  })

  it('R40: viewport zoom availability can increase and decrease against the base descriptor', async () => {
    const { http } = scriptedHttp([
      ok(sessionBody()),
      ok(viewportBody(15)),
      ok(viewportBody(20)),
      ok(viewportBody(12)),
    ])
    const provider = new SatelliteImageryProvider(http, () => ({ googleMapsApiKey: 'key' }))
    provider.update(VIEWPORT_A)
    await vi.waitFor(() => expect(provider.snapshot()).toMatchObject({ state: 'ready', descriptor: { maxzoom: 15 } }))
    provider.updateViewport(VIEWPORT_B)
    // Availability must be recomputed from the base descriptor, not clamped
    // against the prior clamped zoom.
    await vi.waitFor(() => expect(provider.snapshot()).toMatchObject({ state: 'ready', descriptor: { maxzoom: 20 } }))
    provider.updateViewport(VIEWPORT_A)
    await vi.waitFor(() => expect(provider.snapshot()).toMatchObject({ state: 'ready', descriptor: { maxzoom: 12 } }))
    provider.dispose()
  })

  it('R40: overlapping rectangles take the greatest zoom at a point and the least across the viewport', () => {
    // Broad low-zoom rectangle plus a finer one covering the whole viewport:
    // the greater per-point zoom wins, so the broad rectangle cannot suppress it.
    const overlapping = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [
          { north: 90, south: -90, east: 180, west: -180, maxZoom: 10 },
          { north: 49, south: 48, east: 1, west: -1, maxZoom: 18 },
        ],
      },
      VIEWPORT_A,
    )
    expect(overlapping?.maxZoom).toBe(18)

    // Uncovered viewport corners are unavailable, not an invented zoom.
    const partial = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [{ north: 48.5, south: 48, east: 1, west: -1, maxZoom: 18 }],
      },
      VIEWPORT_A,
    )
    expect(partial).toBeNull()
  })

  it('R41: identical publications are no-ops and copyright-only updates attribution in place', () => {
    const { target, sources, order, readAttribution } = recordingTarget()
    const first = {
      state: 'ready' as const,
      descriptor: descriptor({ attribution: 'first' }),
      copyright: 'first',
    }
    reconcileSatelliteContribution(target, first, RESOLVABLE)
    expect(sources.size).toBe(1)
    const addCount = order.filter((entry) => entry.startsWith('addSource')).length

    // Identical publication retains source identity and loaded state.
    reconcileSatelliteContribution(target, first, RESOLVABLE)
    expect(sources.size).toBe(1)
    expect(order.filter((entry) => entry.startsWith('removeSource')).length).toBe(0)
    expect(order.filter((entry) => entry.startsWith('addSource')).length).toBe(addCount)

    // Copyright-only change updates attribution without removing the source.
    reconcileSatelliteContribution(
      target,
      {
        state: 'ready',
        descriptor: descriptor({ attribution: 'second' }),
      },
      RESOLVABLE,
    )
    expect(sources.size).toBe(1)
    expect(order.filter((entry) => entry.startsWith('removeSource')).length).toBe(0)
    expect(readAttribution()).toBe('second')
  })

  it('R41: a real tile-configuration change rebuilds the source', () => {
    const { target, sources, order } = recordingTarget()
    reconcileSatelliteContribution(
      target,
      { state: 'ready', descriptor: descriptor({ maxzoom: 18 }) },
      RESOLVABLE,
    )
    reconcileSatelliteContribution(
      target,
      { state: 'ready', descriptor: descriptor({ maxzoom: 20 }) },
      RESOLVABLE,
    )
    expect(order.filter((entry) => entry.startsWith('removeSource')).length).toBe(1)
    expect(order.filter((entry) => entry.startsWith('addSource')).length).toBe(2)
    expect(sources.size).toBe(1)
  })

  it('R45: copyright-only change updates attribution without removing the source', () => {
    const { target, sources, order, readAttribution } = recordingTarget()
    const first = {
      state: 'ready' as const,
      descriptor: descriptor({ attribution: 'A' }),
      copyright: 'A',
    }
    reconcileSatelliteContribution(target, first, RESOLVABLE)
    const addCount = order.filter((entry) => entry.startsWith('addSource')).length
    reconcileSatelliteContribution(
      target,
      { state: 'ready', descriptor: descriptor({ attribution: 'B' }) },
      RESOLVABLE,
    )
    expect(sources.size).toBe(1)
    expect(order.filter((entry) => entry.startsWith('removeSource')).length).toBe(0)
    expect(order.filter((entry) => entry.startsWith('addSource')).length).toBe(addCount)
    expect(readAttribution()).toBe('B')
  })

  it('R46: Loading hides an unchanged source instead of exposing cached imagery', () => {
    const { target, layers } = recordingTarget()
    reconcileSatelliteContribution(
      target,
      { state: 'ready', descriptor: descriptor() },
      RESOLVABLE,
    )
    const layer = layers.get(MAPLIBRE_SATELLITE_LAYER_ID) as { layout?: { visibility?: string } } | undefined
    expect(layer?.layout?.visibility).toBe('visible')
    reconcileSatelliteContribution(target, { state: 'loading' }, NO_TRANSPORT)
    expect((layers.get(MAPLIBRE_SATELLITE_LAYER_ID) as { layout?: { visibility?: string } })?.layout?.visibility)
      .toBe('none')
  })

  it('R47: uncovered strips in the viewport are unavailable', () => {
    // Longitude 0-1, 4-6 and 9-10 leave uncovered strips inside 0-10.
    const gappy = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [
          { north: 10, south: 0, east: 1, west: 0, maxZoom: 18 },
          { north: 10, south: 0, east: 6, west: 4, maxZoom: 18 },
          { north: 10, south: 0, east: 10, west: 9, maxZoom: 18 },
        ],
      },
      { west: 0, south: 0, east: 10, north: 10, zoom: 12 },
    )
    expect(gappy).toBeNull()
  })

  it('R47: wrapped viewport coverage across the antimeridian is supported', () => {
    const wrapped = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [
          { north: 10, south: 0, east: -170, west: 170, maxZoom: 18 },
        ],
      },
      { west: 175, south: 1, east: -175, north: 9, zoom: 12 },
    )
    expect(wrapped?.maxZoom).toBe(18)
  })

  it('R47: an interior lower ceiling becomes the source-wide ceiling', () => {
    // The high-zoom rectangle covers only the outer band; the interior is
    // supported solely at 12, so the source ceiling cannot exceed 12.
    const interior = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [
          { north: 10, south: 8, east: 10, west: 0, maxZoom: 18 },
          { north: 2, south: 0, east: 10, west: 0, maxZoom: 18 },
          { north: 8, south: 2, east: 2, west: 0, maxZoom: 18 },
          { north: 8, south: 2, east: 10, west: 8, maxZoom: 18 },
          { north: 8, south: 2, east: 8, west: 2, maxZoom: 12 },
        ],
      },
      { west: 0, south: 0, east: 10, north: 10, zoom: 12 },
    )
    expect(interior?.maxZoom).toBe(12)
  })

  it('R47: a broad low-zoom rectangle cannot suppress a finer covering one', () => {
    const overlapping = readViewportMetadata(
      {
        copyright: 'c',
        maxZoomRects: [
          { north: 90, south: -90, east: 180, west: -180, maxZoom: 10 },
          { north: 10, south: 0, east: 10, west: 0, maxZoom: 18 },
        ],
      },
      { west: 0, south: 0, east: 10, north: 10, zoom: 12 },
    )
    expect(overlapping?.maxZoom).toBe(18)
  })

  it('R47: uncovered Greenwich gap is unavailable', () => {
    const result = readViewportMetadata(
      { copyright: 'credit', maxZoomRects: [{ west: 170, east: -170, south: 0, north: 10, maxZoom: 18 }] },
      { west: -10, east: 10, south: 1, north: 9, zoom: 12 },
    )
    expect(result?.maxZoom ?? null).toBeNull()
  })

  it('R47: partial wrapped coverage is unavailable', () => {
    const result = readViewportMetadata(
      { copyright: 'credit', maxZoomRects: [{ west: 178, east: -178, south: 0, north: 10, maxZoom: 18 }] },
      { west: 175, east: -175, south: 1, north: 9, zoom: 12 },
    )
    expect(result?.maxZoom ?? null).toBeNull()
  })

  it('R47: full-world rectangle covers a wrapped viewport', () => {
    const result = readViewportMetadata(
      { copyright: 'credit', maxZoomRects: [{ west: -180, east: 180, south: 0, north: 10, maxZoom: 18 }] },
      { west: 175, east: -175, south: 1, north: 9, zoom: 12 },
    )
    expect(result?.maxZoom).toBe(18)
  })

  it('R47: full-world rectangle covers an unwrapped MapLibre viewport', () => {
    const result = readViewportMetadata(
      { copyright: 'credit', maxZoomRects: [{ west: -180, east: 180, south: 0, north: 10, maxZoom: 18 }] },
      { west: 170, east: 190, south: 1, north: 9, zoom: 12 },
    )
    expect(result?.maxZoom).toBe(18)
  })

  it('R47: healthy wrapped coverage is supported', () => {
    const result = readViewportMetadata(
      { copyright: 'credit', maxZoomRects: [{ west: 170, east: -170, south: 0, north: 10, maxZoom: 18 }] },
      { west: 175, east: -175, south: 1, north: 9, zoom: 12 },
    )
    expect(result?.maxZoom).toBe(18)
  })

  it('R47: more than 64 rectangles is unavailable', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      west: i, east: i + 0.5, south: 0, north: 10, maxZoom: 18,
    }))
    expect(
      readViewportMetadata({ copyright: 'c', maxZoomRects: many }, {
        west: 0, south: 1, east: 65, north: 9, zoom: 12,
      }),
    ).toBeNull()
  })

  it('R47: nonfinite coordinates and zero-width viewports are unavailable', () => {
    expect(
      readViewportMetadata(
        { copyright: 'c', maxZoomRects: [{ west: Number.NaN, east: 1, south: 0, north: 10, maxZoom: 18 }] },
        { west: 0, south: 1, east: 1, north: 9, zoom: 12 },
      ),
    ).toBeNull()
    expect(
      readViewportMetadata(
        { copyright: 'c', maxZoomRects: [{ west: 0, east: 1, south: 0, north: 10, maxZoom: 18 }] },
        { west: 1, south: 1, east: 1, north: 9, zoom: 12 },
      ),
    ).toBeNull()
  })

  it('R45: withdrawal clears basemap credit while other sources keep theirs', () => {
    const credits: string[] = []
    const sources = new Map<string, Record<string, unknown>>()
    const layers = new Map<string, Record<string, unknown>>()
    const target = {
      getSource: (id: string) => sources.get(id) ?? null,
      getLayer: (id: string) => layers.get(id) ?? null,
      removeLayer: (id: string) => void layers.delete(id),
      removeSource: (id: string) => void sources.delete(id),
      addSource: (id: string, source: Record<string, unknown>) => void sources.set(id, source),
      addLayer: (layer: Record<string, unknown>) => void layers.set(String(layer.id), layer),
      setLayoutProperty: () => {},
      replaceSatelliteAttribution: (credit: string) => credits.push(credit),
    }
    reconcileSatelliteContribution(target, {
      state: 'ready',
      descriptor: descriptor({ attribution: 'A' }),
    }, RESOLVABLE)
    expect(credits.at(-1)).toBe('A')
    expect(sources.size).toBe(1)
    reconcileSatelliteContribution(target, { state: 'idle' }, NO_TRANSPORT)
    expect(sources.size).toBe(0)
    expect(credits.at(-1)).toBe('')
  })

  it('M1: mountSatelliteLifecycle applies current configuration without waiting for events', async () => {
    const sources = new Map<string, Record<string, unknown>>()
    const layers = new Map<string, Record<string, unknown>>()
    const map = {
      getSource: (id: string) => sources.get(id) ?? null,
      getLayer: (id: string) => layers.get(id) ?? null,
      removeLayer: (id: string) => void layers.delete(id),
      removeSource: (id: string) => void sources.delete(id),
      addSource: (id: string, source: Record<string, unknown>) => void sources.set(id, source),
      addLayer: (layer: Record<string, unknown>) => void layers.set(String(layer.id), layer),
      setLayoutProperty: (id: string, name: string, value: unknown) => {
        const layer = layers.get(id)
        if (layer && name === 'visibility') layer.layout = { visibility: value }
      },
    }
    const teardown = mountSatelliteLifecycle({
      ...MOUNT_DEFAULTS,
      provider: createSatelliteImagery(new BasemapTileAuth(), readSatelliteConfig),
      map,
      readViewport: () => ({ west: -10, south: -10, east: 10, north: 10, zoom: 2 }),
    })
    // No movement, settings or style-ready event: keyless Google imagery
    // must already be applied from current configuration.
    expect(sources.size).toBe(1)
    expect(layers.get(MAPLIBRE_SATELLITE_LAYER_ID)?.layout).toEqual({ visibility: 'visible' })
    teardown.dispose()
    expect(sources.size).toBe(0)
    expect(layers.size).toBe(0)
  })

  it('M2: mountSatelliteLifecycle keeps a class-based map\'s prototype methods with an attribution seam', async () => {
    // A real MapLibre map exposes its methods on the prototype, so a mount that
    // copies the map into a plain object loses every one of them.
    class PrototypeMap {
      readonly sources = new Map<string, Record<string, unknown>>()
      readonly layers = new Map<string, Record<string, unknown>>()
      getSource(id: string) { return this.sources.get(id) ?? null }
      getLayer(id: string) { return this.layers.get(id) ?? null }
      removeLayer(id: string) { this.layers.delete(id) }
      removeSource(id: string) { this.sources.delete(id) }
      addSource(id: string, source: Record<string, unknown>) { this.sources.set(id, source) }
      addLayer(layer: Record<string, unknown>) { this.layers.set(String(layer.id), layer) }
      setLayoutProperty() {}
    }
    const map = new PrototypeMap()
    const credits: string[] = []
    const mount = mountSatelliteLifecycle({
      ...MOUNT_DEFAULTS,
      provider: createSatelliteImagery(new BasemapTileAuth(), readSatelliteConfig),
      map,
      readViewport: () => ({ west: -10, south: -10, east: 10, north: 10, zoom: 2 }),
      replaceSatelliteAttribution: (credit: string) => credits.push(credit),
    })
    expect(map.sources.has(MAPLIBRE_SATELLITE_SOURCE_ID)).toBe(true)
    expect(credits.at(-1)).toBe('&copy; Google')
    mount.dispose()
    expect(map.sources.size).toBe(0)
    expect(credits.at(-1)).toBe('')
  })

  it('M5: equivalent world copies share the same supported coverage', () => {
    const rect = { west: -15, east: 15, south: -5, north: 5, maxZoom: 18 }
    const json = { copyright: 'credit', maxZoomRects: [rect] }
    const views = [
      { west: -10, south: -4, east: 10, north: 4, zoom: 2 },
      { west: 350, south: -4, east: 370, north: 4, zoom: 2 },
      { west: 710, south: -4, east: 730, north: 4, zoom: 2 },
    ]
    const results = views.map((viewport) => readViewportMetadata(json, viewport)?.maxZoom ?? null)
    expect(results[0]).toBe(18)
    expect(results[1]).toBe(18)
    expect(results[2]).toBe(18)
    // Zoom-0 world view uses the same coverage rule: a local rect cannot
    // support the whole world.
    expect(
      readViewportMetadata(json, { west: -180, south: -4, east: 180, north: 4, zoom: 0 }),
    ).toBeNull()
  })

  it('E1: mountSatelliteLifecycle registers moveend and updates viewport metadata', async () => {
    const sources = new Map<string, Record<string, unknown>>()
    const layers = new Map<string, Record<string, unknown>>()
    const listeners = new Map<string, Set<() => void>>()
    const map = {
      getSource: (id: string) => sources.get(id) ?? null,
      getLayer: (id: string) => layers.get(id) ?? null,
      removeLayer: (id: string) => void layers.delete(id),
      removeSource: (id: string) => void sources.delete(id),
      addSource: (id: string, source: Record<string, unknown>) => void sources.set(id, source),
      addLayer: (layer: Record<string, unknown>) => void layers.set(String(layer.id), layer),
      setLayoutProperty: (id: string, name: string, value: unknown) => {
        const layer = layers.get(id)
        if (layer && name === 'visibility') layer.layout = { visibility: value }
      },
    }
    let viewport = { west: -10, south: -10, east: 10, north: 10, zoom: 2 }
    let readCount = 0
    const events = {
      on(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      off(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener)
      },
    }
    const credits: string[] = []
    const mount = mountSatelliteLifecycle({
      ...MOUNT_DEFAULTS,
      provider: createSatelliteImagery(new BasemapTileAuth(), readSatelliteConfig),
      map,
      readViewport: () => {
        readCount += 1
        return viewport
      },
      events,
      replaceSatelliteAttribution: (credit: string) => credits.push(credit),
    })
    expect(sources.size).toBe(1)
    // The mount owns viewport-event subscription.
    expect(listeners.get('moveend')?.size).toBe(1)

    // A settled move must refresh viewport metadata without recreating the map.
    const readsBeforeMove = readCount
    viewport = { west: 20, south: 20, east: 40, north: 40, zoom: 8 }
    listeners.get('moveend')?.forEach((listener) => listener())
    await Promise.resolve()
    await Promise.resolve()
    expect(readCount).toBeGreaterThan(readsBeforeMove)
    expect(sources.size).toBe(1)
    // Teardown unregisters the listener.
    mount.dispose()
    expect(listeners.get('moveend')?.size ?? 0).toBe(0)
    expect(sources.size).toBe(0)
  })

})
