// The Site data sampler's rules (canopi-f47t.42, architecture review finding 3): one invoke in flight per lane, targets
// split in list order into capped batches, a newer key replaces only the queued one, and nothing is published for a
// Design session that has closed.
import { describe, expect, it } from 'vitest'
import {
  LIDAR_SAMPLE_MAX_POINTS,
  LIDAR_SAMPLE_MAX_TARGETS,
  type LidarSamplePointsRequest,
  type LidarSampleSeries,
  type LidarSampleTarget,
} from '../../generated/contracts'
import { createSiteSampler } from './sampler'

interface Call {
  readonly request: LidarSamplePointsRequest
  answer(): void
  fail(error: Error): void
}

/** A fake native sampler whose answers the test releases one by one; each target answers its own index. */
function fakeNative() {
  const calls: Call[] = []
  let inFlight = 0
  let mostInFlight = 0
  const sample = (request: LidarSamplePointsRequest) => new Promise<LidarSampleSeries[]>((resolve, reject) => {
    inFlight += 1
    mostInFlight = Math.max(mostInFlight, inFlight)
    calls.push({
      request,
      answer: () => {
        inFlight -= 1
        resolve(request.targets.map((target) => ({
          Values: { values: request.points.map(() => Number(target.entity_id.slice(1))) },
        })))
      },
      fail: (error) => {
        inFlight -= 1
        reject(error)
      },
    })
  })
  return { calls, sample, mostInFlight: () => mostInFlight }
}

function targets(count: number): LidarSampleTarget[] {
  return Array.from({ length: count }, (_, index) => ({ kind: 'Source', entity_id: `t${index}`, expected_generation_id: 'g' }))
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function answerNext(native: ReturnType<typeof fakeNative>, index: number): Promise<void> {
  await settle()
  native.calls[index]!.answer()
  await settle()
}

describe('the Site data sampler', () => {
  it('keeps one invoke in flight per lane; a newer key replaces only the queued one; lanes run side by side', async () => {
    const native = fakeNative()
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => 'design' })
    const landed: string[] = []
    const first = sampler.request('values', 'a', targets(1), [[1, 2]], () => landed.push('a'))
    const second = sampler.request('values', 'b', targets(1), [[1, 2]], () => landed.push('b'))
    const third = sampler.request('values', 'c', targets(1), [[1, 2]], () => landed.push('c'))
    const profile = sampler.request('profile', 'p', targets(1), [[1, 2], [3, 4]], () => landed.push('p'))
    await settle()
    expect(native.calls.map((call) => call.request.points.length)).toEqual([1, 2])
    await answerNext(native, 0)
    await answerNext(native, 1)
    await answerNext(native, 2)

    expect(await Promise.all([first, second, third, profile])).toEqual(['done', 'superseded', 'done', 'done'])
    expect(landed).toEqual(['a', 'p', 'c'])
    expect(native.calls).toHaveLength(3)
    // Never two invokes of one lane at once: two lanes made at most two.
    expect(native.mostInFlight()).toBe(2)
  })

  it('reaches row 9 while the key changes at 60 Hz: the running key finishes its batches before the newest runs', async () => {
    const native = fakeNative()
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => 'design' })
    const rows = new Map<number, number | null>()
    const record = (first: number, series: readonly LidarSampleSeries[]) => {
      series.forEach((one, index) => rows.set(first + index, 'Values' in one ? one.Values.values[0] ?? null : null))
    }
    const first = sampler.request('values', 'key-0', targets(9), [[0, 0]], record)
    // The pointer moves every frame while the first batch is out.
    const moved = Array.from({ length: 30 }, (_, frame) =>
      sampler.request('values', `key-${frame + 1}`, targets(9), [[frame + 1, frame + 1]], record))
    await answerNext(native, 0)
    const latest = sampler.request('values', 'key-31', targets(9), [[31, 31]], record)
    await answerNext(native, 1)

    expect(rows.get(8)).toBe(8)
    expect(await first).toBe('done')
    expect(await Promise.all(moved)).toEqual(Array(30).fill('superseded'))
    expect(native.calls.map((call) => [call.request.targets.map((target) => target.entity_id), call.request.points]))
      .toEqual([
        [['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], [[0, 0]]],
        [['t8'], [[0, 0]]],
        [['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], [[31, 31]]],
      ])
    await answerNext(native, 2)
    await answerNext(native, 3)
    expect(await latest).toBe('done')
  })

  it('splits targets in list order into capped batches, each with every point, and refuses points over the cap', async () => {
    const native = fakeNative()
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => 'design' })
    const firsts: number[] = []
    const points = Array.from({ length: LIDAR_SAMPLE_MAX_POINTS }, (_, index) => [index, index] as const)
    const done = sampler.request('profile', 'long', targets(19), points, (first) => firsts.push(first))
    for (let batch = 0; batch < 3; batch += 1) await answerNext(native, batch)

    expect(await done).toBe('done')
    expect(firsts).toEqual([0, 8, 16])
    for (const call of native.calls) {
      expect(call.request.targets.length).toBeLessThanOrEqual(LIDAR_SAMPLE_MAX_TARGETS)
      expect(call.request.points).toHaveLength(LIDAR_SAMPLE_MAX_POINTS)
    }
    expect(native.calls.flatMap((call) => call.request.targets.map((target) => target.entity_id)))
      .toEqual(targets(19).map((target) => target.entity_id))

    const over = [...points, [0, 0] as const]
    await expect(sampler.request('profile', 'over', targets(1), over, () => {})).rejects.toThrow(/at most/)
    expect(native.calls).toHaveLength(3)
  })

  it('never publishes an answer for a Design session that closed, and stops that key', async () => {
    const native = fakeNative()
    let design = { name: 'orchard' }
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => design })
    const landed: number[] = []
    const asked = sampler.request('values', 'k', targets(9), [[1, 1]], (first) => landed.push(first))
    await settle()
    design = { name: 'other' }
    await answerNext(native, 0)

    expect(await asked).toBe('superseded')
    expect(landed).toEqual([])
    expect(native.calls).toHaveLength(1)
  })

  it('never runs or publishes a key queued under a Design session that closed before it ran', async () => {
    const native = fakeNative()
    let design = { name: 'orchard' }
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => design })
    const landed: string[] = []
    const running = sampler.request('values', 'k1', targets(1), [[1, 1]], () => landed.push('k1'))
    const queued = sampler.request('values', 'k2', targets(1), [[2, 2]], () => landed.push('k2'))
    await settle()
    design = { name: 'other' }
    await answerNext(native, 0)

    expect(await running).toBe('superseded')
    expect(await queued).toBe('superseded')
    expect(landed).toEqual([])
    expect(native.calls).toHaveLength(1)
  })

  it('a failed batch rejects its request and the lane goes on with the newest key', async () => {
    const native = fakeNative()
    const sampler = createSiteSampler({ sample: native.sample, designIdentity: () => 'design' })
    const failing = sampler.request('values', 'a', targets(1), [[1, 2]], () => {})
    const next = sampler.request('values', 'b', targets(1), [[1, 2]], () => {})
    await settle()
    native.calls[0]!.fail(new Error('busy'))
    await expect(failing).rejects.toThrow('busy')
    await answerNext(native, 1)
    expect(await next).toBe('done')
  })
})
