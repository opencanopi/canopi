/**
 * Model-based tests (ADR 0028 Model-based tests): one helper, `runModel`, runs
 * random command sequences (`fc.commands`) against a real system and a model of
 * it, with a seeded `fc.scheduler` the real system orders its async replies by.
 *
 * - Seeds: the run takes fast-check's global seed (`src/__tests__/support/fast-check-setup.ts`, pinned,
 *   or `CANOPI_FC_SEED`), so the same seed gives the same commands, the same
 *   scheduling and the same result.
 * - Regressions: the cases `fc-regressions.json` lists for the suite replay
 *   first, before the random runs; a failure prints the entry to add there.
 * - Per-run timeout: a run that does not settle in `timeoutMs` (a held reply
 *   that never comes) fails at the limit, with that timeout as its cause;
 *   `teardown` runs first so it can stop the real system, and the abandoned
 *   run's later commands are refused. This limit replaces fast-check's own
 *   `timeout` for the run, which would fire first and leave the run going.
 * - Budget: the whole check stops at `budgetMs`, which the test's own timeout
 *   must exceed. A failure found by then prints its entry with the shrinking
 *   done so far (a hang costs `timeoutMs` at every shrink step); a check with
 *   no failure by then fails.
 */
import fc from 'fast-check'
import regressionCases from './fc-regressions.json'

/** One `fc-regressions.json` entry: a failing case replayed before the random runs. */
export interface ModelRegression {
  readonly suite: string
  readonly seed: number
  readonly path: string
  /** The tracker item the failure was filed under, while it is open. */
  readonly bead?: string
}

export interface ModelRun<Model extends object, Real, Config> {
  /** The key of this suite's entries in `fc-regressions.json`. */
  readonly suite: string
  /** Generated parameters of the real system (lanes, bounds), shrunk with the commands. */
  readonly config: fc.Arbitrary<Config>
  readonly commands: readonly fc.Arbitrary<fc.AsyncCommand<Model, Real>>[]
  /** A fresh model and real system for one run; the scheduler orders the real system's replies. */
  setup(scheduler: fc.Scheduler, config: Config): { model: Model; real: Real } | Promise<{ model: Model; real: Real }>
  /** Stops the real system and checks what must hold once it stopped; runs after every run, timed out or not. */
  teardown(model: Model, real: Real): void | Promise<void>
  /** The per-run limit; fast-check's global `timeout` (`src/__tests__/support/fast-check-setup.ts`) when omitted. */
  readonly timeoutMs?: number
  /** The whole check's limit, below the test's own timeout, so a failure prints its entry before the test is killed. */
  readonly budgetMs: number
  readonly maxCommands?: number
  /** Overrides of the global configuration, for this helper's own tests. */
  readonly seed?: number
  readonly numRuns?: number
  readonly regressions?: readonly ModelRegression[]
}

/** The marker before the `fc-regressions.json` entry a failure prints. */
export const REGRESSION_ENTRY_MARKER = 'fc-regressions.json entry: '

export class ModelRunTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`model run exceeded its per-run timeout of ${timeoutMs} ms`)
    this.name = 'ModelRunTimeout'
  }
}

/** Replays the suite's regressions, then runs the property; throws the first failure. */
export async function runModel<Model extends object, Real, Config>(run: ModelRun<Model, Real, Config>): Promise<void> {
  const property = modelProperty(run)
  // modelProperty's own timer is the per-run limit; the budget interrupts shrinking and counts as a failure.
  const limits = { timeout: undefined, interruptAfterTimeLimit: run.budgetMs, markInterruptAsFailure: true }
  const regressions = (run.regressions ?? (regressionCases as ModelRegression[])).filter((entry) => entry.suite === run.suite)
  for (const regression of regressions) {
    report(run, await fc.check(property, { ...limits, seed: regression.seed, path: regression.path, numRuns: 1, endOnFailure: true }))
  }
  report(run, await fc.check(property, {
    ...limits,
    ...(run.seed === undefined ? {} : { seed: run.seed }),
    ...(run.numRuns === undefined ? {} : { numRuns: run.numRuns }),
  }))
}

function modelProperty<Model extends object, Real, Config>(run: ModelRun<Model, Real, Config>) {
  const commands = fc.commands([...run.commands], { maxCommands: run.maxCommands ?? 20, size: 'max' })
  const timeoutMs = run.timeoutMs ?? fc.readConfigureGlobal().timeout
  if (timeoutMs === undefined) throw new Error(`${run.suite}: a model run needs a per-run timeout`)
  return fc.asyncProperty(fc.scheduler(), run.config, commands, async (scheduler, config, sequence) => {
    const { model, real } = await run.setup(scheduler, config)
    let aborted = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ModelRunTimeout(timeoutMs)), timeoutMs)
    })
    function* guarded(): Iterable<fc.AsyncCommand<Model, Real>> {
      for (const command of sequence) {
        yield {
          check: (state) => command.check(state),
          run: async (state, system) => {
            if (aborted) throw new Error('model run aborted after its per-run timeout')
            await command.run(state, system)
          },
          toString: () => command.toString(),
        }
      }
    }
    const outcome = Promise.race([fc.asyncModelRun(() => ({ model, real }), guarded()), timedOut])
    try {
      await outcome
    } finally {
      aborted = true
      clearTimeout(timer)
      try {
        await run.teardown(model, real)
      } catch (error) {
        // The run's own failure is the cause; teardown failing after it (a lane still busy after a timeout) is its effect.
        if (await outcome.then(() => true, () => false)) throw error
      }
    }
  })
}

function report<Ts>({ suite, budgetMs }: { suite: string; budgetMs: number }, details: fc.RunDetails<Ts>): void {
  if (!details.failed) return
  if (details.counterexample === null) throw new Error(`${suite}: ran out of its ${budgetMs} ms budget after ${details.numRuns} runs, with no failure found`)
  // The failing run's own case, before shrinking: generated from the seed alone, it replays the same commands
  // after the fix too (a shrink path depends on which commands ran, so it stops replaying once the bug is gone).
  const entry = { suite, seed: details.seed, path: (details.counterexamplePath ?? '0').split(':')[0]! }
  const cause = details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance)
  throw new Error(
    `${suite}: model run failed after ${details.numRuns} runs\n` +
    `counterexample (shrunk, path ${details.counterexamplePath}): ${fc.stringify(details.counterexample)}\n` +
    `cause: ${cause}\n` +
    `${REGRESSION_ENTRY_MARKER}${JSON.stringify(entry)}`,
  )
}
