import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { contains, distanceToSegment, outlineSegments, type Segment } from '../app/canvas-pdf/field-geometry'
import { pageFrame } from '../app/canvas-pdf/page-frame'
import { zoneLabels } from '../app/canvas-pdf/zone-labels'
import { FieldSpace } from '../app/canvas-pdf/field-placement'
import { drawField } from '../app/canvas-pdf/field-layout'
import type { ZoneMeasurements } from '../app/canvas-pdf/zone-measurements'
import type { PdfInput, PdfLabels, PdfPage, PdfSetup } from '../app/canvas-pdf/types'
import type { PrintBounds, PrintPoint, PrintZone } from '../canvas/print'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const MM = 72 / 25.4
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([
  ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')], ['strong', readFileSync('src/app/canvas-pdf/fonts/NotoSans-SemiBold.ttf')],
]), 'en')
const row = (y: number): PrintZone => ({ name: null, path: `M0 ${y} L20 ${y} L20 ${y + 1} L0 ${y + 1} Z`, fill: null, bounds: { x: 0, y, width: 20, height: 1 },
  geometry: { kind: 'rect', points: [{ x: 0, y }, { x: 20, y }, { x: 20, y: y + 1 }, { x: 0, y: y + 1 }] } })
const layers = ['plants', 'zones', 'measurement-guides', 'annotations']
const design = (canvas: Partial<PdfInput['canvas']>): PdfInput => ({ name: 'Orchard', locale: 'en', viewBearingDeg: 60, commonNames: {}, canvas: {
  layers: layers.map(name => ({ name, visible: true, opacity: 1 })), plants: [], zones: [], annotations: [], measurements: [], ...canvas } })

/** Printed codes on a page: their text and the centre of their ink, in page points. */
function codes(page: PdfPage, pattern: RegExp) {
  return page.operations.flatMap(op => op.kind === 'text' && pattern.test(op.line.runs.map(r => r.text).join(''))
    ? [{ code: op.line.runs.map(r => r.text).join(''), centre: { x: op.x + op.line.width / 2, y: op.y - op.size * .35 } }] : [])
}
/** Plan metres to page points: the plan's one frame, then the page's ground. */
const onPage = (page: PdfPage, angle: number) => (p: PrintPoint) => {
  const q = pageFrame(angle).toFrame(p)
  return { x: page.frame.x + (q.x - page.ground.x) * page.pointsPerMeter, y: page.frame.y + (q.y - page.ground.y) * page.pointsPerMeter }
}
function inside(p: PrintPoint, outline: Segment[]): boolean {
  let crossings = 0
  for (const { a, b } of outline) if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) crossings++
  return crossings % 2 === 1
}
const away = (p: PrintPoint, outline: Segment[]) => inside(p, outline) ? 0 : Math.min(...outline.map(s => distanceToSegment(p, s)))

const plant = (id: string, position: PrintPoint) => ({ id, canonicalName: 'Malus domestica', speciesCode: 'MAD', position, color: '#335533', symbol: 'square',
  mark: [{ d: 'M-1 -1 H1 V1 H-1 Z', paint: 'symbol' as const }], pinnedName: false })
// A Print Area turns about its own centre, so this square holds the turned rows whole on one detail page.
const setup: PdfSetup = { paper: 'A4', layers, mapOrientation: 'as-on-screen', areas: [{ id: 'rows', name: 'Rows', bounds: { x: -5, y: -10, width: 30, height: 30 } }] }

it('prints each turned row\'s zone code on that row\'s own top, on the overview and on a detail page', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i * 2))
  const plan = buildPdfPlan(design({ zones: rows }), setup, text(), labels)
  const pages = plan.pages.filter(p => p.kind !== 'legend')
  expect(pages.map(p => p.kind)).toEqual(['overview', 'detail'])
  for (const page of pages) {
    const outlines = rows.map(r => outlineSegments(r.path, onPage(page, 60)))
    const printed = codes(page, /^Z\d\d$/).filter(c => contains(page.frame, c.centre))
    expect(printed.map(c => c.code).sort()).toEqual(['Z01', 'Z02', 'Z03', 'Z04', 'Z05', 'Z06'])
    for (const { code, centre } of printed) {
      const own = Number(code.slice(1)) - 1
      outlines.forEach((outline, i) => {
        if (i === own) return
        expect(inside(centre, outline), `${page.kind} ${code} inside row ${i + 1}`).toBe(false)
        expect(away(centre, outlines[own]!), `${page.kind} ${code} nearer row ${i + 1}`).toBeLessThan(away(centre, outline))
      })
    }
  }
})

