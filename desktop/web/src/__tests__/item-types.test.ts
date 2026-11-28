import { beforeEach, describe, expect, it } from 'vitest'
import type { LidarRamp, RasterQuantity } from '../generated/contracts'
import {
  IMPORTABLE_QUANTITIES,
  RASTER_QUANTITIES,
  itemTypeLabel,
  displayVariant,
  itemTypeStyle,
  kindDisplayDefaults,
  kindRamps,
  profileRole,
  unitSuffix,
} from '../app/data-library/item-types'
import { formatLegendValue, formatRasterMetres, formatRasterRange } from '../app/data-library/display-legend'
import { locale } from '../app/settings/state'

const raster = (quantity: RasterQuantity) => ({ kind: 'Raster' as const, quantity })

describe('library item types', () => {
  beforeEach(() => {
    locale.value = 'en'
  })

  it('profiles elevations on one axis and heights on another, and nothing else', () => {
    expect(profileRole(raster('GroundElevation'))).toBe('elevation')
    expect(profileRole(raster('SurfaceElevation'))).toBe('elevation')
    expect(profileRole(raster('AboveGroundHeight'))).toBe('height')
    expect(profileRole(raster('Slope'))).toBeNull()
    expect(profileRole(raster('OtherContinuous'))).toBeNull()
  })

  /** An entry at its kind's default display, as a library preview draws it. */
  const defaults = { ramp: null, reversed: false, range: null } as const

  it('offers Relief then three Colours to elevations and heights, three ramps to the rest, the default first and Gray last', () => {
    expect(kindRamps(raster('GroundElevation'))).toEqual(['Relief', 'Terrain', 'Earth', 'Gray'])
    expect(kindRamps(raster('SurfaceElevation'))).toEqual(['Relief', 'Terrain', 'Earth', 'Gray'])
    expect(kindRamps(raster('AboveGroundHeight'))).toEqual(['Relief', 'Greens', 'Magma', 'Gray'])
    expect(kindRamps(raster('Slope'))).toEqual(['YellowRed', 'Magma', 'Gray'])
    expect(kindRamps(raster('OtherContinuous'))).toEqual(['Magma', 'YellowRed', 'Gray'])
  })

  it('draws each ramp with one renderer colormap', () => {
    const colormaps = new Map<LidarRamp, string>()
    for (const quantity of Object.keys(RASTER_QUANTITIES) as RasterQuantity[]) {
      for (const ramp of kindRamps(raster(quantity))) {
        colormaps.set(ramp, itemTypeStyle(raster(quantity), { units: '', displayRange: null, ramp, reversed: false, range: null }).colormap)
      }
    }
    const ramps: LidarRamp[] = ['Relief', 'Terrain', 'Earth', 'Greens', 'YellowRed', 'Magma', 'Gray']
    expect(ramps.map((ramp) => colormaps.get(ramp))).toEqual(['gray', 'schwarzwald', 'turbid', 'greens', 'ylorrd', 'magma', 'gray'])
  })

  it('draws a stored ramp its kind does not offer with the kind\'s default ramp', () => {
    expect(itemTypeStyle(raster('Slope'), { units: '°', displayRange: [0, 12], ramp: 'Terrain', reversed: false, range: null }))
      .toEqual({ ramp: 'YellowRed', colormap: 'ylorrd', reversed: false, rescale: [0, 30], units: '°' })
    expect(itemTypeStyle(raster('GroundElevation'), { units: 'm', displayRange: [104, 132], ramp: 'Greens', reversed: true, range: null }))
      .toEqual({ ramp: 'Relief', colormap: 'gray', reversed: false, rescale: [0, 255], units: 'm' })
  })

  it('colours elevation picked Terrain over the data range by default, keeping blue for water', () => {
    for (const quantity of ['GroundElevation', 'SurfaceElevation'] as const) {
      expect(itemTypeStyle(raster(quantity), { units: 'm', displayRange: [104, 132], ...defaults, ramp: 'Terrain' }))
        .toEqual({ ramp: 'Terrain', colormap: 'schwarzwald', reversed: false, rescale: [104, 132], units: 'm' })
    }
  })

  it('colours heights picked Greens and other values with Magma, widening a flat range', () => {
    expect(itemTypeStyle(raster('AboveGroundHeight'), { units: 'm', displayRange: [3, 3], ...defaults, ramp: 'Greens' }))
      .toEqual({ ramp: 'Greens', colormap: 'greens', reversed: false, rescale: [3, 4], units: 'm' })
    expect(itemTypeStyle(raster('OtherContinuous'), { units: 'kg', displayRange: null, ...defaults }))
      .toEqual({ ramp: 'Magma', colormap: 'magma', reversed: false, rescale: [0, 1], units: 'kg' })
  })

  it('colours slope with Yellow–red over a fixed 30° domain in its own unit, never percent as degrees', () => {
    expect(itemTypeStyle(raster('Slope'), { units: '°', displayRange: [0, 12], ...defaults }))
      .toEqual({ ramp: 'YellowRed', colormap: 'ylorrd', reversed: false, rescale: [0, 30], units: '°' })
    expect(itemTypeStyle(raster('Slope'), { units: '%', displayRange: [0, 12], ...defaults }))
      .toEqual({ ramp: 'YellowRed', colormap: 'ylorrd', reversed: false, rescale: [0, 57.7], units: '%' })
  })

  it('draws the entry\'s own ramp, Reverse and range', () => {
    const ground = raster('GroundElevation')
    expect(itemTypeStyle(ground, { units: 'm', displayRange: [104, 132], ramp: 'Gray', reversed: true, range: { mode: 'Custom', min: 110, max: 120 } }))
      .toEqual({ ramp: 'Gray', colormap: 'gray', reversed: true, rescale: [110, 120], units: 'm' })
    expect(itemTypeStyle(raster('Slope'), { units: '°', displayRange: [0, 12], ramp: null, reversed: false, range: { mode: 'Data' } }).rescale)
      .toEqual([0, 12])
  })

  it('cuts outliers to the 2–98 % range once it is known, and draws the data range until then', () => {
    const ground = raster('GroundElevation')
    const cut = { units: 'm', displayRange: [104, 132] as [number, number], ramp: 'Terrain' as const, reversed: false, range: { mode: 'CutOutliers' as const } }
    expect(itemTypeStyle(ground, { ...cut, cutRange: [106.5, 129.25] }).rescale).toEqual([106.5, 129.25])
    expect(itemTypeStyle(ground, cut).rescale).toEqual([104, 132])
  })

  it('gives each kind\'s default display: its first ramp, and the data range or slope\'s 0–30°', () => {
    expect(kindDisplayDefaults(raster('OtherContinuous'), 'kg')).toEqual({ ramp: 'Magma', range: { mode: 'Data' } })
    expect(kindDisplayDefaults(raster('Slope'), '%')).toEqual({ ramp: 'YellowRed', range: { mode: 'Custom', min: 0, max: 57.7 } })
  })

  it('gives MNT, MNS and MNH Relief as the default, first ramp, so a stored null draws Relief', () => {
    for (const quantity of ['GroundElevation', 'SurfaceElevation', 'AboveGroundHeight'] as const) {
      expect(kindRamps(raster(quantity))[0]).toBe('Relief')
      expect(kindDisplayDefaults(raster(quantity), 'm').ramp).toBe('Relief')
    }
  })

  it('draws Relief in gray over 0–255, ignoring the Custom range and Reverse kept for Colours', () => {
    const stored = { units: 'm', displayRange: [104, 132] as [number, number], reversed: true, range: { mode: 'Custom' as const, min: 110, max: 120 } }
    for (const ramp of [null, 'Relief'] as const) {
      expect(itemTypeStyle(raster('GroundElevation'), { ...stored, ramp }))
        .toEqual({ ramp: 'Relief', colormap: 'gray', reversed: false, rescale: [0, 255], units: 'm' })
    }
    expect(itemTypeStyle(raster('GroundElevation'), { ...stored, ramp: 'Terrain' }))
      .toEqual({ ramp: 'Terrain', colormap: 'schwarzwald', reversed: true, rescale: [110, 120], units: 'm' })
  })

  it('draws an entry\'s relief derivative only while it draws Relief, and its elevation for every Colours ramp', () => {
    for (const quantity of ['GroundElevation', 'SurfaceElevation', 'AboveGroundHeight'] as const) {
      expect(displayVariant(raster(quantity), { ramp: null })).toBe('relief')
      expect(displayVariant(raster(quantity), { ramp: 'Relief' })).toBe('relief')
      expect(displayVariant(raster(quantity), { ramp: 'Gray' })).toBe('elevation')
    }
    expect(displayVariant(raster('GroundElevation'), { ramp: 'Terrain' })).toBe('elevation')
    // A kind without Relief draws its elevation whatever is stored.
    expect(displayVariant(raster('Slope'), { ramp: null })).toBe('elevation')
    expect(displayVariant(raster('OtherContinuous'), { ramp: 'Relief' })).toBe('elevation')
  })

  it('imports only measured quantities; slope is derived only', () => {
    expect(IMPORTABLE_QUANTITIES).toEqual(['GroundElevation', 'SurfaceElevation', 'AboveGroundHeight', 'OtherContinuous'])
    expect(RASTER_QUANTITIES.Slope.importable).toBe(false)
  })

  it('has an import declare units only for other values; elevations and heights are metres', () => {
    const declaring = (Object.keys(RASTER_QUANTITIES) as RasterQuantity[])
      .filter((quantity) => RASTER_QUANTITIES[quantity].declaresUnits)
    expect(declaring).toEqual(['OtherContinuous'])
  })

  it('labels every quantity through its own key', () => {
    expect(itemTypeLabel(raster('Slope'))).toBe('Slope')
    expect(itemTypeLabel(raster('AboveGroundHeight'))).toBe('Height above ground (CHM)')
    locale.value = 'fr'
    expect(itemTypeLabel(raster('GroundElevation'))).toBe('Altitude du sol (MNT)')
  })

  it('writes legend units after the value: degrees and percent attached, others spaced', () => {
    expect(unitSuffix('°')).toBe('°')
    expect(unitSuffix('m')).toBe(' m')
    expect(unitSuffix('unknown')).toBe('')
    expect(formatLegendValue(60, '°', 'en')).toBe('60.0°')
    expect(formatLegendValue(173.2, '%', 'en')).toBe('173%')
    expect(formatLegendValue(104.25, 'm', 'en')).toBe('104 m')
    expect(formatLegendValue(1.5, '', 'en')).toBe('1.50')
  })

  it('formats raster numbers with the interface locale and active unit system', () => {
    expect(formatLegendValue(1.5, 'm', 'fr')).toBe('1,50\u202fm')
    expect(formatLegendValue(-12.25, '°', 'de')).toBe('-12,3°')
    expect(formatLegendValue(1700, 'm', 'en', 'us_customary')).toBe('5,577 ft')
    expect(formatRasterMetres(0.5, 'en')).toBe('50 cm')
    expect(formatRasterMetres(0.5, 'fr')).toBe('50\u202fcm')
    expect(formatRasterMetres(2.25, 'de')).toBe('2,3 m')
    expect(formatRasterMetres(12, 'fr')).toBe('12\u202fm')
    expect(formatRasterMetres(0.25, 'en', 'us_customary')).toBe('10 in')
    expect(formatRasterMetres(5, 'en', 'us_customary')).toBe('16 ft')
    expect(formatRasterRange([1, 2.25], 'm', 'fr')).toBe('1,0\u202fm – 2,3\u202fm')
    expect(formatRasterRange([100, 1700], 'm', 'en', 'us_customary')).toBe('328.1 ft – 5,577.4 ft')
    expect(formatRasterRange([10, 30], '%', 'en')).toBe('10.0 – 30.0%')
  })
})
