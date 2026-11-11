// The iOS smoke's polls after the New Design tap ask a busy Safari debugger again (canopi-f47t.52.261). Run
// 41976448160 and run 42132960384 (iPhone 17 Pro, iOS 26.5): the tap landed and the page, busy opening the Design,
// answered the first poll 43 s later with the click recorded, but the driver had given up on it after 30 s
// (webviewAtomWaitTimeout) with its busy-debugger error, and the smoke failed as "no click reached New Design".
import { describe, expect, it } from 'vitest'
import { pollThroughBusy } from './busy-poll'

const BUSY = 'The remote Safari debugger did not respond to the requested command after 36710.286375ms. It appears that JavaScript execution is blocked, which could be caused by either a modal dialog obstructing the current page, or a JavaScript routine monopolizing the event loop. when running "execute/sync" with method "POST"'

/** A clock the polls and sleeps advance, and a poll answering each call from `outcomes` after `cost` ms. */
function harness<T>(outcomes: (T | Error)[], cost: number) {
  let now = 0
  let asked = 0
  return {
    ask: () => {
      asked += 1
      now += cost
      const outcome = outcomes.shift()
      if (outcome === undefined) throw new Error('asked once too often')
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    },
    clock: () => now,
    sleep: (ms: number) => { now += ms; return Promise.resolve() },
    asked: () => asked,
  }
}

describe('the iOS smoke\'s polls after the tap (canopi-f47t.52.261)', () => {
  it('canopi-f47t.52.261: a debugger busy opening the Design is asked again until the click it recorded answers', async () => {
    const page = harness([new Error(BUSY), true], 30_000)
    await expect(pollThroughBusy(page.ask, Boolean, { deadline: 90_000, interval: 250, clock: page.clock, sleep: page.sleep }))
      .resolves.toEqual({ kind: 'done', value: true })
    expect(page.asked()).toBe(2)
  })

  it('a page that answers without the click until the deadline ends answered, with its last answer', async () => {
    const page = harness([false, false, false, false], 30_000)
    await expect(pollThroughBusy(page.ask, Boolean, { deadline: 90_000, interval: 1_000, clock: page.clock, sleep: page.sleep }))
      .resolves.toEqual({ kind: 'answered', value: false })
  })

  it('a debugger busy until the deadline ends busy, with the driver\'s error, never as an answer', async () => {
    const page = harness([new Error(BUSY), new Error(BUSY), new Error(BUSY), new Error(BUSY)], 30_000)
    const outcome = await pollThroughBusy(page.ask, Boolean, { deadline: 90_000, interval: 250, clock: page.clock, sleep: page.sleep })
    expect(outcome.kind).toBe('busy')
    expect(outcome.kind === 'busy' && outcome.error.message).toBe(BUSY)
  })

  it('any other error, such as a session that died, is rethrown unchanged at once', async () => {
    const page = harness([new Error('invalid session id')], 1_000)
    await expect(pollThroughBusy(page.ask, Boolean, { deadline: 90_000, interval: 250, clock: page.clock, sleep: page.sleep }))
      .rejects.toThrow(/^invalid session id$/)
    expect(page.asked()).toBe(1)
  })
})
