import type {
  SceneObjectGroupMember,
  ScenePoint,
} from './runtime/scene'

/**
 * Payload format of a saved stamp. Version 3 (Canopi 2.1, `2.1-M88`) standardises on
 * snake_case fields (`canonical_name`, `canopy_spread_m`, `rotation_deg`, `zone_type`,
 * `fill_color`, `annotation_type`, `font_size`, `measurement_guides`, plus species/budget/care
 * metadata) while continuing to read Canopi 2.0 version 2 (camelCase) payloads seamlessly.
 * Version 1 payloads from before 2.0 and anything newer than v3 are refused here; a v1 stamp
 * stays deletable and a v4+ stamp is listed as needing a newer Canopi (app/saved-object-stamps/row-state.ts).
 */
export const SAVED_OBJECT_STAMP_PAYLOAD_VERSION = 2
export const SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION = 3

interface SavedObjectStampGuide {
  readonly id: string
  readonly start: ScenePoint
  readonly end: ScenePoint
  readonly locked?: boolean
}

interface SavedObjectStampConsortium {
  readonly canonicalName: string
  readonly stratum: string
  readonly startPhase: number
  readonly endPhase: number
}

interface SavedObjectStampBudgetLine {
  readonly canonicalName: string
  readonly unitCost: number
}

interface SavedObjectStampCareAction {
  readonly title: string
  readonly category: string
  readonly offsetDays?: number | null
  readonly notes?: string | null
  readonly recurrence?: unknown
  readonly targets?: readonly unknown[]
}

/**
 * 2.1-Q168 species-code rule: keep the destination Design's code if the species already exists;
 * otherwise keep the stamp's code if unused, or disambiguate with a numeric suffix.
 */
