import { signal } from '@preact/signals'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionPlane } from '../../canvas/session-plane'
import type { GeoPoint, LidarSamplePointsRequest, LidarSampleSeries } from '../../generated/contracts'
import { setCurrentCanvasSession } from '../../canvas/session'
import type { CanvasRuntimeSurfaces } from '../../canvas/runtime/runtime'
import { activePanel, sidePanel } from '../shell/state'
import { recentFrontendDiagnostics, resetFrontendDiagnosticsForTests } from '../problem-report/diagnostics'
import {
  createSiteProfile,
  profileCopyText,
  profileLineMenu,
  type SiteProfile,
} from './profile'
import { createSiteSampler } from './sampler'
import { endSiteDataTransients, profileLine } from './site-transients'

/** An item a profile plots, as the profile's owner reads it. */
type ProfileCurveSource = ReturnType<Parameters<typeof createSiteProfile>[0]['readCurves']>[number]

const PLANE = createSessionPlane({ lon: 2.35, lat: 48.85 })
/** The one Design session the samples are asked for. */
const DESIGN = {}
const at = (x: number, y: number): GeoPoint => PLANE.toGeo({ x, y })

/** A sample call the test answers by hand. */
interface PendingSample {
  readonly request: LidarSamplePointsRequest
  answer(series: (target: number) => LidarSampleSeries): Promise<void>
  fail(): Promise<void>
}

function manualBackend() {
  const calls: PendingSample[] = []
  // The real sampler (one request in flight per lane, batches of LIDAR_SAMPLE_MAX_TARGETS in turn) over a faked command.
  const sampler = createSiteSampler({ designIdentity: () => DESIGN, sample: (request) => new Promise((resolve, reject) => {
    calls.push({
      request,
      answer: async (series) => {
        resolve(request.targets.map((_, index) => series(index)))
        await settle()
      },
      fail: async () => {
        reject(new Error('sampling failed'))
        await settle()
      },
    })
  }) })
  return { calls, sampler }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

const READ_FAILED: LidarSampleSeries = { Unavailable: { reason: 'ReadFailed' } }

function values(...list: (number | null)[]): LidarSampleSeries {
  return { Values: { values: list } }
}

function source(id: string, role: 'elevation' | 'height' = 'elevation', overrides: Partial<ProfileCurveSource> = {}): ProfileCurveSource {
  return { id, kind: 'Source', name: id.toUpperCase(), units: 'm', role, generationId: `${id}-g1`, resolutionM: 0.025, ...overrides }
}

const owners: ReturnType<typeof createSiteProfile>[] = []

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
})

function profileOf(line: GeoPoint[] | null, curves: ProfileCurveSource[]) {
  const backend = manualBackend()
  const lineSignal = signal<readonly GeoPoint[] | null>(line)
  const curveSignal = signal<readonly ProfileCurveSource[]>(curves)
  const owner = createSiteProfile({
    sampler: backend.sampler,
    line: lineSignal,
    readCurves: () => curveSignal.value,
    readPlane: () => PLANE,
  })
  owners.push(owner)
  return { ...backend, owner, lineSignal, curveSignal, status: () => owner.profile.value.status }
}

function ready(profile: SiteProfile): Extract<SiteProfile, { status: 'ready' }> {
  if (profile.status !== 'ready') throw new Error(`The profile is ${profile.status}, not ready`)
  return profile
}

/** The plane points a request read, in session-plane metres. */
function planePoints(request: LidarSamplePointsRequest) {
  return request.points.map(([lon, lat]) => PLANE.toPlane({ lon, lat }))
}

function lengthOf(profile: SiteProfile): number {
  if (profile.status === 'none') throw new Error('No profile')
  return profile.lengthM
}

