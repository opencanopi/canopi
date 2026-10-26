import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fieldKey } from '../app/canvas-pdf/field-key'
import { hits, outlineSegments } from '../app/canvas-pdf/field-geometry'
import { MM } from '../app/canvas-pdf/print-style'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfLabels, PdfSetup } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Print at actual size' }
const engine = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const setup: PdfSetup = { paper: 'A4', views: { overview: { orientation: 'portrait' } }, layers: ['plants'], areas: [{ id: 'all', name: 'Garden', bounds: { x: -1, y: -1, width: 12, height: 17 } }] }
function garden(count = 90): PdfInput {
  return { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: {
    layers: [{ name: 'plants', visible: true, opacity: .7 }], zones: [], annotations: [], measurements: [],
    plants: Array.from({ length: count }, (_, i) => ({ id: String(i), canonicalName: `Species ${String(i).padStart(3, '0')}`, position: { x: i % 10, y: Math.floor(i / 10) },
      color: '#234567', symbol: 'square', mark: [{ d: 'M-1 -1 H1 V1 H-1 Z', paint: 'symbol' }], pinnedName: false })),
  } }
}
it('automatically paginates a complete linked key without requesting consent', () => {
  const input = garden()
  const plan = buildPdfPlan(input, setup, engine(), labels)
  expect(plan.blocked).toBeNull()
  expect(plan.pages.length).toBeGreaterThan(1)
  expect(plan.pages[1]!.legend).toHaveLength(90)
  const rendered = plan.pages.flatMap(page => page.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(run => run.text) : [])).join(' ')
  for (const plant of input.canvas.plants) expect(rendered).toContain(plant.canonicalName)
  const destinations = new Set(plan.pages.flatMap(page => [`page:${page.id}`, ...page.destinations?.map(d => d.id) ?? []]))
  for (const page of plan.pages) for (const link of page.links ?? []) expect(destinations.has(link.target)).toBe(true)
  expect(new Set(plan.pages.flatMap(page => page.destinations?.map(d => d.id) ?? [])).size).toBe(plan.pages.reduce((n, p) => n + (p.destinations?.length ?? 0), 0))
  for (const page of plan.pages.slice(2)) { expect(page.kind).toBe('legend'); expect(page.sourceId).toBe('area:all') }
})

it('keeps automatic area fit while linking legends and later detail pages after pagination', () => {
  const input = garden(60)
  const canvas = { ...input.canvas, zones: [
    { name: 'Long bed', path: 'M0 0 L35 0 L35 5 L0 5 Z', geometry: { kind: 'rect' as const, points: [{ x: 0, y: 0 }, { x: 35, y: 0 }, { x: 35, y: 5 }, { x: 0, y: 5 }] }, fill: null, bounds: { x: 0, y: 0, width: 35, height: 5 } },
    { name: 'Long bed:legend:0', path: 'M100 0 L101 0 L101 1 L100 1 Z', geometry: { kind: 'rect' as const, points: [{ x: 100, y: 0 }, { x: 101, y: 0 }, { x: 101, y: 1 }, { x: 100, y: 1 }] }, fill: null, bounds: { x: 100, y: 0, width: 1, height: 1 } },
  ], plants: input.canvas.plants.map((plant, i) => ({ ...plant, position: { x: i < 30 ? 1 : 34, y: 2 } })) }
  const detail: PdfSetup = { ...setup, areas: [{ id: '1', name: 'Long bed', bounds: { x: 0, y: 0, width: 35, height: 5 } }, { id: '2', name: 'Long bed:legend:0', bounds: { x: 100, y: 0, width: 1, height: 1 } }] }
  const plan = buildPdfPlan({ ...input, canvas }, detail, engine(), labels)
  expect(plan.pages[0]!.kind).toBe('overview')
  expect(plan.pages.filter(page => page.kind === 'detail')).toHaveLength(2)
  expect(plan.pages.slice(2, -1).every(page => page.kind === 'legend')).toBe(true)
  expect(plan.pages[1]!.width).toBeGreaterThan(plan.pages[1]!.height)
  expect(plan.pages[2]!.sourceId).toBe('area:1')
  expect(plan.pages[2]!.operations.some((op) => op.kind === 'text' && op.line.runs.some((run) => run.text === '1 · Key and notes'))).toBe(true)
  const lastDetail = plan.pages.at(-1)!
  expect(lastDetail.kind).toBe('detail')
  expect(lastDetail.number).toBe(plan.pages.length)
  expect(new Set(plan.pages.map((page) => page.id)).size).toBe(plan.pages.length)
  const overviewText = plan.pages[0]!.operations.flatMap((op) => op.kind === 'text' ? op.line.runs.map((run) => run.text) : [])
  expect(overviewText).toContain('2')
  expect(overviewText).toContain(String(lastDetail.detailNumber))
  expect(overviewText).toContain('1')
})

