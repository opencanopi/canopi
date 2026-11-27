import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { PrintSetupV10 } from '../../generated/contracts'
import { createSessionPlane } from '../../geo/session-plane'
import { createPdfTextEngine, type PdfFontId } from './text'
import { buildPdfPlan } from './layout'
import {
  applyPrintEdit,
  defaultPrintSetup,
  inPlane,
  printScalePointsPerGroundMeter,
  scalePickerOptions,
} from './print-setup'
import { createPdfWorkflow } from './workflow'
import type { PdfInput, PdfSetup } from './types'
import { englishPdfLabels } from '../../../scripts/pdf-validation/fixtures'

const testText = () =>
  createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const mark = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }]

function siteInput(unitSystem: 'metric' | 'us_customary' = 'metric'): PdfInput {
  return {
    name: 'Test Site',
    locale: 'en-US',
    unitSystem,
    viewBearingDeg: 0,
    commonNames: {},
    canvas: {
      planeOrigin: { lon: 2.3522, lat: 48.8566 },
      layers: [{ name: 'plants', visible: true, opacity: 1 }, { name: 'zones', visible: true, opacity: 1 }],
      plants: [{ id: 'p1', canonicalName: 'Malus domestica', position: { x: 0, y: 0 }, color: '#2d6a4f', symbol: 'apple', mark, pinnedName: false }],
      zones: [],
      annotations: [],
      measurements: [],
    },
  }
}

