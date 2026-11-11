/**
 * maplibre/map-errors.ts: Owner of map-failure summaries and their reporting (AGENTS.md Secrets, ADR 0025 Frontend
 * sinks). Invariant: a map failure reaches the console and the problem report only through the failure sink, whose
 * one redactor (failures/redact.ts) removes the Google key and session MapLibre copies from request URLs into errors;
 * a summary carries the source, the HTTP status and the redacted message, never a tile object or a request.
 */
import type { FailureCode } from '../generated/contracts'
import { failureLogger, reportFailure } from '../failures/report'
import { redact } from '../failures/redact'

/** The logger shape map owners accept, so a test can inject a spy; the default reports through the sink. */
export type MapErrorReporter = (message?: unknown, ...optionalParams: unknown[]) => void

/** A plain, redacted summary of a MapLibre error event: source, HTTP status and message. */
function describeMapErrorEvent(event: unknown): string {
  if (event instanceof Error) return redact(`${event.name}: ${event.message}`)
  if (typeof event === 'string') return redact(event)
  if (typeof event !== 'object' || event === null) return 'Unknown map error'
  const parts: string[] = []
  const record = event as Record<string, unknown>
  if (typeof record.sourceId === 'string') parts.push(`source ${record.sourceId}`)
  const inner = record.error
  if (typeof inner === 'object' && inner !== null) {
    const status = (inner as Record<string, unknown>).status
    if (typeof status === 'number') parts.push(`status ${status}`)
    const message = (inner as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) parts.push(redact(message))
  } else if (typeof record.message === 'string' && record.message.length > 0) {
    parts.push(redact(record.message))
  }
  return parts.length > 0 ? parts.join(' · ') : 'Unknown map error'
}

const logMapFailure = failureLogger('map')

/**
 * The default map reporter: one ring entry, echoed to the console in the logger's shape, telling no one (the map shows
 * its own state). An event object is reduced to its summary; the sink redacts the text and every echoed value.
 */
export const reportMapError: MapErrorReporter = (message, ...optionalParams) => {
  const values = [message, ...optionalParams].filter((value) => value !== undefined)
    .map((value) => typeof value === 'string' || value instanceof Error ? value : describeMapErrorEvent(value))
  logMapFailure(...values)
}

/**
 * Records a passive basemap failure under its code: a tile source names the layer whose source failed, anything else
 * is the style (its sprite or TileJSON). Silent until 2d's map status (2.1-Q300).
 */
export function reportMapSourceFailure(context: string, event: unknown): void {
  const summary = describeMapErrorEvent(event)
  reportFailure(`${context} ${summary}`, { shown: 'none', source: 'map', echo: [context, summary], code: mapFailureCode(event) })
}

function mapFailureCode(event: unknown): FailureCode {
  const sourceId = typeof event === 'object' && event !== null ? (event as { sourceId?: unknown }).sourceId : undefined
  return typeof sourceId === 'string' ? { kind: 'tile_source_failed', layer: sourceId } : { kind: 'style_failed' }
}
