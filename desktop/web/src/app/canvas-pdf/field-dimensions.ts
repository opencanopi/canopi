import type { CanvasPrintSnapshot, PrintPoint as Point } from '../../canvas/print'
import { clipSegment, contains, distance, inflate, type Segment } from './field-geometry'
import type { FieldSpace, FieldLabel } from './field-placement'

type Guide = CanvasPrintSnapshot['measurements'][number]
export interface FieldDimension { guide: Guide; label: FieldLabel; segments: Segment[]; ticks: Segment[]; cost: number }

/** Dimension strokes have a real gap around their text; artwork is never erased. */
export function fieldDimensions(guides: readonly Guide[], point: (p: Point) => Point, space: FieldSpace, locale: string, size = 8.5): FieldDimension[] {
  const result: FieldDimension[] = [], number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const ordered = [...guides].sort((a, b) => distance(a.start, a.end) - distance(b.start, b.end) || a.start.y - b.start.y || a.start.x - b.start.x || a.id.localeCompare(b.id))
  for (const guide of ordered) {
    const a = point(guide.start), b = point(guide.end), length = distance(a, b)
    if (length < 1e-8) continue
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, n = { x: -u.y, y: u.x }
    const measured = space.measure(`${number.format(distance(guide.start, guide.end))} m`, size, Infinity, true)
    const vertical = Math.abs(u.y) > .9, width = vertical ? measured.height : measured.width, height = vertical ? measured.width : measured.height
    const ignored = [...space.marks].filter(([, r]) => contains(inflate(r, .1), a) || contains(inflate(r, .1), b)).map(([id]) => id)
    let chosen: FieldDimension | undefined
    for (const offset of [0, -1.5, 1.5, -2.5, 2.5, -4, 4, -6, 6, -8, 8, -11, 11, -15, 15]) {
      const oa = { x: a.x + n.x * offset, y: a.y + n.y * offset }, ob = { x: b.x + n.x * offset, y: b.y + n.y * offset }
      const alongSize = Math.abs(u.x) * width + Math.abs(u.y) * height
      const positions = length > alongSize + 1.5 ? [.5, .4, .6, .3, .7, .2, .8].map(t => t * length)
        : [-alongSize / 2 - 1.5, length + alongSize / 2 + 1.5]
      for (const position of positions) {
        const mid = { x: oa.x + u.x * position, y: oa.y + u.y * position }
        const bounds = { x: mid.x - width / 2, y: mid.y - height / 2, width, height }
        if (!space.clear(bounds)) continue
        const main = { a: oa, b: ob }, gap = clipSegment(main, inflate(bounds, .5))
        const segments: Segment[] = gap ? [{ a: oa, b: gap.a }, { a: gap.b, b: ob }] : [main]
        for (const [start, end] of [[a, oa], [b, ob]]) {
          segments.push({
            a: { x: start!.x + n.x * Math.sign(offset) * .6, y: start!.y + n.y * Math.sign(offset) * .6 },
            b: { x: end!.x + n.x * Math.sign(offset) * .6, y: end!.y + n.y * Math.sign(offset) * .6 },
          })
        }
        const ticks = [oa, ob].map(p => ({ a: { x: p.x - (u.x + n.x) * .55, y: p.y - (u.y + n.y) * .55 }, b: { x: p.x + (u.x + n.x) * .55, y: p.y + (u.y + n.y) * .55 } }))
        if (!space.pathClear([...segments, ...ticks], ignored) || !space.keepsCodesBeside([...segments, ...ticks])) continue
        // A long dimension must not sit on an existing shorter measurement.
        if (space.segments.some(s => {
          const l = distance(s.a, s.b)
          if (l < 1) return false
          if (Math.abs(u.x * (s.b.y - s.a.y) - u.y * (s.b.x - s.a.x)) / l > .04) return false
          if (Math.max(...[s.a, s.b].map(p => Math.abs((p.x - oa.x) * u.y - (p.y - oa.y) * u.x))) > .5) return false
          const positions = [s.a, s.b].map(p => (p.x - oa.x) * u.x + (p.y - oa.y) * u.y)
          return Math.min(length, Math.max(...positions)) - Math.max(0, Math.min(...positions)) > 1
        })) continue
        const origin = vertical ? { x: bounds.x + measured.baseline, y: bounds.y + measured.width - measured.inset } : undefined
        const cost = Math.abs(offset) + Math.abs(position - length / 2) * .1
        if (chosen && chosen.cost <= cost) continue
        chosen = { guide, segments, ticks, cost, label: { ...measured, bounds, origin, rotation: vertical ? -90 : 0, route: [], target: '', ids: [], color: '#24211c' } }
      }
    }
    if (chosen) {
      space.reserve(chosen.label.bounds); space.addSegments([...chosen.segments, ...chosen.ticks], true); result.push(chosen)
    }
  }
  return result
}
