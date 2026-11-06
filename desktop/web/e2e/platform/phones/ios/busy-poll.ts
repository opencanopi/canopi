// The iOS smoke's polls after the New Design tap (canopi-f47t.52.261). On hosted runners the page is busy opening the
// Design right after the tap: in run 42132960384 (iPhone 17 Pro, iOS 26.5) the first poll's script was answered 43 s
// later, with the click recorded, but the driver had given up on it after webviewAtomWaitTimeout (wdio.ios.conf.ts) with
// its busy-debugger error. A busy debugger is therefore asked again until the poll's deadline, as the start-screen wait
// does (start-screen-wait.ts). Framework-free, so it is unit tested (src/__tests__/ios-busy-poll.test.ts).
import { isBusyDebugger } from './start-screen-wait'

/** How a poll ended: its condition held, the page kept answering without it, or Safari stayed busy to the deadline. */
export type PollOutcome<T> =
  | { readonly kind: 'done', readonly value: T }
  | { readonly kind: 'answered', readonly value: T }
  | { readonly kind: 'busy', readonly error: Error }

export interface PollTiming {
  /** ms from the first ask after which no new ask starts. */
  readonly deadline: number
  /** ms between an answer that does not hold and the next ask. */
  readonly interval: number
  readonly clock?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Asks `ask` until `holds` its answer or `deadline` ms pass. A busy-debugger error is asked again; any other error (a
 * session that died) is rethrown unchanged. At the deadline the last ask decides: answered, or busy with its error.
 */
export async function pollThroughBusy<T>(ask: () => Promise<T>, holds: (answer: T) => boolean, timing: PollTiming): Promise<PollOutcome<T>> {
  const { deadline, interval, clock = () => performance.now(), sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = timing
  const start = clock()
  for (;;) {
    let last: PollOutcome<T>
    try {
      const value = await ask()
      if (holds(value)) return { kind: 'done', value }
      last = { kind: 'answered', value }
    } catch (error) {
      if (!(error instanceof Error) || !isBusyDebugger(error)) throw error
      last = { kind: 'busy', error }
    }
    if (clock() - start >= deadline) return last
    if (last.kind === 'answered') await sleep(interval)
  }
}
