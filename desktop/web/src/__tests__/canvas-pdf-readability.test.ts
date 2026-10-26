import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { drawMark } from '../app/canvas-pdf/page-drawing'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { FieldSpace } from '../app/canvas-pdf/field-placement'
import { hits, outlineSegments, overlaps } from '../app/canvas-pdf/field-geometry'
import type { PdfInput, PdfLabels, PdfPage, PdfOperation, PdfSetup } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([
  ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')], ['strong', readFileSync('src/app/canvas-pdf/fonts/NotoSans-SemiBold.ttf')],
]), 'en')
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }
const mark = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }]
const words = (page: PdfPage) => page.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(run => run.text) : []).join(' ')
const setup: PdfSetup = { paper: 'A4', layers: ['plants', 'annotations', 'measurement-guides', 'zones'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: -1, y: -1, width: 10, height: 15 } }] }
function input(): PdfInput {
  return { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: { 'Mentha spicata': 'Mint' }, canvas: {
    layers: setup.layers.map(name => ({ name, visible: true, opacity: 1 })),
    plants: Array.from({ length: 25 }, (_, i) => ({ id: String(i), canonicalName: 'Mentha spicata', speciesCode: 'MSP', position: { x: 2, y: i * .4 },
      color: '#123456', symbol: 'rosette', mark, pinnedName: false })), annotations: [], zones: [], measurements: [],
  } }
}

it('identifies every member of a unique straight row through its glyph and one key entry', () => {
  const source = input(), before = structuredClone(source)
  const plan = buildPdfPlan(source, setup, text(), labels), page = plan.pages.find(p => p.kind === 'detail')!
  expect(plan.blocked).toBeNull()
  const ids = page.identifiedPlants!.flatMap(group => group.ids)
  expect([...ids].sort()).toEqual(source.canvas.plants.map(p => p.id).sort())
  expect(new Set(ids).size).toBe(ids.length)
  expect(page.identifiedPlants!.every(group => group.ids.length === 1)).toBe(true)
  expect(plan.pages.map(words).join(' ')).toContain('×25')
  expect(page.legend).toHaveLength(1)
  expect(page.legend[0]!.enclosures).toEqual(['plain'])
  expect(source).toEqual(before)
})

it('keeps alternating species and appearance overrides individually identifiable', () => {
  const base = input()
  const source = { ...base, canvas: { ...base.canvas, plants: base.canvas.plants.map((p, i) => ({ ...p,
    canonicalName: i % 2 ? 'Mentha spicata' : 'Melissa officinalis', speciesCode: i % 2 ? 'MSP' : 'MOF', color: i === 5 ? '#abcdef' : p.color })) } }
  const page = buildPdfPlan(source, setup, text(), labels).pages.find(p => p.kind === 'detail')!
  expect(page.identifiedPlants!.flatMap(group => group.ids).sort()).toEqual(source.canvas.plants.map(p => p.id).sort())
  for (const group of page.identifiedPlants!) {
    const members = source.canvas.plants.filter(p => group.ids.includes(p.id))
    expect(new Set(members.map(p => p.canonicalName + p.color)).size).toBe(1)
  }
  expect(page.identifiedPlants!.find(group => group.ids.includes('5'))!.ids).toEqual(['5'])
})