it('changes a legend page orientation independently and preserves the complete legend', () => {
  const input = garden(150)
  const options: PdfSetup = { ...setup }
  const before = buildPdfPlan(input, options, engine(), labels)
  const plan = buildPdfPlan(input, { ...options, views: { ...options.views, 'area:all:legend:0': { orientation: 'landscape' } } }, engine(), labels)
  expect(plan.pages[0]!.width).toBe(before.pages[0]!.width)
  expect(plan.pages[2]!.width).toBeGreaterThan(plan.pages[2]!.height)
  expect(plan.pages[3]!.width).toBeLessThan(plan.pages[3]!.height)
  const names = plan.pages.flatMap((page) => page.operations.flatMap((op) => op.kind === 'text' ? op.line.runs.map((run) => run.text) : []))
  for (const plant of input.canvas.plants) expect(names).toContain(plant.canonicalName)
})

it('preserves duplicate local names, mixed scripts and every appearance across even an oversized entry', () => {
  const base = garden(4)
  const longName = Array.from({ length: 450 }, () => '名 garden repeated').join(' ')
  const plants = [base.canvas.plants[0]!, { ...base.canvas.plants[1]!, canonicalName: base.canvas.plants[0]!.canonicalName, color: '#987654' }, ...base.canvas.plants.slice(2)]
  const input = { ...base, commonNames: { 'Species 000': longName, 'Species 002': 'Same name', 'Species 003': 'Same name' }, canvas: { ...base.canvas, plants } }
  const text = createPdfTextEngine(new Map<PdfFontId, Uint8Array>([
    ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')], ['sc', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKsc-Regular.otf')],
  ]), 'en')
  const plan = buildPdfPlan(input, { ...setup, views: { ...setup.views, 'area:all:legend:0': { orientation: 'landscape' } } }, text, labels)
  expect(plan.blocked).toBeNull()
  expect(plan.pages.length).toBeGreaterThan(2)
  const source = plan.pages[1]!
  expect(source.legend.filter((entry) => entry.name === 'Same name')).toHaveLength(2)
  expect(source.legend.find((entry) => entry.canonicalName === 'Species 000')!.appearances).toHaveLength(2)
  for (const page of plan.pages.slice(1)) {
    for (const op of page.operations) {if (op.kind === 'text' && op.size === 10 && !op.line.runs.map((run) => run.text).join('').startsWith('Plant list for page')) {
      expect(op.x + op.line.width).toBeLessThanOrEqual(page.frame.x + page.frame.width + 1e-6)
      expect(op.y).toBeLessThanOrEqual(page.frame.y + page.frame.height)
    }}
  }
  const operations = plan.pages.flatMap((page) => page.operations)
  const content = plan.pages.slice(1).flatMap((page) => page.operations.filter((op) => op.kind === 'text' && op.size === 10 && op.y >= page.frame.y && op.y <= page.frame.y + page.frame.height)
    .flatMap((op) => op.kind === 'text' ? op.line.runs.map((run) => run.text) : [])).filter((value) => value !== 'Continued').join(' ').replace(/\s/g, '')
  expect(content).toContain(longName.replace(/\s/g, ''))
  expect(operations.filter((op) => op.kind === 'text' && op.size === 10).length).toBeGreaterThan(100)
  const samples = plan.pages.slice(1).flatMap((page) => page.operations.filter((op) => op.kind === 'path'))
  expect(samples.some((op) => op.fill === '#987654' && op.opacity === .7)).toBe(true)
})

