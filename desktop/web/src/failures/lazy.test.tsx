// @vitest-environment jsdom
// The probe of stream 1b's riskiest assumption (design check, 1b-c3 first commit): preact `lazy` caches a rejected
// chunk, so a Retry through the same `lazy` never loads; a fresh `lazy` per retry generation does.
import { render, type ComponentType } from 'preact'
import { lazy, Suspense } from 'preact/compat'
import { useErrorBoundary, useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryableLazy, RetryGeneration } from './lazy'

function Panel() {
  return <p>Panel loaded</p>
}

/** A loader that rejects its first call, as a chunk fetch does when the network drops, then loads. */
function flakyLoader() {
  let calls = 0
  const load = vi.fn(async (): Promise<{ default: ComponentType }> => {
    calls += 1
    if (calls === 1) throw new TypeError('Failed to fetch dynamically imported module')
    return { default: Panel }
  })
  return load
}

let retry: () => void = () => {}

function Host({ children }: { children: preact.ComponentChildren }) {
  const [generation, setGeneration] = useState(0)
  const [error, resetError] = useErrorBoundary()
  retry = () => {
    setGeneration((value) => value + 1)
    resetError()
  }
  if (error) return <p>Failed</p>
  return (
    <RetryGeneration.Provider value={generation}>
      <Suspense fallback={<p>Loading</p>}>{children}</Suspense>
    </RetryGeneration.Provider>
  )
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('retryable lazy loading', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('preact lazy caches a rejected chunk: a retry through the same lazy never calls the loader again', async () => {
    const load = flakyLoader()
    const Lazy = lazy(load)
    await act(async () => render(<Host><Lazy /></Host>, container))
    await settle()
    expect(container.textContent).toBe('Failed')
    await act(async () => retry())
    await settle()
    expect(container.textContent).toBe('Failed')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a retry builds a fresh lazy for the new generation, so the second attempt loads', async () => {
    const load = flakyLoader()
    const Lazy = retryableLazy(load)
    await act(async () => render(<Host><Lazy /></Host>, container))
    await settle()
    expect(container.textContent).toBe('Failed')
    await act(async () => retry())
    await settle()
    expect(container.textContent).toBe('Panel loaded')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a chunk that loaded is not fetched again when the boundary retries for another reason', async () => {
    const load = vi.fn(async () => ({ default: Panel }))
    const Lazy = retryableLazy(load)
    await act(async () => render(<Host><Lazy /></Host>, container))
    await settle()
    await act(async () => retry())
    await settle()
    expect(container.textContent).toBe('Panel loaded')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
