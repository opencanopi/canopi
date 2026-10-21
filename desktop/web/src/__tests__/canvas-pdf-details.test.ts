import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfLabels, PdfSetup } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Print at actual size' }
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
function garden(): PdfInput {
  return { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: {
    layers: ['plants', 'zones'].map((name) => ({ name, visible: true, opacity: 1 })),
    zones: [{ name: 'Orchard', bounds: { x: 0, y: 0, width: 30, height: 20 }, path: 'M0 0 L30 0 L30 20 L0 20 Z', geometry: { kind: 'rect' as const, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }] }, fill: null }],
    plants: [[8.5, 'Overlap'], [31, 'Nearby'], [200, 'Distant']].map(([x, name]) => ({ id: String(name), canonicalName: String(name), position: { x: Number(x), y: 12 },
      color: '#000000', symbol: 'square', mark: [{ d: 'M-1 -1 H1 V1 H-1 Z', paint: 'symbol' }], pinnedName: false })),
    annotations: [], measurements: [],
  } }
}
const setup: PdfSetup = { paper: 'A4', layers: ['plants', 'zones'], areas: [{ id: 'orchard', name: 'Orchard', bounds: { x: 0, y: 0, width: 30, height: 20 } }] }
describe('Fitted Print Area detail pages', () => {
  it('fits a large Print Area completely on one landscape detail page by default', () => {
    const plan = buildPdfPlan(garden(), setup, text(), labels)
    const details = plan.pages.filter((page) => page.kind === 'detail')
    expect(details).toHaveLength(1)
    const page = details[0]!
    expect(page.width).toBeGreaterThan(page.height)
    expect(page.ground.x).toBeLessThanOrEqual(0)
    expect(page.ground.y).toBeLessThanOrEqual(0)
    expect(page.ground.x + page.ground.width).toBeGreaterThanOrEqual(30)
    expect(page.ground.y + page.ground.height).toBeGreaterThanOrEqual(20)
    expect(page.ground.width).toBeLessThan(33)
    expect(page.ground.height).toBeLessThan(23)
  })
  it('keeps the overview around detail coverage and updates only the visible species legend when zoom changes', () => {
    const plan = buildPdfPlan(garden(), { ...setup, views: { 'area:orchard': { zoom: 90 } } }, text(), labels)
    const [overview, page] = plan.pages
    expect(plan.pages).toHaveLength(3)
    expect(overview!.legend).toEqual([])
    expect(page!.legend.map((entry) => entry.name)).toEqual(['Nearby', 'Overlap'])
    expect(overview!.ground.x).toBeLessThan(page!.ground.x)
    expect(overview!.ground.y).toBeLessThan(page!.ground.y)
    expect(overview!.ground.x + overview!.ground.width).toBeGreaterThan(page!.ground.x + page!.ground.width)
    expect(overview!.ground.y + overview!.ground.height).toBeGreaterThan(page!.ground.y + page!.ground.height)
  })
  it('refits an individual Print Area when its orientation changes without changing the overview setting', () => {
    const plan = buildPdfPlan(garden(), { ...setup, views: { overview: { orientation: 'landscape' }, 'area:orchard': { orientation: 'portrait' } } }, text(), labels)
    expect(plan.pages).toHaveLength(2)
    expect(plan.pages[0]!.width).toBeGreaterThan(plan.pages[0]!.height)
    const page = plan.pages[1]!
    expect(page.width).toBeLessThan(page.height)
    expect(page.ground.x).toBe(0)
    expect(page.ground.x + page.ground.width).toBe(30)
    expect(page.ground.y).toBe(0)
    expect(page.ground.y + page.ground.height).toBe(20)
    expect(page.ground.width * page.pointsPerMeter).toBeCloseTo(page.frame.width, 8)
    expect(page.ground.height * page.pointsPerMeter).toBeCloseTo(page.frame.height, 8)
  })
})
