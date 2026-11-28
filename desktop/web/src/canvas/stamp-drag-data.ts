import { signal } from '@preact/signals'
import type { SavedObjectStampPayload } from './saved-object-stamp-payload'
import { parseSavedObjectStampPayload } from './saved-object-stamp-payload'
import type { SavedObjectStamp } from '../types/saved-object-stamps'

const PLANT_STAMP_MIME = 'application/x.canopi.plant-stamp+json'
const SAVED_OBJECT_STAMP_MIME = 'application/x.canopi.saved-object-stamp+json'
const LEGACY_TEXT_MIME = 'text/plain'

export interface PlantStampSource {
  readonly canonical_name: string
  readonly common_name: string | null
  readonly stratum: string | null
  readonly width_max_m: number | null
}

export interface PlantStampSourceInput {
  readonly canonical_name: string
  readonly common_name: string | null
  readonly stratum: string | null
  readonly width_max_m: number | null
}

type WritableDragData = Pick<DataTransfer, 'setData'> & { effectAllowed?: string }
type DragDataTypes = {
  readonly types?: {
    readonly length: number
    readonly [index: number]: string | undefined
    includes?(type: string): boolean
    item?(index: number): string | null
    contains?(type: string): boolean
  }
}
type ReadableDragData = Pick<DataTransfer, 'getData'> & DragDataTypes

const RECENT_PLANT_STAMP_SOURCE_LIMIT = 8
/** Species chosen to place this session, newest first; Place plants' chooser offers them. */
export const recentPlantStampSources = signal<readonly PlantStampSource[]>([])

const activeSavedObjectStampDragSource = signal<SavedObjectStampPayload | null>(null)
const activeSavedObjectStampDragName = signal<string | null>(null)

function plantStampSourceFromSpecies(source: PlantStampSourceInput): PlantStampSource {
  return {
    canonical_name: source.canonical_name,
    common_name: source.common_name,
    stratum: source.stratum,
    width_max_m: source.width_max_m,
  }
}

/** Records a species chosen for Place plants in the session's recent list (newest first). */
export function recordRecentPlantStampSource(source: PlantStampSourceInput): PlantStampSource {
  const next = plantStampSourceFromSpecies(source)
  recentPlantStampSources.value = [
    next,
    ...recentPlantStampSources.peek().filter((entry) => entry.canonical_name !== next.canonical_name),
  ].slice(0, RECENT_PLANT_STAMP_SOURCE_LIMIT)
  return next
}

export function writePlantStampDragData(
  dataTransfer: WritableDragData | null | undefined,
  source: PlantStampSourceInput,
): PlantStampSource | null {
  if (!dataTransfer) return null
  const next = plantStampSourceFromSpecies(source)
  const serialized = JSON.stringify(next)
  dataTransfer.setData(PLANT_STAMP_MIME, serialized)
  dataTransfer.setData(LEGACY_TEXT_MIME, serialized)
  dataTransfer.effectAllowed = 'copy'
  return next
}

function readPlantStampDragData(
  dataTransfer: ReadableDragData | null | undefined,
): PlantStampSource | null {
  if (!dataTransfer) return null
  for (const mimeType of [PLANT_STAMP_MIME, LEGACY_TEXT_MIME]) {
    let raw = ''
    try {
      raw = dataTransfer.getData(mimeType)
    } catch {
      // DataTransfer.getData throws when the browser withholds drag data outside drop.
      return null
    }
    const source = parsePlantStampSource(raw)
    if (source) return source
  }
  return null
}

export function hasPlantStampDragData(
  dataTransfer: ReadableDragData | null | undefined,
): boolean {
  if (!dataTransfer) return false
  if (hasDragDataType(dataTransfer, PLANT_STAMP_MIME)) return true
  return readPlantStampDragData(dataTransfer) !== null
}

export function readPlantStampDropSource(event: DragEvent): PlantStampSource | null {
  return readPlantStampDragData(event.dataTransfer)
}

export function writeSavedObjectStampDragData(
  dataTransfer: WritableDragData | null | undefined,
  stamp: SavedObjectStamp,
): SavedObjectStampPayload | null {
  if (!dataTransfer) return null
  const payload = parseSavedObjectStampPayload(stamp.payload_json)
  if (!payload) return null
  const serialized = JSON.stringify(payload)
  dataTransfer.setData(SAVED_OBJECT_STAMP_MIME, serialized)
  dataTransfer.setData(LEGACY_TEXT_MIME, serialized)
  dataTransfer.effectAllowed = 'copy'
  activeSavedObjectStampDragSource.value = payload
  activeSavedObjectStampDragName.value = stamp.name.trim() || null
  return payload
}

function readSavedObjectStampDragData(
  dataTransfer: ReadableDragData | null | undefined,
): SavedObjectStampPayload | null {
  if (!dataTransfer) return null
  for (const mimeType of [SAVED_OBJECT_STAMP_MIME, LEGACY_TEXT_MIME]) {
    let raw = ''
    try {
      raw = dataTransfer.getData(mimeType)
    } catch {
      // DataTransfer.getData throws when the browser withholds drag data outside drop.
      return null
    }
    const payload = parseSavedObjectStampPayload(raw)
    if (payload) return payload
  }
  return null
}

export function hasSavedObjectStampDragData(
  dataTransfer: ReadableDragData | null | undefined,
): boolean {
  if (!dataTransfer) return false
  if (hasDragDataType(dataTransfer, SAVED_OBJECT_STAMP_MIME)) return true
  return readSavedObjectStampDragData(dataTransfer) !== null
}

export function readSavedObjectStampDragPreviewSource(
  dataTransfer: ReadableDragData | null | undefined,
): SavedObjectStampPayload | null {
  return readSavedObjectStampDragData(dataTransfer)
    ?? (hasDragDataType(dataTransfer ?? {}, SAVED_OBJECT_STAMP_MIME)
      ? activeSavedObjectStampDragSource.value
      : null)
}

export function readSavedObjectStampDropSource(event: DragEvent): SavedObjectStampPayload | null {
  return readSavedObjectStampDragData(event.dataTransfer)
}

/** The name of the saved stamp being dragged from Favorites, for the tool card when an overview drop picks it. */
export function readSavedObjectStampDragName(): string | null {
  return activeSavedObjectStampDragSource.value ? activeSavedObjectStampDragName.value : null
}

export function clearSavedObjectStampDragSource(): void {
  activeSavedObjectStampDragSource.value = null
  activeSavedObjectStampDragName.value = null
}

function hasDragDataType(dataTransfer: DragDataTypes, type: string): boolean {
  const types = dataTransfer.types
  if (!types) return false
  if (typeof types.includes === 'function') return types.includes(type)
  if (typeof types.contains === 'function') return types.contains(type)
  for (let i = 0; i < types.length; i += 1) {
    const item = typeof types.item === 'function' ? types.item(i) : types[i]
    if (item === type) return true
  }
  return false
}

function parsePlantStampSource(raw: string): PlantStampSource | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (typeof data.canonical_name !== 'string' || data.canonical_name.trim() === '') return null
    return {
      canonical_name: data.canonical_name,
      common_name: typeof data.common_name === 'string' ? data.common_name : null,
      stratum: typeof data.stratum === 'string' ? data.stratum : null,
      width_max_m: typeof data.width_max_m === 'number' && Number.isFinite(data.width_max_m)
        ? data.width_max_m
        : null,
    }
  } catch {
    // Malformed drag payload JSON is treated as not a plant stamp.
    return null
  }
}
