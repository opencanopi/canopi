// app/geocoding/transport.browser.ts
// Web geocoder transport delegating to platform/geocoding.ts `pageFetchJson` (contracts §18 F15).

import { pageFetchJson } from '../../platform/geocoding'
import type { GeocodingTransport } from './registry'

/** Web: browser `fetch`; the browser sends the page Referer that identifies the app. */
export const geocodingTransport: GeocodingTransport = (url, signal) => pageFetchJson(url, signal)
