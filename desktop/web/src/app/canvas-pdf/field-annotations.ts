import type { CanvasPrintSnapshot, PrintPoint } from '../../canvas/print'
import type { PdfOperation } from './types'
import type { FieldSpace } from './field-placement'
import { MM } from './print-style'
import { inflate } from './field-geometry'
import { textOp } from './page-drawing'

/** Try nearby ink-safe placements before spending an N reference and key row. */
export function directAnnotation(note: CanvasPrintSnapshot['annotations'][number], anchor: PrintPoint, scale: number,
  space: FieldSpace, opacity: number, operations: PdfOperation[], sizes: { min: number; max: number; maxLines?: number; clearance?: number } = { min: 8.5, max: 12 }): boolean {
  const ideal = Math.max(sizes.min, Math.min(sizes.max, note.fontSize * scale / 60))
  const angle = note.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  for (const size of [...new Set([ideal, Math.min(9.5, sizes.max), sizes.min])].filter(size => size <= ideal)) {
    for (const maxWidth of [40, 30, 23, 16, 12]) {
      const measured = space.measure(note.text, size, maxWidth)
      if (measured.lines.length > (sizes.maxLines ?? 4)) continue
      // Prefer a smaller whole-word label over an oversized stack of broken words.
      if (measured.lines.map(l => l.runs.map(r => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim()
        !== note.text.normalize('NFC').replace(/\s+/g, ' ').trim()) continue
      const corners = [[0, 0], [measured.width, 0], [0, measured.height], [measured.width, measured.height]]
        .map(([x, y]) => ({ x: x! * cos - y! * sin, y: x! * sin + y! * cos }))
      const left = Math.min(...corners.map(p => p.x)), top = Math.min(...corners.map(p => p.y))
      const width = Math.max(...corners.map(p => p.x)) - left, height = Math.max(...corners.map(p => p.y)) - top
      for (const [dx, dy] of [[0, 0], [1.5, -height - 1], [-width - 1.5, 0], [1.5, 1.5], [-width / 2, -height - 2], [-width / 2, 3], [-width - 4, 0], [-width - 7, 0], [4, 0], [7, 0], [-width - 1.5, -height - 1], [1.5, -height - 2], [-width / 2, -height - 3], [-width / 2, 5]]) {
        const bounds = { x: anchor.x + dx!, y: anchor.y + dy!, width, height }
        const reserved = inflate(bounds, sizes.clearance ?? 0)
        if (!space.clear(reserved)) continue
        space.reserve(reserved)
        measured.lines.forEach((line, index) => {
          const baseline = measured.baseline + index * measured.leading
          operations.push({ ...textOp(line, (bounds.x - left + measured.inset * cos - baseline * sin) * MM,
            (bounds.y - top + measured.inset * sin + baseline * cos) * MM, size, note.rotation, opacity), color: '#805715' })
        })
        return true
      }
    }
  }
  return false
}
