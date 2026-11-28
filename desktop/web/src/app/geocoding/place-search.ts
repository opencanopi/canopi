import { signal, type ReadonlySignal } from '@preact/signals'
import { WEB_MERCATOR_MAX_LATITUDE_DEG } from '../../generated/canopi-design-format'
import { formatFixed } from '../../utils/format'
import {
  DEFAULT_FORWARD_GEOCODE_ENDPOINT,
  NOMINATIM_PROVIDER,
  geocodeForward,
  geocoderMinIntervalMs,
  nextDelayMs,
  type GeocodingTransport,
} from './registry'

export interface PlaceSearchResult {
  /** Short primary name ("Ballon-Saint-Mars"). */
  readonly label: string
  /** Muted locality line ("Sarthe, Pays de la Loire, France"), or null. */
  readonly detail: string | null
  readonly lat: number
  readonly lon: number
  readonly source: 'coordinates' | 'geocoder'
}

type PlaceSearchStatus = 'idle' | 'searching' | 'results' | 'no-results' | 'error'

export interface PlaceSearchController {
  readonly results: ReadonlySignal<readonly PlaceSearchResult[]>
  readonly status: ReadonlySignal<PlaceSearchStatus>
  /** Provider id for geocoder results; null for coordinates or before results. */
  readonly providerId: ReadonlySignal<typeof NOMINATIM_PROVIDER.id | null>
  /** Runs one search; called on Enter only, never while typing. */
  search(query: string): Promise<void>
  clear(): void
  dispose(): void
}

export interface PlaceSearchOptions {
  readonly transport: GeocodingTransport
  readonly endpoint?: string
  readonly limit?: number
  /** Current interface locale for `accept-language`. */
  readonly locale?: () => string
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const COORDINATE_PATTERN = /^\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i

/**
 * Parses "lat, lon" (also "lat lon", "48.85N 2.35E") locally, so coordinates
 * never cost a network request. Latitude must be within the Web Mercator range.
 */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const match = COORDINATE_PATTERN.exec(text)
  if (!match) return null
  let lat = Number(match[1])
  let lon = Number(match[3])
  if (match[2]?.toUpperCase() === 'S') lat = -Math.abs(lat)
  if (match[4]?.toUpperCase() === 'W') lon = -Math.abs(lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > WEB_MERCATOR_MAX_LATITUDE_DEG || Math.abs(lon) > 180) return null
  return { lat, lon }
}

const POSTAL_CODE_PATTERN = /^[\d\s-]+$/
const MAX_LOCALITY_PARTS = 3

/**
 * Splits a geocoder's long display name into a short name and a locality:
 * postal codes and parts that only repeat the country ("France
 * métropolitaine") are dropped, and the locality keeps its last three parts.
 */
export function shortPlaceLabel(displayName: string): { label: string; detail: string | null } {
  const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean)
  const label = parts[0] ?? displayName.trim()
  const country = parts.length > 1 ? parts.at(-1)! : null
  const locality = parts.slice(1).filter((part, index, rest) =>
    !POSTAL_CODE_PATTERN.test(part)
    && part !== label
    && rest.indexOf(part) === index
    && (index === rest.length - 1 || !country || !part.includes(country)),
  )
  return {
    label,
    detail: locality.length > 0 ? locality.slice(-MAX_LOCALITY_PARTS).join(', ') : null,
  }
}

/** Start time of the last geocoder request per endpoint, shared app-wide. */
const lastRequestStartedAt = new Map<string, number>()

/** @testonly */
export function resetPlaceSearchPacingForTests(): void {
  lastRequestStartedAt.clear()
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Search was superseded.', 'AbortError'))
    }, { once: true })
  })
}

const MAX_PLACE_SEARCH_CACHE_ENTRIES = 64

export function createPlaceSearchController(options: PlaceSearchOptions): PlaceSearchController {
  const results = signal<readonly PlaceSearchResult[]>([])
  const status = signal<PlaceSearchStatus>('idle')
  const providerId = signal<typeof NOMINATIM_PROVIDER.id | null>(null)
  const endpoint = options.endpoint ?? DEFAULT_FORWARD_GEOCODE_ENDPOINT
  const getLocale = options.locale ?? (() => 'en')
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? abortableSleep
  let controller: AbortController | null = null

  const cancel = () => {
    controller?.abort()
    controller = null
  }

  const cache = new Map<string, readonly PlaceSearchResult[]>()

  return {
    results,
    status,
    providerId,
    async search(query) {
      cancel()
      const trimmed = query.trim()
      if (!trimmed) {
        results.value = []
        status.value = 'idle'
        providerId.value = null
        return
      }
      const coordinates = parseCoordinates(trimmed)
      if (coordinates) {
        results.value = [{
          label: `${formatFixed(coordinates.lat, 6)}, ${formatFixed(coordinates.lon, 6)}`,
          detail: null,
          ...coordinates,
          source: 'coordinates',
        }]
        status.value = 'results'
        providerId.value = null
        return
      }
      const acceptLanguage = getLocale()
      const normalizedQuery = trimmed.replace(/\s+/g, ' ').toLowerCase()
      const cacheKey = `${endpoint}:${acceptLanguage}:${normalizedQuery}`
      const cached = cache.get(cacheKey)
      if (cached) {
        results.value = cached
        status.value = cached.length > 0 ? 'results' : 'no-results'
        providerId.value = NOMINATIM_PROVIDER.id
        return
      }
      const current = new AbortController()
      controller = current
      status.value = 'searching'
      try {
        const interval = geocoderMinIntervalMs(endpoint)
        await sleep(nextDelayMs(lastRequestStartedAt.get(endpoint) ?? null, now(), interval), current.signal)
        if (current.signal.aborted) return
        lastRequestStartedAt.set(endpoint, now())
        const matches = await geocodeForward(trimmed, options.transport, {
          signal: current.signal,
          endpoint,
          acceptLanguage,
          limit: options.limit ?? 5,
        })
        if (controller !== current) return
        // Nominatim can return several OSM objects (a town and its boundary)
        // under one name; the user can only tell them apart by label.
        const seen = new Set<string>()
        const nextResults: PlaceSearchResult[] = matches
          .filter((match) => !seen.has(match.displayName) && seen.add(match.displayName))
          .map((match) => ({
            ...shortPlaceLabel(match.displayName),
            lat: match.lat,
            lon: match.lon,
            source: 'geocoder',
          }))
        if (cache.size >= MAX_PLACE_SEARCH_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(cacheKey, nextResults)
        results.value = nextResults
        status.value = nextResults.length > 0 ? 'results' : 'no-results'
        providerId.value = NOMINATIM_PROVIDER.id
      } catch (error) {
        if (controller !== current || (error instanceof DOMException && error.name === 'AbortError')) return
        results.value = []
        status.value = 'error'
        providerId.value = null
      } finally {
        if (controller === current) controller = null
      }
    },
    clear() {
      cancel()
      results.value = []
      status.value = 'idle'
      providerId.value = null
    },
    dispose: cancel,
  }
}
