import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfPlan } from '../app/canvas-pdf/types'
import type { PrintZone } from '../canvas/print'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const labels = englishPdfLabels
const mark = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }]
// A is the top item North up and at 30°; B, 10 m east and 8 m south, becomes the top item at 60°.
const A = { x: 0, y: 0 }, B = { x: 10, y: 8 }
const circle = (center: { x: number; y: number }, r: number): PrintZone => ({ name: null, fill: null, bounds: { x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r },
  path: `M${center.x - r} ${center.y} C${center.x - r} ${center.y - r} ${center.x + r} ${center.y - r} ${center.x + r} ${center.y} C${center.x + r} ${center.y + r} ${center.x - r} ${center.y + r} ${center.x - r} ${center.y} Z`,
  geometry: { kind: 'ellipse', center, radii: { x: r, y: r }, rotation: 0 } })
const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
// Guides crowded by one another cannot print their length beside them, so they get M codes.
const guides = (id: string, at: { x: number; y: number }) => Array.from({ length: 30 }, (_, i) => ({ id: `${id}${String(i).padStart(2, "0")}`, start: { x: at.x - .2, y: at.y + .2 }, end: { x: at.x + .2, y: at.y + .2 } }))
const plant = (id: string, position: { x: number; y: number }) => ({ id, canonicalName: 'Malus domestica', position, color: '#496e36', symbol: 'tree', mark, pinnedName: false })
function design(bearing: number): PdfInput {
  return { name: 'References', locale: 'en', commonNames: { 'Malus domestica': 'Apple' }, viewBearingDeg: bearing, canvas: {
    layers: ['plants', 'zones', 'annotations', 'measurement-guides'].map(name => ({ name, visible: true, opacity: 1 })),
    zones: [circle(A, 1), circle(B, 2)],
    // Two coincident pairs give P codes; long notes and short guides give N and M codes.
    plants: [plant('pa1', A), plant('pa2', A), plant('pb1', B), plant('pb2', B)],
    annotations: [
      { id: 'na', position: { x: A.x + .5, y: A.y + .5 }, text: long, fontSize: 16, rotation: 0 },
      { id: 'nb', position: { x: B.x + .5, y: B.y + .5 }, text: long, fontSize: 16, rotation: 0 },
    ],
    measurements: [...guides('ma', A), ...guides('mb', B)],
  } }
}
const setup = { paper: 'A4' as const, layers: ['plants', 'zones', 'annotations', 'measurement-guides'], mapOrientation: 'as-on-screen' as const,
  areas: [{ id: 'all', name: 'Garden', bounds: { x: -60, y: -60, width: 120, height: 120 } }] }
const strings = (plan: PdfPlan) => plan.pages.flatMap(page => page.operations.flatMap(op => op.kind === 'text' ? [op.line.runs.map(run => run.text).join('')] : []))
/** Every printed N, P and M code by the object it names, and every zone row's code by the size it prints. */
function references(plan: PdfPlan) {
  const notes = plan.pages.flatMap(page => (page as { notes?: readonly { id: string; reference: string }[] }).notes ?? [])
  return {
    codes: Object.fromEntries(notes.map(n => [n.id, n.reference])),
    rows: Object.fromEntries(strings(plan).flatMap(s => [...s.matchAll(/\b(E\d\d) · (Ø [\d.]+ × [\d.]+ m)/g)].map(m => [m[1]!, m[2]!]))),
  }
}
// The North up plan order (top, then left, then id or name): every A item comes before its B twin.
const expected = (id: string) => id.startsWith('p') ? `P${id === 'pa1' ? 1 : 3}` : id.startsWith('n') ? `N${id === 'na' ? 1 : 2}`
  : `M${Number(id.slice(2)) + (id.startsWith('ma') ? 1 : 31)}`
describe('PDF reference numbers', () => {
  it('E, N, P and M codes and their rows follow the North up plan order at every As on screen angle', () => {
    const plans = [['North up', buildPdfPlan(design(60), { ...setup, mapOrientation: 'north-up' }, text(), labels)] as const,
      ...[0, 30, 60].map(bearing => [`As on screen ${bearing}°`, buildPdfPlan(design(bearing), setup, text(), labels)] as const)]
    for (const [name, plan] of plans) {
      const { codes, rows } = references(plan)
      expect(new Set(Object.values(codes).map(code => code[0])), name).toEqual(new Set(['N', 'P', 'M']))
      expect(codes, name).toEqual(Object.fromEntries(Object.keys(codes).map(id => [id, expected(id)])))
      expect(rows, name).toEqual({ E01: 'Ø 2 × 2 m', E02: 'Ø 4 × 4 m' })
    }
  })
})

/** Guides outside every zone, listed B first: the overview labels them itself, and list order is not plan order. */
function looseGuides(bearing: number): PdfInput {
  const input = design(bearing)
  return { ...input, canvas: { ...input.canvas, zones: [], measurements: [...guides('mb', B), ...guides('ma', A)] } }
}
describe('PDF guide references across pages', () => {
  it('a guide prints the same M code on the overview as on its detail page, North up and As on screen at 30° and 60°', () => {
    const plans = [['North up', buildPdfPlan(looseGuides(60), { ...setup, mapOrientation: 'north-up' }, text(), labels)] as const,
      ...[30, 60].map(bearing => [`As on screen ${bearing}°`, buildPdfPlan(looseGuides(bearing), setup, text(), labels)] as const)]
    for (const [name, plan] of plans) {
      const guideCodes = (pages: PdfPlan['pages']) => Object.fromEntries(pages
        .flatMap(page => (page as { notes?: readonly { id: string; reference: string }[] }).notes ?? [])
        .filter(note => note.reference.startsWith('M')).map(note => [note.id, note.reference]))
      const overview = guideCodes(plan.pages.filter(page => page.kind === 'overview'))
      const detail = guideCodes(plan.pages.filter(page => page.kind !== 'overview'))
      expect(Object.keys(overview).length, name).toBeGreaterThan(0)
      expect(overview, name).toEqual(Object.fromEntries(Object.keys(overview).map(id => [id, detail[id]])))
    }
  })
})
