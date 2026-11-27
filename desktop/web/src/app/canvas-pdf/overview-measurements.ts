import type { CanvasPrintSnapshot, PrintBounds } from '../../canvas/print'
import { formatNumber } from '../../utils/format'
import type { PdfLabels, PdfOperation } from './types'
import type { PdfTextEngine } from './text'
import { insideZone, type ZoneMeasurements } from './zone-measurements'
import { MM, pathOp, rectPath, textOp } from './page-drawing'

export function groupedGuides(zones: readonly ZoneMeasurements[], guides: CanvasPrintSnapshot['measurements']): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const guide of guides) {
    const mid = { x: (guide.start.x + guide.end.x) / 2, y: (guide.start.y + guide.end.y) / 2 }
    const home = zones.filter(item => insideZone(item.zone, mid)).sort((a, b) => a.zone.bounds.width * a.zone.bounds.height - b.zone.bounds.width * b.zone.bounds.height)[0]
    if (home) result.set(guide.id, home.reference)
  }
  return result
}

/** Zone rows and guide values paginate before they reach the printable footer. */
export function overviewMeasurements(zones: readonly ZoneMeasurements[], guides: CanvasPrintSnapshot['measurements'],
  geometry: (index: number) => PrintBounds, text: PdfTextEngine, locale: string, labels: PdfLabels,
  guideValues: readonly string[] = [],
  groundDistance: (a: CanvasPrintSnapshot['measurements'][number]['start'], b: CanvasPrintSnapshot['measurements'][number]['end']) => number = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)): PdfOperation[][] {
  const pages: PdfOperation[][] = []
  const fmtTwo = (n: number) => formatNumber(n, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtCompact = (n: number) => formatNumber(n, locale, { maximumFractionDigits: 2 }), homes = groupedGuides(zones, guides)
  let operations!: PdfOperation[], frame!: PrintBounds, columns!: number[], y = 0
  const emit = (value: string, x: number, baseline: number, size = 7.5, strong = false) => operations.push(textOp(text.line(value, size, strong), x, baseline, size))
  const start = () => {
    if (pages.length >= 199) throw new Error('coverage-too-large')
    frame = geometry(pages.length); operations = []; pages.push(operations)
    columns = [frame.x, frame.x + frame.width * .30, frame.x + frame.width * .54, frame.x + frame.width * .60]
    emit(zones.length ? labels.measurementSummary : labels.notes, frame.x, frame.y + 9, 9, true)
    if (zones.length) {
      emit(`${labels.metres} · Ø ${labels.diameters}`, frame.x, frame.y + 22, 7)
      operations.push(pathOp(rectPath({ x: frame.x - 2, y: frame.y + 28, width: frame.width + 4, height: 17 }), null, '#f1efe9', 0))
      const headings = [labels.zone, labels.longSide, labels.width, labels.guides]
      headings.forEach((heading, i) => { const line = text.line(heading, 7, true); emit(heading, columns[i]! - (i === 1 || i === 2 ? line.width : 0), frame.y + 39, 7, true) })
      operations.push(pathOp(`M${frame.x} ${frame.y + 44} h${frame.width}`, '#a29c91', null, .2 * MM))
    }
    y = frame.y + (zones.length ? 56 : 25)
  }
  const room = (height: number) => { if (y + height > frame.y + frame.height) start() }
  start()
  for (const item of [...zones].sort((a, b) => Number(a.diameter) - Number(b.diameter) || a.reference.localeCompare(b.reference, 'en', { numeric: true }))) {
    const counts = new Map<number, number>()
    for (const guide of guides.filter(g => homes.get(g.id) === item.reference)) {
      const value = Math.round(groundDistance(guide.start, guide.end) * 100) / 100
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    const values = [...counts].sort((a, b) => a[0] - b[0]).map(([n, count]) => fmtCompact(n) + (count > 1 ? ` ×${count}` : '')).join(' · ') || '—'
    const lines = text.wrap(values, 7.2, frame!.width * .4)
    const name = item.zone.name !== null && item.zone.name !== item.reference ? item.zone.name : ''
    const names = name ? text.wrap(name, 7, frame!.width * .16) : []
    const rows = Math.max(item.lengths.length, lines.length, names.length + 1)
    room(Math.min(rows * 9 + 3, frame!.height - 60))
    for (let i = 0; i < rows; i++) {
      room(10)
      if (i === 0 || y === frame!.y + 56) emit(item.reference + (item.diameter ? ' Ø' : item.lengths.length > 1 ? '*' : ''), columns![0]!, y!, 7.5, true)
      if (i > 0 && names[i - 1]) operations!.push(textOp(names[i - 1]!, columns![0]!, y!, 7))
      if (item.lengths[i] !== undefined) { const v = fmtTwo(item.lengths[i]!); emit(v, columns![1]! - text.line(v, 7.5).width, y!) }
      if (i === 0) {
        const widths = item.widths.map(fmtTwo).join('–') || '—'
        emit(widths, columns![2]! - text.line(widths, 7.2).width, y!, 7.2)
      }
      if (lines[i]) operations!.push(textOp(lines[i]!, columns![3]!, y!, 7.2))
      y! += 9
    }
    operations!.push(pathOp(`M${frame!.x} ${y! - 4} h${frame!.width}`, '#d8d2c8', null, .1 * MM))
    y! += 5
  }
  if (zones.some(z => z.lengths.length > 1)) {
    room(14); y! += 4
    emit(`* ${labels.outerSides}`, frame!.x, y!, 7); y! += 10
  }
  y! += 6
  for (const value of guideValues) {
    for (const line of text.wrap(value.replace(/\s+/g, ' '), 7.5, frame!.width)) {
      room(11); operations!.push(textOp(line, frame!.x, y!, 7.5)); y! += 10
    }
    y! += 4
  }
  return pages
}
