/**
 * Names the map source or layer a MapLibre error event is about, so the
 * workspace can route the failure to the contribution that owns it.
 *
 * MapLibre reports a failing resource in three shapes: a tile or source event
 * carries `sourceId`, a layer event carries `layer.id`, and a style validation
 * or mutation error only names the id in its message
 * (`sources.<id>: unknown property "id"`, `Layer "<id>" already exists`).
 * An event that names no resource returns null and stays a core failure.
 */
/** Source id prefix for Desktop raster display sources so map error routing owns them without regex hacks. */
export const RASTER_DISPLAY_SOURCE_PREFIX = 'canopi-raster-src-'

export function mapErrorResourceId(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as Record<string, unknown>
  if (typeof record.sourceId === 'string' && record.sourceId.length > 0) return record.sourceId
  const layer = record.layer
  if (typeof layer === 'object' && layer !== null) {
    const id = (layer as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return resourceIdFromMessage(errorMessage(record))
}

const STYLE_KEY_PATTERN = /^(?:sources|layers)\.(\S+?)(?:\.[\w-]+)*:\s/
const QUOTED_ID_PATTERN = /^(?:Source|Layer|Cannot (?:add|remove|move|style|filter) (?:non-existing )?layer|The (?:source|layer)) ["']([^"']+)["']/

function resourceIdFromMessage(message: string | null): string | null {
  if (!message) return null
  return STYLE_KEY_PATTERN.exec(message)?.[1] ?? QUOTED_ID_PATTERN.exec(message)?.[1] ?? null
}

function errorMessage(record: Record<string, unknown>): string | null {
  const inner = record.error
  if (typeof inner === 'object' && inner !== null) {
    const message = (inner as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return typeof record.message === 'string' ? record.message : null
}
