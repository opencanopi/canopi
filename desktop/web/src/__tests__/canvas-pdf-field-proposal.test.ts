import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { drawField, fieldReferences } from '../app/canvas-pdf/field-layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfOperation } from '../app/canvas-pdf/types'
import { fieldKey } from '../app/canvas-pdf/field-key'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { zoneMeasurements } from '../app/canvas-pdf/zone-measurements'
import { drawMark } from '../app/canvas-pdf/page-drawing'
import { hits, outlineSegments, rotatedBounds } from '../app/canvas-pdf/field-geometry'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const input: PdfInput = { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: {
  layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
  plants: [{ id: 'apple', canonicalName: 'Malus domestica', speciesCode: 'MDO', position: { x: 5, y: 5 },
    color: '#218455', symbol: 'round', pinnedName: false,
    mark: [{ d: 'M1 0 A1 1 0 1 0 -1 0 A1 1 0 1 0 1 0 Z', paint: 'symbol' }] }],
} }
const draw = (value: PdfInput) => drawField(value, { x: 60, y: 60, width: 400, height: 400 },
  { x: 0, y: 0, width: 10, height: 10 }, 40, { id: 'detail', width: 595, height: 842 }, text(), references(value))
/** North up: the drawn canvas is the plan. */
const references = (value: PdfInput) => fieldReferences(value, value.canvas, zoneMeasurements(value.canvas.zones))

it('prints overlapping zones transparently beneath artwork on the overview, detail and picker without changing authored fills', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas,
    layers: [...input.canvas.layers, { name: 'zones', visible: true, opacity: .43 }, { name: 'measurement-guides', visible: true, opacity: .77 }],
    zones: [
      { name: 'Bed', path: 'M1 1 H7 V7 H1 Z', fill: null, bounds: { x: 1, y: 1, width: 6, height: 6 },
        geometry: { kind: 'rect', points: [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 7 }, { x: 1, y: 7 }] } },
      { name: 'Triangle', path: 'M2 2 L8 2 L5 8 Z', fill: '#f08020', bounds: { x: 2, y: 2, width: 6, height: 6 },
        geometry: { kind: 'polygon', points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 5, y: 8 }] } },
      { name: 'Ellipse', path: 'M8 5 C8 6.1 6.66 7 5 7 C3.34 7 2 6.1 2 5 C2 3.9 3.34 3 5 3 C6.66 3 8 3.9 8 5 Z', fill: '#ffffff',
        bounds: { x: 2, y: 3, width: 6, height: 4 }, geometry: { kind: 'ellipse', center: { x: 5, y: 5 }, radii: { x: 3, y: 2 }, rotation: 0 } },
    ],
    annotations: [{ id: 'note', text: 'Keep this plant', position: { x: 3, y: 4 }, fontSize: 16, rotation: 0 }],
    measurements: [{ id: 'guide', start: { x: 3, y: 5 }, end: { x: 6, y: 5 } }],
  } }
  const before = structuredClone(source)
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants', 'zones', 'annotations', 'measurement-guides'],
    areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 10, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  const pages = [plan.pages[0]!, plan.pages.find(p => p.kind === 'detail')!, plan.pickerPage!]
  for (const page of pages) {
    const zoneIndices = page.operations.flatMap((op, i) => op.kind === 'path' && op.opacity === .43 && op.stroke === '#8b877f' ? [i] : [])
    expect(zoneIndices.length).toBeGreaterThanOrEqual(3)
    for (const i of zoneIndices) expect(page.operations[i]).toMatchObject({ fill: null })
    expect(page.operations.some(op => op.kind === 'path' && op.opacity === .43 && op.fill !== null)).toBe(false)
    const plant = page.operations.findIndex(op => op.kind === 'path' && op.fill === '#218455')
    const guide = page.operations.findIndex(op => op.kind === 'path' && op.opacity === .77)
    expect(plant).toBeGreaterThan(Math.max(...zoneIndices))
    expect(guide).toBeGreaterThan(Math.max(...zoneIndices))
    expect(page.measurementIds).toContain('guide')
  }
  expect(pages[1]!.annotationIds).toContain('note')
  expect(source).toEqual(before)
})

