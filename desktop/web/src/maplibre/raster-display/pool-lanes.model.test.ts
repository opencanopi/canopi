/**
 * The raster pool's scheduling contract (pool.ts header), checked model-based:
 * random sequences of acquire, dispose, tile, relevance, statistics and reply
 * commands run against the real `RasterWorkerPool` over the real lane handler
 * (`__tests__/support/raster-lane.ts`), and after each one the lanes' recorded
 * requests and replies and the pool's public API must agree with the contract.
 *
 * Render and statistics replies are held; the seeded `fc.scheduler` picks the
 * one each reply command releases, so a seed replays the same interleaving.
 * Nothing here is a fake: the only stand-ins are raster-lane.ts's own (fetch by
 * byte range, the canvas encoder).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { geoToMercator } from '../../canvas/projection'
import { RasterWorkerPool, type RasterPoolClient, type RasterProxySource } from './pool'
import type { RasterWorkerRequest } from './protocol'
import { inProcessLane, serveRasterFixtures, type InProcessLane } from '../../__tests__/support/raster-lane'
import { runModel } from '../../__tests__/support/model-based'

const fixtures = new URL('./fixtures/', import.meta.url)
const tif = new Uint8Array(readFileSync(fileURLToPath(new URL('rust-display-cog.tif', fixtures))))
const [west, south, east, north] = (JSON.parse(readFileSync(fileURLToPath(new URL('rust-display-cog.json', fixtures)), 'utf8')) as {
  bounds: [number, number, number, number]
}).bounds

/** Tiles at zoom 20 from the fixture's centre eastwards: tile `seq` is at column X + seq, so a render names its tile. */
const Z = 20
const centre = geoToMercator((west + east) / 2, (south + north) / 2)
const X = Math.floor(centre.x * 2 ** Z)
const Y = Math.floor(centre.y * 2 ** Z)
const BUDGET = 128 * 1024 * 1024
const HELD: readonly RasterWorkerRequest['op'][] = ['render', 'statistics']
const MAX_CLIENTS = 3

interface PoolConfig {
  readonly lanes: number
  readonly maxInFlightPerLane: number
}

type Outcome = 'pending' | 'resolved' | 'rejected'

interface ClientRecord {
  readonly id: number
  readonly client: RasterPoolClient
  source: RasterProxySource | null
  disposed: boolean
  readonly irrelevant: Set<number>
}

interface WorkRecord {
  readonly client: number
  outcome: Outcome
  error: string
}

interface TileRecord extends WorkRecord {
  readonly seq: number
  irrelevant: boolean
  posted: boolean
}

interface Model {
  readonly clients: ClientRecord[]
  readonly tiles: TileRecord[]
  readonly stats: WorkRecord[]
  /** Every promise the pool handed out, so teardown can see each one settle. */
  readonly work: WorkRecord[]
}

interface Real {
  readonly config: PoolConfig
  readonly pool: RasterWorkerPool
  readonly lanes: InProcessLane[]
  readonly scheduler: fc.Scheduler
  /** Held requests a reply command released, by request id. */
  readonly released: Set<number>
  /** Requests already checked, per lane. */
  readonly seen: Map<InProcessLane, number>
  stopped: boolean
}

const live = (m: Model) => m.clients.filter((client) => !client.disposed)
const pick = <T>(items: readonly T[], index: number): T => items[index % items.length]!
const urlOf = (client: number, name: string) => `asset://localhost/c${client}-${name}.tif`
const clientOfUrl = (url: string) => Number(/\/c(\d+)-/.exec(url)?.[1])
const ofOp = <Op extends RasterWorkerRequest['op']>(requests: readonly RasterWorkerRequest[], op: Op) =>
  requests.filter((request): request is Extract<RasterWorkerRequest, { op: Op }> => request.op === op)
const answered = (lane: InProcessLane) => new Set(lane.replies.map((reply) => reply.id))
const outstanding = (lane: InProcessLane, ops: readonly RasterWorkerRequest['op'][]) => {
  const replied = answered(lane)
  return lane.requests.filter((request) => ops.includes(request.op) && !replied.has(request.id))
}

function track<T extends WorkRecord>(m: Model, record: T, promise: Promise<unknown>): T {
  m.work.push(record)
  promise.then(() => { record.outcome = 'resolved' }, (error: unknown) => {
    record.outcome = 'rejected'
    record.error = error instanceof Error ? error.name : String(error)
  })
  return record
}

/** Tiles still waiting in the pool's queue: never rendered, not refused, of a live client. */
function waitingTiles(m: Model): TileRecord[] {
  return m.tiles.filter((tile) => !tile.posted && !tile.irrelevant && tile.outcome === 'pending' && !m.clients[tile.client]!.disposed)
}

/**
 * Waits until the lanes are quiet: every request answered except held replies
 * no command released, for two turns in a row. Lane work is real (wasm, byte
 * ranges), so this polls rather than counting microtasks.
 */
