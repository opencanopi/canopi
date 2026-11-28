import { afterEach, describe, expect, it } from 'vitest'
import { locale, unitSystem } from '../app/settings/state'
import {
  formatHardiness,
  formatMetreRange,
  joinRecorded,
  presentCatalogValue,
} from '../components/species-detail/species-facts'
import { photoFromCatalogUrl } from '../components/species-detail/photo-attribution'

describe('species detail facts', () => {
  afterEach(() => {
    locale.value = 'en'
    unitSystem.value = 'metric'
  })

  it('derives the hardiness temperature from the coldest USDA zone and keeps the zones as recorded', () => {
    expect(formatHardiness(4, 4, 'en')).toBe('USDA 4 · to -34°C')
    expect(formatHardiness(0, 13, 'en')).toBe('USDA 0–13 · to -57°C')
    expect(formatHardiness(null, 9, 'en')).toBe('USDA 9')
    expect(formatHardiness(null, null, 'en')).toBeNull()
  })

  it('formats metre ranges in the active unit system', () => {
    expect(formatMetreRange(4, 10, 'en')).toBe('4 m–10 m')
    expect(formatMetreRange(10, 10, 'en')).toBe('10 m')
    expect(formatMetreRange(null, 0.3, 'en')).toBe('30 cm')
    expect(formatMetreRange(null, null, 'en')).toBeNull()

    unitSystem.value = 'us_customary'
    expect(formatMetreRange(4, 10, 'en')).toBe('13 ft–33 ft')
    expect(formatMetreRange(null, 3, 'en')).toBe('10 ft')
    expect(formatMetreRange(null, 0.3, 'en')).toBe('12 in')
  })

  it('shows English catalog keys as words and passes translated values through', () => {
    expect(presentCatalogValue('stratum', 'medium')).toBe('Mid')
    expect(presentCatalogValue('stratum', 'Canopée haute')).toBe('Canopée haute')
    expect(presentCatalogValue('succession', 'placenta_iii')).toBe('Placenta III')
    expect(presentCatalogValue('succession', 'Secondaire II')).toBe('Secondaire II')
    expect(presentCatalogValue('succession', null)).toBeNull()
  })

  it('joins only recorded parts', () => {
    expect(joinRecorded([null, 'Medium', '', undefined, 'Long'])).toBe('Medium · Long')
    expect(joinRecorded([null, ' '])).toBeNull()
  })

  it('names the photo host as its source and never guesses a license', () => {
    expect(photoFromCatalogUrl('http://commons.wikimedia.org/wiki/Special:FilePath/A.jpg').source).toBe('Wikimedia Commons')
    expect(photoFromCatalogUrl('https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg').source).toBe('iNaturalist')
    expect(photoFromCatalogUrl('not a url')).toEqual({ url: 'not a url', source: null, sourcePageUrl: null, credit: null, license: null })
    expect(photoFromCatalogUrl('https://example.org/a.jpg').license).toBeNull()
  })
})
