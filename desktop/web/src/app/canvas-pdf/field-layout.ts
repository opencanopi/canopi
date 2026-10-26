import type { CanvasPrintSnapshot, PrintBounds, PrintPlant, PrintPoint } from '../../canvas/print'
import type { PdfDestination, PdfEnclosure, PdfInput, PdfLegendEntry, PdfLink, PdfOperation, PdfPageReference } from './types'
import type { PdfTextEngine, TextLine } from './text'
import { MM } from './print-style'
import { drawMark, identifyPlants, pathOp, rectPath, textOp } from './page-drawing'
import { paperPlantRadius } from './plant-marks'
import { nearestPlantSpacing } from '../../canvas/plant-spacing'
import { contains, clipSegment, distance, hits, inflate, outlineSegments, type Segment } from './field-geometry'
import { FieldSpace, type FieldLabel } from './field-placement'
import { fieldDimensions } from './field-dimensions'
import { appearanceKey, assignFieldIdentity, drawEnclosure, enclosureRadius, fieldIdentity } from './field-identity'
import { directAnnotation } from './field-annotations'
import type { ZoneMeasurements } from './zone-measurements'
import { zoneLabels } from './zone-labels'
import { protectZoneInk } from './zone-ink'

export interface FieldReferences {
  species: ReadonlyMap<string, string>
  notes: ReadonlyMap<string, string>
  measurements: ReadonlyMap<string, string>
  plants: ReadonlyMap<string, string>
  allPlants?: readonly PrintPlant[]
  identities?: ReadonlyMap<string, PdfEnclosure>
  measurementHomes?: ReadonlyMap<string, string>
  /** Zone codes and sizes, measured once per plan. */
  zones: readonly ZoneMeasurements[]
}
export interface FieldNote {
  id: string
  reference: string
  text: string
  position: PrintPoint
  species?: string
  kind: 'annotation' | 'distance' | 'plants'
  plantIds?: readonly string[]
  location?: string
  continuation?: string
}
export interface FieldDrawing {
  pageReferences: PdfPageReference[]
  operations: PdfOperation[]
  links: PdfLink[]
  destinations: PdfDestination[]
  legend: PdfLegendEntry[]
  notes: FieldNote[]
  identifiedPlants: { ids: readonly string[]; reference: string; bounds: PrintBounds }[]
  annotationIds: string[]
  measurementIds: string[]
}
const INK = '#24211c', OCHRE = '#A06B1F'
const paper = (r: PrintBounds): PrintBounds => ({ x: r.x * MM, y: r.y * MM, width: r.width * MM, height: r.height * MM })

/**
 * Allocated once from the whole Design, so cropping and locale never renumber a species; N, P and M follow the unturned
 * `plan` (top, then left, then id), so a code names the same object at every Map orientation.
 */
export function fieldReferences(input: PdfInput, plan: CanvasPrintSnapshot, zones: readonly ZoneMeasurements[], fields?: readonly PrintBounds[]): FieldReferences {
  const codes = new Map(input.canvas.plants.map(p => [p.canonicalName, p.speciesCode ?? p.canonicalName]))
  const names = [...codes.keys()].sort((a, b) => codes.get(a)!.localeCompare(codes.get(b)!, 'en') || a.localeCompare(b, 'en'))
  return { zones, allPlants: input.canvas.plants, identities: assignFieldIdentity(input.canvas.plants, fields), species: new Map(names.map((name, i) => [name, String(i + 1).padStart(2, '0')])),
    notes: ordered(plan.annotations, 'N'), plants: ordered(plan.plants, 'P'),
    measurements: measurementReferences(plan) }
}

const ordered = <T extends { id: string; position: PrintPoint }>(items: readonly T[], prefix: string) => new Map([...items]
  .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id))
  .map((p, i) => [p.id, `${prefix}${i + 1}`]))

/** Every guide's M code, from the unturned `plan`: the overview and the detail pages print the same one. */
export function measurementReferences(plan: CanvasPrintSnapshot): ReadonlyMap<string, string> {
  return ordered(plan.measurements.map(g => ({ ...g, position: g.start })), 'M')
}