describe('print-setup frame crossing (contracts §10)', () => {
  it('corpus case: projects a split and a whole-design area into the session plane and keeps untouched pages byte-identical on edit', () => {
    const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    const setup: PrintSetupV10 = {
      paper: 'A4',
      layers: ['plants', 'zones'],
      plant_colors: 'design',
      north_arrow: true,
      overview_angle_deg: 0,
      overview_scale: { kind: 'fit' },
      splits: [{ id: 'sp-1', pivot: { lon: 2.3522, lat: 48.8566 }, angle_deg: 25 }],
      pages: [
        {
          id: '1',
          name: 'Whole',
          area: { kind: 'whole_design', angle_deg: 10 },
          scale: { kind: 'fit' },
        },
        {
          id: '2',
          name: 'Split A',
          area: { kind: 'split_sheet', split: 'sp-1', along_page: { right_m: -10, down_m: 0 }, size: { width_m: 20, height_m: 15 } },
          scale: { kind: 'ratio', denominator: 200 },
        },
        {
          id: '3',
          name: 'Split B',
          area: { kind: 'split_sheet', split: 'sp-1', along_page: { right_m: 10, down_m: 0 }, size: { width_m: 20, height_m: 15 } },
          scale: { kind: 'ratio', denominator: 200 },
        },
      ],
    }

    const projected = inPlane(setup, plane)
    expect(projected.areas).toHaveLength(3)
    expect(projected.areas![0]!.wholeDesign).toBe(true)
    expect(projected.areas![0]!.angleDeg).toBe(10)
    const left = projected.areas![1]!
    const right = projected.areas![2]!
    expect(left.splitId).toBe('sp-1')
    expect(right.splitId).toBe('sp-1')
    expect(left.angleDeg).toBe(25)
    expect(right.angleDeg).toBe(25)
    expect(left.bounds.x + left.bounds.width).toBeCloseTo(right.bounds.x, 6)

    const next = applyPrintEdit(setup, { kind: 'set-page-scale', pageId: 'area:1', scale: { kind: 'ratio', denominator: 100 } }, plane)
    expect(next.pages![1]).toBe(setup.pages![1])
    expect(next.pages![2]).toBe(setup.pages![2])
    expect(next.splits).toBe(setup.splits)
  })

  it('property: at 49° and 65° across two plane anchors, split sheets tile and untouched pages stay byte-identical', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(49, 65),
        fc.double({ min: 0, max: 359, noNaN: true }),
        fc.double({ min: 5, max: 60, noNaN: true }),
        fc.double({ min: 5, max: 60, noNaN: true }),
        (lat, angleDeg, widthM, heightM) => {
          const anchorA = createSessionPlane({ lon: 10.0, lat })
          const anchorB = createSessionPlane({ lon: 10.01, lat: lat + 0.005 })
          const setup: PrintSetupV10 = {
            ...defaultPrintSetup(['plants']),
            splits: [{ id: 's1', pivot: { lon: 10.005, lat: lat + 0.002 }, angle_deg: angleDeg }],
            pages: [
              {
                id: 'a',
                name: 'A',
                area: { kind: 'split_sheet', split: 's1', along_page: { right_m: -widthM / 2, down_m: 0 }, size: { width_m: widthM, height_m: heightM } },
                scale: { kind: 'fit' },
              },
              {
                id: 'b',
                name: 'B',
                area: { kind: 'split_sheet', split: 's1', along_page: { right_m: widthM / 2, down_m: 0 }, size: { width_m: widthM, height_m: heightM } },
                scale: { kind: 'fit' },
              },
            ],
          }
          for (const plane of [anchorA, anchorB]) {
            const p = inPlane(setup, plane)
            const a = p.areas![0]!.bounds
            const b = p.areas![1]!.bounds
            expect(Math.abs((a.x + a.width) - b.x)).toBeLessThan(1e-9)
            expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9)
          }
          const turned = applyPrintEdit(setup, { kind: 'set-page-angle', pageId: 'area:a', angleDeg: (angleDeg + 30) % 360 }, anchorA)
          expect(turned.pages).toBe(setup.pages)
          expect(turned.splits![0]!.angle_deg).toBeCloseTo((angleDeg + 30) % 360, 6)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('keeps a page printed scale exact when paper size or area size changes (2.1-Q356)', () => {
    const text = testText()
    const input = siteInput('us_customary')
    const customaryScale = { kind: 'customary' as const, inches: 1, feet: 20 }
    const baseSetup: PdfSetup = {
      paper: 'A4',
      layers: ['plants'],
      areas: [{ id: '1', name: 'Detail 1', bounds: { x: -10, y: -10, width: 20, height: 20 }, angleDeg: 0 }],
      views: { 'area:1': { scale: customaryScale } },
    }
    const planA4 = buildPdfPlan(input, baseSetup, text, englishPdfLabels)
    const planLetter = buildPdfPlan(input, { ...baseSetup, paper: 'Letter' }, text, englishPdfLabels)
    const planBiggerArea = buildPdfPlan(
      input,
      { ...baseSetup, areas: [{ id: '1', name: 'Detail 1', bounds: { x: -20, y: -20, width: 40, height: 40 }, angleDeg: 0 }] },
      text,
      englishPdfLabels,
    )
    const detailA4 = planA4.pages.find((p) => p.id === 'area:1')!
    const detailLetter = planLetter.pages.find((p) => p.id === 'area:1')!
    const detailBigger = planBiggerArea.pages.find((p) => p.id === 'area:1')!
    const expectedPtsPerM = printScalePointsPerGroundMeter(customaryScale)!
    expect(detailA4.pointsPerMeter).toBeCloseTo(expectedPtsPerM, 4)
    expect(detailLetter.pointsPerMeter).toBeCloseTo(detailA4.pointsPerMeter, 4)
    expect(detailBigger.pointsPerMeter).toBeCloseTo(detailA4.pointsPerMeter, 4)

    const metricOpts = scalePickerOptions('metric', 'en-US', 'Fit')
    const usOpts = scalePickerOptions('us_customary', 'en-US', 'Fit')
    expect(metricOpts[0]!.key).toBe('fit')
    expect(usOpts.length).toBeGreaterThan(metricOpts.length)
    expect(usOpts.some((o) => o.label.includes('1″ = 20′'))).toBe(true)
  })

  it('coalesces edits under one key per workspace session and never writes until first edit (2.1-M90, 2.1-M160)', async () => {
    const log: string[] = []
    const ended: string[] = []
    let stored: PrintSetupV10 | null = null
    const id = {}
    const snap = siteInput()
    const wf = createPdfWorkflow({
      capture: () => ({ identity: id, input: snap, isCurrent: () => true }),
      resolveDisplayNames: vi.fn(async () => ({ names: {}, englishFallbacks: [] })),
      resolveHabits: vi.fn(async () => ({})),
      prepare: vi.fn(async () => ({ plan: { pages: [], angleDeg: 0, outlines: {}, blocked: null }, bytes: new Uint8Array([1]) })),
      delivery: { deliverFile: vi.fn(async () => 'saved' as const) },
      labels: () => englishPdfLabels,
      namePrintArea: (n) => `Area ${n}`,
      printSetup: {
        read: () => stored,
        write: (next, key) => { stored = next; log.push(key) },
        endCoalesce: (key) => { ended.push(key) },
      },
    })

    wf.show()
    await Promise.resolve()
    expect(log).toHaveLength(0)

    wf.configure({ paper: 'Letter' })
    wf.setPageScale('overview', { kind: 'ratio', denominator: 500 })
    wf.setPageAngle('overview', 15)
    expect(log).toHaveLength(3)
    expect(new Set(log).size).toBe(1)
    const firstKey = log[0]!

    wf.close()
    expect(ended).toContain(firstKey)
    wf.show()
    await Promise.resolve()
    wf.configure({ paper: 'A4' })
    expect(log[3]).not.toBe(firstKey)
    wf.dispose()
  })
})
