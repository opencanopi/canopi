import { options } from 'preact'
import { afterAll, afterEach } from 'vitest'

/**
 * Preact 11 runs effects, and a removed component's effect cleanups, after paint: from a requestAnimationFrame
 * and a 35 ms timer of its own. A test that ends on a bare `render(null, container)` leaves that timer behind, and it
 * fires after the file's environment is gone (`document is not defined`, `cancelAnimationFrame is not defined`) or
 * inside the next test. Here the after-paint work queues instead and drains a frame later (17 ms, so a 0 ms timer a
 * layout effect sets still runs first, as in a browser), after each test (after the file's own hooks) and after the
 * file, so every cleanup runs while the page exists. `act` still flushes its own. A cleanup returned from a
 * `beforeEach` or given to `onTestFinished` runs after the per-test drain and is caught only by the file's.
 */
const pending: Array<() => void> = []

function drain(): void {
  while (pending.length > 0) pending.shift()!()
}

options.requestAnimationFrame = (flush) => {
  pending.push(flush)
  setTimeout(drain, 17)
}

afterEach(drain)
afterAll(drain)