it('gives a short key readable full-width columns and retains every authored sample', () => {
  const base = garden(40)
  const first = base.canvas.plants[0]!
  const appearances = Array.from({ length: 12 }, (_, i) => ({ ...first, id: `appearance${i}`, color: `#${String(i).padStart(6, '0')}` }))
  const input = { ...base, canvas: { ...base.canvas, plants: [...base.canvas.plants.slice(1), ...appearances] } }
  const plan = buildPdfPlan(input, setup, engine(), labels)
  expect(plan.blocked).toBeNull()
  const keys = plan.pages.filter(page => page.kind === 'legend')
  const names = keys.flatMap(page => page.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(run => run.text) : [])).join(' ')
  for (const plant of input.canvas.plants) expect(names).toContain(plant.canonicalName)
  const samples = keys.flatMap(page => page.operations.flatMap(op => op.kind === 'path' && op.fill ? [op] : []))
  for (const appearance of appearances) expect(samples.some(sample => sample.fill === appearance.color && sample.opacity === .7)).toBe(true)
  expect(plan.pages[1]!.legend.find(entry => entry.canonicalName === first.canonicalName)!.count).toBe(12)
})

it('reflows every appearance when an oversized key continues into narrower columns', () => {
  const plant = garden(1).canvas.plants[0]!
  const appearances = Array.from({ length: 300 }, (_, i) => ({ ...plant, id: String(i), color: `#${String(i).padStart(6, '0')}` }))
  const entry = { name: 'Mint', canonicalName: 'Mentha', reference: '01', count: appearances.length, appearances }
  const pages = fieldKey({ pageReferences: [], operations: [], links: [], destinations: [], identifiedPlants: [], annotationIds: [], measurementIds: [], notes: [], legend: [entry] }, 'overview',
    index => ({ width: (index ? 297 : 210) * MM, height: (index ? 210 : 297) * MM,
      frame: { x: 10 * MM, y: 20 * MM, width: (index ? 277 : 190) * MM, height: 20 * MM } }), engine(), labels, 1)
  expect(pages.length).toBeGreaterThan(1)
  const samples = pages.flatMap(p => p.operations.filter(op => op.kind === 'path' && op.fill))
  for (const appearance of appearances) expect(samples.filter(op => op.kind === 'path' && op.fill === appearance.color)).toHaveLength(1)
  for (const page of pages) {for (const op of page.operations) if (op.kind === 'path' && op.fill) {
    expect(op.matrix[4] + op.matrix[0]).toBeLessThanOrEqual(page.frame.x + page.frame.width)
    expect(op.matrix[5] + op.matrix[3]).toBeLessThanOrEqual(page.frame.y + page.frame.height)
  }}
})

it('keeps key name and note descenders clear of row separators', () => {
  const base = garden(25)
  const input = { ...base, commonNames: Object.fromEntries(base.canvas.plants.map(p => [p.canonicalName, 'Glycyrrhiza · gypsy'])) }
  const pages = buildPdfPlan(input, setup, engine(), labels).pages.filter(p => p.kind === 'legend')
  for (const page of pages) {for (const op of page.operations) if (op.kind === 'text' && op.line.ink) {
    const ink = { ...op.line.ink, x: op.x + op.line.ink.x, y: op.y + op.line.ink.y }
    for (const rule of page.operations) if (rule.kind === 'path' && rule.stroke && !rule.fill) {
      expect(outlineSegments(rule.d, p => p).some(s => hits(s, ink))).toBe(false)
    }
  }}
})