describe('the points a profile reads: step and cap', () => {
  it('steps at the finest curve resolution along a 10 m line, first point to last', () => {
    const { calls, owner } = profileOf([at(0, 0), at(10, 0)], [source('mnt', 'elevation', { resolutionM: 2 }), source('dsm', 'elevation', { resolutionM: 0.5 })])
    expect(lengthOf(owner.profile.value)).toBeCloseTo(10, 6)
    const points = planePoints(calls[0]!.request)
    expect(points).toHaveLength(21)
    expect(points[0]!.x).toBeCloseTo(0, 6)
    expect(points[1]!.x).toBeCloseTo(0.5, 6)
    expect(points.at(-1)!.x).toBeCloseTo(10, 6)
  })

  it('caps a long line at 4,096 points, also with no resolution', () => {
    expect(profileOf([at(0, 0), at(10_000, 0)], [source('mnt', 'elevation', { resolutionM: 0.5 })]).calls[0]!.request.points).toHaveLength(4096)
    expect(profileOf([at(0, 0), at(30, 40)], [source('mnt', 'elevation', { resolutionM: null })]).calls[0]!.request.points).toHaveLength(4096)
  })

  it('walks a bent line in session-plane metres, so its length is the canvas chips\' sum', () => {
    const { calls, owner } = profileOf([at(0, 0), at(30, 0), at(30, 40)], [source('mnt', 'elevation', { resolutionM: 1 })])
    expect(lengthOf(owner.profile.value)).toBeCloseTo(70, 6)
    const points = planePoints(calls[0]!.request)
    expect(points).toHaveLength(71)
    expect(points[30]!.x).toBeCloseTo(30, 6)
    expect(points[30]!.y).toBeCloseTo(0, 6)
    expect(points[50]!.x).toBeCloseTo(30, 6)
    expect(points[50]!.y).toBeCloseTo(20, 6)
  })
})

