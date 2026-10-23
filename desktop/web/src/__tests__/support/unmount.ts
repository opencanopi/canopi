import { render } from 'preact'
import { act } from 'preact/test-utils'

/**
 * Unmounts a tree inside act, so every cleanup has run when it returns.
 *
 * Preact 11 runs a removed component's useEffect cleanups after the next paint, not during unmount. After a bare
 * `render(null, container)` they wait for the setup file's drain (`preact-after-paint.ts`), which runs after the
 * file's own afterEach hooks: past its store resets and `container.remove()`. Tests that tear down between cases, or
 * assert on what a cleanup did, use this; a test that checks production holds without a flush (a lease, a focus
 * restore) keeps the bare call on purpose.
 */
export function unmount(container: Element): void {
  act(() => { render(null, container) })
}
