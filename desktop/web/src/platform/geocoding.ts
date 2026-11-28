/**
 * platform/geocoding.ts: Owner of browser-side geocoder `fetch` (fetch-only-in-owners, ADR 0028, contracts §18 F15,
 * canopi-f47t.52.77). Invariant: all browser geocoding requests pass through `pageFetchJson` with an optional
 * `AbortSignal`, enforce the 5 s timeout matching Desktop's native transport, and fail cleanly on non-2xx responses.
 */

const GEOCODER_TIMEOUT_MS = 5000

/** Performs one JSON GET request via `fetch` with a 5 s timeout and returns the parsed body (undefined if empty). */
export async function pageFetchJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) {
    controller.abort(signal.reason)
  } else if (signal) {
    signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, GEOCODER_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`)
    const text = await response.text()
    return text.trim() ? JSON.parse(text) as unknown : undefined
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new Error(`Geocoder request timed out after ${GEOCODER_TIMEOUT_MS} ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}
