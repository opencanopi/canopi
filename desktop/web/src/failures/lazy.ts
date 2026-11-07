/**
 * failures/lazy.ts: Owner of retryable lazy loading for surfaces (contracts §2, APP-03, 2.1-Q291). Invariant: preact's
 * `lazy` caches a rejected chunk and rethrows it on every render, so a surface whose chunk failed builds a fresh
 * `lazy` when its boundary's Try again bumps the retry generation; a chunk that loaded is never fetched again.
 */
import { createContext, createElement, type ComponentType, type FunctionComponent } from 'preact'
import { lazy } from 'preact/compat'
import { useContext } from 'preact/hooks'

/** The boundary's retry count: each Try again raises it, and a failed lazy below reloads under the new value. */
export const RetryGeneration = createContext(0)

type Loader<P> = () => Promise<ComponentType<P> | { default: ComponentType<P> }>

/** A lazy surface whose failed chunk loads again, through a fresh `lazy`, once its boundary retries. */
export function retryableLazy<P extends object>(loader: Loader<P>): FunctionComponent<P> {
  let current: ComponentType<P> | null = null
  let madeAt = 0
  let failed = false
  const fresh = (generation: number): ComponentType<P> => {
    failed = false
    madeAt = generation
    return lazy(() => loader().catch((error: unknown) => {
      failed = true
      throw error
    })) as ComponentType<P>
  }
  function RetryableLazy(props: P) {
    const generation = useContext(RetryGeneration)
    if (current === null || (failed && generation !== madeAt)) current = fresh(generation)
    return createElement(current, props)
  }
  return RetryableLazy
}
