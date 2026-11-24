// app/lidar/display-range.ts
//
// Owns the ranges Cut outliers draws (canopi-f47t.42, spec §1.10 "Open item"): the 2–98 % range of one displayed
// generation, read once per display key from its display COGs in the shared raster worker lanes (`pool.ts`). One asset
// uses cog-tiler's own percentiles; a mosaic takes the same 2–98 % points (GeoLibre's `autoRangeFor` rule) of the
// distribution the map draws (`mosaicRange`): each asset counts for the ground it shows by its bounds, so a small part
// read at a finer overview does not outweigh a large one; a higher asset covers its bounds only by its valid share, so
// a member under another's nodata still counts, one hidden under assets that draw their whole bounds is not read, and
// one they hide in part counts for its visible share. Never stored: a reopened Design reads it again. Until it lands, or when it
// cannot be read, the entry draws its data range. An asset whose read fails (a lane restart, an asset error) is read
// again up to `READ_ATTEMPTS` times; past that the key keeps its data range until the store resets (a new generation is
// a new key), since the display effect asks again on every Design edit and would reread the whole mosaic each time.

import { signal } from '@preact/signals'
import { rasterWorkerPool } from '../../maplibre/raster-display/pool'
import type { RasterBandStatistics } from '../../maplibre/raster-display/protocol'

type Range = readonly [number, number]
type Bounds = readonly [number, number, number, number]

/** One display COG of a generation, as the map draws it: first listed on top where assets overlap. */
interface CutOutlierAsset {
  readonly url: string
  readonly bbox: Bounds
}

const MAX_ENTRIES = 256
const READ_ATTEMPTS = 3

const ranges = signal<ReadonlyMap<string, Range>>(new Map())
/** Keys asked for, answered, failed or not, so a key is read once per session. */
const asked = new Set<string>()
let owner = 0

/** The 2–98 % range of one displayed generation (`displayKey`), or null until it is known. */
export function cutOutlierRange(key: string): Range | null {
  return ranges.value.get(key) ?? null
}

/** Reads the 2–98 % range of one displayed generation from its display COGs, once per key. */
export function requestCutOutlierRange(key: string, assets: readonly CutOutlierAsset[]): void {
  if (asked.has(key) || assets.length === 0) return
  asked.add(key)
  const generation = owner
  void readRange(assets).then((range) => {
    if (generation !== owner || !range) return
    const next = new Map(ranges.value)
    next.set(key, range)
    while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value!)
    ranges.value = next
  }, () => { /* The key stays asked: it keeps its data range until the store resets. */ })
}

/** Forgets every range and drops answers still on their way (the display store's dispose). */
export function resetCutOutlierRanges(): void {
  owner += 1
  asked.clear()
  ranges.value = new Map()
}

async function readRange(assets: readonly CutOutlierAsset[]): Promise<Range | null> {
  const client = rasterWorkerPool().acquire()
  try {
    // Read in rounds from the top: an asset is read once the ground it shows is known to be more than none. An asset
    // not read yet is taken to cover its bounds, so one wholly under assets that draw their whole bounds is never read.
    const read = new Map<string, RasterBandStatistics | null>()
    let shown = shownAreas(assets, read)
    const unread = () => [...shown.keys()].filter((url) => !read.has(url))
    while (unread().length > 0) {
      for (let attempt = 1, pending = unread(); pending.length > 0; attempt += 1, pending = unread()) {
        if (attempt > READ_ATTEMPTS) throw new Error('Cut outliers could not read every asset')
        const settled = await Promise.allSettled(pending.map((url) => client.statistics(url)))
        settled.forEach((result, index) => { if (result.status === 'fulfilled') read.set(pending[index]!, result.value) })
      }
      shown = shownAreas(assets, read)
    }
    const statistics = [...shown].flatMap(([url, area]) => {
      const entry = read.get(url)
      return entry ? [{ statistics: entry, groundPerSample: area / entry.pixels }] : []
    })
    if (statistics.length === 0) return null
    if (statistics.length === 1) return [statistics[0]!.statistics.percentile2, statistics[0]!.statistics.percentile98]
    return mosaicRange(statistics)
  } finally {
    client.dispose()
  }
}

/**
 * The ground each asset shows (`visibleArea`), by URL, leaving out those that show none. An asset above covers its
 * bounds by its valid share (`read`); one not read yet covers them wholly.
 */
function shownAreas(assets: readonly CutOutlierAsset[], read: ReadonlyMap<string, RasterBandStatistics | null>): Map<string, number> {
  const cover = (url: string): number => {
    if (!read.has(url)) return 1
    const statistics = read.get(url)
    if (!statistics || statistics.pixels <= 0) return 0
    return Math.min(1, statistics.histogram.reduce((sum, count) => sum + count, 0) / statistics.pixels)
  }
  const shown = new Map<string, number>()
  const seen = new Set<string>()
  assets.forEach((asset, index) => {
    if (seen.has(asset.url)) return
    seen.add(asset.url)
    const area = visibleArea(asset.bbox, assets.slice(0, index).map((above) => ({ bbox: above.bbox, cover: cover(above.url) })))
    if (area > 0) shown.set(asset.url, area)
  })
  return shown
}