describe('profile statistics', () => {
  /** A 4 m line read every 0.5 m (9 points), its one curve answering `list`. */
  async function curveStats(role: 'elevation' | 'height', list: (number | null)[]) {
    const { calls, owner } = profileOf([at(0, 0), at(4, 0)], [source('c', role, { resolutionM: 0.5 })])
    await calls[0]!.answer(() => values(...list))
    return ready(owner.profile.value).curves[0]!.stats
  }

  it('Rise is the signed net change over the values present; Steepest the largest slope over 2 m, at the point between', async () => {
    expect(await curveStats('elevation', [null, 10, 10, 10, 10.2, 10.5, 10.6, 10.6, null])).toEqual({
      role: 'elevation',
      rise: expect.closeTo(0.6, 9),
      steepest: { percent: expect.closeTo(30, 6), index: 4, runM: expect.closeTo(2, 6) },
    })
    expect(await curveStats('elevation', [null, 130.5, null, null, null, null, null, null, 127.25])).toEqual({
      role: 'elevation', rise: expect.closeTo(-3.25, 9), steepest: null,
    })
  })

  it('Steepest uses adjacent points when they are more than 2 m apart, and says so in its run', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(10, 0)], [source('c', 'elevation', { resolutionM: 5 })])
    await calls[0]!.answer(() => values(0, 1, 4))
    expect(ready(owner.profile.value).curves[0]!.stats).toEqual({
      role: 'elevation', rise: 4, steepest: { percent: expect.closeTo(60, 6), index: 2, runM: expect.closeTo(5, 6) },
    })
  })

  it('Steepest measures each curve over its own cell size when that is longer than 2 m, beside a finer curve', async () => {
    // A uniform 10 % slope along 60 m, read every 0.5 m (the finest curve), each grid answering its nearest cell: the
    // coarse grids are staircases at that step, so a 2 m run across a cell edge would read 125 % and 25 %.
    const cells = [25, 5, 0.5]
    const { calls, owner } = profileOf([at(0, 0), at(60, 0)], cells.map((cellM) => source(`c${cellM}`, 'elevation', { resolutionM: cellM })))
    const distances = Array.from({ length: 121 }, (_, index) => index * 0.5)
    await calls[0]!.answer((target) => {
      const cellM = cells[target]!
      return values(...distances.map((distance) => 0.1 * (Math.floor(distance / cellM) * cellM + cellM / 2)))
    })
    expect(ready(owner.profile.value).curves.map((curve) => curve.stats)).toEqual(cells.map((cellM) => ({
      role: 'elevation',
      rise: expect.any(Number),
      steepest: { percent: expect.closeTo(10, 6), index: expect.any(Number), runM: expect.closeTo(Math.max(2, cellM), 6) },
    })))
  })

  it('Steepest on a line that is no whole number of cells long is measured over the sample nearest 2 m, not one more', async () => {
    // 100.5 m over a 1 m grid: 102 points 0.995 m apart, so two steps fall 1 cm short of 2 m; a third would make it 3 m.
    const { calls, owner } = profileOf([at(0, 0), at(100.5, 0)], [source('c', 'elevation', { resolutionM: 1 })])
    const count = calls[0]!.request.points.length
    expect(count).toBe(102)
    // Flat but for one 30 cm step between points 50 and 51: 15 % over about 2 m, 10 % over about 3 m.
    await calls[0]!.answer(() => values(...Array.from({ length: count }, (_, index) => (index > 50 ? 100.3 : 100))))
    const stats = ready(owner.profile.value).curves[0]!.stats
    if (stats.role !== 'elevation' || !stats.steepest) throw new Error('no steepest')
    expect(stats.steepest.runM).toBeCloseTo((2 * 100.5) / 101, 6)
    expect(stats.steepest.percent).toBeCloseTo((0.3 / ((2 * 100.5) / 101)) * 100, 6)
  })

  it('Steepest on a line longer than 8,190 m is measured over the sampling step, its run', async () => {
    // 12 km at 4,096 points: 2.93 m between points over a 0.5 m DEM.
    const { calls, owner } = profileOf([at(0, 0), at(12_000, 0)], [source('c', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.answer(() => values(...Array.from({ length: 4096 }, (_, index) => (index === 4095 ? 1 : 0))))
    const stats = ready(owner.profile.value).curves[0]!.stats
    if (stats.role !== 'elevation' || !stats.steepest) throw new Error('no steepest')
    expect(stats.steepest.runM).toBeCloseTo(12_000 / 4095, 6)
  })

  it('Steepest is never measured over less than 2 m near the line\'s end', async () => {
    // Flat ground every 0.5 m with 10 cm of noise in the last cell: 5 % over the last 2 m, not 20 % over its last 0.5 m.
    const { calls, owner } = profileOf([at(0, 0), at(10, 0)], [source('c', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.answer(() => values(...Array.from({ length: 20 }, () => 100), 100.1))
    expect(ready(owner.profile.value).curves[0]!.stats).toEqual({
      role: 'elevation', rise: expect.closeTo(0.1, 9), steepest: { percent: expect.closeTo(5, 6), index: 18, runM: expect.closeTo(2, 6) },
    })
  })

  it('Steepest on a line shorter than 2 m is measured end to end', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [source('c', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.answer(() => values(10, 10, 10.1))
    expect(ready(owner.profile.value).curves[0]!.stats).toEqual({
      role: 'elevation', rise: expect.closeTo(0.1, 9), steepest: { percent: expect.closeTo(10, 6), index: 1, runM: expect.closeTo(1, 6) },
    })
  })

  it('Highest is the largest height present', async () => {
    expect(await curveStats('height', [null, 3, 14.2, 0, null, null, null, null, null])).toEqual({ role: 'height', highest: 14.2 })
  })
})

describe('createSiteProfile: request key, batches and stale answers', () => {
  it('reads every curve front first in the profile lane and draws once the request lands, with each curve\'s stats', async () => {
    const { calls, owner, status } = profileOf([at(0, 0), at(1, 0)], [source('mnt'), source('chm', 'height')])

    expect(status()).toBe('reading')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.targets).toEqual([
      { kind: 'Source', entity_id: 'mnt', expected_generation_id: 'mnt-g1' },
      { kind: 'Source', entity_id: 'chm', expected_generation_id: 'chm-g1' },
    ])
    expect(calls[0]!.request.points).toHaveLength(41)

    await calls[0]!.answer((target) => target === 0
      ? { Values: { values: Array.from({ length: 41 }, (_, index) => 100 + index / 40) } }
      : { Values: { values: Array.from({ length: 41 }, (_, index) => (index === 20 ? 14.2 : 3)) } })

    const profile = ready(owner.profile.value)
    expect(profile.curves.map((curve) => [curve.id, curve.role])).toEqual([['mnt', 'elevation'], ['chm', 'height']])
    expect(profile.curves[0]!.stats).toMatchObject({ role: 'elevation', rise: 1 })
    expect(profile.curves[1]!.stats).toEqual({ role: 'height', highest: 14.2 })
  })

  it('nine curves are two requests sent in turn, and the chart draws once both landed', async () => {
    const curves = Array.from({ length: 9 }, (_, index) => source(`c${index}`))
    const { calls, owner, status } = profileOf([at(0, 0), at(5, 0)], curves)

    expect(calls.map((call) => call.request.targets.length)).toEqual([8])
    await calls[0]!.answer(() => values(...Array.from({ length: 201 }, () => 1)))
    expect(calls.map((call) => call.request.targets.length)).toEqual([8, 1])
    expect(calls[1]!.request.targets[0]!.entity_id).toBe('c8')
    expect(status()).toBe('reading')

    await calls[1]!.answer(() => values(...Array.from({ length: 201 }, () => 2)))
    expect(ready(owner.profile.value).curves.map((curve) => curve.values[0])).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2])
  })

  it('the same key asks once; a new generation asks again', async () => {
    const { calls, curveSignal } = profileOf([at(0, 0), at(5, 0)], [source('mnt')])
    curveSignal.value = [source('mnt')]
    expect(calls).toHaveLength(1)

    curveSignal.value = [source('mnt', 'elevation', { generationId: 'mnt-g2' })]
    await calls[0]!.answer(() => values(1))
    expect(calls).toHaveLength(2)
    expect(calls[1]!.request.targets[0]!.expected_generation_id).toBe('mnt-g2')
  })

  it('an answer for a line no longer shown is never published', async () => {
    const { calls, lineSignal, owner, status } = profileOf([at(0, 0), at(5, 0)], [source('mnt')])
    lineSignal.value = [at(0, 0), at(0, 5)]

    await calls[0]!.answer(() => values(...Array.from({ length: 201 }, () => 7)))
    expect(status()).toBe('reading')

    await calls[1]!.answer(() => values(...Array.from({ length: 201 }, () => 9)))
    expect(ready(owner.profile.value).curves[0]!.values[0]).toBe(9)
  })

  it('a request whose key comes back while it runs publishes every batch it read', async () => {
    // Nine curves: two batches. Hiding the ninth while the first batch is read, then showing it again before the second
    // lands, makes the running request's key current again; its first batch must not have been thrown away meanwhile.
    const curves = Array.from({ length: 9 }, (_, index) => source(`c${index}`))
    const { calls, curveSignal, owner } = profileOf([at(0, 0), at(5, 0)], curves)
    curveSignal.value = curves.slice(0, 8)
    await calls[0]!.answer(() => values(...Array.from({ length: 201 }, () => 1)))
    curveSignal.value = curves
    await calls[1]!.answer(() => values(...Array.from({ length: 201 }, () => 2)))

    expect(ready(owner.profile.value).curves.map((curve) => curve.values[0])).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2])
  })

  it('closing the profile drops its queued request; the running request only finishes its batches', async () => {
    // Nine curves: two batches. A redraw while the first batch is read queues the second line's request; closing the
    // profile (×, Esc, a panel switch) must drop it, so it never holds the backend's one sampling permit the row values need.
    const curves = Array.from({ length: 9 }, (_, index) => source(`c${index}`))
    const { calls, lineSignal, status } = profileOf([at(0, 0), at(5, 0)], curves)
    lineSignal.value = [at(0, 0), at(0, 5)]
    lineSignal.value = null
    expect(status()).toBe('none')

    await calls[0]!.answer(() => values(...Array.from({ length: 201 }, () => 1)))
    await calls[1]!.answer(() => values(...Array.from({ length: 201 }, () => 1)))
    expect(calls.map((call) => call.request.targets[0]!.entity_id)).toEqual(['c0', 'c8'])
    expect(status()).toBe('none')
  })

  it('hiding every curve drops the profile\'s queued request', async () => {
    const { calls, lineSignal, curveSignal, status } = profileOf([at(0, 0), at(5, 0)], [source('mnt')])
    lineSignal.value = [at(0, 0), at(0, 5)]
    curveSignal.value = []
    expect(status()).toBe('needs-layer')

    await calls[0]!.answer(() => values(...Array.from({ length: 201 }, () => 1)))
    expect(calls).toHaveLength(1)
    expect(status()).toBe('needs-layer')
  })

  it('a line with no curve keeps its length and asks for a layer; no line is no profile', () => {
    const { calls, owner, lineSignal } = profileOf([at(0, 0), at(30, 40)], [])
    expect(owner.profile.value).toEqual({ status: 'needs-layer', lengthM: expect.closeTo(50, 6) })
    expect(calls).toHaveLength(0)
    lineSignal.value = null
    expect(owner.profile.value).toEqual({ status: 'none' })
  })

  it('no value anywhere says so', async () => {
    const empty = profileOf([at(0, 0), at(1, 0)], [source('mnt'), source('dsm', 'elevation', { generationId: 'stale' })])
    await empty.calls[0]!.answer((target) => target === 0 ? values(null) : { Unavailable: { reason: 'StaleGeneration' } })
    expect(empty.status()).toBe('no-values')
  })

  it('a failed read is read-failed, not no-values, and is never re-asked by itself', async () => {
    const failed = profileOf([at(0, 0), at(1, 0)], [source('mnt')])
    await failed.calls[0]!.fail()
    expect(failed.owner.profile.value).toEqual({ status: 'read-failed', lengthM: expect.closeTo(1, 6) })
    await settle()
    expect(failed.calls).toHaveLength(1)
  })

  it('Retry re-asks the same key once and lands ready', async () => {
    const { calls, owner, status } = profileOf([at(0, 0), at(1, 0)], [source('mnt', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.fail()
    expect(status()).toBe('read-failed')

    owner.retry()
    owner.retry()
    expect(status()).toBe('reading')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.request).toEqual(calls[0]!.request)

    await calls[1]!.answer(() => values(1, 2, 3))
    expect(ready(owner.profile.value).curves[0]!.values).toEqual([1, 2, 3])
    owner.retry()
    expect(calls).toHaveLength(2)
  })

  it('a curve whose data could not be read is read-failed, not no-values', async () => {
    const failed = profileOf([at(0, 0), at(1, 0)], [source('mnt')])
    await failed.calls[0]!.answer(() => READ_FAILED)
    expect(failed.owner.profile.value).toEqual({ status: 'read-failed', lengthM: expect.closeTo(1, 6) })
    await settle()
    expect(failed.calls).toHaveLength(1)
  })

  it('a curve that could not be read beside one with values is ready, with that curve marked failed', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [source('mnt', 'elevation', { resolutionM: 0.5 }), source('dsm', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.answer((target) => target === 0 ? values(1, 2, 3) : READ_FAILED)
    const curves = ready(owner.profile.value).curves
    expect(curves.map((curve) => [curve.id, curve.readFailed])).toEqual([['mnt', false], ['dsm', true]])
  })

  it('Retry after a partly failed read re-asks the same key once and draws both curves', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [source('mnt', 'elevation', { resolutionM: 0.5 }), source('dsm', 'elevation', { resolutionM: 0.5 })])
    await calls[0]!.answer((target) => target === 0 ? values(1, 2, 3) : READ_FAILED)

    owner.retry()
    owner.retry()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.request).toEqual(calls[0]!.request)

    await calls[1]!.answer((target) => target === 0 ? values(1, 2, 3) : values(4, 5, 6))
    expect(ready(owner.profile.value).curves.map((curve) => curve.readFailed)).toEqual([false, false])
    owner.retry()
    expect(calls).toHaveLength(2)
  })

  it('a run of curve read failures records one diagnostic; a read that works ends the run', async () => {
    resetFrontendDiagnosticsForTests()
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [source('mnt')])
    await calls[0]!.answer(() => READ_FAILED)
    owner.retry()
    await calls[1]!.answer(() => READ_FAILED)
    expect(recentFrontendDiagnostics().filter((entry) => entry.source === 'lidar-library')).toHaveLength(1)
    owner.retry()
    await calls[2]!.answer(() => values(1, 2))
    owner.retry()
    expect(calls).toHaveLength(3)
    resetFrontendDiagnosticsForTests()
  })

  it('closing after a failed read sends nothing', async () => {
    const { calls, lineSignal, status } = profileOf([at(0, 0), at(1, 0)], [source('mnt')])
    await calls[0]!.fail()
    lineSignal.value = null
    await settle()
    expect(status()).toBe('none')
    expect(calls).toHaveLength(1)
  })

  it('the cursor clamps to the samples, waits for a ready profile and clears with a new key', async () => {
    const { calls, owner, lineSignal } = profileOf([at(0, 0), at(1, 0)], [source('mnt', 'elevation', { resolutionM: 0.5 })])
    owner.setCursor(1)
    expect(owner.cursor.value).toBeNull()
    await calls[0]!.answer(() => values(1, 2, 3))

    owner.setCursor(7)
    expect(owner.cursor.value).toBe(2)
    owner.setCursor(-1)
    expect(owner.cursor.value).toBe(0)

    lineSignal.value = [at(0, 0), at(2, 0)]
    expect(owner.cursor.value).toBeNull()
  })
})