it('places transparent readable text clear of other text and stroked geometry on a diagonal planting', () => {
  const base = input(), a = Math.PI / 6
  const source: PdfInput = { ...base, canvas: { ...base.canvas,
    plants: base.canvas.plants.map(p => ({ ...p, position: { x: p.position.y * Math.cos(a), y: p.position.y * Math.sin(a) } })),
    zones: [{ name: 'Boundary', path: 'M-0.3 0.8 L8.1 5.65', geometry: { kind: 'line' as const, points: [{ x: -0.3, y: 0.8 }, { x: 8.1, y: 5.65 }] }, fill: null, bounds: { x: -.3, y: .8, width: 8.4, height: 4.85 } }],
    measurements: [{ id: 'distance', start: { x: 0, y: 0 }, end: { x: Math.cos(a) * .4, y: Math.sin(a) * .4 } }],
  } }
  const page = buildPdfPlan(source, setup, text(), labels).pages.find(p => p.kind === 'detail')!
  const inks = page.operations.flatMap(op => op.kind === 'text' && op.line.ink ? [{ x: op.x + op.line.ink.x, y: op.y + op.line.ink.y, width: op.line.ink.width, height: op.line.ink.height }] : [])
  for (const [i, ink] of inks.entries()) {
    expect(ink.x).toBeGreaterThanOrEqual(0); expect(ink.y).toBeGreaterThanOrEqual(0)
    expect(ink.x + ink.width).toBeLessThanOrEqual(page.width)
    expect(ink.y + ink.height).toBeLessThanOrEqual(page.height)
    for (const other of inks.slice(i + 1)) expect(overlaps(ink, other)).toBe(false)
    for (const op of page.operations) {if (op.kind === 'path' && op.stroke && !op.fill) {
      const [a, b, c, d, x, y] = op.matrix
      const segments = outlineSegments(op.d, p => ({ x: a * p.x + c * p.y + x, y: b * p.x + d * p.y + y }))
      expect(segments.some(segment => hits(segment, ink))).toBe(false)
    }}
  }
  expect(page.operations.some(op => op.kind === 'path' && op.fill === '#ffffff')).toBe(false)
  expect(words(page)).toContain('0.4 m')
})

it('retains complete rotated, coincident and boundary annotations directly or in the key', () => {
  const base = input(), notes = ['First note with accents: été', 'Second note', 'Boundary note']
  const source = { ...base, canvas: { ...base.canvas, annotations: notes.map((value, i) => ({ id: `note${i}`, text: value, fontSize: 16, rotation: i * 90,
    position: i === 2 ? { x: 9, y: 14 } : { x: 2, y: 2 } })) } }
  const plan = buildPdfPlan(source, setup, text(), labels), page = plan.pages.find(p => p.kind === 'detail')!
  expect(plan.blocked).toBeNull()
  expect(page.annotationIds).toHaveLength(3)
  const key = plan.pages.filter(p => p.id === page.id || p.sourceId === page.id).map(words).join(' ')
  for (const value of notes) expect(key).toContain(value)
  expect(page.links!.filter(l => l.target.includes(':note:N')).length).toBeLessThan(3)
})

it('retains authored overview notes without adding an appendix when field coverage changes', () => {
  const base = input(), source = { ...base, canvas: { ...base.canvas, annotations: [{ id: 'note', text: 'Protect seedlings', fontSize: 100, rotation: -45, position: { x: 2, y: 2 } }] } }
  for (const options of [setup, { ...setup, areas: [] }, { ...setup, views: { 'area:bed': { offset: { x: 100, y: 100 } } } }]) {
    const plan = buildPdfPlan(source, options, text(), labels)
    expect(plan.blocked).toBeNull()
    expect(plan.pages.map(words).join(' ')).toContain('Protect seedlings')
    if (options === setup) expect(words(plan.pages[0]!)).not.toContain('Protect seedlings')
    else expect(words(plan.pages[0]!)).toContain('Protect seedlings')
    expect(plan.pages.some(p => p.sourceId === 'overview')).toBe(false)

  }
})

it('preserves a full measurement crossing a crop instead of reporting the clipped distance', () => {
  const base = input(), source = { ...base, canvas: { ...base.canvas, measurements: [{ id: 'long', start: { x: -10, y: 3 }, end: { x: 20, y: 3 } }] } }
  const plan = buildPdfPlan(source, setup, text(), labels), page = plan.pages.find(p => p.kind === 'detail')!
  expect(page.measurementIds).toEqual(['long'])
  expect(plan.pages.filter(p => p.id === page.id || p.sourceId === page.id).map(words).join(' ')).toContain('30 m')
  expect(words(page)).not.toContain('10 m')
})