it('identifies unique appearances through the key without plant callouts or connecting lines', () => {
  const before = structuredClone(input)
  const drawing = draw(input)
  expect(drawing.identifiedPlants[0]!.bounds.x).toBeLessThan(260)
  expect(drawing.identifiedPlants[0]!.bounds.x + drawing.identifiedPlants[0]!.bounds.width).toBeGreaterThan(260)
  expect(drawing.operations.filter(op => op.kind === 'path')).toHaveLength(1)
  expect(drawing.legend[0]!.code).toBe('MDO')
  expect(input).toEqual(before)
})

it('adds an enclosure only where different species share a symbol and color in the detail', () => {
  const shared: PdfInput = { ...input, canvas: { ...input.canvas, plants: [input.canvas.plants[0]!,
    { ...input.canvas.plants[0]!, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO', position: { x: 7, y: 5 } }] } }
  const drawing = draw(shared)
  expect(drawing.operations.filter(op => op.kind === 'path')).toHaveLength(3)
  expect(drawing.legend.map(entry => entry.enclosures)).toEqual([['plain'], ['circle']])
  expect(drawing.identifiedPlants.flatMap(p => p.ids)).toEqual(['apple', 'pear'])
})

it('prints the Species Code to the left of its single enclosed key sample', () => {
  const drawing = draw(input)
  drawing.legend = [{ ...drawing.legend[0]!, enclosures: ['circle'] }]
  const keys = fieldKey(drawing, 'detail', () => ({ width: 595, height: 842, frame: { x: 28, y: 60, width: 539, height: 720 } }), text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' }, 1)
  const operations = keys[0]!.operations
  const code = operations.find(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'MDO')
  expect(code).toBeDefined()
  const sample = operations.find(op => op.kind === 'path' && op.fill === '#218455')!
  expect(code!.kind === 'text' && sample.kind === 'path' && code!.x < sample.matrix[4]).toBe(true)
  expect(operations.filter(op => op.kind === 'path' && op.stroke === '#24211c')).toHaveLength(1)
})

it('prints an annotation directly at a readable scaled size when its rotated ink fits', () => {
  const source = { ...input, canvas: { ...input.canvas, annotations: [{ id: 'note', position: { x: 2, y: 2 }, text: 'Keep clear', fontSize: 16, rotation: 30 }] } }
  const drawing = draw(source)
  expect(drawing.notes).toEqual([])
  expect(drawing.operations.some(op => op.kind === 'text' && op.rotation === 30 && op.size >= 7 && op.size <= 12
    && op.line.runs.map(r => r.text).join('') === 'Keep clear')).toBe(true)
  expect(drawing.annotationIds).toEqual(['note'])
})

it('uses the reserved Species Code locally when enclosure choices are exhausted', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: Array.from({ length: 5 }, (_, i) => ({ ...input.canvas.plants[0]!,
    id: String(i), canonicalName: `Species ${i}`, speciesCode: `SP${i}`, position: { x: 1 + i * 1.8, y: 5 } })) } }
  const drawing = draw(source)
  expect(drawing.operations.some(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'SP4')).toBe(true)
  expect(drawing.operations.filter(op => op.kind === 'path')).toHaveLength(8)
})

it('fits a complete compact key beside a narrow detail without a redundant key page', () => {
  const plan = buildPdfPlan(input, { paper: 'A4', layers: ['plants'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 4, y: 0, width: 2, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  expect(plan.pages.map(p => p.kind)).toEqual(['overview', 'detail'])
  expect(plan.pages[1]!.operations.some(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'Malus domestica')).toBe(true)
  const destinations = new Set(plan.pages.flatMap(p => [`page:${p.id}`, ...p.destinations?.map(d => d.id) ?? []]))
  for (const page of plan.pages) for (const link of page.links ?? []) expect(destinations.has(link.target)).toBe(true)
})

it('numbers detail sheets consecutively regardless of their physical PDF page indices', () => {
  const plan = buildPdfPlan(input, { paper: 'A4', layers: ['plants'], areas: [0, 1, 2].map(i => ({ id: String(i), name: 'Bed', bounds: { x: 0, y: 0, width: 10, height: 10 } })) }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const details = plan.pages.filter(p => p.kind === 'detail')
  expect(details.map(p => p.detailNumber)).toEqual([1, 2, 3])
  expect(details.map(p => p.number)).toEqual([2, 3, 4])
})

it('reports true ellipse diameters on the overview rather than its rotated bounding box', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Pond', path: 'M6 20 C6 18 14 18 14 20 Z',
    bounds: { x: 6.83, y: 16.83, width: 6.34, height: 6.34 }, fill: null,
    geometry: { kind: 'ellipse', center: { x: 10, y: 20 }, radii: { x: 4, y: 2 }, rotation: 45 } }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const words = plan.pages[0]!.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : []).join(' ')
  expect(words).toContain('8.00')
  expect(words).toContain('4.00')
  expect(words).not.toContain('6.34')
})

it('derives straight and bent zone sizes from real edges without inventing a rectangular extent', () => {
  const zones = zoneMeasurements([
    { name: 'Z01', path: '', fill: null, bounds: { x: 0, y: 0, width: 8, height: 8 }, geometry: { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 1.4, y: 5.2 }, { x: -1.6, y: 1.2 }] } },
    { name: 'Z02', path: '', fill: null, bounds: { x: 0, y: 0, width: 4, height: 4 }, geometry: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 }] } },
  ])
  expect(zones[0]).toMatchObject({ lengths: [5], widths: [2] })
  expect(zones[1]).toMatchObject({ lengths: [4, 4], widths: [1] })
  expect(zones[1]!.dimensions.map(d => d.metres)).toEqual([4, 4, 1])
})

