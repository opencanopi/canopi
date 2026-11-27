import { afterEach, describe, expect, it, vi } from 'vitest'

const geocodeAddress = vi.hoisted(() => vi.fn())
vi.mock('../ipc/geocoding', () => ({ geocodeAddress }))

import { geocodeForward } from '../app/geocoding/registry'
import { createPlaceSearchController } from '../app/geocoding/place-search'
import { geocodingTransport as browserTransport } from '../app/geocoding/transport.browser'
import { geocodingTransport as desktopTransport } from '../app/geocoding/transport.desktop'
import { locale } from '../app/settings/state'
import { t } from '../i18n'

afterEach(() => {
  vi.unstubAllGlobals()
  geocodeAddress.mockReset()
})

describe('geocoding transports', () => {
  it('Web reaches the registry through browser fetch', async () => {
    const fetchStub = vi.fn(async (_url: string) => new Response(JSON.stringify([{ lat: '47.39', lon: '0.689', display_name: 'Tours' }])))
    vi.stubGlobal('fetch', fetchStub)
    const matches = await geocodeForward('Tours', browserTransport, { limit: 5 })
    expect(new URL(fetchStub.mock.calls[0]![0]).hostname).toBe('nominatim.openstreetmap.org')
    expect(matches).toEqual([{ lat: 47.39, lon: 0.689, displayName: 'Tours', score: null }])
  })

  it('Desktop sends Nominatim through the native transport, never the webview fetch', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    geocodeAddress.mockResolvedValue([{ lat: 47.39, lon: 0.689, display_name: 'Tours' }])
    const matches = await geocodeForward('Tours', desktopTransport, { limit: 5 })
    expect(geocodeAddress).toHaveBeenCalledWith('Tours')
    expect(fetchStub).not.toHaveBeenCalled()
    expect(matches).toEqual([{ lat: 47.39, lon: 0.689, displayName: 'Tours', score: null }])
  })

  it('reports an HTTP failure from the browser transport', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(geocodeForward('Tours', browserTransport)).rejects.toThrow('HTTP 429')
  })

  it('both transports give the same order for one fixture body (canopi-f47t.52.77)', async () => {
    const fixture = [
      { lat: '45.7578', lon: '4.8320', display_name: 'Lyon, Auvergne-Rhône-Alpes, France' },
      { lat: '45.7640', lon: '4.8357', display_name: 'Lyon 1er Arrondissement, Lyon, France' },
      { lat: '33.6694', lon: '-84.2288', display_name: 'Lyon, Georgia, USA' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture))))
    geocodeAddress.mockResolvedValue(fixture.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), display_name: r.display_name })))

    const webMatches = await geocodeForward('Lyon', browserTransport, { limit: 5 })
    const desktopMatches = await geocodeForward('Lyon', desktopTransport, { limit: 5 })
    expect(desktopMatches.map((m) => m.displayName)).toEqual(webMatches.map((m) => m.displayName))
  })

  it('localises the geocoding credit in the interface language and caches repeated queries (canopi-f47t.52.77, 2.1-Q91)', async () => {
    const previousLocale = locale.value
    try {
      locale.value = 'fr'
      expect(t('canvas.placeSearch.attributionNominatim')).toContain('contributeurs OpenStreetMap')
      locale.value = 'en'
      expect(t('canvas.placeSearch.attributionNominatim')).toContain('OpenStreetMap contributors')
    } finally {
      locale.value = previousLocale
    }

    const transport = vi.fn(async () => [{ lat: '45.7578', lon: '4.8320', display_name: 'Lyon, France' }])
    const search = createPlaceSearchController({ transport, sleep: async () => {} })
    await search.search('Lyon')
    await search.search('lyon')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(search.results.value).toHaveLength(1)
  })
})
