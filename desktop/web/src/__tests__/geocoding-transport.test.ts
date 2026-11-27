import { afterEach, describe, expect, it, vi } from 'vitest'

const geocoderFetch = vi.hoisted(() => vi.fn())
vi.mock('../ipc/geocoding', () => ({ geocoderFetch }))

import { geocodeForward, NOMINATIM_PROVIDER } from '../app/geocoding/registry'
import { createPlaceSearchController } from '../app/geocoding/place-search'
import { geocodingTransport as browserTransport } from '../app/geocoding/transport.browser'
import { geocodingTransport as desktopTransport } from '../app/geocoding/transport.desktop'
import { locale } from '../app/settings/state'
import { t } from '../i18n'

afterEach(() => {
  vi.unstubAllGlobals()
  geocoderFetch.mockReset()
})

describe('geocoding transports', () => {
  it('Web reaches the registry through browser fetch with accept-language', async () => {
    const fetchStub = vi.fn(async (_url: string) => new Response(JSON.stringify([{ lat: '47.39', lon: '0.689', display_name: 'Tours', importance: 0.72 }])))
    vi.stubGlobal('fetch', fetchStub)
    const matches = await geocodeForward('Tours', browserTransport, { limit: 5, acceptLanguage: 'fr' })
    const sent = new URL(fetchStub.mock.calls[0]![0])
    expect(sent.hostname).toBe('nominatim.openstreetmap.org')
    expect(sent.searchParams.get('format')).toBe('jsonv2')
    expect(sent.searchParams.get('limit')).toBe('5')
    expect(sent.searchParams.get('accept-language')).toBe('fr')
    expect(matches).toEqual([{ lat: 47.39, lon: 0.689, displayName: 'Tours', score: 0.72 }])
  })

  it('Desktop sends Nominatim through native geocoder_fetch with the TS-built URL, never webview fetch', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    geocoderFetch.mockResolvedValue(JSON.stringify([{ lat: '47.39', lon: '0.689', display_name: 'Tours', importance: 0.72 }]))
    const matches = await geocodeForward('Tours', desktopTransport, { limit: 5, acceptLanguage: 'de' })
    expect(geocoderFetch).toHaveBeenCalledOnce()
    const sent = new URL(geocoderFetch.mock.calls[0]![0])
    expect(sent.hostname).toBe('nominatim.openstreetmap.org')
    expect(sent.searchParams.get('q')).toBe('Tours')
    expect(sent.searchParams.get('format')).toBe('jsonv2')
    expect(sent.searchParams.get('limit')).toBe('5')
    expect(sent.searchParams.get('accept-language')).toBe('de')
    expect(fetchStub).not.toHaveBeenCalled()
    expect(matches).toEqual([{ lat: 47.39, lon: 0.689, displayName: 'Tours', score: 0.72 }])
  })

  it('reports an HTTP failure from the browser transport', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(geocodeForward('Tours', browserTransport)).rejects.toThrow('HTTP 429')
  })

  it('both transports give the same GeocodeMatch order and scores for one raw fixture body (canopi-f47t.52.77)', async () => {
    const rawBody = JSON.stringify([
      { lat: '45.7578', lon: '4.8320', display_name: 'Lyon, Auvergne-Rhône-Alpes, France', importance: 0.84 },
      { lat: '45.7640', lon: '4.8357', display_name: 'Lyon 1er Arrondissement, Lyon, France', importance: '0.61' },
      { lat: '33.6694', lon: '-84.2288', display_name: 'Lyon, Georgia, USA' },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rawBody)))
    geocoderFetch.mockResolvedValue(rawBody)

    const webMatches = await geocodeForward('Lyon', browserTransport, { limit: 5, acceptLanguage: 'fr' })
    const desktopMatches = await geocodeForward('Lyon', desktopTransport, { limit: 5, acceptLanguage: 'fr' })
    expect(desktopMatches).toEqual(webMatches)
    expect(desktopMatches.map((m) => m.score)).toEqual([0.84, 0.61, null])
  })

  it('localises geocoding.credit in the interface language before and after results and caches normalised queries (canopi-f47t.52.77, 2.1-Q91)', async () => {
    const previousLocale = locale.value
    try {
      locale.value = 'fr'
      const beforeCredit = t('geocoding.credit', { service: NOMINATIM_PROVIDER.service })
      expect(beforeCredit).toContain('Nominatim')
      expect(beforeCredit).toContain('contributeurs OpenStreetMap')
      locale.value = 'en'
      expect(t('geocoding.credit', { service: NOMINATIM_PROVIDER.service })).toContain('OpenStreetMap contributors')
    } finally {
      locale.value = previousLocale
    }

    const transport = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get('accept-language')).toBe('fr')
      return [{ lat: '45.7578', lon: '4.8320', display_name: 'Lyon, France' }]
    })
    const search = createPlaceSearchController({ transport, locale: () => 'fr', sleep: async () => {} })
    await search.search('  Lyon   France ')
    await search.search('lyon france')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(search.results.value).toHaveLength(1)
    expect(search.providerId.value).toBe('nominatim')
  })
})
