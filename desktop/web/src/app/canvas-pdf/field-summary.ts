import type { PrintBounds } from '../../canvas/print'
import { formatQuantity, type UnitSystem } from '../../utils/format'
import type { PdfTextEngine, TextLine } from './text'
import type { ZoneMeasurements } from './zone-measurements'

export function fieldSummary(
  zones: readonly ZoneMeasurements[],
  ground: PrintBounds,
  width: number,
  locale: string,
  text: PdfTextEngine,
  unitSystem: UnitSystem = 'metric',
): TextLine[] {
  const fmt = (n: number) => formatQuantity('length', n, unitSystem, locale, { trimTrailingZeros: true })
  const lines: TextLine[] = []
  let row = ''
  for (const item of zones) {
    const b = item.zone.bounds
    if (b.x > ground.x + ground.width || b.x + b.width < ground.x || b.y > ground.y + ground.height || b.y + b.height < ground.y) continue
    const value = `${item.reference} · ${item.diameter ? 'Ø ' : ''}${item.lengths.map(fmt).join(' / ')}${item.widths.length ? ` × ${item.widths.map(fmt).join('–')}` : ''}`
    const next = row ? `${row}     ${value}` : value
    if (text.line(next, 8).width <= width) { row = next; continue }
    if (row) lines.push(text.line(row, 8))
    const wrapped = text.wrap(value, 8, width)
    lines.push(...wrapped.slice(0, -1)); row = wrapped[wrapped.length - 1]!.runs.map(r => r.text).join('')
  }
  if (row) lines.push(text.line(row, 8))
  return lines
}
