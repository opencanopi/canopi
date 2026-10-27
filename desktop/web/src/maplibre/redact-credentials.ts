/**
 * maplibre/redact-credentials.ts: Owner of map-text redaction (§18 F24, ADR 0025; AGENTS.md Secrets) until 1b's
 * failures/redact.ts. Invariant: map text is logged, reported or shown only after this.
 *
 * The Google tile key rides in request URLs, and MapLibre copies failed request
 * URLs into its error messages. Anything map-related that is logged, reported
 * or shown passes through here first, so the key never reaches the console,
 * diagnostics, Designs or exports.
 */

// Credential query parameters: the Google Maps `key=` and the Map Tiles `session=` token.
const CREDENTIAL_QUERY_VALUE = /(^|[?&;\s])(key|api-key|api_key|apikey|session)=[^\s&#"')\]},;<>]+/gi

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_QUERY_VALUE, '$1$2=<redacted>')
}

/** The same error when it holds no credential, otherwise a redacted copy. */
export function redactError(error: Error): Error {
  const message = redactCredentials(error.message)
  if (message === error.message) return error
  const redacted = new Error(message)
  redacted.name = error.name
  return redacted
}

/**
 * A plain summary of a MapLibre error event: source, HTTP status and the
 * redacted message. Tile objects and request URLs are never included.
 */
export function describeMapErrorEvent(event: unknown): string {
  if (event instanceof Error) return redactCredentials(`${event.name}: ${event.message}`)
  if (typeof event === 'string') return redactCredentials(event)
  if (typeof event !== 'object' || event === null) return 'Unknown map error'
  const parts: string[] = []
  const record = event as Record<string, unknown>
  if (typeof record.sourceId === 'string') parts.push(`source ${record.sourceId}`)
  const inner = record.error
  if (typeof inner === 'object' && inner !== null) {
    const status = (inner as Record<string, unknown>).status
    if (typeof status === 'number') parts.push(`status ${status}`)
    const message = (inner as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) parts.push(redactCredentials(message))
  } else if (typeof record.message === 'string' && record.message.length > 0) {
    parts.push(redactCredentials(record.message))
  }
  return parts.length > 0 ? parts.join(' · ') : 'Unknown map error'
}

/** Map-layer default logger: every argument is reduced to redacted text or a redacted Error. */
export function logMapError(message: unknown, ...optionalParams: unknown[]): void {
  console.error(
    typeof message === 'string' ? redactCredentials(message) : describeMapErrorEvent(message),
    ...optionalParams.map((value) => value instanceof Error ? redactError(value) : describeMapErrorEvent(value)),
  )
}
