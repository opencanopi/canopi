import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { MM } from '../app/canvas-pdf/print-style'
import { overlaps } from '../app/canvas-pdf/field-geometry'
import type { PdfInput, PdfLabels } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
const fonts = new Map<PdfFontId, Uint8Array>([
  ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')], ['strong', readFileSync('src/app/canvas-pdf/fonts/NotoSans-SemiBold.ttf')],
])
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }

it.each([
  { vertical: false, tilt: 0, rows: 3 },
  { vertical: true, tilt: 0, rows: 3 },
  { vertical: false, tilt: .015, rows: 4 },
  { vertical: true, tilt: -.015, rows: 4 },
])('keeps mixed strip identities clear of plants ($vertical, slope $tilt)', ({ vertical, tilt, rows }) => {
  const point = (x: number, y: number) => vertical ? { x: y, y: x } : { x, y }
  const input: PdfInput = { name: 'Mixed strip', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: {
    layers: [{ name: 'plants', visible: true, opacity: 1 }], annotations: [], zones: [], measurements: [],
    plants: Array.from({ length: 30 * rows }, (_, i) => ({ id: String(i), canonicalName: `Species ${i % 7}`,
      position: point((i % 30) * .35, Math.floor(i / 30) * .3 + (i % 30) * .35 * tilt), color: '#428063', symbol: 'round', mark: [], pinnedName: false })),
  } }
  const bounds = { ...point(-.2, -.4), width: vertical ? 1.7 : 10.6, height: vertical ? 10.6 : 1.7 }
  const plan = buildPdfPlan(input, { paper: 'A4', layers: ['plants'], areas: [{ id: 'strip', name: 'Strip', bounds }] }, createPdfTextEngine(fonts, 'en'), labels)
  const page = plan.pages.find(p => p.kind === 'detail')!
  expect(plan.pages.filter(p => p.kind === 'detail')).toHaveLength(1)
  expect(page.ground).toEqual(bounds)
  expect(page.identifiedPlants!.flatMap(g => g.ids).sort()).toEqual(input.canvas.plants.map(p => p.id).sort())
  const rendered = plan.pages.filter(p => p.id === page.id || p.sourceId === page.id).flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')
  for (const group of page.identifiedPlants!.filter(g => g.bounds.width === 0)) {
    expect(rendered).toContain(group.reference)
    expect(rendered).toContain('x ')
  }
  const inside = page.identifiedPlants!.filter(({ bounds: b }) => vertical
    ? b.x + b.width / 2 > page.frame.x && b.x + b.width / 2 < page.frame.x + page.frame.width
    : b.y + b.height / 2 > page.frame.y && b.y + b.height / 2 < page.frame.y + page.frame.height)
  expect(inside.length).toBeGreaterThan(0)
  const ink = page.operations.flatMap(op => op.kind === 'text' && op.line.ink
    ? [{ ...op.line.ink, x: op.x + op.line.ink.x, y: op.y + op.line.ink.y }] : [])
  for (const [i, bounds] of ink.entries()) {
    expect(ink.slice(i + 1).some(other => overlaps(bounds, other))).toBe(false)
  }
  expect(page.operations.some(op => op.kind === 'path' && op.fill === '#ffffff')).toBe(false)
})

it('fits one complete key and ground scale in spare paper without duplicating the key', () => {
  const input: PdfInput = { name: 'Repeated strip', locale: 'en', viewBearingDeg: 0, commonNames: { 'Species 0': 'Apple', 'Species 1': 'Pear', 'Species 2': 'Plum' }, canvas: {
    layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], measurements: [],
    annotations: [{ id: 'note', text: 'Keep this access clear', position: { x: 5, y: .7 }, fontSize: 12, rotation: 0 }],
    plants: Array.from({ length: 60 }, (_, i) => ({ id: String(i), canonicalName: `Species ${i % 3}`,
      position: { x: i % 30 * .35, y: Math.floor(i / 30) * .4 }, color: '#428063', symbol: 'round', mark: [], pinnedName: false })),
  } }
  const plan = buildPdfPlan(input, { paper: 'A4', layers: ['plants', 'annotations'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: -.2, y: -.2, width: 10.6, height: 1.2 } }] }, createPdfTextEngine(fonts, 'en'), labels)
  const page = plan.pages.find(p => p.kind === 'detail')!
  const text = page.operations.flatMap(op => op.kind === 'text' ? [op.line.runs.map(r => r.text).join('')] : [])
  expect(text).toEqual(expect.arrayContaining(['Apple', 'Pear', 'Plum', '×20', '1 m']))
  expect(text.join(' ')).toContain('Keep this access clear')
  expect(page.legend.reduce((n, e) => n + e.count!, 0)).toBe(60)
  expect(page.continuationIds).toHaveLength(0)
  const destinations = new Set(plan.pages.flatMap(p => [`page:${p.id}`, ...p.destinations?.map(d => d.id) ?? []]))
  expect(page.links!.every(link => destinations.has(link.target))).toBe(true)
  for (const op of page.operations) {if (op.kind === 'text' && op.line.ink) {
    expect(op.x + op.line.ink.x).toBeGreaterThanOrEqual(8 * MM)
    expect(op.y + op.line.ink.y + op.line.ink.height).toBeLessThan(page.height - 8 * MM)
  }}
})
