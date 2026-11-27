import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceSearchController,
  parseCoordinates,
  shortPlaceLabel,
  resetPlaceSearchPacingForTests,
} from '../app/geocoding/place-search'
import { NOMINATIM_MIN_INTERVAL_MS, NOMINATIM_PROVIDER } from '../app/geocoding/registry'

afterEach(() => resetPlaceSearchPacingForTests())

describe('place search', () => {
  it('shortens long geocoder names to a place and its locality', () => {
    expect(shortPlaceLabel('Ballon-Saint-Mars, Mamers, Sarthe, Pays de la Loire, France métropolitaine, 72290, France')).toEqual({
      label: 'Ballon-Saint-Mars',
      detail: 'Sarthe, Pays de la Loire, France',
    })
    expect(shortPlaceLabel('Tours, France')).toEqual({ label: 'Tours', detail: 'France' })
    expect(shortPlaceLabel('Antarctica')).toEqual({ label: 'Antarctica', detail: null })
  })

  it('parses coordinates locally without any request', async () => {
    const transport = vi.fn()
    const search = createPlaceSearchController({ transport })
    await search.search('48.8584, 2.2945')
    expect(transport).not.toHaveBeenCalled()
    expect(search.results.value).toEqual([{ label: '48.858400, 2.294500', detail: null, lat: 48.8584, lon: 2.2945, source: 'coordinates' }])
    expect(search.providerId.value).toBeNull()
  })

  it.each([
    ['47.39 0.69', { lat: 47.39, lon: 0.69 }],
    ['33.9S 18.4E', { lat: -33.9, lon: 18.4 }],
    ['40.7 N; 74.0 W', { lat: 40.7, lon: -74 }],
    ['-12.5,-45.25', { lat: -12.5, lon: -45.25 }],
  ])('reads %s as coordinates', (text, expected) => {
    expect(parseCoordinates(text)).toEqual(expected)
  })

  it.each(['Tours', '91, 0', '10, 181', '48.8', 'rue 12, 5'])('does not read %s as coordinates', (text) => {
    expect(parseCoordinates(text)).toBeNull()
  })

  it('geocodes place names through the registry transport and credits OpenStreetMap', async () => {
    const transport = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get('q')).toBe('Tours, France')
      return [{ lat: '47.39', lon: '0.689', display_name: 'Tours, Indre-et-Loire, France' }]
    })
    const search = createPlaceSearchController({ transport, sleep: async () => {} })
    await search.search('Tours, France')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(search.results.value).toEqual([{ label: 'Tours', detail: 'Indre-et-Loire, France', lat: 47.39, lon: 0.689, source: 'geocoder' }])
    expect(search.status.value).toBe('results')
    expect(search.providerId.value).toBe(NOMINATIM_PROVIDER.id)
  })

  it('lists a place once when the geocoder returns several objects with the same name', async () => {
    const transport = vi.fn(async () => [
      { lat: '47.39', lon: '0.689', display_name: 'Tours, France' },
      { lat: '47.3941', lon: '0.6848', display_name: 'Tours, France' },
      { lat: '47.2', lon: '0.9', display_name: 'Tours-sur-Marne, France' },
    ])
    const search = createPlaceSearchController({ transport, sleep: async () => {} })
    await search.search('Tours')
    expect(search.results.value.map((result) => result.label)).toEqual(['Tours', 'Tours-sur-Marne'])
    expect(search.results.value[0]).toMatchObject({ lat: 47.39, lon: 0.689 })
  })

  it('spaces Nominatim requests at least 1.1 s apart', async () => {
    let clock = 10_000
    const waits: number[] = []
    const transport = vi.fn(async () => [])
    const search = createPlaceSearchController({
      transport,
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms },
    })
    await search.search('first')
    clock += 300
    await search.search('second')
    expect(NOMINATIM_MIN_INTERVAL_MS).toBe(1100)
    expect(waits).toEqual([0, 800])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(search.status.value).toBe('no-results')
  })

  it('keeps only the latest search when a newer one supersedes it', async () => {
    let release!: (value: unknown) => void
    const transport = vi.fn((url: string) => new URL(url).searchParams.get('q') === 'slow'
      ? new Promise((resolve) => { release = resolve })
      : Promise.resolve([{ lat: '1', lon: '2', display_name: 'fast' }]))
    const search = createPlaceSearchController({ transport, sleep: async () => {} })
    const slow = search.search('slow')
    await Promise.resolve()
    await search.search('fast')
    release([{ lat: '9', lon: '9', display_name: 'slow' }])
    await slow
    expect(search.results.value.map((result) => result.label)).toEqual(['fast'])
  })

  it('reports a failed request without results', async () => {
    const search = createPlaceSearchController({
      transport: async () => { throw new Error('offline') },
      sleep: async () => {},
    })
    await search.search('anywhere')
    expect(search.status.value).toBe('error')
    expect(search.results.value).toEqual([])
  })
})
