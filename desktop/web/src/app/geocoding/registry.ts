/*
 * Forward geocoding request builder and response normalizer adapted from GeoLibre
 * packages/core/src/geocoding.ts at commit e9df9e2 (Nominatim URL building,
 * response normalization, and pacing). Copyright (c) 2026 Qiusheng Wu.
 * MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { GEOCODER_IDENTIFIED_HOSTS } from '../../generated/contracts'

/** Host whose public usage policy (1 request per second) must be respected. */
const NOMINATIM_PUBLIC_HOST = GEOCODER_IDENTIFIED_HOSTS[0]
export const DEFAULT_FORWARD_GEOCODE_ENDPOINT = `https://${NOMINATIM_PUBLIC_HOST}/search`
/** Nominatim's public policy is 1 request/second; 1.1 s leaves margin. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100

/** Credit data for the single geocoding provider (canopi-f47t.52.77); prose lives in `geocoding.credit`. */
export const NOMINATIM_PROVIDER = {
  id: 'nominatim',
  service: 'Nominatim',
} as const

/** A normalized forward-geocoding match. */
export interface GeocodeMatch {
  readonly lat: number
  readonly lon: number
  readonly displayName: string
  /** The provider's own confidence scale, or null when it reports none. */
  readonly score: number | null
}

/**
 * Performs one GET and returns the parsed JSON body (undefined for an empty
 * body). Web passes browser `fetch`; Desktop routes Nominatim through the
 * native `geocoder_fetch` transport, which sends an identifying User-Agent.
 */
export type GeocodingTransport = (url: string, signal: AbortSignal | undefined) => Promise<unknown>

interface NominatimForwardResult {
  readonly lat: string
  readonly lon: string
  readonly display_name?: string
  readonly importance?: number | string
}

function coerceScore(value: number | string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** Build a Nominatim forward-geocoding URL (jsonv2) with optional `accept-language`. */
function buildForwardGeocodeUrl(
  endpoint: string,
  query: string,
  options: { acceptLanguage?: string; limit?: number } = {},
): string {
  const url = new URL(endpoint)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(options.limit ?? 1))
  if (options.acceptLanguage) url.searchParams.set('accept-language', options.acceptLanguage)
  return url.toString()
}

function nominatimForwardResultToMatch(result: NominatimForwardResult): GeocodeMatch | null {
  const lat = Number(result.lat)
  const lon = Number(result.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon, displayName: result.display_name ?? '', score: coerceScore(result.importance) }
}

/** Parse a Nominatim `jsonv2` response body into normalized matches. */
function parseNominatimForward(data: unknown): GeocodeMatch[] {
  return Array.isArray(data)
    ? (data as NominatimForwardResult[])
        .map(nominatimForwardResultToMatch)
        .filter((match): match is GeocodeMatch => match !== null)
    : []
}

/** Whether requests to `endpoint` fall under Nominatim's public usage policy. */
function shouldThrottle(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === NOMINATIM_PUBLIC_HOST
  } catch {
    return true
  }
}

/** Minimum spacing between requests for `endpoint`. */
export function geocoderMinIntervalMs(endpoint: string): number {
  return shouldThrottle(endpoint) ? NOMINATIM_MIN_INTERVAL_MS : 0
}

/**
 * Milliseconds to wait before the next request so consecutive requests start
 * at least `intervalMs` apart, measured from the previous start.
 */
export function nextDelayMs(lastStartedAt: number | null, now: number, intervalMs: number): number {
  if (lastStartedAt === null) return 0
  return Math.max(0, intervalMs - (now - lastStartedAt))
}

/** Forward-geocode one query through the shared Nominatim request builder and transport. */
export async function geocodeForward(
  query: string,
  transport: GeocodingTransport,
  options: { signal?: AbortSignal; endpoint?: string; limit?: number; acceptLanguage?: string } = {},
): Promise<GeocodeMatch[]> {
  const endpoint = options.endpoint ?? DEFAULT_FORWARD_GEOCODE_ENDPOINT
  const url = buildForwardGeocodeUrl(endpoint, query, {
    ...(options.acceptLanguage ? { acceptLanguage: options.acceptLanguage } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  })
  return parseNominatimForward(await transport(url, options.signal))
}
