import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import regressionFile from './fc-regressions.json'
import { REGRESSION_ENTRY_MARKER, runModel, type ModelRegression, type ModelRun } from './model-based'

/** A counter whose real side breaks at `breaksAt`; every run's commands are logged. */
interface Counter {
  count: number
}

interface Recorder {
  readonly runs: string[][]
  /** The commands of the first run that failed, before shrinking. */
  firstFailing: string[] | null
}

function counterRun(recorder: Recorder, breaksAt: number | null, overrides: Partial<ModelRun<Counter, Counter, null>> = {}): ModelRun<Counter, Counter, null> {
  class Step implements fc.AsyncCommand<Counter, Counter> {
    constructor(readonly by: 1 | -1) {}
    check = () => true
    async run(model: Counter, real: Counter) {
      recorder.runs.at(-1)!.push(this.toString())
      model.count += this.by
      real.count += this.by
      if (real.count === breaksAt) {
        recorder.firstFailing ??= [...recorder.runs.at(-1)!]
        throw new Error(`the counter broke at ${breaksAt}`)
      }
      expect(real.count).toBe(model.count)
    }
    toString = () => (this.by === 1 ? 'inc' : 'dec')
  }
  return {
    suite: 'counter',
    config: fc.constant(null),
    commands: [fc.constant(new Step(1)), fc.constant(new Step(-1))],
    setup: () => {
      recorder.runs.push([])
      return { model: { count: 0 }, real: { count: 0 } }
    },
    teardown: () => {},
    timeoutMs: 1_000,
    budgetMs: 10_000,
    regressions: [],
    numRuns: 30,
    ...overrides,
  }
}

const recorder = (): Recorder => ({ runs: [], firstFailing: null })

