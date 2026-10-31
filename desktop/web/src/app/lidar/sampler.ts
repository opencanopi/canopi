// app/lidar/sampler.ts
// Owner of the Site data sampler lanes (serial-lane-only-in-owners, ADR 0024; §18 F37). Invariant: one sample in flight per lane.
//
// The one way the frontend samples site data (canopi-f47t.42, spec §1.10; architecture review finding 3; stream C builds
// it): row values (lane 'values', from site-values.ts) and the profile (lane 'profile', from profile.ts) both ask here, and
// nothing else calls `lidarSamplePoints`. Its rules:
// - one invoke in flight per lane; the backend serialises sampling across lanes (one permit before its Local slot);
// - a request's targets are split, in list order, into batches of LIDAR_SAMPLE_MAX_TARGETS, each with every point
//   (at most LIDAR_SAMPLE_MAX_POINTS), sent one after another;
// - a newer key replaces the lane's queued key, but never cuts short the running key's remaining batches, so a row past
//   the first batch gets its value while the pointer moves;
// - an answer is published only while the Design session it was asked for (at `request`, not when it runs) is open, and
//   a key whose session closed while it was queued never runs; each target names the generation it expects, so a moved
//   head answers Unavailable rather than newer data;
// - a failed batch rejects its request; the lane goes on with its queued key.

import {
  LIDAR_SAMPLE_MAX_POINTS,
  LIDAR_SAMPLE_MAX_TARGETS,
  type LidarSamplePointsRequest,
  type LidarSampleSeries,
  type LidarSampleTarget,
} from '../../generated/contracts'
import { lidarSamplePoints } from '../../ipc/lidar'
import { designSessionStore } from '../document-session/store'

export type SampleLane = 'values' | 'profile'

export interface SiteSampler {
  /**
   * Samples `targets` at `points` ([lon, lat]) under `key`. `onBatch` receives each batch's series with the index of its
   * first target. Resolves 'done' once every batch landed, or 'superseded' when a newer key replaced this one in its
   * lane before it ran, or the Design session changed.
   */
  request(
    lane: SampleLane,
    key: string,
    targets: readonly LidarSampleTarget[],
    points: readonly (readonly [number, number])[],
    onBatch: (firstTarget: number, series: readonly LidarSampleSeries[]) => void,
  ): Promise<'done' | 'superseded'>
}

type Points = readonly (readonly [number, number])[]

interface Asked {
  readonly key: string
  readonly targets: readonly LidarSampleTarget[]
  readonly points: Points
  /** The Design session's identity when the key was asked. */
  readonly identity: unknown
  readonly onBatch: (firstTarget: number, series: readonly LidarSampleSeries[]) => void
  settle(outcome: 'done' | 'superseded'): void
  fail(error: unknown): void
}

interface Lane {
  running: boolean
  queued: Asked | null
}

export function createSiteSampler(deps: {
  sample(request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]>
  /** The open Design session's identity: an answer for another session is never published. */
  designIdentity(): unknown
}): SiteSampler {
  const lanes: Record<SampleLane, Lane> = {
    values: { running: false, queued: null },
    profile: { running: false, queued: null },
  }

  async function run(asked: Asked): Promise<void> {
    const points = asked.points.map(([lon, lat]) => [lon, lat] as [number, number])
    const closed = () => deps.designIdentity() !== asked.identity
    try {
      for (let first = 0; first < asked.targets.length; first += LIDAR_SAMPLE_MAX_TARGETS) {
        if (closed()) {
          asked.settle('superseded')
          return
        }
        const targets = asked.targets.slice(first, first + LIDAR_SAMPLE_MAX_TARGETS)
        const series = await deps.sample({ targets, points })
        if (closed()) {
          asked.settle('superseded')
          return
        }
        asked.onBatch(first, series)
      }
      asked.settle('done')
    } catch (error) {
      asked.fail(error)
    }
  }

  async function drain(lane: Lane): Promise<void> {
    lane.running = true
    while (lane.queued) {
      const next = lane.queued
      lane.queued = null
      await run(next)
    }
    lane.running = false
  }

  return {
    request(lane, key, targets, points, onBatch) {
      if (points.length > LIDAR_SAMPLE_MAX_POINTS) {
        return Promise.reject(new Error(`A Site data sample takes at most ${LIDAR_SAMPLE_MAX_POINTS} points`))
      }
      return new Promise((resolve, reject) => {
        const state = lanes[lane]
        state.queued?.settle('superseded')
        const identity = deps.designIdentity()
        state.queued = { key, targets, points, identity, onBatch, settle: resolve, fail: reject }
        if (!state.running) void drain(state)
      })
    },
  }
}

/** The app's one sampler: row values and the profile share it, each in its own lane. */
export const siteSampler: SiteSampler = createSiteSampler({
  sample: lidarSamplePoints,
  designIdentity: () => designSessionStore.sessionIdentity.peek(),
})
