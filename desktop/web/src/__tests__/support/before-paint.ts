/**
 * Settles what an event outside `act` set going up to the frame a browser would paint: Preact's queued render
 * (microtasks), its commit and layout effects, and 0 ms timers, but not the after-paint work (`useEffect`,
 * `useSignalEffect` re-runs), which preact-after-paint.ts drains 17 ms later. A test reads here what a user sees on the
 * first painted frame, before after-paint work could run: WebKit can deliver a key in that gap.
 */
export function beforePaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