async function quiesce(r: Real): Promise<void> {
  let stable = 0
  let last = -1
  for (let turn = 0; stable < 2; turn += 1) {
    if (r.stopped) throw new Error('the run was stopped')
    if (turn > 5_000) throw new Error('the lanes never went quiet')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const busy = r.lanes.filter((lane) => !lane.terminated).some((lane) => {
      const replied = answered(lane)
      return lane.requests.some((request) => !replied.has(request.id) && (!HELD.includes(request.op) || r.released.has(request.id)))
    })
    const total = r.lanes.reduce((sum, lane) => sum + lane.requests.length, 0)
    stable = !busy && total === last ? stable + 1 : 0
    last = total
  }
}

/** Runs one command's action, waits for quiet, then checks the contract over what it posted. */
async function step(m: Model, r: Real, action: () => void): Promise<void> {
  const liveBefore = live(m).length
  const lanesBefore = r.lanes.length
  action()
  await quiesce(r)
  const posted = r.lanes.flatMap((lane) => {
    const fresh = lane.requests.slice(r.seen.get(lane) ?? 0)
    r.seen.set(lane, lane.requests.length)
    return fresh.map((request) => ({ lane, request }))
  }).sort((a, b) => a.request.id - b.request.id)

  // Every held reply joins the scheduler; a reply command releases the one it picks.
  for (const { lane, request } of posted) {
    if (!HELD.includes(request.op)) continue
    void r.scheduler.schedule(Promise.resolve(), `${request.op} ${request.id}`).then(() => {
      if (lane.terminated) return
      r.released.add(request.id)
      lane.release(request)
    })
  }

  // Lanes start on the first acquire and end on the last dispose, leaving 0.
  const liveAfter = live(m).length
  if (liveBefore === 0 && liveAfter > 0) expect(r.lanes.length - lanesBefore).toBe(r.config.lanes)
  else expect(r.lanes.length).toBe(lanesBefore)
  expect(r.pool.laneCount).toBe(liveAfter > 0 ? r.config.lanes : 0)
  if (liveAfter === 0) expect(r.lanes.every((lane) => lane.terminated)).toBe(true)

  // Newest tile first, never one reported irrelevant while it waited.
  for (const { request } of posted) {
    if (request.op !== 'render') continue
    const newest = Math.max(...waitingTiles(m).map((tile) => tile.seq))
    expect(request.x - X, 'the newest waiting tile starts first').toBe(newest)
    m.tiles[newest]!.posted = true
  }

  const running = r.lanes.filter((lane) => !lane.terminated)
  for (const lane of running) {
    expect(outstanding(lane, HELD).length, 'in flight per lane').toBeLessThanOrEqual(r.config.maxInFlightPerLane)
    expect(outstanding(lane, ['statistics']).length, 'statistics per lane').toBeLessThanOrEqual(1)
  }
  const reading = running.filter((lane) => outstanding(lane, ['statistics']).length > 0)
  expect(reading.length, 'statistics in all').toBeLessThanOrEqual(Math.max(1, r.config.lanes - 1))

  // Statistics start only when no tile waits.
  if (posted.some(({ request }) => request.op === 'statistics')) expect(waitingTiles(m)).toEqual([])
  // A tile goes to a lane reading statistics only when every lane reading none is full.
  for (const lane of reading) {
    if (!posted.some((entry) => entry.lane === lane && entry.request.op === 'render')) continue
    for (const other of running.filter((candidate) => !reading.includes(candidate))) {
      expect(outstanding(other, HELD).length, 'a lane reading no statistics was free').toBe(r.config.maxInFlightPerLane)
    }
  }
  // Any dispatch drops the waiting tiles reported irrelevant first.
  if (posted.some(({ request }) => HELD.includes(request.op))) {
    const refused = m.tiles.filter((tile) => tile.irrelevant && !tile.posted && !m.clients[tile.client]!.disposed)
    expect(refused.map((tile) => tile.error)).toEqual(refused.map(() => 'AbortError'))
  }
}

class Acquire implements fc.AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => live(m).length < MAX_CLIENTS
  async run(m: Model, r: Real) {
    const id = m.clients.length
    await step(m, r, () => {
      const record: ClientRecord = { id, client: r.pool.acquire(), source: null, disposed: false, irrelevant: new Set() }
      m.clients.push(record)
      const opening = record.client.openCog(urlOf(id, 'tiles'))
      track(m, { client: id, outcome: 'pending', error: '' }, opening)
      opening.then((source) => { record.source = source }, () => {})
    })
  }
  toString = () => 'acquire'
}