describe('profileCopyText', () => {
  it('writes tab-separated columns in the locale\'s decimals, with empty cells for no data', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [
      source('mnt', 'elevation', { name: 'MNT\tIGN', resolutionM: 0.5 }),
      source('chm', 'height', { name: 'Canopy', units: 'unknown', resolutionM: 0.5 }),
    ])
    await calls[0]!.answer((target) => target === 0 ? values(128.104, 128.5, null) : values(null, 2, 3.456))
    const profile = ready(owner.profile.value)
    const words: Record<string, string> = {
      'siteData.chart.distance': 'Distance (m)', 'siteData.chart.longitude': 'Longitude', 'siteData.chart.latitude': 'Latitude',
    }

    const lines = profileCopyText(profile, 'fr', (key) => words[key]!).split('\n')

    expect(lines[0]).toBe('Distance (m)\tLongitude\tLatitude\tMNT IGN (m)\tCanopy')
    const first = lines[1]!.split('\t')
    expect(first[0]).toBe('0,00')
    expect(first[1]).toBe(new Intl.NumberFormat('fr', { minimumFractionDigits: 7, maximumFractionDigits: 7, useGrouping: false }).format(profile.samples.points[0]!.lon))
    expect(first.slice(3)).toEqual(['128,10', ''])
    expect(lines[2]!.split('\t')[0]).toBe('0,50')
    expect(lines[3]!.split('\t').slice(3)).toEqual(['', '3,46'])
    expect(lines).toHaveLength(5)
    expect(lines[4]).toBe('')
  })

  it('leaves out a curve whose read failed, so its column is not mistaken for no data', async () => {
    const { calls, owner } = profileOf([at(0, 0), at(1, 0)], [
      source('mnt', 'elevation', { name: 'MNT', resolutionM: 0.5 }),
      source('mns', 'elevation', { name: 'MNS', resolutionM: 0.5 }),
    ])
    await calls[0]!.answer((target) => target === 0 ? values(128, 129, 130) : READ_FAILED)
    const profile = ready(owner.profile.value)
    expect(profile.curves.map((curve) => curve.readFailed)).toEqual([false, true])
    const words: Record<string, string> = {
      'siteData.chart.distance': 'Distance (m)', 'siteData.chart.longitude': 'Longitude', 'siteData.chart.latitude': 'Latitude',
    }

    const lines = profileCopyText(profile, 'en', (key) => words[key]!).split('\n')

    expect(lines[0]).toBe('Distance (m)\tLongitude\tLatitude\tMNT (m)')
    expect(lines[1]!.split('\t')).toHaveLength(4)
    expect(lines[1]!.split('\t')[3]).toBe('128.00')
  })
})