it('prints each guide\'s M code beside its own guide in a turned chain of eight rows', () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i * 1.5))
  const measurements = rows.slice(1).map((r, i) => ({ id: `g${i}`, start: { x: 10, y: r.bounds.y - .5 }, end: { x: 10, y: r.bounds.y } }))
  const plants = rows.flatMap((r, i) => Array.from({ length: 41 }, (_, j) => plant(`p${i}-${j}`, { x: j * .5, y: r.bounds.y + .5 })))
  const wide: PdfSetup = { ...setup, areas: [{ id: 'rows', name: 'Rows', bounds: { x: -10, y: -14, width: 40, height: 40 } }] }
  const plan = buildPdfPlan(design({ zones: rows, measurements, plants }), wide, text(), labels)
  const page = plan.pages.find(p => p.kind === 'detail')!
  const guides = measurements.map(g => ({ a: onPage(page, 60)(g.start), b: onPage(page, 60)(g.end) }))
  const references = new Map([...measurements].sort((a, b) => a.start.y - b.start.y).map((g, i) => [`M${i + 1}`, measurements.indexOf(g)]))
  const printed = codes(page, /^M\d+$/).filter(c => contains(page.frame, c.centre))
  expect(printed.length).toBeGreaterThan(0)
  for (const { code, centre } of printed) {
    const own = distanceToSegment(centre, guides[references.get(code)!]!)
    expect(own / MM, `${code} from its guide`).toBeLessThanOrEqual(6)
    guides.forEach((guide, i) => { if (i !== references.get(code)) expect(own, `${code} nearer guide ${i}`).toBeLessThan(distanceToSegment(centre, guide)) })
  }
})

/** Where a zone's code is anchored: on an open field with ground metres as millimetres, its first slot sits centred 1 mm above the anchor. */
function zoneTop(zone: PrintZone, ground: PrintBounds): PrintPoint | null {
  const space = new FieldSpace({ x: -1000, y: -1000, width: 2000, height: 2000 }, text())
  const op = zoneLabels([{ zone, reference: 'Z01' } as ZoneMeasurements], ground, p => p, space, false).find(o => o.kind === 'text')
  if (op?.kind !== 'text') return null
  const measured = space.measure('Z01', 7.5, Infinity, true), round = (n: number) => Math.round(n * 1e6) / 1e6 + 0
  return { x: round(op.x / MM - measured.inset + measured.width / 2), y: round(op.y / MM - measured.baseline + measured.height + 1) }
}

it('tops a zone at its highest outline point inside the ground, or the middle of a level top edge', () => {
  const ground = { x: 0, y: 0, width: 10, height: 10 }
  const diamond: PrintZone = { name: null, path: 'M5 1 L8 4 L5 7 L2 4 Z', fill: null, bounds: { x: 2, y: 1, width: 6, height: 6 },
    geometry: { kind: 'polygon', points: [{ x: 5, y: 1 }, { x: 8, y: 4 }, { x: 5, y: 7 }, { x: 2, y: 4 }] } }
  expect(zoneTop(diamond, ground)).toEqual({ x: 5, y: 1 })
  expect(zoneTop(row(2), ground)).toEqual({ x: 5, y: 2 })
  // Cropped by the page, the top is the level edge where the zone enters the ground, never off it.
  expect(zoneTop(diamond, { x: 0, y: 3, width: 4, height: 5 })).toEqual({ x: 3.5, y: 3 })
  expect(zoneTop(row(20), ground)).toBeNull()
  const field: PrintZone = { ...row(-5), path: 'M-5 -5 L15 -5 L15 15 L-5 15 Z', geometry: { kind: 'rect', points: [{ x: -5, y: -5 }, { x: 15, y: -5 }, { x: 15, y: 15 }, { x: -5, y: 15 }] } }
  expect(zoneTop(field, ground)).toEqual({ x: 5, y: 0 })
})