export function visibleFieldCanvas(canvas: CanvasPrintSnapshot, ground: PrintBounds): CanvasPrintSnapshot {
  return { ...canvas, plants: canvas.plants.filter(p => contains(ground, p.position)),
    annotations: canvas.annotations.filter(n => contains(ground, n.position)),
    measurements: canvas.measurements.filter(g => hits({ a: g.start, b: g.end }, ground)) }
}

/** One pure physical layout feeds both the SVG preview and the encoder. */
export function drawField(input: PdfInput, frame: PrintBounds, ground: PrintBounds, scale: number, page: { id: string; width: number; height: number; reserved?: readonly PrintBounds[]; summary?: readonly TextLine[]; bodyTop?: number },
  text: PdfTextEngine, references: FieldReferences): FieldDrawing {
  let identities = new Map(fieldIdentity(input.canvas.plants, references.allPlants ?? input.canvas.plants, references.identities))
  let best = layoutField(input, frame, ground, scale, page, text, references, identities)
  const unresolved = (drawing: FieldDrawing) => drawing.identifiedPlants.filter(p => !p.bounds.width).reduce((n, p) => n + p.ids.length, 0)
  // Spend enclosures where guide ink prevents a direct code; keep the retry budget bounded.
  if (unresolved(best) > 8) return best
  let attempts = 0
  for (const failure of best.notes.filter(n => n.species)) {
    const plant = input.canvas.plants.find(p => p.id === failure.id)!
    if (nearestPlantSpacing(input.canvas.plants, plant.position) * scale < .7 * MM) continue
    const group = input.canvas.plants.filter(p => appearanceKey(p) === appearanceKey(plant))
    const members = group.filter(p => p.canonicalName === plant.canonicalName)
    const choices = (['circle', 'square', 'diamond', 'plain'] as const).map(style => ({ style, donors: group.filter(p => identities.get(p.id) === style) }))
      .sort((a, b) => a.donors.length - b.donors.length)
    for (const { style, donors } of choices) {
      if (++attempts > 8) return best
      const candidate = new Map(identities)
      for (const p of donors) candidate.set(p.id, 'code')
      for (const p of members) candidate.set(p.id, style)
      const drawing = layoutField(input, frame, ground, scale, page, text, references, candidate)
      if (unresolved(drawing) >= unresolved(best)) continue
      identities = candidate; best = drawing; break
    }
    if (!unresolved(best)) break
  }
  return best
}