it('adds derived dimensions to a detail while preserving authored guides and zone geometry', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Bed', path: 'M2 2 H7 V4 H2 Z',
    bounds: { x: 2, y: 2, width: 5, height: 2 }, fill: null,
    geometry: { kind: 'rect', points: [{ x: 2, y: 2 }, { x: 7, y: 2 }, { x: 7, y: 4 }, { x: 2, y: 4 }] } }],
    measurements: [{ id: 'authored', start: { x: 2, y: 7 }, end: { x: 3.5, y: 7 } }] } }
  const before = structuredClone(source)
  const drawing = draw(source)
  const words = drawing.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : []).join(' ')
  expect(words).toContain('5 m')
  expect(words).toContain('2 m')
  expect(words).toContain('1.5 m')
  expect(drawing.measurementIds).toEqual(['authored'])
  expect(source).toEqual(before)
})

it('reuses enclosure choices for species that never share a detail and favors frequent plants for the plain mark', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: [
    ['A', 1], ['B', 2], ['B', 3], ['B', 12], ['B', 13], ['C', 14],
  ].map(([name, x], i) => ({ ...input.canvas.plants[0]!, id: String(i), canonicalName: String(name), position: { x: Number(x), y: 5 } })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants'], areas: [0, 10].map((x, i) => ({ id: String(i), name: 'Bed', bounds: { x, y: 0, width: 6, height: 10 } })) }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const details = plan.pages.filter(p => p.kind === 'detail')
  for (const detail of details) expect(detail.legend.find(e => e.canonicalName === 'B')!.enclosures).toEqual(['plain'])
  expect(details[0]!.legend.find(e => e.canonicalName === 'A')!.enclosures).toEqual(['circle'])
  expect(details[1]!.legend.find(e => e.canonicalName === 'C')!.enclosures).toEqual(['circle'])
})

it('groups repeated overview guide values by zone while retaining every authored segment', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Bed', path: 'M0 0 H4 V8 H0 Z',
    bounds: { x: 0, y: 0, width: 4, height: 8 }, fill: null, geometry: { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 8 }, { x: 0, y: 8 }] } }],
    measurements: [1, 2, 3].map(y => ({ id: `g${y}`, start: { x: 2, y }, end: { x: 2.5, y } })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones', 'measurement-guides'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const overview = plan.pages[0]!
  const words = overview.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])
  expect(words).toContain('0.5 ×3')
  expect(words.filter(w => w === '0.5 m')).toHaveLength(0)
  expect(overview.measurementIds).toEqual(['g1', 'g2', 'g3'])
})

