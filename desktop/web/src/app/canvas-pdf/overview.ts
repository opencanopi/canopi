import type { PrintBounds, PrintPoint } from '../../canvas/print'
import type { PdfInput } from './types'
import type { PdfTextEngine } from './text'
import type { FieldDrawing } from './field-layout'
import { drawMark, MM, pathOp, textOp } from './page-drawing'
import { paperPlantRadius } from './plant-marks'
import { FieldSpace } from './field-placement'
import { contains } from './field-geometry'
import type { ZoneMeasurements } from './zone-measurements'
import { zoneLabels } from './zone-labels'
import { fieldDimensions } from './field-dimensions'
import { directAnnotation } from './field-annotations'
import { protectZoneInk } from './zone-ink'

/**
 * Overview and picker share authored artwork; only the overview adds physical guide and zone labels. A guide it cannot label
 * in place prints its code from `measurementCodes` (measurementReferences), the one its detail page prints.
 */
export function drawOverview(input: PdfInput, frame: PrintBounds, ground: PrintBounds, scale: number, text: PdfTextEngine, grouped: ReadonlyMap<string, string> = new Map(), labels = false, zones: readonly ZoneMeasurements[] = [],
  measurementCodes: ReadonlyMap<string, string> = new Map()): FieldDrawing {
  const canvas = input.canvas
  const drawing: FieldDrawing = { operations: [], links: [], destinations: [], legend: [], notes: [], identifiedPlants: [],
    annotationIds: labels ? [] : canvas.annotations.map(n => n.id), measurementIds: canvas.measurements.map(g => g.id), pageReferences: [] }
  const operations = drawing.operations
  const point = (p: PrintPoint) => ({ x: frame.x + (p.x - ground.x) * scale, y: frame.y + (p.y - ground.y) * scale })
  const opacity = (name: string) => canvas.layers.find(l => l.name === name)?.opacity ?? 1
  const space = new FieldSpace({ x: frame.x / MM, y: frame.y / MM, width: frame.width / MM, height: frame.height / MM }, text)
  const project = (p: PrintPoint) => { const q = point(p); return { x: q.x / MM, y: q.y / MM } }
  for (const p of canvas.plants) {
    const q = project(p.position), r = Math.max(.42, Math.min(1, paperPlantRadius(canvas.plants, p, scale) / MM))
    space.mark(p.id, { x: q.x - r, y: q.y - r, width: r * 2, height: r * 2 })
  }
  const dimensions = labels ? fieldDimensions(canvas.measurements.filter(g => !grouped.has(g.id) && contains(ground, g.start) && contains(ground, g.end)), project, space, input.locale, 7.5) : []
  const dimensionIds = new Set(dimensions.map(d => d.guide.id))
  // Canvas annotation sizes are screen pixels. A fixed reference scale keeps
  // overview text proportional to artwork instead of expanding over dense beds.
  const textScale = Math.min(.75, scale / 60)
  operations.push({ kind: 'clip', bounds: frame })
  for (const zone of canvas.zones) {operations.push({ kind: 'path', d: zone.path,
    matrix: [scale, 0, 0, scale, frame.x - ground.x * scale, frame.y - ground.y * scale],
    fill: null, stroke: '#8b877f', width: .18 * MM / scale, opacity: opacity('zones') })}
  const zonePaths = new Set(operations.filter(op => op.kind === 'path'))
  for (const guide of canvas.measurements) {
    if (dimensionIds.has(guide.id)) continue
    const a = point(guide.start), b = point(guide.end)
    operations.push({ ...pathOp(`M${a.x} ${a.y} L${b.x} ${b.y}`, '#8b877f', null, .18 * MM), opacity: opacity('measurement-guides') })
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length > 1e-8) {
      const dx = (b.y - a.y) / length * .6 * MM, dy = (a.x - b.x) / length * .6 * MM
      for (const p of [a, b]) operations.push({ ...pathOp(`M${p.x - dx} ${p.y - dy} L${p.x + dx} ${p.y + dy}`, '#656058', null, .15 * MM), opacity: opacity('measurement-guides') })
    }
    const value = new Intl.NumberFormat(input.locale, { maximumFractionDigits: 2 }).format(Math.hypot(guide.end.x - guide.start.x, guide.end.y - guide.start.y))
    if (!grouped.has(guide.id) && !labels) operations.push(textOp(text.line(`${value} m`, 10 * textScale), (a.x + b.x) / 2, (a.y + b.y) / 2 - textScale, 10 * textScale, 0, opacity('measurement-guides')))
  }
  for (const d of dimensions) {
    for (const s of [...d.segments, ...d.ticks]) operations.push({ ...pathOp(`M${s.a.x * MM} ${s.a.y * MM} L${s.b.x * MM} ${s.b.y * MM}`, '#656058', null, .15 * MM), opacity: opacity('measurement-guides') })
    const l = d.label
    operations.push(textOp(l.lines[0]!, (l.origin?.x ?? l.bounds.x + l.inset) * MM, (l.origin?.y ?? l.bounds.y + l.baseline) * MM, l.size, l.rotation ?? 0, opacity('measurement-guides')))
  }
  if (labels) {for (const guide of canvas.measurements) {
    const reference = measurementCodes.get(guide.id)
    if (!reference || grouped.has(guide.id) || dimensionIds.has(guide.id)) continue
    const position = { x: (guide.start.x + guide.end.x) / 2, y: (guide.start.y + guide.end.y) / 2 }
    const n = new Intl.NumberFormat(input.locale, { maximumFractionDigits: 2 })
    const label = space.place(space.measure(reference, 7.5), [project(position)], [], '', { near: true })
    if (label) {
      label.route = []; space.admit(label)
      operations.push(textOp(label.lines[0]!, (label.bounds.x + label.inset) * MM, (label.bounds.y + label.baseline) * MM, 7.5, 0, opacity('measurement-guides')))
    }
    drawing.notes.push({ id: guide.id, reference, position, kind: 'distance',
      text: `${n.format(Math.hypot(guide.end.x - guide.start.x, guide.end.y - guide.start.y))} m · (${n.format(guide.start.x)}, ${n.format(guide.start.y)}) — (${n.format(guide.end.x)}, ${n.format(guide.end.y)})` })
  }}
  for (const plant of canvas.plants) {
    const p = point(plant.position)
    drawMark(plant, p.x, p.y, Math.max(.42 * MM, Math.min(MM, paperPlantRadius(canvas.plants, plant, scale))), opacity('plants'), operations)
    if (plant.pinnedName) operations.push(textOp(text.line(plant.canonicalName, 12 * textScale), p.x + MM, p.y - textScale, 12 * textScale, 0, opacity('plants')))
  }
  if (labels) {
    for (const guide of canvas.measurements) space.addSegments([{ a: project(guide.start), b: project(guide.end) }])
    operations.push(...zoneLabels(zones, ground, project, space, false))
  }
  for (const note of [...canvas.annotations].sort((a, b) => a.text.length - b.text.length || a.id.localeCompare(b.id))) {
    if (labels) {
      if (directAnnotation(note, project(note.position), scale, space, opacity('annotations'), operations, { min: 7, max: 9, maxLines: 2, clearance: 2 })) drawing.annotationIds.push(note.id)
      continue
    }
    const p = point(note.position), size = note.fontSize * textScale, angle = note.rotation * Math.PI / 180
    note.text.replace(/\r\n?/g, '\n').split('\n').forEach((value, index) => {
      const offset = size * (1 + index * 1.25)
      operations.push(textOp(text.line(value, size), p.x - Math.sin(angle) * offset, p.y + Math.cos(angle) * offset, size, note.rotation, opacity('annotations')))
    })
  }
  operations.push({ kind: 'unclip' })
  if (labels) drawing.operations = protectZoneInk(operations, zonePaths)
  return drawing
}