function layoutField(input: PdfInput, frame: PrintBounds, ground: PrintBounds, scale: number, page: { id: string; width: number; height: number; reserved?: readonly PrintBounds[]; summary?: readonly TextLine[]; bodyTop?: number },
  text: PdfTextEngine, references: FieldReferences, identities: ReadonlyMap<string, PdfEnclosure>): FieldDrawing {
  const canvas = input.canvas, operations: PdfOperation[] = [], links: PdfLink[] = [], destinations: PdfDestination[] = []
  const point = (p: PrintPoint): PrintPoint => ({ x: (frame.x + (p.x - ground.x) * scale) / MM, y: (frame.y + (p.y - ground.y) * scale) / MM })
  // Prefer short-axis margins for shallow beds; codes can also use clear internal gaps.
  const strip = Math.max(frame.width / frame.height, frame.height / frame.width) >= 4
    ? inflate({ x: frame.x / MM, y: frame.y / MM, width: frame.width / MM, height: frame.height / MM }, 1) : undefined
  const stripOptions = (anchor: PrintPoint) => strip ? { outside: strip, axis: frame.width > frame.height ? 'y' as const : 'x' as const,
    preferred: frame.width > frame.height ? anchor.y < strip.y + strip.height / 2 ? -1 : 1 : anchor.x < strip.x + strip.width / 2 ? -1 : 1 } : {}
  const numbers = new Intl.NumberFormat(input.locale, { maximumFractionDigits: 2 })
  const coordinates = (p: PrintPoint) => `x ${numbers.format(p.x)} m · y ${numbers.format(p.y)} m`
  const opacity = (name: string) => canvas.layers.find(l => l.name === name)?.opacity ?? 1
  const top = (page.bodyTop ?? 24 * MM) / MM
  const space = new FieldSpace({ x: 8, y: top, width: page.width / MM - 16, height: page.height / MM - top - 18 }, text)
  page.summary?.forEach((line, i) => operations.push({ ...textOp(line, 10 * MM, 28 * MM + i * 11, 8), color: '#655f55' }))
  for (const r of page.reserved ?? []) space.reserve({ x: r.x / MM, y: r.y / MM, width: r.width / MM, height: r.height / MM })
  // Match PDFKit’s six-decimal point precision in the shared preview/export plan.
  const coordinate = (mm: number) => Math.round(mm * MM * 1e6) / 1e6
  const line = (s: Segment, color: string, width: number, alpha = 1) => operations.push({ ...pathOp(`M${coordinate(s.a.x)} ${coordinate(s.a.y)} L${coordinate(s.b.x)} ${coordinate(s.b.y)}`, color, null, width * MM), opacity: alpha })
  const labelText = (label: FieldLabel, alpha = label.opacity ?? 1) => label.lines.forEach((l, i) => operations.push({ ...textOp(l, (label.origin?.x ?? label.bounds.x + label.inset) * MM,
    ((label.origin?.y ?? label.bounds.y + label.baseline) + i * label.leading) * MM, label.size, label.rotation ?? 0, alpha), color: label.color }))
  const codePeers = new Map<string, string[]>()
  for (const plant of canvas.plants) {
    if (identities.get(plant.id) === 'plain' || identities.get(plant.id) === 'code') {
      const key = appearanceKey(plant), peers = codePeers.get(key) ?? []
      peers.push(plant.id); codePeers.set(key, peers)
    }
  }
  const legend = identifyPlants(canvas.plants, input).map(entry => ({ ...entry, enclosures: entry.appearances.map(p => identities.get(p.id)!), reference: references.species.get(entry.canonicalName)!,
    count: canvas.plants.filter(p => p.canonicalName === entry.canonicalName).length })).sort((a, b) => Number(a.reference) - Number(b.reference))
  operations.push({ kind: 'clip', bounds: frame })
  const zonePaths = new Set<PdfOperation>()
  const zoneSegments: Segment[] = []
  for (const zone of canvas.zones) {
    if (!hits({ a: { x: zone.bounds.x, y: zone.bounds.y }, b: { x: zone.bounds.x + zone.bounds.width, y: zone.bounds.y + zone.bounds.height } }, ground)
      && !(zone.bounds.x <= ground.x + ground.width && zone.bounds.x + zone.bounds.width >= ground.x && zone.bounds.y <= ground.y + ground.height && zone.bounds.y + zone.bounds.height >= ground.y)) continue
    operations.push({ kind: 'path', d: zone.path, matrix: [scale, 0, 0, scale, frame.x - ground.x * scale, frame.y - ground.y * scale],
      fill: null, stroke: '#8b877f', width: .18 * MM / scale, opacity: opacity('zones') })
    zonePaths.add(operations[operations.length - 1]!)
    zoneSegments.push(...outlineSegments(zone.path, point))
  }
  operations.push({ kind: 'unclip' })
  const points = canvas.plants.map(p => ({ plant: p, point: point(p.position), radius: Math.min(.8, paperPlantRadius(canvas.plants, p, scale) / MM) }))
  for (const p of points) {
    const radius = enclosureRadius(identities.get(p.plant.id)!, p.radius * MM) / MM
    space.mark(p.plant.id, { x: p.point.x - radius, y: p.point.y - radius, width: 2 * radius, height: 2 * radius })
  }
  const notes: FieldNote[] = []
  const identifiedPlants: FieldDrawing['identifiedPlants'] = []
  const deferredMeasurement = (guide: CanvasPrintSnapshot['measurements'][number]) => {
    const clipped = clipSegment({ a: guide.start, b: guide.end }, ground)!
    const position = { x: (clipped.a.x + clipped.b.x) / 2, y: (clipped.a.y + clipped.b.y) / 2 }
    const value = `${new Intl.NumberFormat(input.locale, { maximumFractionDigits: 2 }).format(distance(guide.start, guide.end))} m`
    const projected = { a: point(clipped.a), b: point(clipped.b) }
    line(projected, '#a29c91', .12, opacity('measurement-guides')); space.addSegments([projected])
    const home = references.measurementHomes?.get(guide.id)
    const continuation = home && home !== page.id ? home : undefined
    const label = space.place(space.measure(value + (continuation ? '      000' : ''), 8.5), [point(position)], [], '', { near: true })
    if (label) {
      label.route = []; label.opacity = opacity('measurement-guides')
      if (continuation) {
        label.lines = [text.line(value, label.size)]
        pageReferences.push({ target: continuation, x: (label.bounds.x + label.inset) * MM + label.lines[0]!.width + MM,
          y: (label.bounds.y + label.baseline) * MM, size: label.size })
        links.push({ bounds: paper(label.bounds), target: `page:${continuation}` })
      }
      space.admit(label)
      return
    }
    notes.push({ id: guide.id, reference: references.measurements.get(guide.id)!, text: value, position, kind: 'distance',
      continuation: references.measurementHomes?.get(guide.id) === page.id ? undefined : references.measurementHomes?.get(guide.id) })
  }
  const pageReferences: PdfPageReference[] = []
  const processedNotes = new Set<string>()
  const locations = new Map<string, PrintPlant[]>()
  for (const p of canvas.plants) {
    const key = JSON.stringify(p.position), group = locations.get(key) ?? []
    group.push(p); locations.set(key, group)
  }
  const coincident = new Set<string>()
  for (const group of locations.values()) {
    if (group.length > 1) {
      const first = [...group].sort((a, b) => a.id.localeCompare(b.id))[0]!, counts = new Map<string, number>()
      for (const p of group) { coincident.add(p.id); counts.set(p.canonicalName, (counts.get(p.canonicalName) ?? 0) + 1) }
      const value = [...counts].map(([name, count]) => {
        const p = group.find(p => p.canonicalName === name)!
        return `${p.speciesCode ?? references.species.get(name)} · ${input.commonNames[name]?.trim() || name} ×${count}`
      }).join('\n')
      notes.push({ id: first.id, reference: references.plants.get(first.id)!, text: value, position: first.position, kind: 'plants', plantIds: group.map(p => p.id) })
    }
  }
  const guideInk = canvas.measurements.map(g => ({ a: point(g.start), b: point(g.end) }))
  for (const p of points) {
    if (coincident.has(p.plant.id)) continue
    const reference = references.species.get(p.plant.canonicalName)!
    let bounds = paper({ x: p.point.x - p.radius, y: p.point.y - p.radius, width: 2 * p.radius, height: 2 * p.radius })
    if (identities.get(p.plant.id) === 'code' || p.plant.pinnedName) {
      const value = p.plant.pinnedName ? input.commonNames[p.plant.canonicalName]?.trim() || p.plant.canonicalName : p.plant.speciesCode ?? reference
      const measured = space.measure(value, p.plant.pinnedName ? 8.5 : 8, 32, !p.plant.pinnedName)
      const inseparable = nearestPlantSpacing(canvas.plants, p.plant.position) * scale < .7 * MM
      const label = inseparable ? null : space.place(measured, [p.point], [p.plant.id], `${page.id}:key:${reference}`, { near: true, association: true, avoid: guideInk, associationPeers: p.plant.pinnedName ? undefined : codePeers.get(appearanceKey(p.plant)), ...stripOptions(p.point), outside: undefined })
      if (label) { label.route = []; space.admit(label); bounds = paper(label.bounds) }
      else {
        notes.push({ id: p.plant.id, reference: p.plant.speciesCode ?? reference, text: `${p.plant.speciesCode ?? reference} · ${input.commonNames[p.plant.canonicalName]?.trim() || p.plant.canonicalName}`,
          position: p.plant.position, species: p.plant.canonicalName, kind: 'plants', plantIds: [p.plant.id],
          location: coordinates(p.plant.position) })
        continue
      }
    }
    identifiedPlants.push({ ids: [p.plant.id], reference, bounds })
  }
  const nativeDimensions = fieldDimensions(canvas.measurements.filter(g => contains(ground, g.start) && contains(ground, g.end)), point, space, input.locale)
  const nativeDimensionIds = new Set(nativeDimensions.map(d => d.guide.id))
  for (const d of nativeDimensions) {
    d.segments.forEach(s => line(s, '#656058', .17, opacity('measurement-guides')))
    d.ticks.forEach(s => line(s, INK, .25, opacity('measurement-guides'))); labelText(d.label, opacity('measurement-guides'))
  }
  // Every guide's ink on this page by guide: a dimension's strokes, or the guide clipped to the ground.
  const guideLines = new Map(nativeDimensions.map(d => [d.guide.id, d.segments]))
  for (const guide of canvas.measurements.filter(g => !nativeDimensionIds.has(g.id))) {
    const clipped = clipSegment({ a: guide.start, b: guide.end }, ground)!, projected = { a: point(clipped.a), b: point(clipped.b) }
    space.addSegments([projected]); guideLines.set(guide.id, [projected])
  }
  notes.push(...[...canvas.annotations].sort((a, b) => a.text.length - b.text.length || a.id.localeCompare(b.id))
    .filter(n => !directAnnotation(n, point(n.position), scale, space, opacity('annotations'), operations)).map((n): FieldNote => ({ id: n.id, reference: references.notes.get(n.id)!, text: n.text, position: n.position, kind: 'annotation' }))
    .sort((a, b) => Number(a.reference.slice(1)) - Number(b.reference.slice(1))))
  for (const note of notes.filter(n => !n.species)) { const p = point(note.position); space.mark(note.id, { x: p.x - .7, y: p.y - .7, width: 1.4, height: 1.4 }) }
  const zones = references.zones
  operations.push(...zoneLabels(zones, ground, point, space))
  placeDimensions()
  space.addSegments(zoneSegments)
  for (const zone of zones.filter(item => item.zone.bounds.x <= ground.x + ground.width
    && item.zone.bounds.x + item.zone.bounds.width >= ground.x && item.zone.bounds.y <= ground.y + ground.height
    && item.zone.bounds.y + item.zone.bounds.height >= ground.y)) {
    const complete = zone.dimensions.filter(d => contains(ground, d.start) && contains(ground, d.end))
    const reused = new Set(complete.filter(d => canvas.measurements.some(g =>
      distance(g.start, d.start) < .005 && distance(g.end, d.end) < .005 || distance(g.end, d.start) < .005 && distance(g.start, d.end) < .005)).map(d => d.id))
    const dimensions = fieldDimensions(complete.filter(d => !reused.has(d.id)), point, space, input.locale)
    for (const d of dimensions) {
      d.segments.forEach(s => line(s, '#656058', .16, opacity('zones')))
      d.ticks.forEach(s => line(s, INK, .25, opacity('zones'))); labelText(d.label, opacity('zones'))
    }
  }

  function placeDimensions(): void {
    for (const guide of canvas.measurements.filter(g => !nativeDimensionIds.has(g.id))) deferredMeasurement(guide)
    placeNotes()
  }

  function placeNotes(): void {
    for (const note of notes) {
      if (processedNotes.has(note.id)) continue
      processedNotes.add(note.id)
      const anchor = point(note.position)
      if (note.species) {
        identifiedPlants.push({ ids: note.plantIds!, reference: note.reference, bounds: paper({ ...anchor, width: 0, height: 0 }) })
        continue
      }
      const isDistance = note.kind === 'annotation' && /^\(?\s*\d+(?:[,.]\d+)?\s*(?:cm|m)\s*\)?$/u.test(note.text.trim())
      const value = note.reference + (isDistance ? ` · ${note.text}` : '')
      const reservedValue = value + (note.continuation ? '      000' : '')
      const measured = space.measure(reservedValue, isDistance ? 9.5 : 8), guide = note.kind === 'distance' ? guideLines.get(note.id)?.[0] : undefined
      // A guide's code sits beside its own guide, nearer it than any other guide, or stays in the key (Q16).
      const beside = guide && !note.location ? space.beside(measured, guide, [...guideLines].flatMap(([id, ink]) => id === note.id ? [] : ink)) : null
      const label = note.location ? null : guide ? beside && { ...measured, bounds: beside, route: [], ids: [note.id], target: `${page.id}:note:${note.reference}`, color: OCHRE, boxed: true }
        : space.place(measured, [anchor], [note.id, ...note.plantIds ?? []], `${page.id}:note:${note.reference}`, { color: OCHRE, boxed: !isDistance, note: true, ...stripOptions(anchor) })
      if (label) {
        if (note.continuation) {
          label.lines = [text.line(value, label.size)]
          pageReferences.push({ target: note.continuation, x: (label.bounds.x + label.inset) * MM + label.lines[0]!.width + MM,
            y: (label.bounds.y + label.baseline) * MM, size: label.size })
          links.push({ bounds: paper(label.bounds), target: `page:${note.continuation}` })
          label.target = ''
        }
        label.route = []
        space.admit(label, guide)
        if (note.plantIds) identifiedPlants.push({ ids: note.plantIds, reference: note.reference, bounds: paper(label.bounds) })
      } else {
        note.location = coordinates(note.position)
        if (note.plantIds) identifiedPlants.push({ ids: note.plantIds, reference: note.reference, bounds: paper({ ...anchor, width: 0, height: 0 }) })
      }
      operations.push(pathOp(rectPath(paper({ x: anchor.x - .55, y: anchor.y - .55, width: 1.1, height: 1.1 })), OCHRE, null, .23 * MM))
      destinations.push({ id: `${page.id}:anchor:${note.reference}`, bounds: paper(inflate({ ...anchor, width: 0, height: 0 }, 12)) })
    }
  }
  for (const label of space.labels) {
    if (label.boxed) operations.push(pathOp(rectPath(paper(label.bounds)), label.color, null, .2 * MM))
    labelText(label)
    if (label.target) links.push({ bounds: paper(label.bounds), target: label.target })
  }
  operations.push({ kind: 'clip', bounds: frame })
  for (const p of points) {
    if (coincident.has(p.plant.id)) continue
    drawMark(p.plant, p.point.x * MM, p.point.y * MM, p.radius * MM, opacity('plants'), operations)
    drawEnclosure(identities.get(p.plant.id)!, p.point.x * MM, p.point.y * MM, p.radius * MM, opacity('plants'), operations)
  }
  operations.push({ kind: 'unclip' })
  for (const entry of legend) {
    const locations = points.filter(p => p.plant.canonicalName === entry.canonicalName).map(p => p.point)
    const x = Math.min(...locations.map(p => p.x)), y = Math.min(...locations.map(p => p.y))
    destinations.push({ id: `${page.id}:species:${entry.reference}`, bounds: paper(inflate({ x, y, width: Math.max(...locations.map(p => p.x)) - x, height: Math.max(...locations.map(p => p.y)) - y }, 10)) })
  }
  notes.sort((a, b) => a.kind.localeCompare(b.kind, 'en') || Number(a.reference.slice(1)) - Number(b.reference.slice(1)))
  return { pageReferences, operations: protectZoneInk(operations, zonePaths), links, destinations, legend, notes, identifiedPlants, annotationIds: canvas.annotations.map(n => n.id), measurementIds: canvas.measurements.map(g => g.id) }
}