const rect = (x: number, y: number, width: number, height: number): PrintZone => ({ name: null, path: `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`,
  fill: null, bounds: { x, y, width, height }, geometry: { kind: 'rect', points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] } })

it('tops a zone that covers the page\'s top band at the page top, not on its own lower edge', () => {
  const ground = { x: -5, y: 0, width: 30, height: 15 }
  // Only one top corner of the ground inside: the top runs from that corner to where the outline crosses the top edge.
  expect(zoneTop(rect(-50, -50, 60, 55), ground)).toEqual({ x: 2.5, y: 0 })
})

it('prints a band zone\'s code at its own top, above its neighbour\'s, whatever the drawing order', () => {
  const band = rect(-50, -50, 120, 55), neighbour = rect(0, 5, 20, 1)
  const area: PdfSetup = { ...setup, areas: [{ id: 'band', name: 'Band', bounds: { x: -5, y: 0, width: 30, height: 15 } }] }
  const placed = [[neighbour, band], [band, neighbour]].map(zones => {
    const page = buildPdfPlan({ ...design({ zones }), viewBearingDeg: 0 }, area, text(), labels).pages.find(p => p.kind === 'detail')!
    const at = onPage(page, 0), centre = (zone: PrintZone) => codes(page, new RegExp(`^Z0${zones.indexOf(zone) + 1}$`))[0]!.centre
    const bandOutline = outlineSegments(band.path, at), neighbourOutline = outlineSegments(neighbour.path, at)
    const pageTop = at({ x: 0, y: 0 }).y, sharedEdge = at({ x: 0, y: 5 }).y
    // The band's code sits in the band at the page top, never at the shared edge where it would name the neighbour.
    expect(inside(centre(band), bandOutline)).toBe(true)
    expect(inside(centre(band), neighbourOutline)).toBe(false)
    expect(Math.abs(centre(band).y - pageTop)).toBeLessThan(Math.abs(centre(band).y - sharedEdge))
    expect(away(centre(neighbour), neighbourOutline) / MM).toBeLessThanOrEqual(6)
    return [centre(band), centre(neighbour)]
  })
  expect(placed[0]).toEqual(placed[1])
})

/**
 * One detail page, frame 10 mm right and 30 mm down, ground metres at 10 mm each: plan (X, Y) prints at
 * (10 + 10X, 30 + 10Y) mm. Reserved rectangles are in millimetres; guides start off the ground so none is a dimension.
 */
function guidePage(measurements: PdfInput['canvas']['measurements'], reserved: readonly PrintBounds[], homes?: ReadonlyMap<string, string>,
  zones: readonly ZoneMeasurements[] = []) {
  const input = { ...design({ measurements, zones: zones.map(z => z.zone) }), viewBearingDeg: 0 }
  const references: Parameters<typeof drawField>[6] = { species: new Map(), notes: new Map(), plants: new Map(), zones: [...zones], measurementHomes: homes,
    measurements: new Map(measurements.map((g, i) => [g.id, `M${i + 1}`])) }
  const toPoints = (r: PrintBounds) => ({ x: r.x * MM, y: r.y * MM, width: r.width * MM, height: r.height * MM })
  return drawField(input, { x: 10 * MM, y: 30 * MM, width: 180 * MM, height: 240 * MM }, { x: 0, y: 0, width: 18, height: 24 }, 10 * MM,
    { id: 'here', width: 210 * MM, height: 297 * MM, reserved: reserved.map(toPoints) }, text(), references)
}
const printedCodes = (operations: readonly PdfPage['operations'][number][]) => codes({ operations } as PdfPage, /^M\d+$/)