export function mergeStampSpeciesCodes(
  existing: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!incoming) return { ...existing }
  const next: Record<string, string> = { ...existing }
  const used = new Set(Object.values(next))
  for (const [species, code] of Object.entries(incoming)) {
    if (next[species]) continue
    let candidate = code
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${code}${suffix}`
      suffix += 1
    }
    next[species] = candidate
    used.add(candidate)
  }
  return next
}

export interface SavedObjectStampPayload {
  readonly version: typeof SAVED_OBJECT_STAMP_PAYLOAD_VERSION | typeof SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION
  readonly anchor: ScenePoint
  readonly plants: SavedObjectStampPlant[]
  readonly zones: SavedObjectStampZone[]
  readonly annotations: SavedObjectStampAnnotation[]
  readonly groups: SavedObjectStampGroup[]
  readonly measurementGuides?: SavedObjectStampGuide[]
  readonly plantSpeciesColors?: Readonly<Record<string, string>>
  readonly plantSpeciesSymbols?: Readonly<Record<string, string>>
  readonly plantSpeciesCodes?: Readonly<Record<string, string>>
  readonly consortiums?: readonly SavedObjectStampConsortium[]
  readonly budget?: readonly SavedObjectStampBudgetLine[]
  readonly timeline?: readonly SavedObjectStampCareAction[]
}

export interface SavedObjectStampPlant {
  readonly id: string
  readonly canonicalName: string
  readonly commonName: string | null
  readonly color: string | null
  readonly symbol?: string | null
  readonly position: ScenePoint
  readonly rotationDeg: number | null
  readonly scale: number | null
  readonly locked?: boolean
  readonly pinnedName?: boolean
  readonly notes?: string | null
  readonly plantedDate?: string | null
  readonly quantity?: number
}

export interface SavedObjectStampZone {
  readonly id: string
  /** The zone's display name; null when the user has not named it. */
  readonly name: string | null
  readonly zoneType: string
  readonly points: ScenePoint[]
  readonly rotationDeg: number
  readonly fillColor: string | null
  readonly strokeColor?: string | null
  readonly opacity?: number | null
  readonly locked?: boolean
  readonly notes?: string | null
}

export interface SavedObjectStampAnnotation {
  readonly id: string
  readonly annotationType: string
  readonly position: ScenePoint
  readonly text: string
  readonly fontSize: number
  readonly rotationDeg: number | null
  readonly locked?: boolean
  readonly color?: string | null
}

interface SavedObjectStampGroup {
  readonly id: string
  readonly name: string | null
  readonly members: SceneObjectGroupMember[]
}

export function parseSavedObjectStampPayload(raw: string): SavedObjectStampPayload | null {
  if (!raw) return null

  try {
    return normalizeSavedObjectStampPayload(JSON.parse(raw))
  } catch {
    return null
  }
}

function normalizeSavedObjectStampPayload(raw: unknown): SavedObjectStampPayload | null {
  if (!isRecord(raw)) return null
  if (raw.version === SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION) {
    return normalizeSavedObjectStampPayloadV3(raw)
  }
  if (raw.version !== SAVED_OBJECT_STAMP_PAYLOAD_VERSION) return null
  const anchor = pointFromUnknown(raw.anchor)
  if (!anchor) return null

  const plants = arrayFromUnknown(raw.plants, plantFromUnknown)
  const zones = arrayFromUnknown(raw.zones, zoneFromUnknown)
  const annotations = arrayFromUnknown(raw.annotations, annotationFromUnknown)
  const groups = arrayFromUnknown(raw.groups, groupFromUnknown)
  if (!plants || !zones || !annotations || !groups) return null

  return {
    version: SAVED_OBJECT_STAMP_PAYLOAD_VERSION,
    anchor,
    plants,
    zones,
    annotations,
    groups,
  }
}

function optionalArrayFromUnknown<T>(raw: unknown, item: (value: unknown) => T | null): T[] | undefined {
  if (raw === undefined) return undefined
  const parsed = arrayFromUnknown(raw, item)
  return parsed && parsed.length > 0 ? parsed : undefined
}

function normalizeSavedObjectStampPayloadV3(raw: Record<string, unknown>): SavedObjectStampPayload | null {
  const anchor = pointFromUnknown(raw.anchor)
  if (!anchor) return null

  const plants = arrayFromUnknown(raw.plants, plantFromV3)
  const zones = arrayFromUnknown(raw.zones, zoneFromV3)
  const annotations = arrayFromUnknown(raw.annotations, annotationFromV3)
  const groups = arrayFromUnknown(raw.groups, groupFromV3)
  if (!plants || !zones || !annotations || !groups) return null

  const result: Record<string, unknown> = {
    version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
    anchor,
    plants,
    zones,
    annotations,
    groups,
  }
  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ['measurementGuides', optionalArrayFromUnknown(raw.measurement_guides, guideFromV3)],
    ['plantSpeciesColors', stringRecordFromUnknown(raw.plant_species_colors)],
    ['plantSpeciesSymbols', stringRecordFromUnknown(raw.plant_species_symbols)],
    ['plantSpeciesCodes', stringRecordFromUnknown(raw.plant_species_codes)],
    ['consortiums', optionalArrayFromUnknown(raw.consortiums, consortiumFromV3)],
    ['budget', optionalArrayFromUnknown(raw.budget, budgetFromV3)],
    ['timeline', optionalArrayFromUnknown(raw.timeline, careActionFromV3)],
  ]
  for (const [key, value] of optional) {
    if (value !== undefined) result[key] = value
  }
  return result as unknown as SavedObjectStampPayload
}

function stringRecordFromUnknown(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = {}
  let count = 0
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = v
      count += 1
    }
  }
  return count > 0 ? out : undefined
}

function guideFromV3(data: unknown): SavedObjectStampGuide | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const start = pointFromUnknown(data.start)
  const end = pointFromUnknown(data.end)
  if (!id || !start || !end) return null
  return { id, start, end, ...(data.locked === true ? { locked: true } : {}) }
}

function consortiumFromV3(data: unknown): SavedObjectStampConsortium | null {
  if (!isRecord(data)) return null
  const canonicalName = stringFromUnknown(data.canonical_name)
  const stratum = stringFromUnknown(data.stratum)
  const startPhase = numberFromUnknown(data.start_phase)
  const endPhase = numberFromUnknown(data.end_phase)
  if (!canonicalName || !stratum || startPhase === null || endPhase === null) return null
  return { canonicalName, stratum, startPhase, endPhase }
}

function budgetFromV3(data: unknown): SavedObjectStampBudgetLine | null {
  if (!isRecord(data)) return null
  const canonicalName = stringFromUnknown(data.canonical_name)
  const unitCost = numberFromUnknown(data.unit_cost)
  if (!canonicalName || unitCost === null) return null
  return { canonicalName, unitCost }
}

function careActionFromV3(data: unknown): SavedObjectStampCareAction | null {
  if (!isRecord(data)) return null
  const title = stringFromUnknown(data.title)
  const category = stringFromUnknown(data.category)
  if (!title || !category) return null
  return {
    title,
    category,
    offsetDays: nullableNumberFromUnknown(data.offset_days),
    notes: nullableStringFromUnknown(data.notes),
    ...(data.recurrence !== undefined ? { recurrence: data.recurrence } : {}),
    ...(Array.isArray(data.targets) ? { targets: data.targets } : {}),
  }
}

export function serializeSavedObjectStampPayloadV3(payload: SavedObjectStampPayload): string {
  const v3: Record<string, unknown> = {
    version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
    anchor: payload.anchor,
    plants: payload.plants.map((p) => ({
      id: p.id,
      canonical_name: p.canonicalName,
      common_name: p.commonName,
      color: p.color,
      ...(p.symbol !== undefined ? { symbol: p.symbol } : {}),
      position: p.position,
      rotation_deg: p.rotationDeg,
      canopy_spread_m: p.scale,
      ...(p.locked ? { locked: true } : {}),
      ...(p.pinnedName ? { pinned_name: true } : {}),
      ...(p.notes != null ? { notes: p.notes } : {}),
      ...(p.plantedDate != null ? { planted_date: p.plantedDate } : {}),
      ...(p.quantity != null ? { quantity: p.quantity } : {}),
    })),
    zones: payload.zones.map((z) => ({
      id: z.id,
      name: z.name,
      zone_type: z.zoneType,
      points: z.points,
      rotation_deg: z.rotationDeg,
      fill_color: z.fillColor,
      ...(z.strokeColor != null ? { stroke_color: z.strokeColor } : {}),
      ...(z.opacity != null ? { opacity: z.opacity } : {}),
      ...(z.locked ? { locked: true } : {}),
      ...(z.notes != null ? { notes: z.notes } : {}),
    })),
    annotations: payload.annotations.map((a) => ({
      id: a.id,
      annotation_type: a.annotationType,
      position: a.position,
      text: a.text,
      font_size: a.fontSize,
      rotation_deg: a.rotationDeg,
      ...(a.locked ? { locked: true } : {}),
      ...(a.color != null ? { color: a.color } : {}),
    })),
    measurement_guides: (payload.measurementGuides ?? []).map((g) => ({
      id: g.id,
      start: g.start,
      end: g.end,
      ...(g.locked ? { locked: true } : {}),
    })),
    groups: payload.groups.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({
        kind: m.kind === 'measurement-guide' ? 'measurement_guide' : m.kind,
        id: m.id,
      })),
    })),
    ...(payload.plantSpeciesColors ? { plant_species_colors: payload.plantSpeciesColors } : {}),
    ...(payload.plantSpeciesSymbols ? { plant_species_symbols: payload.plantSpeciesSymbols } : {}),
    ...(payload.plantSpeciesCodes ? { plant_species_codes: payload.plantSpeciesCodes } : {}),
    ...(payload.consortiums?.length
      ? {
          consortiums: payload.consortiums.map((c) => ({
            canonical_name: c.canonicalName,
            stratum: c.stratum,
            start_phase: c.startPhase,
            end_phase: c.endPhase,
          })),
        }
      : {}),
    ...(payload.budget?.length
      ? {
          budget: payload.budget.map((b) => ({
            canonical_name: b.canonicalName,
            unit_cost: b.unitCost,
          })),
        }
      : {}),
    ...(payload.timeline?.length
      ? {
          timeline: payload.timeline.map((a) => ({
            title: a.title,
            category: a.category,
            ...(a.offsetDays != null ? { offset_days: a.offsetDays } : {}),
            ...(a.notes != null ? { notes: a.notes } : {}),
            ...(a.recurrence !== undefined ? { recurrence: a.recurrence } : {}),
            ...(a.targets !== undefined ? { targets: a.targets } : {}),
          })),
        }
      : {}),
  }
  return JSON.stringify(v3)
}

function plantFromV3(data: unknown): SavedObjectStampPlant | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const canonicalName = stringFromUnknown(data.canonical_name)
  const position = pointFromUnknown(data.position)
  if (!id || !canonicalName || !position) return null

  return {
    id,
    canonicalName,
    commonName: nullableStringFromUnknown(data.common_name),
    color: nullableStringFromUnknown(data.color),
    symbol: nullableStringFromUnknown(data.symbol),
    position,
    rotationDeg: nullableNumberFromUnknown(data.rotation_deg),
    scale: nullableNumberFromUnknown(data.canopy_spread_m),
    ...(data.locked === true ? { locked: true } : {}),
    ...(data.pinned_name === true ? { pinnedName: true } : {}),
    ...(data.notes !== undefined ? { notes: nullableStringFromUnknown(data.notes) } : {}),
    ...(data.planted_date !== undefined ? { plantedDate: nullableStringFromUnknown(data.planted_date) } : {}),
    ...(typeof data.quantity === 'number' ? { quantity: data.quantity } : {}),
  }
}

function zoneFromV3(data: unknown): SavedObjectStampZone | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const name = nullableStringFromUnknown(data.name)
  const zoneType = stringFromUnknown(data.zone_type)
  const points = arrayFromUnknown(data.points, pointFromUnknown)
  if (!id || !zoneType || !points || points.length === 0) return null

  return {
    id,
    name,
    zoneType,
    points,
    rotationDeg: numberFromUnknown(data.rotation_deg) ?? 0,
    fillColor: nullableStringFromUnknown(data.fill_color),
    ...(data.stroke_color !== undefined ? { strokeColor: nullableStringFromUnknown(data.stroke_color) } : {}),
    ...(data.opacity !== undefined ? { opacity: nullableNumberFromUnknown(data.opacity) } : {}),
    ...(data.locked === true ? { locked: true } : {}),
    ...(data.notes !== undefined ? { notes: nullableStringFromUnknown(data.notes) } : {}),
  }
}

function annotationFromV3(data: unknown): SavedObjectStampAnnotation | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const annotationType = stringFromUnknown(data.annotation_type)
  const position = pointFromUnknown(data.position)
  const text = stringFromUnknown(data.text)
  const fontSize = numberFromUnknown(data.font_size)
  if (!id || !annotationType || !position || text === null || fontSize === null) return null

  return {
    id,
    annotationType,
    position,
    text,
    fontSize,
    rotationDeg: nullableNumberFromUnknown(data.rotation_deg),
    ...(data.locked === true ? { locked: true } : {}),
    ...(data.color !== undefined ? { color: nullableStringFromUnknown(data.color) } : {}),
  }
}

function groupFromV3(data: unknown): SavedObjectStampGroup | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  if (!id || !Array.isArray(data.members)) return null
  const members: SceneObjectGroupMember[] = []
  for (const entry of data.members) {
    if (!isRecord(entry)) return null
    const memberId = stringFromUnknown(entry.id)
    if (!memberId) return null
    if (entry.kind === 'plant' || entry.kind === 'zone' || entry.kind === 'annotation') {
      members.push({ kind: entry.kind, id: memberId })
    } else if (entry.kind === 'measurement_guide' || entry.kind === 'measurement-guide') {
      members.push({ kind: 'measurement-guide', id: memberId })
    } else {
      return null
    }
  }
  return {
    id,
    name: nullableStringFromUnknown(data.name),
    members,
  }
}

function plantFromUnknown(data: unknown): SavedObjectStampPlant | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const canonicalName = stringFromUnknown(data.canonicalName)
  const position = pointFromUnknown(data.position)
  if (!id || !canonicalName || !position) return null

  return {
    id,
    canonicalName,
    commonName: nullableStringFromUnknown(data.commonName),
    color: nullableStringFromUnknown(data.color),
    symbol: nullableStringFromUnknown(data.symbol),
    position,
    rotationDeg: nullableNumberFromUnknown(data.rotationDeg),
    scale: nullableNumberFromUnknown(data.scale),
  }
}

function zoneFromUnknown(data: unknown): SavedObjectStampZone | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const name = nullableStringFromUnknown(data.name)
  const zoneType = stringFromUnknown(data.zoneType)
  const points = arrayFromUnknown(data.points, pointFromUnknown)
  if (!id || !zoneType || !points || points.length === 0) return null

  return {
    id,
    name,
    zoneType,
    points,
    rotationDeg: numberFromUnknown(data.rotationDeg) ?? 0,
    fillColor: nullableStringFromUnknown(data.fillColor),
  }
}

function annotationFromUnknown(data: unknown): SavedObjectStampAnnotation | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  const annotationType = stringFromUnknown(data.annotationType)
  const position = pointFromUnknown(data.position)
  const text = stringFromUnknown(data.text)
  const fontSize = numberFromUnknown(data.fontSize)
  if (!id || !annotationType || !position || text === null || fontSize === null) return null

  return {
    id,
    annotationType,
    position,
    text,
    fontSize,
    rotationDeg: nullableNumberFromUnknown(data.rotationDeg),
  }
}

function groupFromUnknown(data: unknown): SavedObjectStampGroup | null {
  if (!isRecord(data)) return null
  const id = stringFromUnknown(data.id)
  if (!id) return null
  const members = arrayFromUnknown(data.members, groupMemberFromUnknown)
  if (!members) return null

  return {
    id,
    name: nullableStringFromUnknown(data.name),
    members,
  }
}

function groupMemberFromUnknown(data: unknown): SceneObjectGroupMember | null {
  if (!isRecord(data)) return null
  const kind = data.kind
  const id = stringFromUnknown(data.id)
  if (!id) return null
  if (kind === 'plant' || kind === 'zone' || kind === 'annotation') return { kind, id }
  return null
}

function pointFromUnknown(data: unknown): ScenePoint | null {
  if (!isRecord(data)) return null
  const x = numberFromUnknown(data.x)
  const y = numberFromUnknown(data.y)
  if (x === null || y === null) return null
  return { x, y }
}

function arrayFromUnknown<T>(
  data: unknown,
  map: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(data)) return null
  const result: T[] = []
  for (const entry of data) {
    const mapped = map(entry)
    if (mapped === null) return null
    result.push(mapped)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function nullableStringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableNumberFromUnknown(value: unknown): number | null {
  return value === null || value === undefined ? null : numberFromUnknown(value)
}
