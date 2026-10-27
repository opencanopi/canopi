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
    let stopped = 0
    class Hold implements fc.AsyncCommand<object, { reply: Promise<void>; stop(): void }> {
      check = () => true
      run = (_model: object, real: { reply: Promise<void> }) => real.reply
      toString = () => 'hold'
    }
    const started = performance.now()
    const message = await failure(counterRun(recorder(), null, {
      commands: [fc.constant(new Hold() as unknown as fc.AsyncCommand<Counter, Counter>)],
      maxCommands: 3,
      numRuns: 3,
      timeoutMs: 50,
      setup: () => {
        let stop = () => {}
        const reply = new Promise<void>((_, reject) => { stop = () => reject(new Error('stopped')) })
        reply.catch(() => {})
        return { model: { count: 0 }, real: { count: 0, reply, stop } as unknown as Counter }
      },
      teardown: (_model, real) => {
        stopped += 1
        ;(real as unknown as { stop(): void }).stop()
      },
    }))
    expect(message).toContain('model run exceeded its per-run timeout of 50 ms')
    expect(stopped).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(4_000)
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
