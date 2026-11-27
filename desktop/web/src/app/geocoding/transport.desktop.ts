import { geocoderFetch } from '../../ipc/geocoding'
import type { GeocodingTransport } from './registry'

/**
 * Desktop: Nominatim requests go through the native `geocoder_fetch` transport, which
 * sends an identifying User-Agent as Nominatim's usage policy requires (a webview `fetch`
 * cannot set one). The TS registry owns URL building and response parsing on both editions.
 */
export const geocodingTransport: GeocodingTransport = async (url, signal) => {
  const body = await geocoderFetch(url)
  if (signal?.aborted) throw new DOMException('Geocoding was cancelled.', 'AbortError')
  return body.trim() ? JSON.parse(body) : undefined
}
