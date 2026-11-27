import type { CanvasPrintSnapshot, PrintBounds } from '../../canvas/print'
import { formatNumber } from '../../utils/format'
import type { PdfOperation } from './types'
import type { PdfTextEngine } from './text'
import { contains } from './field-geometry'
import { MM, pathOp, textOp } from './page-drawing'

type Guide = CanvasPrintSnapshot['measurements'][number]

/** Only an existing, connected horizontal chain can become the overview band. */
export function overviewGuideChain(guides: readonly Guide[]): readonly Guide[] {
  const ordered = guides.filter(g => Math.abs(g.start.y - g.end.y) < 1e-6).sort((a, b) => a.start.y - b.start.y
    || Math.min(a.start.x, a.end.x) - Math.min(b.start.x, b.end.x) || a.id.localeCompare(b.id))
  let best: Guide[] = [], current: Guide[] = []
  for (const guide of ordered) {
    const previous = current[current.length - 1]
    if (previous && (Math.abs(guide.start.y - previous.start.y) > 1e-6 || Math.abs(Math.min(guide.start.x, guide.end.x) - Math.max(previous.start.x, previous.end.x)) > 1e-6)) current = []
    current.push(guide)
    if (current.length > best.length) best = [...current]
  }
  return best.length >= 3 ? best : []
}

/** The band is optional: crops and very tight chains keep their local guide treatment. */
export function readableOverviewChain(
  guides: readonly Guide[],
  frame: PrintBounds,
  ground: PrintBounds,
  scale: number,
  text: PdfTextEngine,
  locale: string,
  groundDistance: (a: Guide['start'], b: Guide['end']) => number = (a, b) => Math.hypot(b.x - a.x, b.y - a.y),
): readonly Guide[] {
  const ends = [-Infinity, -Infinity]
  for (const [i, guide] of guides.entries()) {
    if (!contains(ground, guide.start) || !contains(ground, guide.end)) return []
    const center = frame.x + ((guide.start.x + guide.end.x) / 2 - ground.x) * scale
    const width = text.line(formatNumber(groundDistance(guide.start, guide.end), locale, { maximumFractionDigits: 2 }), 7.5).width
    if (center - width / 2 < Math.max(frame.x, ends[i % 2]! + MM) || center + width / 2 > frame.x + frame.width) return []
    ends[i % 2] = center + width / 2
  }
  return guides
}

export function drawOverviewGuideChain(
  guides: readonly Guide[],
  frame: PrintBounds,
  ground: PrintBounds,
  scale: number,
  text: PdfTextEngine,
  locale: string,
  title: string,
  opacity = 1,
  groundDistance: (a: Guide['start'], b: Guide['end']) => number = (a, b) => Math.hypot(b.x - a.x, b.y - a.y),
): PdfOperation[] {
  if (!guides.length) return []
  const operations: PdfOperation[] = [], y = frame.y + frame.height + 10 * MM
  operations.push(textOp(text.line(`${title} · m`, 8), frame.x, y - 6 * MM, 8))
  for (const [i, guide] of guides.entries()) {
    const a = frame.x + (guide.start.x - ground.x) * scale, b = frame.x + (guide.end.x - ground.x) * scale
    operations.push(pathOp(`M${a} ${y} L${b} ${y} M${a} ${y - MM} v${2 * MM} M${b} ${y - MM} v${2 * MM}`, '#656058', null, .15 * MM))
    const line = text.line(formatNumber(groundDistance(guide.start, guide.end), locale, { maximumFractionDigits: 2 }), 7.5)
    operations.push(textOp(line, (a + b - line.width) / 2, y + (i % 2 ? -2 : 5) * MM, 7.5))
  }
  return operations.map(op => op.kind === 'path' || op.kind === 'text' ? { ...op, opacity } : op)
}