it('retains the authored compact symbol even at small print sizes so the visual key stays meaningful', () => {
  const operations: PdfOperation[] = []
  drawMark({ ...input.canvas.plants[0]!, symbol: 'square', smallMark: [{ d: 'M-1 -1 H1 V1 H-1 Z', paint: 'symbol' }] }, 10, 20, 1, .7, operations)
  expect(operations).toEqual([expect.objectContaining({ kind: 'path', d: 'M-1 -1 H1 V1 H-1 Z', fill: '#218455', opacity: .7 })])
})

it('gives printed details a clear sheet identity, totals and a ground scale', () => {
  const plan = buildPdfPlan(input, { paper: 'A4', layers: ['plants'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 4, y: 0, width: 2, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: 'Print at 100%' })
  const words = plan.pages[1]!.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])
  expect(words).toContain('Detail 1')
  expect(words).toContain('1 plants · 1 species')
  expect(words).toContain('Print at 100% · A4')
  expect(words.some(w => /^\d+(?:\.\d+)? m$/.test(w))).toBe(true)
})

it('retains complete coincident plant membership behind one location reference', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [input.canvas.plants[0]!,
    { ...input.canvas.plants[0]!, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO' }] } }
  const drawing = draw(source)
  const note = drawing.notes.find(n => n.kind === 'plants')
  expect(note?.plantIds).toEqual(['apple', 'pear'])
  expect(note?.text).toContain('MDO')
  expect(note?.text).toContain('PCO')
  expect(drawing.identifiedPlants).toHaveLength(1)
  expect(drawing.identifiedPlants[0]!.reference).toMatch(/^P\d+$/)
})

it('moves a slender map across the sheet to fit its full key without reducing drawing scale', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: Array.from({ length: 29 }, (_, i) => ({ ...input.canvas.plants[0]!,
    id: String(i), canonicalName: `Species ${i}`, speciesCode: `S${i}`, color: `#${(100000 + i).toString(16).padStart(6, '0')}`, position: { x: 2, y: i / 2 } })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 5, height: 15 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages.map(p => p.kind)).toEqual(['overview', 'detail'])
  expect(plan.pages[1]!.legend).toHaveLength(29)
  expect(plan.pages[1]!.pointsPerMeter).toBeGreaterThan(47)
})

it('retains small kinks on a bent bed’s exterior without mistaking them for its width', () => {
  const [zone] = zoneMeasurements([{ name: 'Bent bed', path: '', fill: null, bounds: { x: 0, y: 0, width: 6, height: 5 },
    geometry: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3.5, y: .005 }, { x: 6, y: 0 },
      { x: 6, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 5 }, { x: 0, y: 5 }] } }])
  expect(zone!.widths).toEqual([1])
  expect(zone!.lengths).toHaveLength(4)
  expect(zone!.lengths.map(n => Math.round(n * 100) / 100)).toEqual([5, 2.5, .5, 3])
})

it('preserves covered detail notes and omits remote notes instead of relocating them', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, annotations: [
    { id: 'local', text: 'Protect this cultivar', position: { x: 2, y: 2 }, fontSize: 16, rotation: 0 },
    { id: 'general', text: 'All varieties may be substituted', position: { x: -20, y: 0 }, fontSize: 16, rotation: 0 },
  ] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants', 'annotations'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 10, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const words = (pages: typeof plan.pages) => pages.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')
  expect(words([plan.pages[0]!])).not.toContain('Protect this cultivar')
  expect(words(plan.pages)).toContain('Protect this cultivar')
  expect(words(plan.pages)).not.toContain('All varieties may be substituted')
  expect(plan.pages[0]!.ground.x).toBeGreaterThan(-15)
  expect(plan.pages.filter(p => p.kind === 'detail')).toHaveLength(1)
})

it('aligns a vertical dimension label with its guide instead of consuming the planting gap', () => {
  const drawing = draw({ ...input, canvas: { ...input.canvas, plants: [], measurements: [{ id: 'vertical', start: { x: 5, y: 2 }, end: { x: 5, y: 8 } }] } })
  expect(drawing.operations.some(op => op.kind === 'text' && op.rotation === -90 && op.line.runs.map(r => r.text).join('') === '6 m')).toBe(true)
  expect(drawing.measurementIds).toEqual(['vertical'])
})

