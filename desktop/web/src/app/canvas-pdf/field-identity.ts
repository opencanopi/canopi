import type { PrintBounds, PrintPlant } from '../../canvas/print'
import type { PdfEnclosure, PdfOperation } from './types'
import { pathOp } from './page-drawing'
import { MM } from './print-style'
import { contains } from './field-geometry'

export const appearanceKey = (plant: PrintPlant): string => JSON.stringify([plant.symbol, plant.color.toLowerCase()])
const identityKey = (plant: PrintPlant): string => JSON.stringify([appearanceKey(plant), plant.canonicalName])

export type FieldPredicate = PrintBounds | ((plant: PrintPlant) => boolean)

export function assignFieldIdentity(plants: readonly PrintPlant[], fields?: readonly FieldPredicate[]): ReadonlyMap<string, PdfEnclosure> {
  const counts = new Map<string, number>(), neighbours = new Map<string, Set<string>>()
  for (const p of plants) { const key = identityKey(p); counts.set(key, (counts.get(key) ?? 0) + 1); neighbours.set(key, new Set()) }
  for (const field of fields ?? [undefined]) {
    const groups = new Map<string, Set<string>>()
    for (const p of plants) {
      if (field && !(typeof field === 'function' ? field(p) : contains(field, p.position))) continue
      const appearance = appearanceKey(p), group = groups.get(appearance) ?? new Set<string>()
      group.add(identityKey(p)); groups.set(appearance, group)
    }
    for (const group of groups.values()) for (const key of group) for (const other of group) if (other !== key) neighbours.get(key)!.add(other)
  }
  const result = new Map<string, PdfEnclosure>(), styles: PdfEnclosure[] = ['plain', 'circle', 'square', 'diamond']
  for (const key of [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || neighbours.get(b)!.size - neighbours.get(a)!.size || a.localeCompare(b, 'en'))) {
    const used = new Set([...neighbours.get(key)!].map(n => result.get(n)))
    result.set(key, styles.find(style => !used.has(style)) ?? 'code')
  }
  return result
}

/** Frequency is local to the sheet; whole-Design choices only break equal-frequency ties. */
export function fieldIdentity(plants: readonly PrintPlant[], all: readonly PrintPlant[], assigned = assignFieldIdentity(all)): ReadonlyMap<string, PdfEnclosure> {
  const groups = new Map<string, Map<string, PrintPlant[]>>()
  for (const p of plants) {
    const appearance = appearanceKey(p), group = groups.get(appearance) ?? new Map<string, PrintPlant[]>()
    const members = group.get(p.canonicalName) ?? []
    members.push(p); group.set(p.canonicalName, members); groups.set(appearance, group)
  }
  const result = new Map<string, PdfEnclosure>(), styles: PdfEnclosure[] = ['plain', 'circle', 'square', 'diamond']
  for (const group of groups.values()) {
    const ordered = [...group.values()].sort((a, b) => b.length - a.length
      || [...styles, 'code'].indexOf(assigned.get(identityKey(a[0]!))!) - [...styles, 'code'].indexOf(assigned.get(identityKey(b[0]!))!)
      || a[0]!.canonicalName.localeCompare(b[0]!.canonicalName, 'en'))
    let next = 0
    for (const members of ordered) {
      // Spend text on occasional occurrences, keeping repeated patterns quick to scan.
      const occasional = members.length <= 3 && members.length * 3 < ordered[0]!.length
      const style = group.size === 1 ? 'plain' : occasional ? 'code' : styles[next++] ?? 'code'
      for (const plant of members) result.set(plant.id, style)
    }
  }
  return result
}

export function enclosureRadius(style: PdfEnclosure, radius: number): number {
  return style === 'plain' || style === 'code' ? radius : (radius + .35 * MM) * (style === 'diamond' ? 1.3 : 1) + .09 * MM
}

export function drawEnclosure(style: PdfEnclosure, x: number, y: number, radius: number, opacity: number, operations: PdfOperation[]): void {
  if (style === 'plain' || style === 'code') return
  const r = radius + .35 * MM, k = r * .5522847498307936
  const d = style === 'circle' ? `M${x + r} ${y} C${x + r} ${y + k} ${x + k} ${y + r} ${x} ${y + r} C${x - k} ${y + r} ${x - r} ${y + k} ${x - r} ${y} C${x - r} ${y - k} ${x - k} ${y - r} ${x} ${y - r} C${x + k} ${y - r} ${x + r} ${y - k} ${x + r} ${y} Z`
    : style === 'square' ? `M${x - r} ${y - r} h${2 * r} v${2 * r} h${-2 * r} Z`
      : `M${x} ${y - r * 1.3} L${x + r * 1.3} ${y} L${x} ${y + r * 1.3} L${x - r * 1.3} ${y} Z`
  operations.push({ ...pathOp(d, '#24211c', null, .18 * MM), opacity })
}
