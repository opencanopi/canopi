import type { PdfOperation } from './types'
import { clipSegment, distance, inflate, outlineSegments, PaperIndex, rotatedBounds, segmentBounds, type Segment } from './field-geometry'
import { MM } from './print-style'
import type { PrintBounds } from '../../canvas/print'

/** Interrupt outline-only zones around readable ink without painting over artwork. */
export function protectZoneInk(operations: readonly PdfOperation[], zones: ReadonlySet<PdfOperation>): PdfOperation[] {
  const index = new PaperIndex<PrintBounds>()
  for (const op of operations) {
    if (op.kind === 'text' && op.line.ink) {
      const bounds = inflate(rotatedBounds(op.line.ink, op.rotation, op), .35 * MM)
      index.add(bounds, bounds)
    }
  }
  return operations.flatMap(op => {
    if (!zones.has(op) || op.kind !== 'path') return [op]
    const [a, b, c, d, x, y] = op.matrix
    let interrupted = false
    const segments = outlineSegments(op.d, p => ({ x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y })).flatMap(segment => {
      let pieces = [segment]
      for (const bounds of index.query(segmentBounds(segment))) {
        pieces = pieces.flatMap(s => {
          const clipped = clipSegment(s, bounds)
          if (!clipped) return [s]
          interrupted = true
          const result: Segment[] = []
          if (distance(s.a, clipped.a) > 1e-6) result.push({ a: s.a, b: clipped.a })
          if (distance(clipped.b, s.b) > 1e-6) result.push({ a: clipped.b, b: s.b })
          return result
        })
      }
      return pieces
    })
    if (!interrupted) return [op]
    const coordinate = (n: number) => Math.round(n * 1e6) / 1e6
    const result: PdfOperation[] = []
    if (segments.length) {
      result.push({ ...op, fill: null, matrix: [1, 0, 0, 1, 0, 0], width: op.width * Math.hypot(a, b),
        d: segments.map(s => `M${coordinate(s.a.x)} ${coordinate(s.a.y)} L${coordinate(s.b.x)} ${coordinate(s.b.y)}`).join(' ') })
    }
    return result
  })
}
