import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RasterWorkerPool } from '../maplibre/raster-display/pool'
import type { RasterWorkerRequest } from '../maplibre/raster-display/protocol'
import { inProcessLane, opaquePixels, serveRasterFixtures, type InProcessLane } from './support/raster-lane'

/** A display COG the Rust engine wrote; every asset URL these tests open serves it. */
const fixtures = new URL('../maplibre/raster-display/fixtures/', import.meta.url)
const tif = new Uint8Array(readFileSync(fileURLToPath(new URL('rust-display-cog.tif', fixtures))))
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('rust-display-cog.json', fixtures)), 'utf8')) as {
  bounds: [number, number, number, number]
  width: number
  height: number
}

/** A tile over the fixture, and one beside it at the same zoom. */
const Z = 20
const [west, south, east, north] = fixture.bounds
const X = Math.floor((((west + east) / 2 + 180) / 360) * 2 ** Z)
const Y = (() => {
  const rad = (((south + north) / 2) * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** Z)
})()
const TILE_BYTES = 256 * 256 * 4

function pool(lanes = 1, maxInFlightPerLane = 1) {
  const created: InProcessLane[] = []
  const instance = new RasterWorkerPool({
    lanes,
    budgetBytes: 128 * 1024 * 1024,
    maxInFlightPerLane,
    createWorker: () => {
      const lane = inProcessLane()
      created.push(lane)
      return lane
    },
  })
  return { instance, created }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const ofOp = (lane: InProcessLane, op: RasterWorkerRequest['op']) => lane.requests.filter((request) => request.op === op)

beforeEach(() => {
  serveRasterFixtures((url) => (url.startsWith('asset://localhost/') ? tif : undefined))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('raster display worker pool', () => {
  it('reads one asset\'s statistics in a lane through a handle it closes afterwards', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const lane = created[0]!
    const statistics = await client.statistics('asset://localhost/a.tif')
    expect(statistics).toMatchObject({ pixels: fixture.width * fixture.height })
    expect(statistics!.min).toBeLessThanOrEqual(statistics!.max)
    await settle()
    const opened = ofOp(lane, 'open')[0]!
    expect(opened).toMatchObject({ url: 'asset://localhost/a.tif' })
    expect(lane.requests.at(-1)).toMatchObject({ op: 'close', handle: (opened as { handle: number }).handle })
    client.dispose()
  }, 30_000)

  it('runs statistics behind tiles and keeps one lane free of them, so a mosaic\'s reads never hold back the map', async () => {
    const { instance, created } = pool(2, 4)
    const map = instance.acquire()
    const ranges = instance.acquire()
    const source = await map.openCog('asset://localhost/tile.tif')
    const [laneA, laneB] = created as [InProcessLane, InProcessLane]
    for (const lane of created) lane.hold(['statistics', 'render'])
    const all = (op: RasterWorkerRequest['op']) => created.flatMap((lane) => ofOp(lane, op))
    const reads = Array.from({ length: 30 }, (_, index) =>
      ranges.statistics(`asset://localhost/part-${index}.tif`).catch((error: unknown) => error))
    await vi.waitFor(() => expect(all('statistics')).toHaveLength(1))
    const reading = ofOp(laneA, 'statistics').length > 0 ? laneA : laneB
    const free = reading === laneA ? laneB : laneA
    // Tiles go to the lane no read blocks, even once it holds more tiles.
    const tiles = [source.renderTilePNG(Z, X, Y), source.renderTilePNG(Z, X + 1, Y)]
    await settle()
    expect(free.renders()).toHaveLength(2)
    expect(reading.renders()).toHaveLength(0)
    // An answered read frees the one statistics slot for the next one.
    reading.release(all('statistics')[0]!)
    await expect(reads[0]).resolves.toMatchObject({ pixels: fixture.width * fixture.height })
    await vi.waitFor(() => expect(all('statistics')).toHaveLength(2))
    expect(ofOp(free, 'statistics')).toHaveLength(0)
    for (const render of free.renders()) free.release(render)
    const [over, beside] = await Promise.all(tiles)
    expect(over!.byteLength).toBe(TILE_BYTES)
    expect(opaquePixels(over!)).toBeGreaterThan(0)
    expect(beside).toBeInstanceOf(Uint8Array)
    ranges.dispose()
    await expect(reads.at(-1)).resolves.toMatchObject({ name: 'AbortError' })
    map.dispose()
  }, 30_000)

  it('runs at most one statistics read per lane and one fewer than the lanes in all', async () => {
    const { instance, created } = pool(3, 4)
    const ranges = instance.acquire()
    for (const lane of created) lane.hold(['statistics'])
    const reads = Array.from({ length: 5 }, (_, index) =>
      ranges.statistics(`asset://localhost/part-${index}.tif`).catch((error: unknown) => error))
    await vi.waitFor(() => expect(created.flatMap((lane) => ofOp(lane, 'statistics'))).toHaveLength(2))
    await settle()
    expect(created.map((lane) => ofOp(lane, 'statistics').length).sort()).toEqual([0, 1, 1])
    ranges.dispose()
    await Promise.all(reads)
  }, 30_000)

  it('starts lanes with an even share of one aggregate decoded-block budget', () => {
    const { instance, created } = pool(2)
    const client = instance.acquire()
    expect(created).toHaveLength(2)
    expect(created.map((lane) => lane.requests[0])).toEqual([
      expect.objectContaining({ op: 'init', budgetBytes: 64 * 1024 * 1024 }),
      expect.objectContaining({ op: 'init', budgetBytes: 64 * 1024 * 1024 }),
    ])
    client.dispose()
  })

  it('dispatches the newest tile first and drops queued tiles that left the viewport', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const source = await client.openCog('asset://localhost/a.tif')
    const lane = created[0]!
    lane.hold(['render'])
    const first = source.renderTilePNG(Z, X, Y)
    await settle()
    // The lane is busy; the next two queue behind it.
    const stale = source.renderTilePNG(Z, X + 1, Y).catch((error: unknown) => error)
    const fresh = source.renderTilePNG(Z, X + 2, Y)
    client.setRelevance((tile) => tile.x !== X + 1)
    lane.release(lane.renders()[0]!)
    await first
    await settle()
    expect(lane.renders().map((request) => request.x)).toEqual([X, X + 2])
    expect(await stale).toMatchObject({ name: 'AbortError' })
    lane.release(lane.renders()[1]!)
    await expect(fresh).resolves.toBeInstanceOf(Uint8Array)
    client.dispose()
  }, 30_000)

  it('rejects a disposed client’s queued work, closes its sources and stops idle workers', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const other = instance.acquire()
    const source = await client.openCog('asset://localhost/a.tif')
    const lane = created[0]!
    lane.hold(['render'])
    const running = source.renderTilePNG(Z, X, Y)
    await settle()
    const queued = source.renderTilePNG(Z, X + 1, Y)
    client.dispose()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(ofOp(lane, 'close').length).toBeGreaterThan(0)
    expect(instance.laneCount).toBe(1)
    lane.release(lane.renders()[0]!)
    await running
    other.dispose()
    expect(instance.laneCount).toBe(0)
    expect(lane.terminated).toBe(true)
    await expect(client.openCog('asset://localhost/b.tif')).rejects.toMatchObject({ name: 'AbortError' })
  }, 30_000)

  it('canopi-ana9: release, reopen, then render fails on a closed handle as the real worker does', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const released = await client.openCog('asset://localhost/a.tif')
    await client.openCog('asset://localhost/b.tif')
    const lane = created[0]!
    const handleOf = (url: string) => (ofOp(lane, 'open').find((request) => (request as { url: string }).url === url) as { handle: number }).handle
    const releasedHandle = handleOf('asset://localhost/a.tif')
    const keptHandle = handleOf('asset://localhost/b.tif')

    client.releaseSources(['asset://localhost/a.tif'])
    const closed = ofOp(lane, 'close').map((request) => (request as { handle: number }).handle)
    expect(closed).toEqual([releasedHandle])
    expect(closed).not.toContain(keptHandle)
    await settle()

    // The URL opened again is a new source that draws.
    const reopened = await client.openCog('asset://localhost/a.tif')
    expect(opaquePixels(await reopened.renderTilePNG(Z, X, Y))).toBeGreaterThan(0)
    // The released proxy never reopens behind the engine's back,
    await expect(released.renderTilePNG(Z, X, Y)).rejects.toMatchObject({ name: 'AbortError', message: 'Raster source is released' })
    expect(ofOp(lane, 'open')).toHaveLength(3)
    // and a render that reached the lane on the closed handle fails there.
    lane.postMessage({ op: 'render', id: -1, handle: releasedHandle, z: Z, x: X, y: Y, render: {}, encoding: 'png' })
    await vi.waitFor(() => expect(lane.replies.find((reply) => reply.id === -1)).toEqual({
      id: -1,
      ok: false,
      error: `raster source ${releasedHandle} is not open in this lane`,
    }))
    client.dispose()
  }, 30_000)

  it('fails a crashed lane’s pending work instead of leaving it waiting', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const source = await client.openCog('asset://localhost/a.tif')
    created[0]!.hold(['render'])
    const pending = source.renderTilePNG(Z, X, Y)
    await settle()
    created[0]!.onerror?.({ message: 'wasm trap' } as ErrorEvent)
    await expect(pending).rejects.toThrow('wasm trap')
    client.dispose()
  }, 30_000)

  it('replaces a crashed lane so later tiles render instead of failing forever', async () => {
    const { instance, created } = pool(1, 1)
    const client = instance.acquire()
    const source = await client.openCog('asset://localhost/a.tif')
    created[0]!.hold(['render'])
    const pending = source.renderTilePNG(Z, X, Y).catch((error: unknown) => error)
    await settle()
    created[0]!.onerror?.({ message: 'wasm trap' } as ErrorEvent)
    await pending
    expect(created[0]!.terminated).toBe(true)
    expect(created).toHaveLength(2)
    expect(instance.laneCount).toBe(1)

    // The source is reopened from its URL in the new lane and its next tile draws there.
    const next = await source.renderTilePNG(Z, X, Y)
    const lane = created[1]!
    expect(ofOp(lane, 'open')).toEqual([expect.objectContaining({ url: 'asset://localhost/a.tif' })])
    expect(opaquePixels(next)).toBeGreaterThan(0)
    client.dispose()
    expect(lane.terminated).toBe(true)
  }, 30_000)
})