/**
 * The ground of `bbox` that the assets `above` leave showing, in the bounds' own units. The cells of a grid on every
 * edge inside `bbox` are each inside an asset's bounds or not. Inside its bounds an asset draws its valid share
 * (`cover`) of the ground: where its valid pixels lie is not known, so each cell keeps the share none of the assets
 * over it draws, taken as independent (a corridor survey's nodata or a warped tile's corners show what lies below).
 */
function visibleArea(bbox: Bounds, above: readonly { bbox: Bounds, cover: number }[]): number {
  const [west, south, east, north] = bbox
  const covering = above
    .map(({ bbox: [w, s, e, n], cover }) => ({ box: [Math.max(w, west), Math.max(s, south), Math.min(e, east), Math.min(n, north)] as Bounds, cover }))
    .filter(({ box: [w, s, e, n], cover }) => w < e && s < n && cover > 0)
  const edges = (low: number, high: number, cut: (box: Bounds) => number[]) =>
    [...new Set([low, high, ...covering.flatMap(({ box }) => cut(box))])].sort((a, b) => a - b)
  const xs = edges(west, east, ([w, , e]) => [w, e])
  const ys = edges(south, north, ([, s, , n]) => [s, n])
  let area = 0
  for (let i = 1; i < xs.length; i += 1) {
    for (let j = 1; j < ys.length; j += 1) {
      const [x, y] = [(xs[i - 1]! + xs[i]!) / 2, (ys[j - 1]! + ys[j]!) / 2]
      const showing = covering.reduce((share, { box: [w, s, e, n], cover }) => (x > w && x < e && y > s && y < n ? share * (1 - cover) : share), 1)
      area += showing * (xs[i]! - xs[i - 1]!) * (ys[j]! - ys[j - 1]!)
    }
  }
  return area
}

/**
 * The 2–98 % range of several assets pooled, each sample counting for the ground it covers (`groundPerSample`: the
 * ground the asset shows over the pixels of the overview read), so an asset of 512² pixels or more weighs by its
 * size, not by the 512² samples every such read holds. Each asset keeps its own resolution: its cumulative count is
 * known at its bin edges, its 2 % and 98 % points and its ends, and runs linearly between them. maplibre-gl-raster's
 * `mergeBandStats` rebins every asset onto 128 bins over the union instead, so one spike in one asset coarsens every
 * asset to 1/128 of the spike's span.
 */
function mosaicRange(assets: readonly { statistics: RasterBandStatistics, groundPerSample: number }[]): Range {
  const curves = assets.map(({ statistics, groundPerSample }) => ({ curve: cumulativeCurve(statistics), weight: groundPerSample }))
  const total = curves.reduce((sum, { curve, weight }) => sum + weight * curve.total, 0)
  const low = Math.min(...assets.map(({ statistics }) => statistics.min))
  const high = Math.max(...assets.map(({ statistics }) => statistics.max))
  const quantile = (fraction: number): number => {
    let [below, above] = [low, high]
    for (let step = 0; step < 64 && below < above; step += 1) {
      const middle = (below + above) / 2
      if (curves.reduce((sum, { curve, weight }) => sum + weight * curve.at(middle), 0) < fraction * total) below = middle
      else above = middle
    }
    return above
  }
  return [quantile(0.02), quantile(0.98)]
}

interface CumulativeCurve {
  readonly total: number
  /** Values counted at or below `value`, linear between known points. */
  at(value: number): number
}

function cumulativeCurve({ min, max, percentile2, percentile98, histogram }: RasterBandStatistics): CumulativeCurve {
  const total = histogram.reduce((sum, count) => sum + count, 0)
  const span = max - min
  const points: [number, number][] = [[min, 0], [percentile2, 0.02 * total], [percentile98, 0.98 * total], [max, total]]
  // cog-tiler's bins are equal over [min, max]: values below edge k sit in bins 0..k-1.
  let below = 0
  for (let edge = 1; edge < histogram.length; edge += 1) {
    below += histogram[edge - 1]!
    points.push([min + (span * edge) / histogram.length, below])
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  for (let index = 1; index < points.length; index += 1) points[index]![1] = Math.max(points[index]![1], points[index - 1]![1])
  return {
    total,
    at(value) {
      if (value < min) return 0
      if (value >= max) return total
      // The last point at or below `value`; the first point is `min`, so there is one.
      let [index, after] = [0, points.length]
      while (after - index > 1) {
        const middle = (index + after) >> 1
        if (points[middle]![0] <= value) index = middle
        else after = middle
      }
      const [x0, y0] = points[index]!
      const [x1, y1] = points[index + 1] ?? [x0, y0]
      return x1 > x0 ? y0 + ((value - x0) / (x1 - x0)) * (y1 - y0) : y0
    },
  }
}
