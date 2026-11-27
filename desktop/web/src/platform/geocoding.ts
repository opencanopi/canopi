/**
 * platform/geocoding.ts: Owner of browser-side geocoder `fetch` (fetch-only-in-owners, ADR 0028, contracts §18 F15,
 * canopi-f47t.52.77). Invariant: all browser geocoding requests pass through `pageFetchJson` with an optional
 * `AbortSignal`, enforce the 5 s timeout matching Desktop's native transport, and fail cleanly on non-2xx responses.
 */

const GEOCODER_TIMEOUT_MS = 5000

/** Performs one JSON GET request via `fetch` with a 5 s timeout and returns the parsed body (undefined if empty). */
export async function pageFetchJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(GEOCODER_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: combined })
    if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`)
    const text = await response.text()
    return text.trim() ? JSON.parse(text) as unknown : undefined
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error(`Geocoder request timed out after ${GEOCODER_TIMEOUT_MS} ms`)
    }
    throw error
  }
}
