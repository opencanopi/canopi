import { DEFAULT_PLANT_COLOR, normalizeHexColor } from '../plant-colors'
import { isDotScale } from '../plants'
import { resolvePlantSymbolForPlant, type PlantSymbolId } from './scene/plant-symbols'
import type { ScenePlantEntity, ScenePoint } from './scene/types'
import type { SpeciesCacheEntry } from './presentation-data'
import { nearestPlantSpacing } from '../plant-spacing'
import { DEFAULT_PLANT_DISPLAY, resolveDisplayedPlantColor, type PlantDisplay } from './plant-display'

/** Stack badge count text: the 12 px type floor (digits only, so no CJK raise). */
export const STACK_BADGE_FONT_SIZE_PX = 12
/** Badge height; it is a circle for one digit and a pill for more. */
const STACK_BADGE_HEIGHT_PX = 18
const STACK_BADGE_GAP_PX = 2
// A 12 px Source Sans 3 digit is about 6.1 px wide; 7 keeps a margin for fallback fonts.
const STACK_BADGE_DIGIT_WIDTH_PX = 7
const STACK_BADGE_PADDING_PX = 5

export interface PlantPresentationContext {
  /** The view's scale: screen sizes in CSS px turn into metres with it. */
  pixelsPerMetre: number
  /** Local ground-metre scale at a plant's position (through `SessionPlane.groundScaleAt`, 2.1-M520). */
  pixelsPerMetreAt?: (point: ScenePoint) => number
  plants?: readonly ScenePlantEntity[]
  speciesCache: ReadonlyMap<string, SpeciesCacheEntry>
  plantSpeciesSymbols?: Readonly<Record<string, string>>
  localizedCommonNames?: ReadonlyMap<string, string | null>
  plantDisplay?: PlantDisplay
}

/** What a plant's footprint (its bounds, hit radius and drawn radius) reads: the scale and the plants that set its spacing. */
type PlantFootprintContext = Pick<PlantPresentationContext, 'plants' | 'pixelsPerMetre' | 'pixelsPerMetreAt' | 'plantDisplay'>

export interface PlantPresentationEntry {
  plant: ScenePlantEntity
  /** Metres to the nearest other plant (Infinity alone); with the scale it sets the radius, so a zoom reuses it. */
  spacing: number
  radiusWorld: number
  radiusScreenPx: number
  /** The drawn radius: `radiusScreenPx` to the nearest 0.25 px, so glyphs of one size share their geometry. */
  glyphRadiusPx: number
  color: string
  symbol: PlantSymbolId
  stackPriority: number
  /** Drawn as a plain disc: a far overview, or a symbol too small to read. */
  dot: boolean
  selected: boolean
}

/** Screen size of the badge that shows `text` (the stack count). */
export function getStackBadgeSizePx(text: string): { width: number; height: number } {
  return {
    width: Math.max(STACK_BADGE_HEIGHT_PX, text.length * STACK_BADGE_DIGIT_WIDTH_PX + STACK_BADGE_PADDING_PX * 2),
    height: STACK_BADGE_HEIGHT_PX,
  }
}

export function getStackBadgeOffsetPx(radiusScreenPx: number): ScenePoint {
  const offset = radiusScreenPx + STACK_BADGE_GAP_PX
  return { x: offset, y: -offset }
}

export interface PlantWorldBounds {
  x: number
  y: number
  width: number
  height: number
}

export function buildPlantPresentationEntries(
  plants: readonly ScenePlantEntity[],
  context: PlantPresentationContext,
  selectedPlantIds: ReadonlySet<string>,
): PlantPresentationEntry[] {
  const spacingFrom = context.plants ?? plants
  const display = context.plantDisplay ?? DEFAULT_PLANT_DISPLAY
  return plants.map((plant) => {
    const spacing = nearestPlantSpacing(spacingFrom, plant.position)
    const selected = selectedPlantIds.has(plant.id)
    const localScale = context.pixelsPerMetreAt ? context.pixelsPerMetreAt(plant.position) : context.pixelsPerMetre
    return {
      plant,
      spacing,
      ...plantSizeAt(spacing, localScale, display.symbolScale),
      color: resolveDisplayedPlantColor(resolvePlantBaseColor(plant), plant.canonicalName, display),
      symbol: resolvePlantSymbolForPlant(plant, context.plantSpeciesSymbols ?? {}),
      stackPriority: getStackPriority(plant, selected),
      selected,
    }
  })
}

/** The entry at another scale: only its size and its dot switch follow the scale. */
export function rescalePlantEntry(
  entry: PlantPresentationEntry,
  pixelsPerMetre: number,
  symbolScale = DEFAULT_PLANT_DISPLAY.symbolScale,
): PlantPresentationEntry {
  return { ...entry, ...plantSizeAt(entry.spacing, pixelsPerMetre, symbolScale) }
}

export function getPlantWorldBounds(
  plant: ScenePlantEntity,
  context: PlantFootprintContext,
): PlantWorldBounds {
  const radiusWorld = resolvePlantRadiusWorld(plant, context)
  return {
    x: plant.position.x - radiusWorld,
    y: plant.position.y - radiusWorld,
    width: radiusWorld * 2,
    height: radiusWorld * 2,
  }
}

/** The drawn radius plus the interaction padding, in CSS px. */
function plantHitRadiusPx(plant: ScenePlantEntity, context: PlantFootprintContext): number {
  const localScale = context.pixelsPerMetreAt ? context.pixelsPerMetreAt(plant.position) : context.pixelsPerMetre
  return resolvePlantRadiusWorld(plant, context) * localScale + 4
}

