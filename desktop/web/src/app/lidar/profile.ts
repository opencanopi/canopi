// app/lidar/profile.ts
//
// Owns the Site data profile (canopi-f47t.42, spec §1.10 "Profile"): the curves of every shown, ready elevation or height
// item along the finished line, sampled through `sampler.ts`, their statistics, the chart's cursor and the copied text.
// The line itself lives in `site-transients.ts`, which ends it; this module only reads it and hands new lines to it.
// - Sampling: the line is walked in session-plane metres (so its length matches the canvas chips) at a step of
//   max(finest resolution among the curves, length / 4095), at most 4,096 points, each sent as WGS84.
// - The curves are the shown, ready elevation and height items, front first (the panel's order), as one request in the
//   'profile' lane under the key (line, item ids, generations); the sampler splits it into batches of
//   LIDAR_SAMPLE_MAX_TARGETS sent in turn. A key no longer current is never published, and the chart draws once every
//   batch of its key has landed. Closing the profile, or hiding its last curve, drops the lane's queued request.
// - A failed read is 'read-failed', never 'no-values': the whole call failing, or every curve answering ReadFailed. A
//   curve answering ReadFailed beside a curve with values is 'ready' with that curve's `readFailed` set. Either way it is
//   asked again only when the user presses Retry (`retrySiteProfile`), under the same key, never by itself.
// - Nothing here is stored, printed or captured.

import { computed, effect, signal, type ReadonlySignal } from '@preact/signals'
import { currentCanvasQuerySurface } from '../../canvas/session'
import type { CanvasContextMenuProfileLine } from '../canvas-context-menu/entries'
import type { SessionPlane } from '../../canvas/session-plane'
import type { LibraryItemRole, LibrarySnapshot, LidarSampleSeries, LidarSampleTarget } from '../../generated/contracts'
import { armCanvasTool } from '../keyboard/arming'
import { selectPanel, sidePanel } from '../shell/state'
import { profileRole, type ProfileRole } from './item-types'
import { lidarFailureMessage } from './lidar-failures'
import { lidarLibrary, readCurrentLidarPresentation, type LidarPresentationItem } from './library-store'
import { siteSampler, type SiteSampler } from './sampler'
import { profileLine, setProfileLine, type GeoPoint } from './site-transients'
import type { LocaleKey } from '../../generated/locale-keys'

/** At most this many points along a line (LIDAR_SAMPLE_MAX_POINTS). */
const PROFILE_MAX_POINTS = 4096
/** Steepest is the steepest slope over at least this run along the line (longer for a coarser curve). */
const STEEPEST_MIN_RUN_M = 2

/** One item a profile plots: a shown, ready elevation or height item. */
interface ProfileCurveSource {
  readonly id: string
  readonly kind: LibraryItemRole
  readonly name: string
  readonly units: string
  readonly role: ProfileRole
  readonly generationId: string
  /** The item's cell size in metres, when the library knows it. */
  readonly resolutionM: number | null
}

/** Where a profile is read: the distance of each point from the start, in metres, and the point itself. */
interface ProfileSamples {
  readonly lengthM: number
  readonly distances: readonly number[]
  readonly points: readonly GeoPoint[]
}

/**
 * An elevation curve's statistics: Rise (the signed net change) and Steepest (percent over about max(2 m, the curve's own
 * cell size), at a point, with the run it was measured over, which the legend names: longer still when the points are
 * further apart).
 */
interface ElevationStats {
  readonly role: 'elevation'
  readonly rise: number | null
  readonly steepest: ProfileSteepest | null
}

interface ProfileSteepest {
  readonly percent: number
  readonly index: number
  readonly runM: number
}

/** A height curve's statistic: Highest. */
interface HeightStats {
  readonly role: 'height'
  readonly highest: number | null
}

export interface ProfileCurve {
  readonly id: string
  readonly name: string
  readonly units: string
  readonly role: ProfileRole
  /** One value per sample point; null where the item has no data. */
  readonly values: readonly (number | null)[]
  readonly stats: ElevationStats | HeightStats
  /** The item's stored data could not be read (ReadFailed): its values are all null and Retry may bring them. */
  readonly readFailed: boolean
}

