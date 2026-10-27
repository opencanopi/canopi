import type { LibraryItemType, LidarColourRange, LidarRamp, RasterQuantity } from '../../generated/contracts'
import { t } from '../../i18n'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * The single place that knows library item types.
 *
 * Display style, labels and import eligibility dispatch through these tables;
 * nothing else in the frontend branches on a quantity, so a new item type is
 * one entry here rather than a scatter of special cases.
 */

/** Upstream palette and stretch for one item, always in its stored units. */
export interface LidarDisplayStyle {
  /** The ramp drawn: the entry's own, else its kind's default; Relief draws the grey shaded relief. */
  readonly ramp: LidarRamp
  readonly colormap: string
  readonly reversed: boolean
  readonly rescale: readonly [number, number]
  /** Units of `rescale`, for the legend. */
  readonly units: string
}

/** What a style needs to know about one item and the entry that shows it. */
export interface RasterStyleInput {
  readonly units: string
  /** The data's own range in its stored units, when known. */
  readonly displayRange: readonly [number, number] | null
  /** The entry's ramp and range; null is the kind's default. */
  readonly ramp: LidarRamp | null
  readonly reversed: boolean
  readonly range: LidarColourRange | null
  /** The 2–98 % range Cut outliers draws, once `display-range.ts` knows it. */
  readonly cutRange?: readonly [number, number] | null
}

/**
 * How a profile plots a quantity: elevations share one axis, heights above
 * ground share a second plot below it, and anything else is not profiled.
 */
export type ProfileRole = 'elevation' | 'height'

interface RasterQuantityType {
  readonly labelKey: LocaleKey
  /** Whether a source can be imported as this quantity; derived-only otherwise. */
  readonly importable: boolean
  /** Whether an import names the units (or says they are unknown); false is metres or the analysis's own unit. */
  readonly declaresUnits: boolean
  readonly profile: ProfileRole | null
  /**
   * The ramps an open item offers, its default first (U49 Q32). Elevations
   * and heights open on Relief, the grey shaded relief (canopi-2add); the rest
   * of their list is Colours. Blue ramps belong to water kinds only
   * (display-legend.test.ts holds the rule), so a difference uses
   * purple–orange and blue keeps one meaning on the map.
   */
  readonly ramps: readonly LidarRamp[]
  /** The range an entry with `range: null` spans, in the item's own units. */
  defaultRange(units: string): LidarColourRange
}

/**
 * Which display derivative an entry draws: the elevation values a ramp colours,
 * or the grey shaded relief prepared from them.
 */
export type DisplayVariant = 'elevation' | 'relief'

/** The renderer's colormap for each ramp (`cog-tiler-wasm`'s built-in names). */
const RAMP_COLORMAPS: Readonly<Record<LidarRamp, string>> = {
  // The relief derivative stores its greys as values 1–255.
  Relief: 'gray',
  // Hypsometric without blue.
  Terrain: 'schwarzwald',
  Earth: 'turbid',
  Greens: 'greens',
  YellowRed: 'ylorrd',
  Magma: 'magma',
  Gray: 'gray',
}

const DATA_RANGE = (): LidarColourRange => ({ mode: 'Data' })

const SLOPE_DEGREES_MAX = 30
/** The same 30° expressed in percent, so both units share one colour domain. */
const SLOPE_PERCENT_MAX = Math.round(Math.tan((SLOPE_DEGREES_MAX * Math.PI) / 180) * 1000) / 10

function slopeDomainMax(units: string): number {
  return units === '%' ? SLOPE_PERCENT_MAX : SLOPE_DEGREES_MAX
}

export const RASTER_QUANTITIES: Readonly<Record<RasterQuantity, RasterQuantityType>> = {
  GroundElevation: {
    labelKey: 'canvas.lidar.library.quantity.GroundElevation',
    importable: true,
    declaresUnits: false,
    profile: 'elevation',
    ramps: ['Relief', 'Terrain', 'Earth', 'Gray'],
    defaultRange: DATA_RANGE,
  },
  SurfaceElevation: {
    labelKey: 'canvas.lidar.library.quantity.SurfaceElevation',
    importable: true,
    declaresUnits: false,
    profile: 'elevation',
    ramps: ['Relief', 'Terrain', 'Earth', 'Gray'],
    defaultRange: DATA_RANGE,
  },
  AboveGroundHeight: {
    labelKey: 'canvas.lidar.library.quantity.AboveGroundHeight',
    importable: true,
    declaresUnits: false,
    profile: 'height',
    ramps: ['Relief', 'Greens', 'Magma', 'Gray'],
    defaultRange: DATA_RANGE,
  },
  OtherContinuous: {
    labelKey: 'canvas.lidar.library.quantity.OtherContinuous',
    importable: true,
    declaresUnits: true,
    profile: null,
    ramps: ['Magma', 'YellowRed', 'Gray'],
    defaultRange: DATA_RANGE,
  },
  Slope: {
    labelKey: 'canvas.lidar.library.quantity.Slope',
    importable: false,
    declaresUnits: false,
    profile: null,
    ramps: ['YellowRed', 'Magma', 'Gray'],
    // A fixed 0–30° (57.7 % for a percent result) in the result's own unit, so
    // a percent result is never coloured as degrees and two slopes compare at a glance.
    defaultRange: (units) => ({ mode: 'Custom', min: 0, max: slopeDomainMax(units) }),
  },
}

