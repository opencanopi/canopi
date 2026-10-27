// app/geocoding/transport.browser.ts
// Owner of the Web geocoder fetch (fetch-only-in-owners, ADR 0028; §18 F15) until 2a's
// platform/geocoding.ts pageFetchJson. Invariant: geocoding requests leave the page only through here.

import type { GeocodingTransport } from './registry'

/** Web: browser `fetch`; the browser sends the page Referer that identifies the app. */
export const geocodingTransport: GeocodingTransport = async (url, signal) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`)
  const text = await response.text()
  return text.trim() ? JSON.parse(text) as unknown : undefined
}