it('keeps full zone sizes on the detail itself when the zone crosses its crop', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Long bed', path: 'M0 0 H100 V1 H0 Z', fill: null,
    bounds: { x: 0, y: 0, width: 100, height: 1 }, geometry: { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 1 }, { x: 0, y: 1 }] } }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones'], areas: [{ id: 'crop', name: 'Crop', bounds: { x: -1, y: -1, width: 12, height: 4 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' })
  const detail = plan.pages.find(p => p.kind === 'detail')!
  expect(detail.operations.some(op => op.kind === 'text' && op.size === 8 && op.y < 90 && op.line.runs.map(r => r.text).join('').includes('100 × 1 m'))).toBe(true)
})

it('fits a field key with both common and botanical names without shrinking the map', () => {
  const plants = Array.from({ length: 29 }, (_, i) => ({ ...input.canvas.plants[0]!, id: String(i), canonicalName: `Genus species ${i}`, speciesCode: `S${i}`,
    color: `#${(100000 + i).toString(16).padStart(6, '0')}`, position: { x: 2, y: i / 2 } }))
  const source: PdfInput = { ...input, commonNames: Object.fromEntries(plants.map((p, i) => [p.canonicalName, `Common name ${i}`])), canvas: { ...input.canvas, plants,
    annotations: [{ id: 'long', text: 'A complete note '.repeat(8), position: { x: 3, y: 5 }, fontSize: 16, rotation: 0 }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants', 'annotations'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 5, height: 15 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages.map(p => p.kind)).toEqual(['overview', 'detail'])
  const words = plan.pages[1]!.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : []).join(' ')
  expect(words).toContain('Genus species 28')
  expect(words).toContain('Common name 28')
})

it('labels overview zones on the drawing so their dimension table can be used on paper', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Z01', path: 'M0 0 H4 V8 H0 Z', fill: null,
    bounds: { x: 0, y: 0, width: 4, height: 8 }, geometry: { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 8 }, { x: 0, y: 8 }] } }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  const page = plan.pages[0]!
  expect(page.operations.some(op => op.kind === 'text' && op.x < page.frame.x + page.frame.width && op.line.runs.map(r => r.text).join('') === 'Z01')).toBe(true)
})

it('keeps a note near its authored position by interrupting only a crossing zone outline', () => {
  const drawing = draw({ ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Bed', path: 'M2 1 L3.5 1 L3.5 8 L2 8 Z', geometry: { kind: 'rect' as const, points: [{ x: 2, y: 1 }, { x: 3.5, y: 1 }, { x: 3.5, y: 8 }, { x: 2, y: 8 }] }, fill: null,
    bounds: { x: 2, y: 1, width: 1.5, height: 7 } }], annotations: [{ id: 'note', text: 'Keep access clear', fontSize: 16, rotation: 0, position: { x: 2, y: 4 } }] } })
  const note = drawing.operations.find(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'Keep access clear')!
  expect(note.kind === 'text' && note.x >= 140 && note.x < 142).toBe(true)
  if (note.kind !== 'text' || !note.line.ink) throw new Error('Missing note ink')
  const ink = rotatedBounds(note.line.ink, note.rotation, note)
  for (const op of drawing.operations) {
    if (op.kind === 'path' && op.stroke === '#8b877f') {
      const [a, b, c, d, x, y] = op.matrix
      expect(outlineSegments(op.d, p => ({ x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y })).some(s => hits(s, ink))).toBe(false)
    }
  }
  expect(drawing.operations.some(op => op.kind === 'path' && op.fill === '#ffffff')).toBe(false)
})