it('places a continuing guide\'s wide M code beside its guide at any angle, keeping its link to the home page', () => {
  const space = new FieldSpace({ x: -1000, y: -1000, width: 2000, height: 2000 }, text())
  const wide = space.measure('M3      000', 8)
  for (const degrees of [0, 30, 45, 60, 90]) {
    const angle = degrees * Math.PI / 180, guide = { a: { x: 0, y: 0 }, b: { x: 30 * Math.cos(angle), y: 30 * Math.sin(angle) } }
    const box = space.beside(wide, guide, [])
    expect(box, `${degrees}°`).not.toBeNull()
    // Its near edge stays within the widest gap of the guide.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ x: box!.x + i! * box!.width, y: box!.y + j! * box!.height }))
    expect(Math.min(...corners.map(c => distanceToSegment(c, guide))), `${degrees}°`).toBeLessThanOrEqual(2.5 + 1e-9)
  }
  // On the page: a north-south guide whose length is crowded out of its middle, its home another page.
  const drawing = guidePage([{ id: 'g', start: { x: 9, y: -3 }, end: { x: 9, y: 9 } }], [{ x: 60, y: 60, width: 76, height: 30 }], new Map([['g', 'home']]))
  expect(drawing.notes.find(n => n.id === 'g')?.location).toBeUndefined()
  expect(printedCodes(drawing.operations).map(c => c.code)).toEqual(['M1'])
  expect(drawing.links.map(l => l.target)).toContain('page:home')
  expect(drawing.pageReferences.map(r => r.target)).toEqual(['home'])
})

it('keeps a guide\'s M code nearer its own guide than a zone dimension drawn after it', () => {
  // The guide's middle is crowded, so M1 sits beside it near y 57 mm; a narrow zone's left-edge dimension would then
  // print about 2.6 mm from M1's centre, nearer than M1's own guide (3.3 mm), for any of these left edges.
  const guide = { a: { x: 100 * MM, y: 0 }, b: { x: 100 * MM, y: 120 * MM } }
  for (const left of [9.84, 9.86, 9.88, 9.9]) {
    const zone = rect(left, 1, 10.14 - left, 2.3)
    const drawing = guidePage([{ id: 'g', start: { x: 9, y: -3 }, end: { x: 9, y: 9 } }], [{ x: 60, y: 64, width: 76, height: 22 }], undefined,
      [{ zone, reference: 'Z01', lengths: [], widths: [], diameter: false, dimensions: [{ id: 'left', start: { x: left, y: 1 }, end: { x: left, y: 3.3 }, metres: 2.3 }] }])
    const strokes = drawing.operations.flatMap(op => op.kind === 'path' && op.stroke === '#656058'
      ? [op.d.match(/^M(\S+) (\S+) L(\S+) (\S+)$/)!.slice(1).map(Number)].map(([ax, ay, bx, by]) => ({ a: { x: ax!, y: ay! }, b: { x: bx!, y: by! } })) : [])
    expect(strokes.length, `left ${left}: a zone dimension prints`).toBeGreaterThan(0)
    expect(printedCodes(drawing.operations).map(c => c.code), `left ${left}`).toEqual(['M1'])
    for (const { code, centre } of printedCodes(drawing.operations)) {
      const own = distanceToSegment(centre, guide)
      for (const stroke of strokes) expect(own, `left ${left}: ${code} nearer a zone dimension`).toBeLessThan(distanceToSegment(centre, stroke))
    }
  }
})

it('keeps a guide\'s M code in the key when its only clear side lies nearer the next guide', () => {
  // On the page: two parallel guides 3.6 mm apart, both crowded out of their middles, A's outer side taken.
  const drawing = guidePage([{ id: 'a', start: { x: -1, y: 7 }, end: { x: 13, y: 7 } }, { id: 'b', start: { x: -1, y: 7.36 }, end: { x: 13, y: 7.36 } }],
    [{ x: 10, y: 80, width: 190, height: 19.4 }, { x: 45, y: 80, width: 60, height: 45 }])
  const guides = [{ a: { x: 10 * MM, y: 100 * MM }, b: { x: 140 * MM, y: 100 * MM } }, { a: { x: 10 * MM, y: 103.6 * MM }, b: { x: 140 * MM, y: 103.6 * MM } }]
  const printed = printedCodes(drawing.operations)
  expect(printed.map(c => c.code)).toEqual(['M2'])
  for (const { code, centre } of printed) {
    const own = Number(code.slice(1)) - 1
    expect(distanceToSegment(centre, guides[own]!), code).toBeLessThan(distanceToSegment(centre, guides[1 - own]!))
  }
  expect(drawing.notes.find(n => n.id === 'a')?.location).toBeDefined()
})