export function hitTestPlant(
  plant: ScenePlantEntity,
  point: ScenePoint,
  context: PlantFootprintContext,
): boolean {
  const localScale = context.pixelsPerMetreAt ? context.pixelsPerMetreAt(plant.position) : context.pixelsPerMetre
  const radiusWorld = plantHitRadiusPx(plant, context) / Math.max(localScale, 0.001)
  const dx = point.x - plant.position.x
  const dy = point.y - plant.position.y
  return dx * dx + dy * dy <= radiusWorld * radiusWorld
}

/** The plant's own colour, else the default plant colour. */
export function resolvePlantBaseColor(
  plant: Pick<ScenePlantEntity, 'canonicalName' | 'color'>,
): string {
  return normalizeHexColor(plant.color) ?? DEFAULT_PLANT_COLOR
}

/** The species' stratum in the loaded catalog entries; null when not loaded or the catalog has none. */
export function cachedStratum(speciesCache: ReadonlyMap<string, SpeciesCacheEntry>, canonicalName: string): string | null {
  const stratum = speciesCache.get(canonicalName)?.stratum
  return typeof stratum === 'string' && stratum.length > 0 ? stratum : null
}

/** The species' mature width in the loaded catalog entries; null when not loaded or the catalog has none. */
export function cachedWidth(speciesCache: ReadonlyMap<string, SpeciesCacheEntry>, canonicalName: string): number | null {
  const width = speciesCache.get(canonicalName)?.width_max_m
  return typeof width === 'number' && width > 0 ? width : null
}

/** The colour the plant is drawn with under the current plant display; its stored colour never changes. */
export function resolvePlantDisplayColor(
  plant: ScenePlantEntity,
  display: PlantDisplay = DEFAULT_PLANT_DISPLAY,
): string {
  return resolveDisplayedPlantColor(resolvePlantBaseColor(plant), plant.canonicalName, display)
}

/**
 * The stack badges: for each point that two or more plants share exactly, the count on the member drawn on top (the
 * selected one, then one with its own colour, then the first by id). A count never depends on the scale.
 */
export function plantStackCounts(entries: readonly PlantPresentationEntry[]): ReadonlyMap<string, number> {
  const coincident = new Map<string, PlantPresentationEntry[]>()
  for (const entry of entries) {
    const { x, y } = entry.plant.position
    const key = `${x}:${y}`
    const members = coincident.get(key)
    if (members) members.push(entry)
    else coincident.set(key, [entry])
  }
  const counts = new Map<string, number>()
  for (const members of coincident.values()) {
    if (members.length < 2) continue
    members.sort((left, right) => left.stackPriority - right.stackPriority || left.plant.id.localeCompare(right.plant.id))
    counts.set(members[0]!.plant.id, members.length)
  }
  return counts
}

// A symbol fills 42% of the distance to its nearest plant, so neighbours never touch, up to a 14 px radius: zooming
// in reaches the detailed artwork (16 px across) and still leaves room for names, notes and rings. A plant with no
// neighbour within 4 m is sized as if one stood 4 m away, never under 2 px. projectcanopi.com's featured design uses
// the same rule with an 18 px cap, as it shows plants alone.
const PLANT_SPACING_SHARE = .42
const PLANT_MAX_RADIUS_PX = 14
const LONE_PLANT_SPACING_M = 4
const LONE_PLANT_MIN_RADIUS_PX = 2

function resolvePlantRadiusWorld(plant: ScenePlantEntity, context: PlantFootprintContext): number {
  const spacing = context.plants ? nearestPlantSpacing(context.plants, plant.position) : Infinity
  const localScale = context.pixelsPerMetreAt ? context.pixelsPerMetreAt(plant.position) : context.pixelsPerMetre
  return plantSizeAt(spacing, localScale, (context.plantDisplay ?? DEFAULT_PLANT_DISPLAY).symbolScale).radiusWorld
}

/** The drawn size at a scale; the dot switch reads the drawn radius, so a glyph's shape and size change together. */
function plantSizeAt(
  spacing: number,
  pixelsPerMetre: number,
  symbolScale = DEFAULT_PLANT_DISPLAY.symbolScale,
): Pick<PlantPresentationEntry, 'radiusWorld' | 'radiusScreenPx' | 'glyphRadiusPx' | 'dot'> {
  const scale = Math.max(pixelsPerMetre, .001)
  // Display › Symbol size scales the footprint, so drawing, hit testing and bounds agree.
  const ceilingPx = Math.min(PLANT_MAX_RADIUS_PX, Math.max(LONE_PLANT_MIN_RADIUS_PX, LONE_PLANT_SPACING_M * scale * PLANT_SPACING_SHARE))
  const radiusScreenPx = Math.max(.65, Math.min(ceilingPx, spacing * scale * PLANT_SPACING_SHARE)
    * symbolScale)
  const glyphRadiusPx = Math.round(radiusScreenPx * 4) / 4
  return { radiusWorld: radiusScreenPx / scale, radiusScreenPx, glyphRadiusPx, dot: isDotScale(pixelsPerMetre) || glyphRadiusPx < 3.6 }
}

function getStackPriority(plant: ScenePlantEntity, selected: boolean): number {
  if (selected) return 0
  return normalizeHexColor(plant.color) ? 1 : 2
}