async function failure(run: ModelRun<Counter, Counter, null>): Promise<string> {
  try {
    await runModel(run)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the model run passed')
}

function printedEntry(message: string): unknown {
  const line = message.split('\n').find((text) => text.startsWith(REGRESSION_ENTRY_MARKER))
  expect(line, message).toBeDefined()
  return JSON.parse(line!.slice(REGRESSION_ENTRY_MARKER.length))
}

/** The real side a holding run sets up: a counter whose reply never comes until teardown stops it. */
interface HoldingCounter extends Counter {
  readonly config: number | null
  held: boolean
  readonly reply: Promise<void>
  readonly stop: () => void
}

/** A holding run's real side, as the runner hands it back typed as the plain counter. */
function holdingReal(real: Counter): HoldingCounter {
  return real as HoldingCounter
}

/** A command whose reply never comes, and a real side teardown stops; `holdsWhen` picks the configs that hold. */
function holdingRun(stopped: { count: number }, holdsWhen: (config: number) => boolean = () => true): Partial<ModelRun<Counter, Counter, null>> {
  class Hold implements fc.AsyncCommand<object, { config: number; held: boolean; reply: Promise<void>; stop(): void }> {
    check = () => true
    run = async (_model: object, real: { config: number; held: boolean; reply: Promise<void> }) => {
      if (!holdsWhen(real.config)) return
      real.held = true
      await real.reply
    }
    toString = () => 'hold'
  }
  return {
    commands: [fc.constant(new Hold() as unknown as fc.AsyncCommand<Counter, Counter>)],
    maxCommands: 3,
    numRuns: 3,
    timeoutMs: 50,
    setup: (_scheduler, config) => {
      let stop = () => {}
      const reply = new Promise<void>((_, reject) => { stop = () => reject(new Error('stopped')) })
      reply.catch(() => {})
      const real: HoldingCounter = { count: 0, config, held: false, reply, stop }
      return { model: { count: 0 }, real }
    },
    teardown: (_model, real) => {
      stopped.count += 1
      holdingReal(real).stop()
    },
  }
}

describe('runModel', () => {
  it('gives the same command sequence and the same result for the same seed', async () => {
    const first = recorder()
    const second = recorder()
    const firstMessage = await failure(counterRun(first, 3, { seed: 42 }))
    const secondMessage = await failure(counterRun(second, 3, { seed: 42 }))
    expect(second.runs).toEqual(first.runs)
    expect(secondMessage).toBe(firstMessage)
    const passing = [recorder(), recorder()]
    for (const log of passing) await runModel(counterRun(log, null, { seed: 7 }))
    expect(passing[1]!.runs).toEqual(passing[0]!.runs)
    expect(passing[0]!.runs.flat()).toContain('dec')
  })

  it('fails a run whose real system holds a reply forever at the per-run timeout, after stopping it', async () => {
    const stopped = { count: 0 }
    const started = performance.now()
    const message = await failure(counterRun(recorder(), null, holdingRun(stopped)))
    expect(message).toContain('model run exceeded its per-run timeout of 50 ms')
    expect(stopped.count).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(4_000)
  })

  it('times a run out at its own limit, not fast-check\'s, when the limit is fast-check\'s global timeout', async () => {
    const global = fc.readConfigureGlobal()
    fc.configureGlobal({ ...global, timeout: 80 })
    try {
      const message = await failure(counterRun(recorder(), null, { ...holdingRun({ count: 0 }), timeoutMs: undefined }))
      expect(message).toContain('model run exceeded its per-run timeout of 80 ms')
      expect(message).not.toContain('Property timeout')
    } finally {
      fc.configureGlobal(global)
    }
  })

  it('reports the timeout as the cause when teardown also fails after it', async () => {
    const message = await failure(counterRun(recorder(), null, {
      ...holdingRun({ count: 0 }),
      // A system stopped mid-reply fails its own checks too; the timeout before it stays the cause.
      teardown: (_model, real) => {
        if (holdingReal(real).held) throw new Error('a lane was still busy')
      },
    }))
    expect(message).toContain('cause: model run exceeded its per-run timeout of 50 ms')
  })

  it('prints the entry of a hang that holds at every shrink step once its budget runs out', async () => {
    const started = performance.now()
    // Odd configs hold and 0 does not, so shrinking a large odd config times out at each of about 30 steps.
    const message = await failure({
      ...counterRun(recorder(), null, holdingRun({ count: 0 }, (config) => config % 2 === 1)),
      config: fc.integer({ min: 0, max: 2 ** 30 }),
      seed: 1,
      numRuns: 10,
      timeoutMs: 100,
      budgetMs: 400,
    } as unknown as ModelRun<Counter, Counter, null>)
    expect(printedEntry(message)).toEqual({ suite: 'counter', seed: 1, path: expect.stringMatching(/^\d+$/) })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('stops a run that hangs once less than its timeout of the budget is left, and prints its entry, before the check returns', async () => {
    const stopped = { count: 0 }
    const holding = holdingRun(stopped)
    let runs = 0
    const message = await failure(counterRun(recorder(), null, {
      ...holding,
      // The first run is slow but passes, leaving 100 ms of the budget, half the per-run timeout; the second holds.
      setup: async (scheduler, config) => {
        runs += 1
        if (runs === 1) await new Promise((resolve) => setTimeout(resolve, 300))
        return holding.setup!(scheduler, config)
      },
      commands: [fc.constant(new (class implements fc.AsyncCommand<Counter, Counter> {
        check = () => true
        run = async (_model: Counter, real: Counter) => {
          if (runs > 1) await holdingReal(real).reply
        }
        toString = () => 'hold after the first run'
      })())],
      seed: 1,
      timeoutMs: 200,
      budgetMs: 400,
    }))
    expect(message).toMatch(/^counter: ran out of its 400 ms budget after \d+ runs, with no failure found/)
    expect(message).toContain('cut at the budget')
    expect(printedEntry(message)).toEqual({ suite: 'counter', seed: 1, path: expect.stringMatching(/^\d+$/) })
    // Every run was torn down before the check returned: none is left to stop the system after the test.
    const stoppedAtReturn = stopped.count
    expect(stoppedAtReturn).toBe(runs)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stopped.count).toBe(stoppedAtReturn)
  })

  it('fails a check that runs out of its budget before any failure', async () => {
    class Slow implements fc.AsyncCommand<Counter, Counter> {
      check = () => true
      run = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
      toString = () => 'slow'
    }
    const message = await failure(counterRun(recorder(), null, {
      commands: [fc.constant(new Slow())],
      numRuns: 10_000,
      budgetMs: 200,
    }))
    expect(message).toMatch(/^counter: ran out of its 200 ms budget after \d+ runs, with no failure found/)
  })

  it('replays a case fc-regressions.json lists for the suite before the random runs', async () => {
    const broken = recorder()
    const entry = printedEntry(await failure(counterRun(broken, 2, { seed: 11 }))) as ModelRegression
    expect(broken.firstFailing).not.toBeNull()
    const replay = recorder()
    await runModel(counterRun(replay, null, { seed: 99, regressions: [{ ...entry, suite: 'other' }, entry] }))
    // The same generated commands: the broken run stopped at the failure, the fixed one runs them all.
    expect(replay.runs[0]!.slice(0, broken.firstFailing!.length)).toEqual(broken.firstFailing)
    // Then the random runs, exactly as the seed gives them without a regression.
    const random = recorder()
    await runModel(counterRun(random, null, { seed: 99 }))
    expect(replay.runs.slice(1)).toEqual(random.runs)
  })

  it('prints a failure\'s seed and path in exactly the form fc-regressions.json takes', async () => {
    const entry = printedEntry(await failure(counterRun(recorder(), 2, { seed: 5 })))
    expect(entry).toEqual({ suite: 'counter', seed: 5, path: expect.stringMatching(/^\d+$/) })
    // The committed file holds entries of that form only.
    for (const listed of regressionFile as unknown[]) {
      expect(Object.keys(listed as object).filter((key) => !['suite', 'seed', 'path', 'bead'].includes(key))).toEqual([])
    }
  })
})