it('prints a connected chain of authored overview guides in a readable aligned band', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: [], measurements: [0, 1, 2, 3].map(x => ({ id: `g${x}`, start: { x, y: 5 }, end: { x: x + 1, y: 5 } })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['measurement-guides'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  const page = plan.pages[0]!
  const labels = page.operations.filter(op => op.kind === 'text' && op.size >= 7 && op.y > page.frame.y + page.frame.height && op.line.runs.map(r => r.text).join('') === '1')
  expect(labels).toHaveLength(4)
  expect(page.measurementIds).toEqual(['g0', 'g1', 'g2', 'g3'])
})

it('paginates only zone dimensions and guide values when an overview with annotations overflows', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: Array.from({ length: 90 }, (_, i) => ({
    name: `Z${String(i + 1).padStart(2, '0')}`, path: `M${i} 0 h1 v3 h-1 Z`, fill: null,
    bounds: { x: i, y: 0, width: 1, height: 3 }, geometry: { kind: 'rect' as const, points: [{ x: i, y: 0 }, { x: i + 1, y: 0 }, { x: i + 1, y: 3 }, { x: i, y: 3 }] },
  })), measurements: Array.from({ length: 90 }, (_, i) => ({ id: `guide-${i}`, start: { x: i + .5, y: 1 }, end: { x: i + .5, y: 1.5 } })),
    annotations: [{ id: 'omit', text: 'Uncovered annotation '.repeat(30), position: { x: 45, y: 1 }, fontSize: 16, rotation: 0 }],
  } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones', 'measurement-guides', 'annotations'], views: { 'overview:legend:0': { orientation: 'portrait' } } }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages.length).toBeGreaterThan(1)
  expect(plan.pages.slice(1).every(p => p.kind === 'legend' && p.sourceId === 'overview')).toBe(true)
  expect(plan.pages[0]!.measurementIds).toHaveLength(90)
  expect(plan.pages.flatMap(p => p.annotationIds ?? [])).toEqual([])
  const continuation = plan.pages.find(p => p.sourceId === 'overview')!
  expect(continuation.width).toBeLessThan(continuation.height)
  expect(plan.pages.filter(p => p.sourceId === 'overview').length).toBeGreaterThan(0)
  const values = plan.pages.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : []))
  expect(values).toContain('Z90')
  expect(values.filter(v => v === '0.5')).toHaveLength(90)
  expect(values.join(' ')).not.toContain('Uncovered annotation')
  for (const page of plan.pages) {
    for (const op of page.operations) {
      if (op.kind === 'text' && op.line.ink) {
        expect(op.y + op.line.ink.y + op.line.ink.height).toBeLessThan(page.height)
      }
    }
  }
})

it('keeps local overview notes legible at a large ground extent', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], zones: [{ name: 'Park', path: 'M0 0 L400 0 L400 400 L0 400 Z', geometry: { kind: 'rect' as const, points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }] }, fill: null,
    bounds: { x: 0, y: 0, width: 400, height: 400 } }], annotations: [{ id: 'tree', text: 'Keep this tree', fontSize: 16, rotation: 0, position: { x: 200, y: 200 } }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['zones', 'annotations'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages[0]!.operations.some(op => op.kind === 'text' && op.size >= 7 && op.line.runs.map(r => r.text).join('') === 'Keep this tree')).toBe(true)
})

