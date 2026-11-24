// The iOS smoke's start-screen wait outlasts a page still loading (canopi-f47t.52.261, run 41753452998 on the iPad mini):
// the first element lookup reached Safari mid-load, its debugger answered nothing for 30 s and the driver's busy-page
// error failed the smoke 80 s into a load that then finished on the start screen. The wait asks again until its
// deadline; at the deadline a busy page and an absent start screen fail with different messages, so the lane's
// planted-page step still matches only the second.
import { describe, expect, it } from 'vitest'
import { pollStartScreen } from './start-screen-wait'

const BUSY = 'The remote Safari debugger did not respond to the requested command after 30007.18225ms. It appears that JavaScript execution is blocked, which could be caused by either a modal dialog obstructing the current page, or a JavaScript routine monopolizing the event loop. when running "elements" with method "POST"'

/** A clock the poll advances, and a probe that answers each call from `outcomes` after `cost` ms. */
function harness(outcomes: (string | boolean)[], cost: number) {
  let now = 0
  let calls = 0
  const probe = async () => {
    calls += 1
    now += cost
    const outcome = outcomes.shift() ?? true
    if (typeof outcome === 'string') throw new Error(outcome)
    return outcome
  }
  const options = { interval: 1_000, clock: () => now, sleep: async (ms: number) => { now += ms } }
  return { probe, options, calls: () => calls, now: () => now }
}

describe('the iOS start-screen wait (canopi-f47t.52.261, canopi-5kel)', () => {
  it('canopi-f47t.52.261: a debugger busy while the page loads is asked again until the start screen shows', async () => {
    const { probe, options, calls } = harness([BUSY, BUSY, true], 30_000)
    await pollStartScreen(probe, 'http://localhost:4174/web.html', 90_000, options)
    expect(calls()).toBe(3)
  })

  it('a start screen still absent at the deadline fails with the message the planted-page step requires', async () => {
    const { probe, options } = harness(Array<boolean>(20).fill(false), 10_000)
    await expect(pollStartScreen(probe, 'planted.html', 90_000, options)).rejects.toThrow('the start screen was not displayed 90 s after opening planted.html')
  })

  it('a debugger busy until the deadline fails naming the busy page, never as an absent start screen', async () => {
    const { probe, options } = harness(Array<string>(10).fill(BUSY), 30_000)
    const failure = pollStartScreen(probe, 'web.html', 90_000, options)
    await expect(failure).rejects.toThrow('Safari answered no element lookup for 90 s after opening web.html: the page stayed busy')
    await expect(failure).rejects.not.toThrow('was not displayed')
  })

  it('any other error, such as a session that died, is rethrown unchanged at once', async () => {
    const { probe, options, calls } = harness(['invalid session id'], 1_000)
    await expect(pollStartScreen(probe, 'web.html', 90_000, options)).rejects.toThrow(/^invalid session id$/)
    expect(calls()).toBe(1)
  })

  it('canopi-5kel: pollStartScreen sends a fresh lookup after a 30 s Safari debugger timeout and succeeds once the page recovers', async () => {
    const { probe, options, calls, now } = harness([BUSY, false, true], 0)
    await pollStartScreen(probe, 'http://localhost:4174/web.html', 90_000, options)
    expect(calls()).toBe(3)
    // One pause after the busy answer and one after the absent one.
    expect(now()).toBe(2_000)
  })

  it('a busy error that returns at once is asked again only after a pause, so the poll never spins', async () => {
    const { probe, options, calls } = harness(Array<string>(1_000).fill(BUSY), 0)
    await expect(pollStartScreen(probe, 'web.html', 10_000, options)).rejects.toThrow('the page stayed busy')
    expect(calls()).toBe(11)
  })

  it('a page that answered once and then stayed busy until the deadline fails as busy, not as an absent start screen', async () => {
    const { probe, options } = harness([false, ...Array<string>(10).fill(BUSY)], 30_000)
    await expect(pollStartScreen(probe, 'web.html', 90_000, options)).rejects.toThrow('the page stayed busy')
  })
})
