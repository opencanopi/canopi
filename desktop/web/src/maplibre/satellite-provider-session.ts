import {
  resolveSatelliteDescriptor,
  type SatelliteDescriptor,
  type SatelliteConfig,
} from './satellite-provider'
import { googleSessionRequestUrl, googleViewportRequestUrl, type BasemapTileAuth } from './basemap-tile-auth'
import { reportMapError } from './map-errors'

/**
 * One active Google satellite imagery generation.
 *
 * `satellite-provider.ts` decides *what* a configuration maps to; this owns the lifecycle of
 * getting there. It is deliberately separate from any map: a provider
 * generation is bound to the map surface that admitted it, owns its own
 * requests and timers, and is fenced so a superseded generation cannot publish
 * a session, an attribution string, a descriptor or an error over the current
 * one.
 *
 * It performs no map mutation at all. A caller reacts to published state through
 * the existing contribution reconciliation, which is what keeps a key or
 * locale change from needing `setStyle()` or a new map.
 */

/** The bounded HTTP capability the provider is given, injected per edition. */
export interface SatelliteHttp {
  /**
   * Perform one request. `signal` must abort the underlying work. The provider
   * always supplies a finite timeout, so an implementation that ignores the
   * signal still cannot hang the caller indefinitely.
   */
  request(input: {
    readonly url: string
    readonly signal: AbortSignal
    /** Defaults to GET. */
    readonly method?: 'GET' | 'POST'
    /** JSON body for a POST; the adapter serialises it. */
    readonly body?: unknown
  }): Promise<SatelliteHttpResponse>
}

export interface SatelliteHttpResponse {
  readonly ok: boolean
  readonly status: number
  /** Parsed JSON body, or `null` when the body is absent or not JSON. */
  readonly json: unknown
  /** `Retry-After` in seconds when the response carried one. */
  readonly retryAfterSeconds?: number | null
}

/** The viewport a caller asks the provider to serve. */
export interface SatelliteViewport {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
  readonly zoom: number
}

export type SatelliteState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready'
      /** An official descriptor's attribution is the viewport copyright. */
      readonly descriptor: SatelliteDescriptor
      /**
       * Nothing. The live session token and key are published separately, into
       * the map's tile transport, so they can never be persisted, exported or
       * logged as part of a provider state.
       */
    }
  /**
   * The key was rejected, the connection failed or Google's answer was unusable. No cause: the map notice has one
   * sentence for all of them, and a cause text could carry the key.
   */
  | { readonly state: 'unavailable' }

