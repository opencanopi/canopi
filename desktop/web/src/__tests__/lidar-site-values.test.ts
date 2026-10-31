// Site data row values and the pin (canopi-f47t.42, spec §1.10, §3.8): through the real presentation join, the real
// sampler, the real transients and the test canvas query surface's pointer; only the native command is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LidarSamplePointsRequest, LidarSampleSeries } from '../generated/contracts'

const native = vi.hoisted(() => ({
  requests: [] as LidarSamplePointsRequest[],
  /** Entity ids that answer no data. */
  empty: new Set<string>(),
  /** While holding, each answer waits here until the test releases it. */
  holding: false,
  held: [] as (() => void)[],
  /** How many next requests the backend refuses, as when its Local admission is full. */
  refusals: 0,
}))
vi.mock('../ipc/lidar', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcLidarModule>()),
  lidarSamplePoints: async (request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]> => {
    native.requests.push(request)
    if (native.refusals > 0) {
      native.refusals -= 1
      throw new Error('Native local operations are busy; try again')
    }
    if (native.holding) await new Promise<void>((release) => native.held.push(release))
    // Each target answers the point's longitude, so a row shows where it was read.
    return request.targets.map((target) => ({
      Values: { values: request.points.map(([lon]) => (native.empty.has(target.entity_id) ? null : lon)) },
    }))
  },
}))

import { setCurrentCanvasSession } from '../canvas/session'
import type { CanvasRuntimeSurfaces } from '../canvas/runtime/runtime'
import type { PointerKind } from '../canvas/runtime/interaction-types'
import { designSessionStore } from '../app/document-session/store'
import { setLidarEntryVisibility } from '../app/lidar/actions'
import { lidarLibrary } from '../app/lidar/library-store'
import { endSiteDataTransients, pin, setPin } from '../app/lidar/site-transients'
import { pinSiteDataPoint, siteValues } from '../app/lidar/site-values'
import { activePanel, selectPanel, sidePanel } from '../app/shell/state'
import type { CanopiFile } from '../types/design'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'
import { librarySnapshot, slopeItem, slopeProvenance, sourceItem } from './support/library-fixtures'
import type * as IpcLidarModule from '../ipc/lidar'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let surface: TestCanvasQuerySurface

function openDesign(entries: { id: string; visible: boolean; kind?: 'Source' | 'Derived' }[]): void {
  const design = {
    name: 'Orchard',
    lidar: {
      visible: true,
      entries: entries.map(({ id, visible, kind = 'Source' }, order) => ({
        kind, id, name: id, visible, opacity: 1, order, ramp: null, reversed: false, range: null,
      })),
    },
  } as unknown as CanopiFile
  designSessionStore.replaceCurrentDesignState(design, null, 'Orchard')
}

/** Releases every held answer, including those the released ones let run, then answers at once again. */
async function releaseHeld(): Promise<void> {
  native.holding = false
  await flush()
  while (native.held.length > 0) {
    native.held.shift()!()
    await flush()
  }
}

function hover(x: number, y: number, pointerKind: PointerKind = 'mouse'): void {
  surface.emitPointerWorld({ world: { x, y }, screen: { x: 0, y: 0 }, pointerKind })
}

function lonAt(x: number, y: number): number {
  return surface.sessionPlane.peek()!.toGeo({ x, y }).lon
}

function shown(): Record<string, unknown> | null {
  const values = siteValues.value
  return values && { at: values.at, ...Object.fromEntries(values.rows) }
}

