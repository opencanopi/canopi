import { textGraphemes } from '../../utils/text-graphemes'
import type { InspectionLabel, InspectionPoint, InspectedPlant } from '../inspection'
import { LabelCollisionIndex } from '../label-collision'
import { nearestPlantSpacing } from '../plant-spacing'
import type { ScenePlantEntity } from './scene'
import type { ViewTransform } from '../../geo/view/types'

// Matches the lens name buttons: 12px type, 16px lines, 4px padding.
const INSPECTION_TYPE = { size: 12, line: 16, padding: 4 } as const

/** Plants nearest first from a point, ties by id. */
function byDistance(plants: readonly ScenePlantEntity[], centre: InspectionPoint): ScenePlantEntity[] {
  return plants.map(plant => ({ plant, distanceM: Math.hypot(plant.position.x - centre.x, plant.position.y - centre.y) }))
    .sort((a, b) => a.distanceM - b.distanceM || a.plant.id.localeCompare(b.plant.id))
    .map(({ plant }) => plant)
}

/**
 * The lens scale in preview pixels per metre: 100 px between the median of the nearest seven plants and their neighbours,
 * within 140–600, times the lens magnification. The lens builds its view from it (inspection-lens.ts), then lays out.
 */
export function inspectionScale(plants: readonly ScenePlantEntity[], centre: InspectionPoint, magnification: number): number {
  const spacing = byDistance(plants, centre).slice(0, 7).map((plant) => nearestPlantSpacing(plants, plant.position)).sort((a, b) => a - b)
  return Math.max(140, Math.min(600, 100 / (spacing[Math.floor(spacing.length / 2)] ?? Infinity))) * magnification
}

/**
 * The plants on the lens and their name buttons, through the lens's own view (turned with the main map, spec §4.13): each
 * plant at `lensView.worldToScreen(position)`, nearest the lens centre first, its name placed level on screen.
 */
export function inspectionLayout(plants: readonly ScenePlantEntity[], lensView: Pick<ViewTransform, 'worldToScreen' | 'screenToWorld' | 'screen'>,
  names: ReadonlyMap<string, string | null>, measure: (text: string) => number): InspectedPlant[] {
  const frame = lensView.screen
  const centre = lensView.screenToWorld({ x: frame.width / 2, y: frame.height / 2 })
  const visible = plants.map((plant) => {
    const p = lensView.worldToScreen(plant.position)
    return { plant, distanceM: Math.hypot(plant.position.x - centre.x, plant.position.y - centre.y), screenPosition: { x: p.x, y: p.y } }
  }).sort((a, b) => a.distanceM - b.distanceM || a.plant.id.localeCompare(b.plant.id))
    .filter(({ screenPosition: p }) => p.x >= 0 && p.y >= 0 && p.x <= frame.width && p.y <= frame.height)
  const occupied = new LabelCollisionIndex()
  // The centre crosshair (InspectionLens.tsx, arms out to 10 px plus their halo) and every plant stay clear of names.
  occupied.add({ x: frame.width / 2 - 12, y: frame.height / 2 - 12, width: 24, height: 24 })
  for (const { screenPosition: p } of visible) occupied.add({ x: p.x - 10, y: p.y - 10, width: 20, height: 20 })
  return visible.map(({ plant, screenPosition: p }) => {
    const name = names.get(plant.canonicalName)?.trim() || plant.commonName?.trim() || plant.canonicalName
    const lines = wrapName(name, Math.max(1, Math.min(220, frame.width - 24) - 8), measure)
    const width = Math.max(...lines.map(measure)) + 8, height = lines.length * INSPECTION_TYPE.line + 8
    const centredX = Math.max(4, Math.min(frame.width - width - 4, p.x - width / 2))
    const candidates = [
      { x: centredX, y: p.y + 13 }, { x: centredX, y: p.y - 13 - height },
      { x: p.x + 13, y: p.y - height / 2 }, { x: p.x - 13 - width, y: p.y - height / 2 },
    ]
    const bounds = candidates.map(position => ({ ...position, width, height }))
      .find(box => box.x >= 4 && box.y >= 4 && box.x + width <= frame.width - 4 && box.y + height <= frame.height - 4 && !occupied.overlaps(box))
    let label: InspectionLabel | null = null
    if (bounds) { occupied.add(bounds); label = { ...bounds, lines } }
    return { id: plant.id, name, screenPosition: p, label }
  })
}

function wrapName(name: string, width: number, measure: (text: string) => number): string[] {
  const result: string[] = []
  let line = ''
  // Grapheme boundaries retain accents, combining marks and CJK without ellipses.
  for (const segment of textGraphemes(name)) {
    if (line && measure(line + segment) > width) { result.push(line); line = '' }
    line += segment
  }
  if (line) result.push(line)
  return result.length ? result : ['']
}