export type SiteProfile =
  | { readonly status: 'none' }
  /** A line, but no shown, ready elevation or height item: the line is kept and the chart says what to show. */
  | { readonly status: 'needs-layer'; readonly lengthM: number }
  | { readonly status: 'reading'; readonly lengthM: number }
  /** Every curve answered, with no value anywhere along the line, and none failed to read. */
  | { readonly status: 'no-values'; readonly lengthM: number }
  /** The read failed, or every curve's data could not be read; Retry asks the same line and curves again. */
  | { readonly status: 'read-failed'; readonly lengthM: number }
  | { readonly status: 'ready'; readonly lengthM: number; readonly samples: ProfileSamples; readonly curves: readonly ProfileCurve[] }

const NONE: SiteProfile = Object.freeze({ status: 'none' })

/** The items a profile plots, front first: shown, ready, aimed at a generation, and elevation or height. */
function profileCurveSources(
  items: readonly LidarPresentationItem[],
  library: LibrarySnapshot | null,
): ProfileCurveSource[] {
  const resolutions = new Map((library?.items ?? []).map((item) => [item.id, item.resolution_m]))
  return items.flatMap((item): ProfileCurveSource[] => {
    const role = item.itemType ? profileRole(item.itemType) : null
    if (!item.shown || item.availability !== 'present' || item.state !== 'Ready' || !item.generationId || !role) return []
    return [{
      id: item.id,
      kind: item.kind,
      name: item.name,
      units: item.units,
      role,
      generationId: item.generationId,
      resolutionM: resolutions.get(item.id) ?? null,
    }]
  }).reverse()
}

/**
 * The points a profile reads along `line`: evenly spaced in session-plane metres from the first point to the last, at
 * most `finestResolutionM` apart (never closer than length / 4095), so at most 4,096 points; without a resolution,
 * 4,096 points.
 */
