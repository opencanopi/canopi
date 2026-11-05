// The iOS smoke's start-screen wait outlasts a page still loading (canopi-f47t.52.261, run 41753452998 on the iPad mini):
// the first element lookup reached Safari mid-load, its debugger answered nothing for 30 s and the driver's busy-page
// error failed the smoke 80 s into a load that then finished on the start screen. The wait asks again until its
// deadline; at the deadline a busy page and an absent start screen fail with different messages, so the lane's
// planted-page step still matches only the second.
import { describe, expect, it } from 'vitest'
import { waitForStartScreen } from '../../e2e/platform/phones/ios/start-screen-wait'

const BUSY = 'The remote Safari debugger did not respond to the requested command after 30007.18225ms. It appears that JavaScript execution is blocked, which could be caused by either a modal dialog obstructing the current page, or a JavaScript routine monopolizing the event loop. when running "elements" with method "POST"'

/** A clock the waits advance, and a lookup that answers each call from `outcomes` after `cost` ms. */
function harness(outcomes: (string | 'shown')[], cost: number) {
  let now = 0
  const asked: number[] = []
  const wait = async (timeout: number) => {
    asked.push(timeout)
    const outcome = outcomes.shift() ?? 'shown'
    now += Math.min(cost, timeout)
    if (outcome !== 'shown') throw new Error(outcome)
  }
  return { wait, clock: () => now, asked }
}

describe('the iOS start-screen wait (canopi-f47t.52.261)', () => {
  it('canopi-f47t.52.261: a debugger busy while the page loads is asked again until the start screen shows', async () => {
    const { wait, clock, asked } = harness([BUSY, BUSY, 'shown'], 30_000)
    await waitForStartScreen(wait, 'http://localhost:4174/web.html', 90_000, clock)
    expect(asked).toEqual([90_000, 60_000, 30_000])
  })

  it('a start screen still absent at the deadline fails with the message the planted-page step requires', async () => {
    const { wait, clock } = harness(['element ("[data-start-screen]") still not displayed after 90000ms'], 90_000)
    await expect(waitForStartScreen(wait, 'planted.html', 90_000, clock)).rejects.toThrow('the start screen was not displayed 90 s after opening planted.html')
  })

  it('a debugger busy until the deadline fails naming the busy page, never as an absent start screen', async () => {
    const { wait, clock } = harness([BUSY, BUSY, BUSY, BUSY], 30_000)
    const failure = waitForStartScreen(wait, 'web.html', 90_000, clock)
    await expect(failure).rejects.toThrow('Safari answered no element lookup for 90 s after opening web.html')
    await expect(failure).rejects.not.toThrow('was not displayed')
  })

  it('any other error, such as a session that died, is rethrown unchanged at once', async () => {
    const { wait, clock, asked } = harness(['invalid session id'], 1_000)
    await expect(waitForStartScreen(wait, 'web.html', 90_000, clock)).rejects.toThrow(/^invalid session id$/)
    expect(asked).toHaveLength(1)
  })
})