describe('Site data row values', () => {
  beforeEach(() => {
    native.requests.length = 0
    native.empty.clear()
    native.refusals = 0
    lidarLibrary.value = librarySnapshot([sourceItem('mnt', 'MNT'), sourceItem('dsm', 'DSM'), sourceItem('dtm', 'DTM')])
    openDesign([{ id: 'mnt', visible: true }, { id: 'dsm', visible: true }])
    surface = createTestCanvasQuerySurface()
    setCurrentCanvasSession({ queries: surface } as unknown as CanvasRuntimeSurfaces)
    activePanel.value = 'canvas'
    selectPanel('site-data')
  })

  afterEach(async () => {
    // A held answer would keep the shared sampler's lane busy for the next test.
    await releaseHeld()
    endSiteDataTransients()
    sidePanel.value = null
    setCurrentCanvasSession(null)
    lidarLibrary.value = null
  })

  it('reads the shown rows under the pointer, front row first, and falls back to the pin off the map', async () => {
    setPin({ lon: 1.5, lat: 47 })
    hover(10, 20)
    await flush()

    expect(native.requests.at(-1)!.targets.map((target) => target.entity_id)).toEqual(['dsm', 'mnt'])
    expect(native.requests.at(-1)!.targets[0]!.expected_generation_id).toBe('dsm-g1')
    expect(shown()).toEqual({
      at: 'pointer',
      dsm: { kind: 'value', value: lonAt(10, 20) },
      mnt: { kind: 'value', value: lonAt(10, 20) },
    })

    surface.emitPointerWorld(null)
    await flush()
    expect(shown()).toEqual({ at: 'pin', dsm: { kind: 'value', value: 1.5 }, mnt: { kind: 'value', value: 1.5 } })
  })

  it('reads the rows in the panel list order: a source before the result listed under it', async () => {
    lidarLibrary.value = librarySnapshot([sourceItem('mnt', 'MNT'), slopeItem('slope', 'mnt'), sourceItem('dsm', 'DSM')])
    openDesign([{ id: 'mnt', visible: true }, { id: 'slope', visible: true, kind: 'Derived' }, { id: 'dsm', visible: true }])
    hover(10, 20)
    await flush()

    expect(native.requests.at(-1)!.targets.map((target) => target.entity_id)).toEqual(['dsm', 'mnt', 'slope'])
  })

  it('reads the outputs of one analysis together, as the panel gathers them, before a sibling listed between them', async () => {
    const flowOutput = (id: string) =>
      slopeItem(id, 'mnt', { provenance: slopeProvenance(id, 'mnt', { definition_id: 'flow-def' }) })
    lidarLibrary.value = librarySnapshot([sourceItem('mnt', 'MNT'), flowOutput('flow-a'), slopeItem('slope', 'mnt'), flowOutput('flow-b')])
    openDesign([
      { id: 'mnt', visible: true },
      { id: 'flow-b', visible: true, kind: 'Derived' },
      { id: 'slope', visible: true, kind: 'Derived' },
      { id: 'flow-a', visible: true, kind: 'Derived' },
    ])
    hover(10, 20)
    await flush()

    expect(native.requests.at(-1)!.targets.map((target) => target.entity_id)).toEqual(['mnt', 'flow-a', 'flow-b', 'slope'])
  })

  it('shows no data where the cell holds none, and reads nothing with no pointer and no pin', async () => {
    await flush()
    expect(native.requests).toHaveLength(0)
    expect(siteValues.value).toBeNull()

    native.empty.add('mnt')
    hover(1, 1)
    await flush()
    expect(siteValues.value?.rows.get('mnt')).toEqual({ kind: 'no-data' })
  })

  it('re-samples at once when an eye is toggled, and a hidden row reads nothing', async () => {
    hover(5, 5)
    await flush()
    const before = native.requests.length

    setLidarEntryVisibility('dsm', false)
    await flush()

    expect(native.requests).toHaveLength(before + 1)
    expect(native.requests.at(-1)!.targets.map((target) => target.entity_id)).toEqual(['mnt'])
    expect(shown()).toEqual({ at: 'pointer', mnt: { kind: 'value', value: lonAt(5, 5) } })
  })

  it('samples nothing while Site data is not the open panel', async () => {
    selectPanel('layers')
    hover(5, 5)
    await flush()

    expect(native.requests).toHaveLength(0)
    expect(siteValues.value).toBeNull()
  })

  it('publishes no late answer once the pointer leaves the map with no pin', async () => {
    native.holding = true
    hover(10, 20)
    await flush()
    hover(11, 21)
    await flush()
    surface.emitPointerWorld(null)
    await flush()
    expect(siteValues.value).toBeNull()

    await releaseHeld()
    expect(siteValues.value).toBeNull()
  })

  it('publishes no late answer once the panel closes', async () => {
    native.holding = true
    hover(10, 20)
    await flush()
    selectPanel('layers')
    await flush()

    await releaseHeld()
    expect(siteValues.value).toBeNull()
  })

  it('a late answer never brings back the value of a row hidden meanwhile', async () => {
    native.holding = true
    hover(5, 5)
    await flush()
    setLidarEntryVisibility('dsm', false)
    await flush()

    // The answer asked with both rows lands first.
    native.held.shift()!()
    await flush()
    expect(shown()).toEqual({ at: 'pointer', mnt: { kind: 'value', value: lonAt(5, 5) } })
    await releaseHeld()
    expect(shown()).toEqual({ at: 'pointer', mnt: { kind: 'value', value: lonAt(5, 5) } })
  })

  it('reads again when the Design is reopened with the same rows while the pointer rests', async () => {
    native.holding = true
    hover(10, 20)
    await flush()
    // Reopened from the keyboard: the pointer never leaves the map, and the rows to read are the same.
    openDesign([{ id: 'mnt', visible: true }, { id: 'dsm', visible: true }])
    await flush()

    // The answer asked for the closed session is dropped; the reopened session asks again at the same point.
    await releaseHeld()
    expect(native.requests).toHaveLength(2)
    expect(shown()).toEqual({
      at: 'pointer',
      dsm: { kind: 'value', value: lonAt(10, 20) },
      mnt: { kind: 'value', value: lonAt(10, 20) },
    })
  })

  it('drops values a refused read leaves behind, and asks again until the read lands', async () => {
    setPin({ lon: 1.5, lat: 47 })
    hover(10, 20)
    await flush()
    expect(shown()?.at).toBe('pointer')

    vi.useFakeTimers()
    try {
      native.refusals = 2
      surface.emitPointerWorld(null)
      await vi.advanceTimersByTimeAsync(0)
      // The pointer has left the map: its values are no longer shown while the pin's read is refused.
      expect(siteValues.value).toBeNull()

      await vi.advanceTimersByTimeAsync(10_000)
    } finally {
      vi.useRealTimers()
    }
    expect(shown()).toEqual({ at: 'pin', dsm: { kind: 'value', value: 1.5 }, mnt: { kind: 'value', value: 1.5 } })
  })

  it('gives up asking again after a few refusals of the same read', async () => {
    vi.useFakeTimers()
    try {
      native.refusals = Number.POSITIVE_INFINITY
      setPin({ lon: 1.5, lat: 47 })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(600_000)
    } finally {
      vi.useRealTimers()
      native.refusals = 0
    }
    expect(native.requests.length).toBeGreaterThan(1)
    expect(native.requests.length).toBeLessThanOrEqual(6)
    expect(siteValues.value).toBeNull()
  })

  it('ignores touch for hover: a finger reads values through the pin', async () => {
    setPin({ lon: 1.25, lat: 47 })
    hover(5, 5, 'touch')
    await flush()

    expect(native.requests.every((request) => request.points[0]![0] === 1.25)).toBe(true)
    expect(shown()?.at).toBe('pin')
  })

  it('a finger after a resting mouse reads through the pin', async () => {
    hover(10, 20)
    await flush()
    expect(shown()?.at).toBe('pointer')

    hover(5, 5, 'touch')
    setPin({ lon: 1.25, lat: 47 })
    await flush()

    expect(shown()).toEqual({ at: 'pin', dsm: { kind: 'value', value: 1.25 }, mnt: { kind: 'value', value: 1.25 } })
  })

  it('pins the tap no tool uses as the WGS84 point the canvas drew there', () => {
    pinSiteDataPoint({ x: 12, y: -30 })

    expect(pin.value).toEqual(surface.sessionPlane.peek()!.toGeo({ x: 12, y: -30 }))
  })
})
