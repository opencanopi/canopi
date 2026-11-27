import { geocoderFetch } from '../../ipc/geocoding'
import { NOMINATIM_PUBLIC_HOST, type GeocodingTransport } from './registry'
import { geocodingTransport as browserTransport } from './transport.browser'

/**
 * Desktop: Nominatim requests go through the native `geocoder_fetch` transport, which
 * sends an identifying User-Agent as Nominatim's usage policy requires (a webview `fetch`
 * cannot set one). The TS registry owns URL building and response parsing on both editions.
 */
export const geocodingTransport: GeocodingTransport = async (url, signal) => {
  const parsed = new URL(url)
  if (parsed.hostname !== NOMINATIM_PUBLIC_HOST) return browserTransport(url, signal)
  const body = await geocoderFetch(url)
  if (signal?.aborted) throw new DOMException('Geocoding was cancelled.', 'AbortError')
  return body.trim() ? JSON.parse(body) : undefined
}