class Dispose implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => live(m).length > 0
  async run(m: Model, r: Real) {
    const record = pick(live(m), this.index)
    const queued = [...waitingTiles(m), ...m.tiles.filter((tile) => tile.irrelevant && !tile.posted)].filter((tile) => tile.client === record.id)
    const startedStats = new Set(r.lanes.flatMap((lane) => ofOp(lane.requests, 'open')).map((open) => open.url))
    const queuedStats = m.stats.filter((stat, index) => stat.client === record.id && !startedStats.has(urlOf(record.id, `s${index}`)))
    await step(m, r, () => {
      record.disposed = true
      record.client.dispose()
    })
    // Its queued work is rejected, and every source it opened is closed in every lane.
    expect([...queued, ...queuedStats].map((work) => work.error)).toEqual([...queued, ...queuedStats].map(() => 'AbortError'))
    for (const lane of r.lanes) {
      for (const open of ofOp(lane.requests, 'open').filter((request) => clientOfUrl(request.url) === record.id)) {
        const closed = lane.requests.some((request) => request.op === 'close' && request.handle === open.handle && request.id > open.id)
        expect(closed, `${open.url} closed in its lane`).toBe(true)
      }
    }
  }
  toString = () => `dispose(${this.index})`
}

class RequestTile implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => live(m).some((client) => client.source)
  async run(m: Model, r: Real) {
    const record = pick(live(m).filter((client) => client.source), this.index)
    const seq = m.tiles.length
    await step(m, r, () => {
      const tile: TileRecord = { client: record.id, seq, outcome: 'pending', error: '', irrelevant: false, posted: false }
      m.tiles.push(track(m, tile, record.source!.renderTilePNG(Z, X + seq, Y)))
    })
  }
  toString = () => `tile(${this.index})`
}

class MarkIrrelevant implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => waitingTiles(m).length > 0
  async run(m: Model, r: Real) {
    const tile = pick(waitingTiles(m), this.index)
    const record = m.clients[tile.client]!
    await step(m, r, () => {
      tile.irrelevant = true
      record.irrelevant.add(X + tile.seq)
      const irrelevant = new Set(record.irrelevant)
      record.client.setRelevance((request) => !irrelevant.has(request.x))
    })
  }
  toString = () => `irrelevant(${this.index})`
}

class RequestStatistics implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => live(m).length > 0
  async run(m: Model, r: Real) {
    const record = pick(live(m), this.index)
    const index = m.stats.length
    await step(m, r, () => {
      m.stats.push(track(m, { client: record.id, outcome: 'pending', error: '' }, record.client.statistics(urlOf(record.id, `s${index}`))))
    })
  }
  toString = () => `statistics(${this.index})`
}

class ReleaseReply implements fc.AsyncCommand<Model, Real> {
  check = () => true
  async run(m: Model, r: Real) {
    if (r.scheduler.count() === 0) return
    await step(m, r, () => { void r.scheduler.waitOne() })
  }
  toString = () => 'reply'
}

function setup(scheduler: fc.Scheduler, config: PoolConfig): { model: Model; real: Real } {
  const lanes: InProcessLane[] = []
  const pool = new RasterWorkerPool({
    ...config,
    budgetBytes: BUDGET,
    createWorker: () => {
      const lane = inProcessLane()
      lane.hold(HELD)
      lanes.push(lane)
      return lane
    },
  })
  return {
    model: { clients: [], tiles: [], stats: [], work: [] },
    real: { config, pool, lanes, scheduler, released: new Set(), seen: new Map(), stopped: false },
  }
}

/** Disposing every client stops the lanes, and no promise the pool handed out is left pending. */
async function teardown(m: Model, r: Real): Promise<void> {
  r.stopped = true
  for (const record of live(m)) {
    record.disposed = true
    record.client.dispose()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(r.pool.laneCount).toBe(0)
  expect(r.lanes.every((lane) => lane.terminated)).toBe(true)
  expect(m.work.filter((work) => work.outcome === 'pending')).toEqual([])
}

beforeEach(() => {
  serveRasterFixtures((url) => (url.startsWith('asset://localhost/') ? tif : undefined))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps the raster pool\'s scheduling contract over random clients, tiles, statistics and reply orders', async () => {
  await runModel<Model, Real, PoolConfig>({
    suite: 'pool-lanes',
    config: fc.record({ lanes: fc.integer({ min: 1, max: 3 }), maxInFlightPerLane: fc.integer({ min: 1, max: 3 }) }),
    // Tiles and replies listed twice: queues form, and a freed slot then picks among waiting tiles.
    commands: [
      fc.constant(new Acquire()),
      fc.nat().map((index) => new Dispose(index)),
      fc.nat().map((index) => new RequestTile(index)),
      fc.nat().map((index) => new RequestTile(index)),
      fc.nat().map((index) => new MarkIrrelevant(index)),
      fc.nat().map((index) => new RequestStatistics(index)),
      fc.constant(new ReleaseReply()),
      fc.constant(new ReleaseReply()),
    ],
    maxCommands: 40,
    // Below the test's timeout: a hang costs the per-run limit at every shrink step, and its entry must print first.
    budgetMs: 100_000,
    setup,
    teardown,
  })
}, 120_000)
