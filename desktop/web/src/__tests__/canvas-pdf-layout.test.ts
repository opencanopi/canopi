import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixture, englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { areaFromFrame, pageFrame } from '../app/canvas-pdf/page-frame'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfOperation } from '../app/canvas-pdf/types'
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const labels = englishPdfLabels
// Symbol legend and north arrow fill in ink; plant marks keep their authored colours.
const plantFill = (op: PdfOperation) => op.kind === 'path' && !!op.fill && op.fill !== '#24211c'
const mark = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }]
function input(): PdfInput {
  return { name: 'Field garden', locale: 'en', viewBearingDeg: 0, commonNames: { 'Malus domestica': 'Apple' }, canvas: {
    layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
    plants: [
      { id: 'a', canonicalName: 'Malus domestica', position: { x: 0, y: 0 }, color: '#123456', symbol: 'square', mark, pinnedName: true },
      { id: 'b', canonicalName: 'Malus domestica', position: { x: 30, y: 12 }, color: '#654321', symbol: 'square', mark, pinnedName: false },
      { id: 'c', canonicalName: 'Rosmarinus officinalis var. angustifolius', position: { x: 12, y: 6 }, color: '#123456', symbol: 'square', mark, pinnedName: false },
    ],
  } }
}
describe('Canvas PDF page plan', () => {
  it('crops overview artwork without introducing a generated key', () => {
    const plan = buildPdfPlan(input(), { paper: 'A4', views: { overview: { orientation: 'landscape', zoom: 300 } }, layers: ['plants'] }, text(), labels)
    expect(plan.pages).toHaveLength(1)
    expect(plan.pages[0]!.legend).toEqual([])
    expect(plan.pages[0]!.operations.filter(plantFill)).toHaveLength(1)
  })
  it('excludes distant deselected content from extent and legends without changing visibility', () => {
    const design = input()
    const canvas = { ...design.canvas, layers: [...design.canvas.layers, { name: 'annotations', visible: false, opacity: 1 }],
      annotations: [{ id: 'far', position: { x: 10_000, y: 10_000 }, text: 'Distant note', fontSize: 16, rotation: 0 }] }
    const before = structuredClone(canvas)
    const plants = buildPdfPlan({ ...design, canvas }, { paper: 'A4', views: { overview: { orientation: 'portrait' } }, layers: ['plants'] }, text(), labels)
    expect(plants.pages[0]!.ground.width).toBeLessThan(100)
    expect(plants.pages[0]!.operations.filter(plantFill)).toHaveLength(3)
    const notes = buildPdfPlan({ ...design, canvas }, { paper: 'A4', views: { overview: { orientation: 'portrait' } }, layers: ['annotations'] }, text(), labels)
    expect(notes.pages[0]!.legend).toEqual([])
    expect(notes.pages[0]!.ground.x).toBeGreaterThan(9_000)
    expect(canvas).toEqual(before)
  })
  it('fits authored content on A4 with complete species identity, common-name fallback and every appearance', () => {
    const plan = buildPdfPlan(input(), { paper: 'A4', views: { overview: { orientation: 'portrait' }, 'area:all': { orientation: 'portrait' } }, layers: ['plants'], areas: [{ id: 'all', name: 'Garden', bounds: { x: -1, y: -1, width: 32, height: 14 } }] }, text(), labels)
    expect(plan.blocked).toBeNull()
    expect(plan.pages).toHaveLength(2)
    const page = plan.pages[1]!
    expect(page.width).toBeCloseTo(595.27559, 4)
    expect(page.height).toBeCloseTo(841.88976, 4)
    expect(page.legend.map((entry) => entry.name)).toEqual(['Apple', 'Rosmarinus officinalis var. angustifolius'])
    expect(page.legend[0]!.appearances).toHaveLength(2)
    expect(new Set(page.legend.map(entry => entry.reference)).size).toBe(2)
    expect(page.ground.x).toBeLessThan(0)
    expect(page.ground.x + page.ground.width).toBeGreaterThan(30)
    expect(plan.pages.flatMap(page => page.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(run => run.text) : [])).join(' ')).toContain('Apple')
  })
  it('Map orientation is North up by default; As on screen re-lays every page', () => {
    const turned = { ...input(), viewBearingDeg: 30 }
    const area = { id: 'all', name: 'Garden', bounds: { x: -1, y: -1, width: 32, height: 14 } }
    const setup = { paper: 'A4' as const, layers: ['plants'], areas: [area] }
    const northUp = buildPdfPlan(input(), setup, text(), labels)
    const byDefault = buildPdfPlan(turned, setup, text(), labels)
    expect(byDefault.angleDeg).toBe(0)
    expect(byDefault).toEqual(northUp)
    expect(buildPdfPlan(turned, { ...setup, mapOrientation: 'north-up' }, text(), labels)).toEqual(northUp)
    const onScreen = buildPdfPlan(turned, { ...setup, mapOrientation: 'as-on-screen' }, text(), labels)
    expect(onScreen.angleDeg).toBe(30)
    const frame = pageFrame(30)
    for (const kind of ['overview', 'detail'] as const) {
      const before = northUp.pages.find(p => p.kind === kind)!, after = onScreen.pages.find(p => p.kind === kind)!
      expect(after.ground).not.toEqual(before.ground)
      expect(after.operations).not.toEqual(before.operations)
    }
    expect(onScreen.pickerPage!.ground).not.toEqual(northUp.pickerPage!.ground)
    // The area keeps its size along the page axes and turns about its own centre.
    const detail = onScreen.pages.find(p => p.kind === 'detail')!
    const centre = frame.toFrame({ x: 15, y: 6 })
    expect(detail.ground.x + detail.ground.width / 2).toBeCloseTo(centre.x, 6)
    expect(detail.ground.y + detail.ground.height / 2).toBeCloseTo(centre.y, 6)
    expect(detail.ground.width).toBeCloseTo(32, 6)
    expect(detail.ground.height).toBeCloseTo(14, 6)
    // Page offsets are plan metres: the page moves by the same ground whatever the angle.
    const moved = buildPdfPlan(turned, { ...setup, mapOrientation: 'as-on-screen', views: { 'area:all': { offset: { x: 2, y: 0 } } } }, text(), labels)
    const shift = moved.pages.find(p => p.kind === 'detail')!.ground, step = frame.toFrame({ x: 2, y: 0 })
    expect(shift.x - detail.ground.x).toBeCloseTo(step.x, 6)
    expect(shift.y - detail.ground.y).toBeCloseTo(step.y, 6)
  })
  it('Add whole design refits to the design at every Map orientation', () => {
    // A 20 m square bed level on a screen turned to 45: north-up it is a diamond about 28.3 m across.
    const at45 = pageFrame(45), corners = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y]) => at45.fromFrame({ x: x!, y: y! }))
    const design: PdfInput = { ...input(), viewBearingDeg: 45, canvas: { ...input().canvas, plants: corners.map((position, i) =>
      ({ id: `c${i}`, canonicalName: 'Malus domestica', position, color: '#123456', symbol: 'square' as const, mark, pinnedName: false })) } }
    const setup = { paper: 'A4' as const, layers: ['plants'], mapOrientation: 'as-on-screen' as const }
    const picker = buildPdfPlan(design, setup, text(), labels).pickerPage!.ground
    const area = { id: 'whole', name: 'Whole design', bounds: areaFromFrame(at45, picker), wholeDesign: true as const }
    for (const mapOrientation of ['as-on-screen', 'north-up'] as const) {
      const plan = buildPdfPlan(design, { ...setup, mapOrientation, areas: [area] }, text(), labels)
      const frame = pageFrame(plan.angleDeg), ground = plan.pages.find(p => p.kind === 'detail')!.ground
      for (const corner of corners.map(frame.toFrame)) {
        expect(corner.x).toBeGreaterThan(ground.x); expect(corner.x).toBeLessThan(ground.x + ground.width)
        expect(corner.y).toBeGreaterThan(ground.y); expect(corner.y).toBeLessThan(ground.y + ground.height)
      }
    }
  })
})

it('serializes measurement strokes at the encoder precision shared by native previews', () => {
  const { input, setup, labels } = fixture('mixed')
  const source = { ...input, canvas: { ...input.canvas, measurements: [{ id: 'measure', start: { x: 1.123456789, y: 1 }, end: { x: 3.123456789, y: 1 } }] } }
  const plan = buildPdfPlan(source, { ...setup, layers: [...setup.layers, 'measurement-guides'] }, text(), labels)
  const strokes = plan.pages[1]!.operations.filter(op => op.kind === 'path' && /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/.test(op.d))
  expect(strokes.length).toBeGreaterThan(0)
  for (const stroke of strokes) {
    if (stroke.kind !== 'path') continue
    expect(stroke.d).not.toMatch(/\.\d{7}/)
  }
})