/** The fixed retry/timeout policy the product contract settles. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000
export const PROVIDER_MAX_RETRIES = 2
const PROVIDER_RETRY_BACKOFF_MS = [1_000, 2_000] as const
/** Renew an official session within this window of its expiry. */
const PROVIDER_SESSION_RENEWAL_WINDOW_MS = 60_000
/** The longest single timer any runtime reliably supports, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

interface GoogleSession {
  /**
   * Live session token. Held in memory on this provider only: it is never
   * returned to a caller, so it cannot be persisted, logged or exported, and it
   * expires.
   */
  readonly sessionToken: string
  readonly tileWidth: number
  readonly expiresAtMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export class SatelliteImageryProvider {
  private generation = 0
  private disposed = false
  private state: SatelliteState = { state: 'idle' }
  private listeners = new Set<(state: SatelliteState) => void>()
  private controller: AbortController | null = null
  private session: GoogleSession | null = null
  private lastViewport: SatelliteViewport | null = null
  /**
   * The newest viewport the caller wants served, even while a request is in
   * flight. One active request plus one latest desired viewport: a newer
   * viewport supersedes the older request/result rather than queueing.
   */
  private latestDesiredViewport: SatelliteViewport | null = null
  /**
   * Viewport refresh in flight for one generation.
   *
   * Sessions need no equivalent bookkeeping: `update()` advances the
   * generation and aborts the controller, so a superseded session attempt can
   * neither publish nor install itself, and at most one attempt per generation
   * can reach the publish point.
   */
  private viewportInFlight: { readonly generation: number; readonly viewport: SatelliteViewport } | null = null
  /** Validated viewport metadata for the current generation, when established. */
  private viewportMetadata: BasemapViewportMetadata | null = null
  /** The descriptor as resolved before any viewport zoom clamp. */
  private baseDescriptor: SatelliteDescriptor | null = null
  /**
   * Identity of the configuration the live session was acquired under.
   *
   * A key or locale change is a different credential/session identity: the old
   * session, viewport facts, credentials and renewal must not survive it.
   */
  private configIdentity: string | null = null

  private renewalTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly http: SatelliteHttp,
    /**
     * Reads the configuration: a device-local key or a locale change reaches a
     * provider that is already serving a live map, because `update()` re-reads
     * it, so no caller has to capture the key at map-creation time and go stale.
     */
    readonly config: () => SatelliteConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    /**
     * Where the live credential is published, when the surface has a tile
     * transport. Absent for a caller that never renders tiles.
     */
    private readonly credentials: BasemapTileAuth | null = null,
  ) {}

  /** The current published state. */
  snapshot(): SatelliteState {
    return this.state
  }

  /** Whether the map's transport holds this provider's session, so an official `{session}` tile template resolves. */
  officialTilesResolvable(): boolean {
    return this.credentials?.installed === true
  }

  /** Subscribe to state changes; the returned function removes the listener. */
  subscribe(listener: (state: SatelliteState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Adopt the current configuration and a viewport.
   *
   * Every call begins a new generation. Anything the previous generation had in
   * flight is aborted and can no longer publish, which is what makes a key
   * change, a locale change or a fast sequence of viewport moves safe.
   * A configuration identity change also drops incompatible session, viewport
   * facts, credentials and renewal before the new session is acquired.
   */
  update(viewport: SatelliteViewport): void {
    if (this.disposed) return
    this.generation += 1
    const generation = this.generation
    this.controller?.abort()
    this.controller = new AbortController()
    this.lastViewport = viewport
    this.latestDesiredViewport = viewport
    this.viewportInFlight = null
    this.clearRenewal()

    const config = this.config()
    const nextIdentity = this.configIdentityOf(config)
    const configChanged = this.configIdentity !== nextIdentity
    if (configChanged) {
      this.session = null
      this.credentials?.clear()
      this.viewportMetadata = null
    }
    this.configIdentity = nextIdentity

    const descriptor = resolveSatelliteDescriptor(config)

    this.baseDescriptor = descriptor

    if (!descriptor.official) {
      // Keyless public Google tiles need no session and no viewport
      // metadata, so there is no loading state to show and no request. A
      // cleared key drops the previous session with it.
      this.session = null
      this.credentials?.clear()
      this.viewportMetadata = null
      this.publish({ state: 'ready', descriptor })
      return
    }

    // An official generation needs a live session *and* validated viewport
    // metadata before imagery is Ready. A session that still matches this
    // configuration may be reused; otherwise it is re-acquired.
    const existing = this.session
    if (existing && existing.expiresAtMs - this.now() > PROVIDER_SESSION_RENEWAL_WINDOW_MS) {
      this.publish({ state: 'loading' })
      void this.refreshViewport(generation, viewport)
      return
    }

    this.publish({ state: 'loading' })
    void this.acquireSession(generation, descriptor)
  }

  /**
   * Adopt a settled viewport without restarting the provider generation.
   *
   * A session is not per-viewport, so moving the map refreshes the viewport
   * metadata in place: aborting and re-acquiring the session on every pan would
   * cost a request per movement and blank the imagery while it completed.
   * Only the latest desired viewport is kept; an older in-flight result is
   * discarded and the latest is requested immediately.
   */
  updateViewport(viewport: SatelliteViewport): void {
    if (this.disposed) return
    this.lastViewport = viewport
    this.latestDesiredViewport = viewport
    if (!this.session) return
    // Same settled viewport need not refetch when metadata is already valid.
    if (
      this.viewportMetadata !== null &&
      this.viewportInFlight === null &&
      this.lastPublishedViewport &&
      sameViewport(this.lastPublishedViewport, viewport)
    ) {
      return
    }
    void this.refreshViewport(this.generation, viewport)
  }

  /** Release every request, timer and listener this provider owns. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.clearRenewal()
    this.listeners.clear()
    this.session = null
    // The map's transport must stop carrying a credential the moment its owner
    // stops serving that provider.
    this.credentials?.clear()
    this.viewportInFlight = null
    this.latestDesiredViewport = null
    this.viewportMetadata = null
    this.baseDescriptor = null
    this.configIdentity = null
    this.state = { state: 'idle' }
  }

  /** Stable identity for the credential/session-relevant configuration. */
  private configIdentityOf(config: SatelliteConfig): string {
    return JSON.stringify({
      key: config.googleMapsApiKey?.trim() ?? '',
      locale: config.locale ?? '',
    })
  }

  /** The viewport last published as current metadata, when one was published. */
  private lastPublishedViewport: SatelliteViewport | null = null

  private publish(state: SatelliteState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  /** Whether one answer still belongs to the generation that asked for it. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.controller !== null
  }

  private async acquireSession(
    generation: number,
    descriptor: SatelliteDescriptor,
  ): Promise<void> {
    const key = this.config().googleMapsApiKey?.trim() ?? ''
    let session: GoogleSession | null = null
    try {
      session = await this.runSessionRequest(generation, key)
    } catch {
      session = null
    }
    if (!this.isCurrent(generation)) return
    if (session === null) {
      // A rejected key or a lost connection is reported as unavailable and
      // never downgraded to keyless tiles, because silently serving different
      // imagery would misrepresent it.
      this.session = null
      this.credentials?.clear()
      this.viewportMetadata = null
      this.publish({ state: 'unavailable' })
      return
    }
    this.session = session
    // Official imagery stays withheld until validated viewport metadata also
    // arrives. Credentials are installed so the tile transport is ready, but
    // the contribution is not published Ready yet.
    this.installCredentials(session)
    this.scheduleRenewal(generation, session, descriptor)
    if (this.lastViewport) void this.refreshViewport(generation, this.lastViewport)
  }

  /** Hand the live session to the map's transport, when the surface has one. */
  private installCredentials(session: GoogleSession): void {
    if (!this.credentials) return
    const key = this.config().googleMapsApiKey?.trim() ?? ''
    if (!key) return
    this.credentials.set({ sessionToken: session.sessionToken, apiKey: key })
  }

  /**
   * The descriptor for a live session: the session's own tile size, the
   * validated viewport copyright and the zoom the current viewport metadata
   * actually permits, always computed against the base descriptor so
   * availability can increase and decrease.
   */
  private descriptorForSession(
    descriptor: SatelliteDescriptor,
    session: GoogleSession,
  ): SatelliteDescriptor {
    const metadataZoom = this.viewportMetadata?.maxZoom
    const copyright = this.viewportMetadata?.copyright
    return {
      ...descriptor,
      tiles: [...descriptor.tiles],
      tileSize: session.tileWidth,
      attribution: copyright ?? descriptor.attribution,
      maxzoom: Math.min(
        descriptor.maxzoom,
        typeof metadataZoom === 'number' && Number.isFinite(metadataZoom)
          ? metadataZoom
          : descriptor.maxzoom,
      ),
    }
  }

  /** Publish Ready only when session and validated viewport metadata agree. */
  private publishOfficialReady(generation: number, descriptor: SatelliteDescriptor): void {
    if (!this.isCurrent(generation)) return
    const session = this.session
    const metadata = this.viewportMetadata
    if (!session || !metadata) return
    this.installCredentials(session)
    this.publish({
      state: 'ready',
      descriptor: this.descriptorForSession(descriptor, session),
    })
    this.scheduleRenewal(generation, session, descriptor)
  }

  /**
   * Renew a session before it expires.
   *
   * Scheduling is part of the session's own lifetime: a session that expired
   * while the map was idle would leave the transport authenticating with a dead
   * token, so the renewal starts inside the renewal window and publishes
   * `loading` while it runs, which withdraws the tiles a dead token would fail.
   */
  private scheduleRenewal(
    generation: number,
    session: GoogleSession,
    descriptor: SatelliteDescriptor,
  ): void {
    this.clearRenewal()
    const remaining = session.expiresAtMs - this.now() - PROVIDER_SESSION_RENEWAL_WINDOW_MS
    // A session far in the future cannot be waited for in one timer: the delay
    // would exceed the platform's timer range, so a bounded wait is armed and
    // re-armed until the renewal window is actually reached.
    const delay = Math.max(1_000, Math.min(remaining, MAX_TIMER_DELAY_MS))
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null
      if (!this.isCurrent(generation)) return
      if (session.expiresAtMs - this.now() > PROVIDER_SESSION_RENEWAL_WINDOW_MS) {
        this.scheduleRenewal(generation, session, descriptor)
        return
      }
      this.session = null
      this.credentials?.clear()
      this.publish({ state: 'loading' })
      void this.acquireSession(generation, descriptor)
    }, delay)
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) {
      clearTimeout(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  /** One session request with the fixed retry policy, fenced by generation. */
  private async runSessionRequest(generation: number, key: string): Promise<GoogleSession | null> {
    const response = await this.requestWithRetry(generation, googleSessionRequestUrl(key), {
      method: 'POST',
      body: { mapType: 'satellite', language: this.sessionLocale(), region: this.sessionRegion() },
    })
    if (response === null) return null
    if (!response.ok) {
      // The numeric status only: the request URL carries the key.
      reportMapError(`Satellite session request failed (HTTP ${response.status}).`)
      return null
    }
    const body = response.json
    if (!isRecord(body)) return null
    const sessionToken = body.session
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) return null
    const tileWidth = Number(body.tileWidth)
    return {
      sessionToken,
      tileWidth: Number.isFinite(tileWidth) && tileWidth > 0 ? tileWidth : 256,
      expiresAtMs: readSessionExpiryMs(body.expiry, this.now()),
    }
  }

  /**
   * Viewport copyright and zoom availability, refreshed on settled viewport
   * changes.
   *
   * The documented viewport request is authenticated with the session **and**
   * the API key, so both are sent. A refused or malformed answer becomes an
   * actionable unavailable state rather than leaving the previous attribution
   * in place as if it still described what is on screen. A later valid request
   * for a distinct settled viewport (or an explicit retry) may recover.
   */
  private async refreshViewport(
    generation: number,
    viewport: SatelliteViewport,
  ): Promise<void> {
    if (this.viewportInFlight && this.viewportInFlight.generation === generation) {
      // Keep only the latest desired viewport; the in-flight request will be
      // superseded when it settles if it is no longer the latest.
      this.latestDesiredViewport = viewport
      return
    }
    const session = this.session
    const key = this.config().googleMapsApiKey?.trim() ?? ''
    if (!session || !key) return
    this.latestDesiredViewport = viewport
    this.viewportInFlight = { generation, viewport }
    let response: SatelliteHttpResponse | null = null
    try {
      response = await this.requestWithRetry(
        generation,
        googleViewportRequestUrl(session.sessionToken, key, viewport),
        { method: 'GET' },
      )
    } catch {
      response = null
    }
    if (!this.isCurrent(generation)) return
    this.viewportInFlight = null

    // A newer viewport arrived while this request was running: discard this
    // result without publishing and immediately request the latest.
    const latest = this.latestDesiredViewport
    if (latest && !sameViewport(latest, viewport)) {
      void this.refreshViewport(generation, latest)
      return
    }

    if (!response || !response.ok) {
      this.failViewportMetadata(generation)
      return
    }
    const metadata = readViewportMetadata(response.json, viewport)
    if (metadata === null) {
      this.failViewportMetadata(generation)
      return
    }
    this.viewportMetadata = metadata
    this.lastPublishedViewport = viewport
    const descriptor = this.baseDescriptor
    if (!descriptor) return
    this.publishOfficialReady(generation, descriptor)
  }

  /**
   * Report viewport metadata that could not be established.
   *
   * Official imagery is not shown without usable viewport attribution and
   * availability, so a failed metadata request is an unavailable provider —
   * not a ready provider with a stale credit line. The
   * transport credential is cleared so stale tokens cannot authenticate tiles.
   * A later valid request may recover through the same bounded policy.
   */
  private failViewportMetadata(generation: number): void {
    if (!this.isCurrent(generation)) return
    this.credentials?.clear()
    this.viewportMetadata = null
    this.clearRenewal()
    this.publish({ state: 'unavailable' })
  }

  /**
   * One bounded request with the contract's retry policy.
   *
   * Transient network, 429 and 5xx answers get at most two retries with
   * jittered backoff, and a longer `Retry-After` is honoured by reporting retry
   * availability rather than holding work indefinitely. Invalid credentials are
   * never retried. Returns `null` when the generation was superseded, so no
   * caller can act on a stale answer.
   */
  private async requestWithRetry(
    generation: number,
    url: string,
    options: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
  ): Promise<SatelliteHttpResponse | null> {
    for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt += 1) {
      if (!this.isCurrent(generation)) return null
      const controller = this.controller
      if (!controller) return null
      const timeout = new AbortController()
      const onAbort = () => timeout.abort()
      controller.signal.addEventListener('abort', onAbort)
      const timer = setTimeout(() => timeout.abort(), PROVIDER_REQUEST_TIMEOUT_MS)
      let response: SatelliteHttpResponse
      try {
        response = await this.http.request(
          options.method === 'POST'
            ? { url, signal: timeout.signal, method: 'POST', body: options.body }
            : { url, signal: timeout.signal },
        )
      } catch {
        response = { ok: false, status: 0, json: null }
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
      }
      if (!this.isCurrent(generation)) return null
      if (response.ok) return response

      const retryable = response.status === 0 || response.status === 429 || response.status >= 500
      if (!retryable || attempt === PROVIDER_MAX_RETRIES) return response
      const retryAfter = response.retryAfterSeconds
      if (typeof retryAfter === 'number' && retryAfter * 1000 > PROVIDER_RETRY_BACKOFF_MS[attempt]!) {
        // A longer server-directed wait is reported rather than held, so the
        // caller can offer retry instead of appearing to hang.
        return response
      }
      await this.sleep(jittered(PROVIDER_RETRY_BACKOFF_MS[attempt]!, attempt))
      if (!this.isCurrent(generation)) return null
    }
    return null
  }

  /** The app's supported locale as an IETF tag, falling back to `en`. */
  private sessionLocale(): string {
    const locale = this.config().locale?.trim()
    return locale && /^[A-Za-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(locale) ? locale : 'en'
  }

  /** A validated region, defaulting to `US` as the contract specifies. */
  private sessionRegion(): string {
    const locale = this.config().locale ?? ''
    const region = locale.split('-')[1]
    return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : 'US'
  }
}

/** A bounded, deterministic jitter so retries do not synchronise. */
function jittered(baseMs: number, attempt: number): number {
  const spread = baseMs * 0.25
  // Deterministic per attempt: tests must not depend on wall-clock randomness,
  // and the spread still separates retries from one another.
  const offset = attempt % 2 === 0 ? spread / 2 : -spread / 2
  return Math.max(0, Math.round(baseMs + offset))
}

/**
 * A session's expiry in milliseconds.
 *
 * The documented `createSession` response carries `expiry` as an
 * **epoch-seconds string**, so a numeric-only parse would silently discard a
 * real expiry and fall back to a guessed lifetime. Both forms are accepted, and
 * a malformed value falls back to the conservative default rather than to a
 * session that never renews.
 */
export function readSessionExpiryMs(expiry: unknown, nowMs: number): number {
  const raw =
    typeof expiry === 'string' ? Number(expiry.trim())
    : typeof expiry === 'number' ? expiry
    : Number.NaN
  if (!Number.isFinite(raw) || raw <= 0) {
    return nowMs + PROVIDER_SESSION_RENEWAL_WINDOW_MS * 2
  }
  // A value that is implausibly small cannot be epoch seconds; treat it as a
  // relative lifetime in seconds so a shortened response is still honoured.
  return raw > 1_000_000_000 ? raw * 1000 : nowMs + raw * 1000
}

/** The attribution and zoom availability one viewport answer supplies. */
export interface BasemapViewportMetadata {
  readonly copyright: string | null
  readonly maxZoom: number
}

/**
 * Read the documented viewport response.
 *
 * `maxZoomRects` describes availability over sub-rectangles of the request.
 * Coverage is exact for the bounded metadata format: wrapped provider
 * rectangles and viewports are normalized into intervals split at ±180 with
 * constant-time modulo, then intersected. A viewport spanning at least 360
 * degrees queries one complete world. Every positive-area partition needs
 * support; its supported zoom is the maximum of covering rectangles, and the
 * source ceiling is the minimum across partitions, capped by the base
 * descriptor. Uncovered or unsupported metadata is unavailable, not an
 * invented zoom. More than 64 input rectangles is unavailable under the
 * existing metadata error policy. Empty objects and answers without finite
 * applicable availability or a copyright are not established metadata.
 */
export function readViewportMetadata(
  json: unknown,
  viewport: SatelliteViewport,
): BasemapViewportMetadata | null {
  if (!isRecord(json)) return null
  const copyright =
    typeof json.copyright === 'string' && json.copyright.length > 0 ? json.copyright : null
  if (copyright === null) return null
  const rects = Array.isArray(json.maxZoomRects) ? json.maxZoomRects : []
  // Conservative local parser support bound, not a claimed provider guarantee.
  if (rects.length > 64) return null
  const parsed: Array<{ north: number; south: number; west: number; east: number; maxZoom: number }> = []
  for (const rect of rects) {
    if (!isRecord(rect)) continue
    const value = Number(rect.maxZoom)
    if (!Number.isFinite(value) || value <= 0) continue
    const north = Number(rect.north)
    const south = Number(rect.south)
    const east = Number(rect.east)
    const west = Number(rect.west)
    if (
      !Number.isFinite(north) || !Number.isFinite(south)
      || !Number.isFinite(east) || !Number.isFinite(west)
      || north <= south
      || south < -90 || north > 90
    ) {
      continue
    }
    parsed.push({ north, south, west, east, maxZoom: value })
  }
  if (parsed.length === 0) return null
  if (
    !Number.isFinite(viewport.north) || !Number.isFinite(viewport.south)
    || !Number.isFinite(viewport.east) || !Number.isFinite(viewport.west)
    || !Number.isFinite(viewport.zoom)
    || viewport.north <= viewport.south
    || viewport.south < -90 || viewport.north > 90
  ) {
    return null
  }
  const viewPieces = splitLongitudeSpan(viewport.west, viewport.east)
  if (viewPieces.length === 0) return null
  const ceiling = exactCoverageCeiling(viewPieces, viewport, parsed)
  if (ceiling === null) return null
  return { copyright, maxZoom: ceiling }
}

type LonInterval = { start: number; end: number }

/**
 * Normalize one directed longitude span into intervals in [-180, 180],
 * split at the antimeridian with constant-time modulo (no iterative shifting).
 *
 * A span of at least 360 degrees is one complete world. Zero-width spans
 * produce no interval. Ordinary unwrapped bounds such as 170..190 are
 * supported and become [170, 180] and [-180, -170].
 */
function splitLongitudeSpan(west: number, east: number): LonInterval[] {
  const span = east >= west ? east - west : east + 360 - west
  if (!Number.isFinite(span) || span <= 0) return []
  if (span >= 360 - 1e-9) {
    return [{ start: -180, end: 180 }]
  }
  // Constant-time wrap of the start into [-180, 180).
  let cursor = (((west + 180) % 360) + 360) % 360 - 180
  if (cursor === 180) cursor = -180
  const pieces: LonInterval[] = []
  let remaining = span
  // At most two pieces: one per side of the antimeridian.
  while (remaining > 1e-9 && pieces.length < 3) {
    const room = 180 - cursor
    const take = Math.min(remaining, room)
    if (take > 1e-9) {
      pieces.push({ start: cursor, end: cursor + take })
    }
    remaining -= take
    cursor = -180
  }
  return pieces
}

function intersectLon(a: LonInterval, b: LonInterval): LonInterval | null {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return end > start ? { start, end } : null
}

/**
 * Exact rectangle coverage over the normalized viewport intervals.
 *
 * Overlapping rectangles offer the greatest supported zoom at a point; the
 * source-wide ceiling is the least such availability across partitions.
 */
function exactCoverageCeiling(
  viewPieces: readonly LonInterval[],
  viewport: SatelliteViewport,
  rects: ReadonlyArray<{ north: number; south: number; west: number; east: number; maxZoom: number }>,
): number | null {
  type Piece = LonInterval & { latNorth: number; latSouth: number; maxZoom: number }
  let ceiling: number | null = null
  for (const view of viewPieces) {
    const latEdges = new Set<number>([viewport.south, viewport.north])
    const lonEdges = new Set<number>([view.start, view.end])
    const pieces: Piece[] = []
    for (const rect of rects) {
      const latSouth = Math.max(rect.south, viewport.south)
      const latNorth = Math.min(rect.north, viewport.north)
      if (latNorth <= latSouth) continue
      for (const span of splitLongitudeSpan(rect.west, rect.east)) {
        const clipped = intersectLon(span, view)
        if (!clipped) continue
        lonEdges.add(clipped.start)
        lonEdges.add(clipped.end)
        latEdges.add(latSouth)
        latEdges.add(latNorth)
        pieces.push({
          start: clipped.start,
          end: clipped.end,
          latNorth,
          latSouth,
          maxZoom: rect.maxZoom,
        })
      }
    }
    const latBreaks = [...latEdges].sort((a, b) => a - b)
    const lonBreaks = [...lonEdges].sort((a, b) => a - b)
    for (let i = 0; i + 1 < latBreaks.length; i += 1) {
      const latA = latBreaks[i]!
      const latB = latBreaks[i + 1]!
      if (!(latB > latA)) continue
      for (let j = 0; j + 1 < lonBreaks.length; j += 1) {
        const lonA = lonBreaks[j]!
        const lonB = lonBreaks[j + 1]!
        if (!(lonB > lonA)) continue
        let partZoom: number | null = null
        for (const piece of pieces) {
          if (piece.latNorth <= latA || piece.latSouth >= latB) continue
          if (piece.end <= lonA || piece.start >= lonB) continue
          partZoom = partZoom === null ? piece.maxZoom : Math.max(partZoom, piece.maxZoom)
        }
        if (partZoom === null) return null
        ceiling = ceiling === null ? partZoom : Math.min(ceiling, partZoom)
      }
    }
  }
  return ceiling
}

function sameViewport(a: SatelliteViewport, b: SatelliteViewport): boolean {
  return (
    a.west === b.west &&
    a.south === b.south &&
    a.east === b.east &&
    a.north === b.north &&
    a.zoom === b.zoom
  )
}

