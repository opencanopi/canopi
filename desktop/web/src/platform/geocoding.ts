/**
 * platform/geocoding.ts: Owner of browser-side geocoder `fetch` (fetch-only-in-owners, ADR 0028, contracts §18 F15,
 * canopi-f47t.52.77). Invariant: all browser geocoding requests pass through `pageFetchJson` with an optional
 * `AbortSignal` and fail cleanly on non-2xx responses.
 */

/** Performs one JSON GET request via `fetch` and returns the parsed body (undefined if empty). */
export async function pageFetchJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`)
  const text = await response.text()
  return text.trim() ? JSON.parse(text) as unknown : undefined
}
