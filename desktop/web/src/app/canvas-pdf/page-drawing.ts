import type { PrintBounds, PrintPlant, PrintPoint } from '../../canvas/print'
import { PdfTextError, type TextLine } from './text'
import type { PdfHabit, PdfInput, PdfLegendEntry, PdfOperation } from './types'
import { contrastingInk } from '../../canvas/plant-colors'

import { MM, PRINT } from './print-style'
export { MM, PRINT } from './print-style'
const IDENTITY = [1, 0, 0, 1, 0, 0] as const
export function identifyPlants(plants: readonly PrintPlant[], input: Pick<PdfInput, 'commonNames' | 'locale' | 'habits' | 'englishFallbacks'>): PdfLegendEntry[] {
  const bySpecies = new Map<string, { canonicalName: string; name: string; code?: string; appearances: PrintPlant[]; habit: PdfHabit; englishFallback?: true }>()
  const fallbacks = new Set(input.englishFallbacks)
  for (const plant of plants) {
    let entry = bySpecies.get(plant.canonicalName)
    if (!entry) {
      const name = input.commonNames[plant.canonicalName]?.trim()
      entry = { canonicalName: plant.canonicalName, code: plant.speciesCode, name: name || plant.canonicalName, appearances: [],
        habit: input.habits?.[plant.canonicalName] ?? 'other', ...name && fallbacks.has(plant.canonicalName) ? { englishFallback: true as const } : {} }
      bySpecies.set(plant.canonicalName, entry)
    }
    if (!entry.appearances.some((a) => a.symbol === plant.symbol && a.color === plant.color)) entry.appearances.push(plant)
  }
  const collator = new Intl.Collator(input.locale)
  return Array.from(bySpecies.values()).sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.canonicalName, b.canonicalName))
}
interface ExtentAnchor { point: PrintPoint; left: number; top: number; right: number; bottom: number }
export function fitOverview(input: PdfInput, frame: PrintBounds, coverage: readonly PrintBounds[] = []): { ground: PrintBounds; pointsPerMeter: number } {
  const anchors: ExtentAnchor[] = []
  const at = (point: PrintPoint, left = 0, top = 0, right = 0, bottom = 0) => anchors.push({ point, left, top, right, bottom })
  for (const bounds of coverage) { at(bounds); at({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }) }
  for (const zone of input.canvas.zones) { at(zone.bounds); at({ x: zone.bounds.x + zone.bounds.width, y: zone.bounds.y + zone.bounds.height }) }
  for (const guide of input.canvas.measurements) { at(guide.start); at(guide.end) }
  for (const plant of input.canvas.plants) at(plant.position, -PRINT.marker, -PRINT.marker, PRINT.marker, PRINT.marker)
  for (const annotation of input.canvas.annotations) at(annotation.position)
  const projected = (scale: number): PrintBounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const item of anchors) {
      minX = Math.min(minX, item.point.x * scale + item.left); maxX = Math.max(maxX, item.point.x * scale + item.right)
      minY = Math.min(minY, item.point.y * scale + item.top); maxY = Math.max(maxY, item.point.y * scale + item.bottom)
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }
  const padding = 3 * MM
  let low = 0, high = Math.min(frame.width, frame.height)
  for (let i = 0; i < 55; i++) {
    const middle = (low + high) / 2, bounds = projected(middle)
    if (bounds.width <= frame.width - 2 * padding && bounds.height <= frame.height - 2 * padding) low = middle
    else high = middle
  }
  if (low < 1e-9) throw new PdfTextError('text-too-wide')
  const bounds = projected(low)
  return { pointsPerMeter: low, ground: { x: (bounds.x - (frame.width - bounds.width) / 2) / low,
    y: (bounds.y - (frame.height - bounds.height) / 2) / low, width: frame.width / low, height: frame.height / low } }
}

export function drawMark(plant: PrintPlant, x: number, y: number, radius: number, opacity: number, operations: PdfOperation[]): void {
  // PDF units are points; 16 CSS px corresponds to 12pt at 96px/in.
  const marks = radius * 2 < 12 ? plant.smallMark ?? plant.mark : plant.mark
  // Print has no outline, so cut-outs flip between paper and ink for contrast with the symbol colour.
  const cutout = contrastingInk(plant.color, PRINT.paper, PRINT.ink)
  for (const mark of marks) {operations.push({ kind: 'path', d: mark.d, matrix: [radius, 0, 0, radius, x, y],
    fill: mark.paint === 'symbol' ? plant.color : cutout, stroke: null, width: 0, opacity })}
}
export function textOp(line: TextLine, x: number, y: number, size: number, rotation = 0, opacity = 1): Extract<PdfOperation, { kind: 'text' }> {
  return { kind: 'text', line, x, y, size, rotation, opacity }
}
export function pathOp(d: string, stroke: string | null, fill: string | null, width = PRINT.stroke): Extract<PdfOperation, { kind: 'path' }> {
  return { kind: 'path', d, matrix: IDENTITY, fill, stroke, width, opacity: 1 }
}
export function rectPath(b: PrintBounds): string { return `M${b.x} ${b.y} h${b.width} v${b.height} h${-b.width} Z` }