describe('Profile this line', () => {
  afterEach(() => {
    endSiteDataTransients()
    setCurrentCanvasSession(null)
    sidePanel.value = null
  })

  it('opens Site data and shows the profile of a Line zone or a Measure guide, in lon/lat', () => {
    const scene = {
      zones: [{ kind: 'zone', id: 'line-1', zoneType: 'line', points: [{ x: 0, y: 0 }, { x: 30, y: 40 }] }],
      measurementGuides: [{ kind: 'measurement-guide', id: 'guide-1', start: { x: 5, y: 5 }, end: { x: 5, y: 25 } }],
    }
    setCurrentCanvasSession({
      queries: { sessionPlane: signal(PLANE), view: { mode: signal('site') }, getSceneSnapshot: () => scene },
    } as unknown as CanvasRuntimeSurfaces)
    activePanel.value = 'canvas'
    sidePanel.value = null

    profileLineMenu.profile({ kind: 'zone', id: 'line-1' })
    expect(sidePanel.value).toBe('site-data')
    expect(profileLine.value).toEqual([PLANE.toGeo({ x: 0, y: 0 }), PLANE.toGeo({ x: 30, y: 40 })])

    profileLineMenu.profile({ kind: 'measurement-guide', id: 'guide-1' })
    expect(profileLine.value).toEqual([PLANE.toGeo({ x: 5, y: 5 }), PLANE.toGeo({ x: 5, y: 25 })])

    profileLineMenu.profile({ kind: 'zone', id: 'gone' })
    expect(profileLine.value).toEqual([PLANE.toGeo({ x: 5, y: 5 }), PLANE.toGeo({ x: 5, y: 25 })])
  })
})
