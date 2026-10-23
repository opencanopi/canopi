import { options } from 'preact'
import { afterEach } from 'vitest'

/**
 * Preact 11 runs effects, and a removed component's effect cleanups, after paint: from a requestAnimationFrame
 * and a 35 ms timer of its own. A test that ends on a bare `render(null, container)` leaves that timer behind, and it
 * fires after the file's environment is gone (`document is not defined`, `cancelAnimationFrame is not defined`) or
 * inside the next test. Here the after-paint work queues instead and drains on a 0 ms timer, and after each test
 * (after the file's own hooks), so every cleanup runs inside the test that caused it. `act` still flushes its own.
 */
const pending: Array<() => void> = []

function drain(): void {
  while (pending.length > 0) pending.shift()!()
}

options.requestAnimationFrame = (flush) => {
  pending.push(flush)
  setTimeout(drain)
}

afterEach(drain)
