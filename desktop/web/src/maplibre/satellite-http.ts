import type {
  SatelliteHttp,
  SatelliteHttpResponse,
} from './satellite-provider-session'

/** Longest response body the provider will read, in bytes. */
export const BASEMAP_HTTP_MAX_BODY_BYTES = 256 * 1024

/**
 * The bounded browser HTTP capability the basemap provider is given.
 *
 * It is deliberately narrow: the provider supplies a fixed endpoint and an
 * `AbortSignal`, and this adapter adds the transport rules the product contract
 * requires — a bounded response body, JSON-only body reading, `Retry-After`
 * extraction, and errors that carry no request URL. A provider error must never
 * be able to echo a configured API key into a console, a diagnostic sink or the
 * UI, and the key travels in the URL.
 */
export function createBrowserSatelliteHttp(
  fetchImpl: typeof fetch = globalThis.fetch,
): SatelliteHttp {
  return {
    async request(input): Promise<SatelliteHttpResponse> {
      let response: Response
      try {
        response = await fetchImpl(input.url, {
          method: input.method ?? 'GET',
          signal: input.signal,
          headers:
            input.method === 'POST'
              ? { 'Content-Type': 'application/json' }
              : undefined,
          body: input.method === 'POST' ? JSON.stringify(input.body ?? {}) : undefined,
          // No ambient credentials: these are public tile endpoints and sending
          // cookies would widen the request beyond what the provider needs.
          credentials: 'omit',
          mode: 'cors',
          redirect: 'follow',
        })
      } catch {
        // The throw is swallowed rather than re-thrown with its cause, because
        // a fetch failure message can contain the full request URL and with it
        // the API key. A status of 0 is the provider's "transport failure".
        return { ok: false, status: 0, json: null }
      }

      const retryAfterSeconds = readRetryAfter(response.headers)
      let json: unknown = null
      if (response.ok) {
        json = await readBoundedJson(response)
      }
      return {
        ok: response.ok,
        status: response.status,
        json,
        retryAfterSeconds,
      }
    },
  }
}

/** `Retry-After` as seconds, accepting the HTTP-date form too. */
function readRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return null
  const delta = (date - Date.now()) / 1000
  return delta > 0 ? delta : 0
}

/**
 * Read a response body only when it is JSON, and only up to the cap.
 *
 * The cap is enforced **while reading**, from the streamed bytes, because a
 * `Content-Length` header is optional and a chunked answer would otherwise be
 * buffered whole before the size was ever consulted. Text length is not byte
 * length either, so the count is taken from the decoded chunks. A non-JSON or
 * oversized body is reported as `null` rather than being parsed, and an
 * oversized body cancels the reader instead of draining it.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) return null
  // An honest declared length is respected without opening the body at all.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > BASEMAP_HTTP_MAX_BODY_BYTES) return null

  const body = response.body
  if (!body) return null
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > BASEMAP_HTTP_MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