function profileSamples(line: readonly GeoPoint[], plane: SessionPlane, finestResolutionM: number | null): ProfileSamples {
  const vertices = line.map((point) => plane.toPlane(point))
  const cumulative = [0]
  for (let index = 1; index < vertices.length; index += 1) {
    const a = vertices[index - 1]!
    const b = vertices[index]!
    cumulative.push(cumulative[index - 1]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const lengthM = cumulative[cumulative.length - 1]!
  const floor = lengthM / (PROFILE_MAX_POINTS - 1)
  const step = finestResolutionM !== null && finestResolutionM > 0 ? Math.max(finestResolutionM, floor) : floor
  const count = step > 0 ? Math.min(PROFILE_MAX_POINTS, Math.ceil(lengthM / step - 1e-6) + 1) : 2
  const distances: number[] = []
  const points: GeoPoint[] = []
  let segment = 0
  for (let index = 0; index < count; index += 1) {
    const distance = count === 1 ? 0 : (lengthM * index) / (count - 1)
    while (segment < vertices.length - 2 && cumulative[segment + 1]! < distance) segment += 1
    const a = vertices[segment]!
    const b = vertices[segment + 1] ?? a
    const span = cumulative[segment + 1]! - cumulative[segment]!
    const t = span > 0 ? Math.min(1, Math.max(0, (distance - cumulative[segment]!) / span)) : 0
    const geo = plane.toGeo({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    distances.push(distance)
    points.push({ lon: geo.lon, lat: geo.lat })
  }
  return { lengthM, distances, points }
}

/** Rise: the last value minus the first, over the values the curve has. */
function profileRise(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length >= 2 ? present[present.length - 1]! - present[0]! : null
}

/**
 * Steepest: the largest slope, in percent, between two points nearest `minRunM` apart (adjacent points when they are further
 * apart than that), the point midway between them and the run between them; null with no such pair. The run is
 * max(2 m, the curve's own cell size): the sampler reads the nearest native cell, so a coarse grid read at a finer
 * curve's step is a staircase, and a shorter run across one of its cell edges reads the whole cell's jump. A start too
 * near the line's end to reach the run is skipped, since a shorter run magnifies cell noise; a line shorter than the run
 * is measured end to end.
 */
function profileSteepest(
  values: readonly (number | null)[],
  distances: readonly number[],
  resolutionM: number | null,
): ProfileSteepest | null {
  const minRunM = Math.max(STEEPEST_MIN_RUN_M, resolutionM ?? 0)
  let best: ProfileSteepest | null = null
  const last = values.length - 1
  // The points are evenly spaced a little under the cell size, so a run of whole steps rarely lands on minRunM: the end
  // is the point nearest to it (within half a step), never the one after, which would stretch a 2 m run to 3 m.
  const shortest = minRunM - (last > 0 ? (distances[1]! - distances[0]!) / 2 : 0)
  let end = 0
  for (let start = 0; start < last; start += 1) {
    end = Math.max(end, start + 1)
    while (end < last && distances[end]! - distances[start]! < shortest) end += 1
    const a = values[start]
    const b = values[end]
    const run = distances[end]! - distances[start]!
    if (run < shortest && start > 0) break
    if (a === null || a === undefined || b === null || b === undefined || run <= 0) continue
    const percent = (Math.abs(b - a) / run) * 100
    if (!best || percent > best.percent) best = { percent, index: Math.round((start + end) / 2), runM: run }
  }
  return best
}

/** Highest: the largest value the curve has. */
function profileHighest(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length > 0 ? Math.max(...present) : null
}

/** Numbers in the copied text: the locale's decimal separator, no grouping, a fixed number of decimals. */
function fixed(locale: string, decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false })
}

/**
 * Copy values (U49 Q46): tab-separated text a spreadsheet pastes as columns, in the locale's decimals. Columns: Distance
 * (m), Longitude, Latitude (7 decimals), then "{name} ({units})" per curve; values to 2 decimals, an empty cell where a
 * curve has no data. A curve whose read failed is left out: its blank column would read as no data, and the chart
 * already offers Retry. Tabs and line breaks in names become spaces.
 */
export function profileCopyText(
  profile: Extract<SiteProfile, { status: 'ready' }>,
  locale: string,
  translate: (key: LocaleKey) => string,
): string {
  const two = fixed(locale, 2)
  const seven = fixed(locale, 7)
  const cell = (text: string) => text.replace(/[\t\r\n]+/g, ' ')
  const curves = profile.curves.filter((curve) => !curve.readFailed)
  const header = [
    translate('siteData.chart.distance'),
    translate('siteData.chart.longitude'),
    translate('siteData.chart.latitude'),
    ...curves.map((curve) => cell(curve.units && curve.units !== 'unknown' ? `${curve.name} (${curve.units})` : curve.name)),
  ]
  const rows = profile.samples.points.map((point, index) => [
    two.format(profile.samples.distances[index]!),
    seven.format(point.lon),
    seven.format(point.lat),
    ...curves.map((curve) => {
      const value = curve.values[index]
      return value === null || value === undefined ? '' : two.format(value)
    }),
  ])
  return [header, ...rows].map((row) => row.join('\t')).join('\n') + '\n'
}

function curveOf(source: ProfileCurveSource, series: LidarSampleSeries | undefined, samples: ProfileSamples): ProfileCurve {
  const values = series && 'Values' in series
    ? samples.points.map((_, index) => {
        const value = series.Values.values[index]
        return value === null || value === undefined || !Number.isFinite(value) ? null : value
      })
    : samples.points.map(() => null)
  const stats: ElevationStats | HeightStats = source.role === 'elevation'
    ? { role: 'elevation', rise: profileRise(values), steepest: profileSteepest(values, samples.distances, source.resolutionM) }
    : { role: 'height', highest: profileHighest(values) }
  const readFailed = series !== undefined && 'Unavailable' in series && series.Unavailable.reason === 'ReadFailed'
  return { id: source.id, name: source.name, units: source.units, role: source.role, values, stats, readFailed }
}

interface SiteProfileDeps {
  readonly sampler: SiteSampler
  readonly line: ReadonlySignal<readonly GeoPoint[] | null>
  /** The items to plot, read inside the profile's effect so a change re-samples. */
  readCurves(): readonly ProfileCurveSource[]
  /** The open Design's session plane, read inside the profile's effect. */
  readPlane(): SessionPlane | null
}

interface SiteProfileOwner {
  readonly profile: ReadonlySignal<SiteProfile>
  /** The chart's cursor: a sample index, or null. A new key clears it. */
  readonly cursor: ReadonlySignal<number | null>
  setCursor(index: number | null): void
  /** After a failed read, or a ready profile with a curve that failed to read, asks the same key again, once; otherwise does nothing. */
  retry(): void
  dispose(): void
}

/** The profile of `deps.line`: one request per key, the latest key published once every batch has landed. */
export function createSiteProfile(deps: SiteProfileDeps): SiteProfileOwner {
  const state = signal<SiteProfile>(NONE)
  const cursor = signal<number | null>(null)
  let asked: string | null = null
  // Read by the effect, so Retry, which forgets the asked key, re-runs it under the same key.
  const attempt = signal(0)
  // Whether the last read failed: a run of failures (Retry, a redrawn line) records its reason once, so a failing
  // library never fills the problem report's ring; a read that works ends the run.
  let failing = false
  // Whether the lane's last request is this profile's: a request still queued when the profile closes or loses every
  // curve would hold the backend's one sampling permit for nothing, so it is replaced by an empty request, which reads
  // no batch. The running request still finishes its batches (the sampler never cuts one short).
  let requested = false
  const release = () => {
    if (!requested) return
    requested = false
    deps.sampler.request('profile', '', [], [], () => {}).catch(() => {
      // Nothing waits on the empty request.
    })
  }

  const dispose = effect(() => {
    void attempt.value
    const line = deps.line.value
    const curves = deps.readCurves()
    const plane = deps.readPlane()
    if (!line || !plane) {
      release()
      asked = null
      cursor.value = null
      state.value = NONE
      return
    }
    const resolutions = curves.flatMap((curve) => curve.resolutionM !== null && curve.resolutionM > 0 ? [curve.resolutionM] : [])
    const samples = profileSamples(line, plane, resolutions.length > 0 ? Math.min(...resolutions) : null)
    const targets: LidarSampleTarget[] = curves.map((curve) => ({
      kind: curve.kind,
      entity_id: curve.id,
      expected_generation_id: curve.generationId,
    }))
    const key = JSON.stringify([line.map((point) => [point.lon, point.lat]), targets])
    if (key === asked) return
    asked = key
    cursor.value = null
    if (curves.length === 0) {
      release()
      state.value = { status: 'needs-layer', lengthM: samples.lengthM }
      return
    }
    state.value = { status: 'reading', lengthM: samples.lengthM }
    // This request's own answers: every batch it reads lands here, even while its key is not current, since the key
    // can come back before the request ends; only the end decides what is published.
    const answers: (LidarSampleSeries | undefined)[] = []
    requested = true
    deps.sampler.request('profile', key, targets, samples.points.map((point) => [point.lon, point.lat]), (first, series) => {
      series.forEach((answer, index) => {
        answers[first + index] = answer
      })
    }).then((outcome) => {
      if (outcome !== 'done' || asked !== key) return
      const plotted = curves.map((curve, index) => curveOf(curve, answers[index], samples))
      const unread = plotted.filter((curve) => curve.readFailed)
      // The backend logs the cause; this records which curves failed, once per run of failures.
      if (unread.length > 0) lidarFailureMessage(`profile curves could not be read: ${unread.map((curve) => curve.id).join(', ')}`, !failing)
      failing = unread.length > 0
      state.value = plotted.some((curve) => curve.values.some((value) => value !== null))
        ? { status: 'ready', lengthM: samples.lengthM, samples, curves: plotted }
        : unread.length > 0
          ? { status: 'read-failed', lengthM: samples.lengthM }
          : { status: 'no-values', lengthM: samples.lengthM }
    }, (error: unknown) => {
      if (asked !== key) return
      // The chart reads its own copy with Retry; this records the reason only.
      lidarFailureMessage(error, !failing)
      failing = true
      state.value = { status: 'read-failed', lengthM: samples.lengthM }
    })
  })

  return {
    profile: state,
    cursor,
    setCursor(index) {
      const current = state.peek()
      if (index === null || current.status !== 'ready') {
        cursor.value = null
        return
      }
      cursor.value = Math.min(current.samples.points.length - 1, Math.max(0, Math.round(index)))
    },
    retry() {
      const current = state.peek()
      const failed = current.status === 'read-failed' || (current.status === 'ready' && current.curves.some((curve) => curve.readFailed))
      if (!failed) return
      asked = null
      attempt.value += 1
    },
    dispose,
  }
}

// The app's profile, in the 'profile' lane of the app's one sampler, beside the row values' lane.
const readAppCurves = () => profileCurveSources(readCurrentLidarPresentation(), lidarLibrary.value)

const app = createSiteProfile({
  sampler: siteSampler,
  line: profileLine,
  readCurves: readAppCurves,
  readPlane: () => currentCanvasQuerySurface.value?.sessionPlane.value ?? null,
})

/** The Site data profile the chart shows. */
export const siteProfile: ReadonlySignal<SiteProfile> = app.profile

/** The chart's cursor, as a sample index of the shown profile; null while the chart is not hovered. */
export const profileCursor: ReadonlySignal<number | null> = app.cursor

/** The chart's Retry after a failed read, whole or of some curves: the same line and curves are read again, once. */
export function retrySiteProfile(): void {
  app.retry()
}

/** Moves the chart's cursor (hover, scrub or Steepest); null hides it. */
export function setProfileCursor(index: number | null): void {
  app.setCursor(index)
}

/**
 * Whether Profile can be armed: some shown, ready elevation or height item (U49 Q31); otherwise the Site data toolbar's
 * Profile and the palette command are disabled with "Show an elevation or height layer to draw a profile".
 */
export const profileAvailable: ReadonlySignal<boolean> = computed(() => readAppCurves().length > 0)

/**
 * Arms Profile from the Site data toolbar ('panel') or the palette, with Site data open beside the map, so the finished
 * line has a panel to show its chart in.
 */
export function armProfile(from: 'panel' | 'palette'): void {
  armCanvasTool('profile', { from })
  if (sidePanel.peek() !== 'site-data') selectPanel('site-data')
}

/**
 * The ground point under the chart's cursor while it is hovered or scrubbed, which the map draws as a hollow ring on the
 * line (chart to map only); null without a profile. It never rides the overlay snapshot: the Desktop map adapter's
 * `readSiteHover` feeds it to one setData.
 */
export const profileHover: ReadonlySignal<GeoPoint | null> = computed(() => {
  const profile = siteProfile.value
  const index = profileCursor.value
  return profile.status === 'ready' && index !== null ? profile.samples.points[index] ?? null : null
})

/**
 * The profile hand-off (CanvasRuntimeAppAdapter.finishProfile): the Profile tool's finished line, in session-plane
 * metres, becomes the Site data profile line in WGS84; a new line replaces the old. Site data opens first when another
 * side panel took its place while Profile stayed armed, so the line the user drew always gets its chart.
 */
export function finishSiteProfile(points: readonly { readonly x: number; readonly y: number }[]): void {
  const plane = currentCanvasQuerySurface.peek()?.sessionPlane.peek()
  if (!plane) return
  if (sidePanel.peek() !== 'site-data') selectPanel('site-data')
  setProfileLine(points.map((point) => plane.toGeo(point)))
}

/**
 * Desktop's "Profile this line" on a Line zone's or Measure guide's canvas menu (U49 Q29): opens Site data and shows
 * the profile along that object, as if it had been drawn with the Profile tool. Disabled like the Profile button.
 */
export const profileLineMenu: CanvasContextMenuProfileLine = {
  get available() {
    return profileAvailable.value
  },
  profile(target) {
    const scene = currentCanvasQuerySurface.peek()?.getSceneSnapshot()
    const points = target.kind === 'zone'
      ? scene?.zones.find((zone) => zone.id === target.id && zone.zoneType === 'line')?.points
      : (() => {
          const guide = scene?.measurementGuides.find((candidate) => candidate.id === target.id)
          return guide ? [guide.start, guide.end] : undefined
        })()
    if (!points || points.length < 2) return
    finishSiteProfile(points)
  },
}