it('keeps compact key descenders and enclosed samples clear of row separators', () => {
  const source: PdfInput = { ...input, commonNames: { 'Malus domestica': 'Young apple' }, canvas: { ...input.canvas, plants: [input.canvas.plants[0]!,
    { ...input.canvas.plants[0]!, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO', position: { x: 5, y: 7 } }] } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 4, y: 0, width: 2, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages).toHaveLength(2)
  const page = plan.pages[1]!
  const ink = page.operations.flatMap(op => op.kind === 'text' && op.line.ink ? [rotatedBounds(op.line.ink, op.rotation, op)] : [])
  for (const op of page.operations) {
    if (op.kind === 'path' && op.stroke === '#d8d2c8') {
      const segments = outlineSegments(op.d, p => p)
      expect(ink.some(b => segments.some(s => hits(s, b)))).toBe(false)
    }
  }
})


it('keeps a cropped overview guide at its full distance without drawing the chain beyond the page', () => {
  const source: PdfInput = { ...input, canvas: { ...input.canvas, plants: [], measurements: [0, 1, 2, 3].map(i => ({
    id: `g${i}`, start: { x: i, y: 0 }, end: { x: i + 1, y: 0 },
  })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['measurement-guides'], views: { overview: { zoom: 500 } } }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  const words = plan.pages.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')
  expect(words).toContain('1 m')
  for (const page of plan.pages) {
    for (const op of page.operations) {
      if (op.kind === 'text' && op.line.ink) {
        const ink = rotatedBounds(op.line.ink, op.rotation, op)
        expect(ink.x).toBeGreaterThanOrEqual(0)
        expect(ink.x + ink.width).toBeLessThan(page.width)
        expect(ink.y + ink.height).toBeLessThan(page.height)
      }
    }
  }
})

it('uses direct Species Codes for locally occasional ambiguous plants, regardless of whole-Design frequency', () => {
  const plants = Array.from({ length: 12 }, (_, i) => ({ ...input.canvas.plants[0]!, id: `apple-${i}`, position: { x: 3, y: 1 + i * .6 } }))
  const pear = { ...input.canvas.plants[0]!, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO', position: { x: 7, y: 5 } }
  const source = { ...input, canvas: { ...input.canvas, plants: [...plants, pear] } }
  const allPlants = references({ ...source, canvas: { ...source.canvas, plants: [...source.canvas.plants,
    ...Array.from({ length: 100 }, (_, i) => ({ ...pear, id: `outside-${i}`, position: { x: 30, y: i } }))] } })
  const drawing = drawField(source, { x: 60, y: 60, width: 400, height: 400 }, { x: 0, y: 0, width: 10, height: 10 }, 40,
    { id: 'detail', width: 595, height: 842 }, text(), allPlants)
  expect(drawing.legend.find(e => e.canonicalName === 'Pyrus communis')!.enclosures).toEqual(['code'])
  expect(drawing.legend.find(e => e.canonicalName === 'Malus domestica')!.enclosures).toEqual(['plain'])
  expect(drawing.operations.some(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'PCO')).toBe(true)
  expect(drawing.notes.filter(n => n.kind === 'plants')).toEqual([])
})

it('keeps an unplaceable species under its existing code and coordinates without inventing a P identifier', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: Array.from({ length: 5 }, (_, i) => ({ ...input.canvas.plants[0]!,
    id: String(i), canonicalName: `Species ${i}`, speciesCode: `SP${i}`, position: { x: 5 + i * .001, y: 5 } })) } }
  const drawing = draw(source)
  const note = drawing.notes.find(n => n.species === 'Species 4')!
  expect(note.reference).toBe('SP4')
  expect(note.location).toContain('x 5')
  expect(drawing.operations.some(op => op.kind === 'text' && /^P\d+$/.test(op.line.runs.map(r => r.text).join('')))).toBe(false)
  expect(drawing.identifiedPlants.find(p => p.ids.includes('4'))!.bounds.width).toBe(0)
})

it('keeps crowded annotations off the overview without an N marker or annotation index', async () => {
  const { drawOverview } = await import('../app/canvas-pdf/overview')
  const source = { ...input, canvas: { ...input.canvas, annotations: [{ id: 'crowded', text: 'Full contextual note '.repeat(30),
    position: { x: 5, y: 5 }, fontSize: 16, rotation: 0 }] } }
  const overview = drawOverview(source, { x: 30, y: 80, width: 500, height: 400 }, { x: 0, y: 0, width: 10, height: 8 }, 50, text(), new Map(), true)
  expect(overview.notes.filter(n => n.kind === 'annotation')).toEqual([])
  expect(overview.annotationIds).not.toContain('crowded')
  expect(overview.operations.some(op => op.kind === 'text' && /^N\d+$/.test(op.line.runs.map(r => r.text).join('')))).toBe(false)
})

it('omits unreadable notes outside chosen details without expanding their coverage', () => {
  const source = { ...input, canvas: { ...input.canvas, plants: [...input.canvas.plants, { ...input.canvas.plants[0]!, id: 'remote-plant', position: { x: 25, y: 5 } }], annotations: [{ id: 'outside', text: 'Complete field instruction '.repeat(15),
    position: { x: 25, y: 5 }, fontSize: 16, rotation: 0 }] } }
  const setup = { paper: 'A4' as const, layers: ['plants', 'annotations'], areas: [{ id: 'chosen', name: 'Chosen', bounds: { x: 0, y: 0, width: 10, height: 10 } }] }
  const before = structuredClone(setup)
  const plan = buildPdfPlan(source, setup, text(), { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages.filter(p => p.kind === 'detail')).toHaveLength(1)
  expect(plan.pages.find(p => p.id === 'area:chosen')!.ground).toEqual(setup.areas[0]!.bounds)
  expect(plan.pages.flatMap(p => p.annotationIds ?? [])).not.toContain('outside')
  expect(plan.pages.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')).not.toContain('Complete field instruction')
  expect(setup).toEqual(before)
})

it('places a short code immediately above an occasional plant when its row has no side clearance', () => {
  const apple = input.canvas.plants[0]!
  const plants = Array.from({ length: 12 }, (_, i) => ({ ...apple, id: `a${i}`, position: { x: 1 + i * .7, y: 5 } }))
  const pear = { ...apple, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO', position: { x: 4.15, y: 5 } }
  const drawing = draw({ ...input, canvas: { ...input.canvas, plants: [...plants, pear] } })
  expect(drawing.notes.filter(n => n.species)).toEqual([])
  const label = drawing.operations.find(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'PCO')!
  expect(label).toBeDefined()
  if (label.kind !== 'text') throw new Error('Missing code')
  expect(Math.abs(label.y - 260)).toBeLessThan(15)
})

it('keeps multi-line zone dimensions and their descenders clear of overview table rules', () => {
  const zone = { name: 'Z01', path: 'M0 0 H4 V1 H1 V4 H0 Z', fill: null, bounds: { x: 0, y: 0, width: 4, height: 4 },
    geometry: { kind: 'polygon' as const, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 }] } }
  const plan = buildPdfPlan({ ...input, canvas: { ...input.canvas, zones: [zone, { ...zone, name: 'Z02' }] } }, { paper: 'A4', layers: ['zones'] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  const page = plan.pages[0]!, ink = page.operations.flatMap(op => op.kind === 'text' && op.line.ink ? [rotatedBounds(op.line.ink, op.rotation, op)] : [])
  for (const op of page.operations) {
    if (op.kind === 'path' && op.stroke === '#d8d2c8') {
      expect(ink.some(b => outlineSegments(op.d, p => p).some(s => hits(s, b)))).toBe(false)
    }
  }
})

it('uses an available enclosure when measurement ink leaves no readable place for an occasional code', () => {
  const apple = input.canvas.plants[0]!
  const source = { ...input, canvas: { ...input.canvas,
    plants: [...Array.from({ length: 12 }, (_, i) => ({ ...apple, id: `a${i}`, position: { x: 2, y: 1 + i * .6 } })),
      { ...apple, id: 'pear', canonicalName: 'Pyrus communis', speciesCode: 'PCO', position: { x: 5, y: 5 } }],
    measurements: Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, start: { x: 4 + i * .1, y: 4.5 }, end: { x: 4 + i * .1, y: 5.5 } })),
  } }
  const drawing = draw(source)
  expect(drawing.legend.find(e => e.canonicalName === 'Pyrus communis')!.enclosures).toEqual(['circle'])
  expect(drawing.identifiedPlants.every(p => p.bounds.width > 0)).toBe(true)
  expect(drawing.measurementIds).toHaveLength(21)
})

it('retains a long covered note in its detail key while omitting a neighbouring uncovered note', () => {
  const source = { ...input, canvas: { ...input.canvas, annotations: [5, 6].map((x, i) => ({ id: i ? 'deferred' : 'covered', text: 'Complete instruction '.repeat(20),
    position: { x, y: 5 }, fontSize: 16, rotation: 0 })) } }
  const plan = buildPdfPlan(source, { paper: 'A4', layers: ['plants', 'annotations'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 5.5, height: 10 } }] }, text(),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'plants', actualSize: '100%' })
  expect(plan.pages.filter(p => p.kind === 'detail').map(p => p.id)).toEqual(['area:bed'])
  expect(plan.pages.flatMap(p => p.annotationIds ?? [])).toEqual(['covered'])
  const detail = plan.pages.find(p => p.id === 'area:bed')!
  expect(detail.operations.some(op => op.kind === 'text' && /^N\d+$/.test(op.line.runs.map(r => r.text).join('')))).toBe(true)
  expect(plan.pages.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')).toContain('Complete instruction')
})