it('preserves readable pinned names and authored spacing notes beside their anchor', () => {
  const base = input(), source = { ...base, canvas: { ...base.canvas, plants: [{ ...base.canvas.plants[0]!, pinnedName: true }],
    annotations: [{ id: 'space', text: '(40 cm)', fontSize: 16, rotation: 0, position: { x: 4, y: 4 } }] } }
  const page = buildPdfPlan(source, setup, text(), labels).pages.find(p => p.kind === 'detail')!
  expect(words(page)).toContain('Mint'); expect(words(page)).toContain('(40 cm)')
})

it('retains the compact authored symbol at small sizes and selects detail at readable sizes', () => {
  const plant = { ...input().canvas.plants[0]!, smallMark: [{ ...mark[0]!, d: 'compact' }] }
  for (const symbol of ['round', 'canopy', 'fern', 'rosette']) {
    const operations: PdfOperation[] = []
    drawMark({ ...plant, symbol }, 10, 20, 1, .6, operations)
    expect(operations).toEqual([{ kind: 'path', d: 'compact',
      matrix: [1, 0, 0, 1, 10, 20], fill: '#123456', stroke: null, width: 0, opacity: .6 }])
  }
  for (const [radius, expected] of [[3, 'compact'], [6, mark[0]!.d]] as const) {
    const operations: PdfOperation[] = []
    drawMark(plant, 10, 20, radius, 1, operations)
    expect(operations[0]).toMatchObject({ kind: 'path', d: expected, fill: '#123456' })
  }
})

it('lets an annotation connector leave a plant clearance margin without obscuring another marker', () => {
  const space = new FieldSpace({ x: 0, y: 0, width: 100, height: 100 }, text())
  space.mark('near', { x: 49, y: 49, width: 2, height: 2 })
  space.mark('other', { x: 44, y: 50, width: 2, height: 2 })
  const placed = space.place(space.measure('N24', 8), [{ x: 50, y: 51.05 }], ['note'], 'note', { note: true })
  expect(placed).not.toBeNull()
  expect(placed!.route.some(s => hits(s, space.marks.get('other')!))).toBe(false)
})

it('links a cropped measurement to its complete detail using consecutive detail numbering', () => {
  const base = input(), source = { ...base, canvas: { ...base.canvas, measurements: [{ id: 'long', start: { x: -10, y: 3 }, end: { x: 20, y: 3 } }] } }
  const options = { ...setup, areas: [...setup.areas!, { id: 'full', name: 'Full length', bounds: { x: -11, y: 0, width: 32, height: 6 } }] }
  const plan = buildPdfPlan(source, options, text(), labels), cropped = plan.pages.find(p => p.id === 'area:bed')!, full = plan.pages.find(p => p.id === 'area:full')!
  expect(cropped.links!.some(l => l.target === `page:${full.id}`)).toBe(true)
  expect(cropped.pageReferences).toHaveLength(1)
  const location = cropped.pageReferences![0]!
  expect(cropped.operations.some(op => op.kind === 'text' && op.y === location.y && op.line.runs.map(r => r.text).join('') === String(full.detailNumber))).toBe(true)
  expect(plan.pages.filter(p => p.id === cropped.id || p.sourceId === cropped.id).map(words).join(' ')).toContain('30 m')
})

it('prints symbol cut-outs in paper or ink, whichever contrasts with the symbol colour', () => {
  const plant = input().canvas.plants[0]!
  const marks = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }, { d: 'M0 0 h1 v1 h-1 Z', paint: 'cutout' as const }]
  for (const [color, cutout] of [['#123456', '#ffffff'], ['#E9D28B', '#24211c']] as const) {
    const operations: PdfOperation[] = []
    drawMark({ ...plant, color, mark: marks }, 10, 20, 6, 1, operations)
    expect(operations.map((op) => op.kind === 'path' ? [op.d, op.fill] : null)).toEqual([['M-1 -1 h2 v2 h-2 Z', color], ['M0 0 h1 v1 h-1 Z', cutout]])
  }
})