/** Quantities a user can declare when importing a source, in menu order. */
export const IMPORTABLE_QUANTITIES: readonly RasterQuantity[] = (Object.keys(RASTER_QUANTITIES) as RasterQuantity[])
  .filter((quantity) => RASTER_QUANTITIES[quantity].importable)

export function itemTypeLabel(itemType: LibraryItemType): string {
  return t(RASTER_QUANTITIES[itemType.quantity].labelKey)
}

/**
 * Whether and how the Profile tool plots an item type; the Site data toolbar
 * and the profile's curves ask this instead of naming quantities.
 */
export function profileRole(itemType: LibraryItemType): ProfileRole | null {
  return RASTER_QUANTITIES[itemType.quantity].profile
}

/**
 * What `ramp: null` and `range: null` mean for an item type in its own units.
 * The Site data writer stores a choice equal to these as null, so a default
 * has one encoding and Reset compares once.
 */
export function kindDisplayDefaults(
  itemType: LibraryItemType,
  units: string,
): { readonly ramp: LidarRamp; readonly range: LidarColourRange } {
  const type = RASTER_QUANTITIES[itemType.quantity]
  return { ramp: type.ramps[0]!, range: type.defaultRange(units) }
}

/** The ramps an open item of this type offers, its default first. */
export function kindRamps(itemType: LibraryItemType): readonly LidarRamp[] {
  return RASTER_QUANTITIES[itemType.quantity].ramps
}

/** The ramp an entry draws: its own when its kind offers it, else the kind's default, so the per-kind lists keep blue for water. */
function resolvedRamp(itemType: LibraryItemType, ramp: LidarRamp | null): LidarRamp {
  const ramps = kindRamps(itemType)
  return ramp !== null && ramps.includes(ramp) ? ramp : ramps[0]!
}

/** The grey stretch of the relief derivative, whose greys are stored as values 1–255. */
const RELIEF_RESCALE: readonly [number, number] = [0, 255]

/**
 * Which display derivative an entry draws: the relief for Relief, else the
 * elevation values its ramp colours. Display, the library preview and Site
 * data all ask this, so a descriptor, its poll and its failure belong to the
 * variant drawn.
 */
export function displayVariant(itemType: LibraryItemType, entry: { readonly ramp: LidarRamp | null }): DisplayVariant {
  return resolvedRamp(itemType, entry.ramp) === 'Relief' ? 'relief' : 'elevation'
}

/**
 * The colours and stretch one entry draws with: its own ramp, Reverse and
 * range over its kind's defaults. A stored ramp the kind does not offer draws
 * with the kind's default. Relief draws its greys as stored, keeping the
 * entry's Reverse and range for Colours. Data range spans the data; Cut
 * outliers spans its 2–98 % range once known and the data until then; Custom
 * spans the entry's pair. A flat span widens by one unit so the renderer can
 * divide by it.
 */
export function itemTypeStyle(itemType: LibraryItemType, item: RasterStyleInput): LidarDisplayStyle {
  const ramp = resolvedRamp(itemType, item.ramp)
  if (ramp === 'Relief') {
    return { ramp, colormap: RAMP_COLORMAPS.Relief, reversed: false, rescale: RELIEF_RESCALE, units: item.units }
  }
  const range = item.range ?? kindDisplayDefaults(itemType, item.units).range
  const [min, max] = range.mode === 'Custom'
    ? [range.min, range.max]
    : (range.mode === 'CutOutliers' ? item.cutRange : null) ?? item.displayRange ?? [0, 1]
  const rescale: [number, number] = max > min ? [min, max] : [min, min + 1]
  return { ramp, colormap: RAMP_COLORMAPS[ramp], reversed: item.reversed, rescale, units: item.units }
}

/** Units written straight after the number, without a space (12°, 30%). */
const ATTACHED_UNITS = new Set(['°', '%'])

/** A unit suffix for a formatted number: "°", "%" or " m"; empty when unknown. */
export function unitSuffix(units: string): string {
  if (!units || units === 'unknown') return ''
  return ATTACHED_UNITS.has(units) ? units : ` ${units}`
}
