import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTestDesignCore } from './support/design-wire'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfWorkflow } from '../app/canvas-pdf/workflow'
import { applyPrintEdit, defaultPrintSetup } from '../app/canvas-pdf/print-setup'
import { createSessionPlane } from '../geo/session-plane'
import type { PdfInput, PdfPage, PdfSetup } from '../app/canvas-pdf/types'
import type { PrintSetupV10 } from '../generated/contracts'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const testText = () =>
  createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const mark = [{ d: 'M-1 -1 h2 v2 h-2 Z', paint: 'symbol' as const }]

const LABELS = englishPdfLabels

function makeInput(plantsCount = 2): PdfInput {
  const plants = Array.from({ length: plantsCount }, (_, i) => ({
    id: `p-${i}`,
    canonicalName: 'Malus domestica',
    position: { x: (i % 20) * 1.5 - 10, y: Math.floor(i / 20) * 1.5 - 5 },
    color: '#2d6a4f',
    symbol: 'apple',
    mark,
    pinnedName: false,
  }))
  return {
    name: 'Orchard Plan',
    locale: 'en-US',
    unitSystem: 'metric',
    viewBearingDeg: 0,
    commonNames: { 'Malus domestica': 'Apple' },
    canvas: {
      planeOrigin: { lon: 2.3522, lat: 48.8566 },
      layers: [
        { name: 'plants', visible: true, opacity: 1 },
        { name: 'zones', visible: true, opacity: 1 },
        { name: 'annotations', visible: true, opacity: 1 },
        { name: 'measurement-guides', visible: true, opacity: 1 },
      ],
      plants,
      zones: [],
      annotations: [],
      measurements: [],
    },
  }
}

/** Extracts the north arrow half-triangle in `page.operations` and returns its clockwise tip angle in degrees. */
function northArrowAngleDeg(page: PdfPage): number {
  const nIndex = page.operations.findIndex(
    (op) => op.kind === 'text' && op.line.runs.map((r) => r.text).join('') === 'N',
  )
  if (nIndex < 1) throw new Error(`No north arrow found on page ${page.id}`)
  const arrowHalf = page.operations
    .slice(Math.max(0, nIndex - 4), nIndex)
    .find(
      (op): op is Extract<PdfPage['operations'][number], { kind: 'path' }> =>
        op.kind === 'path' && op.d.endsWith('Z'),
    )
  if (!arrowHalf) throw new Error(`No north arrow path found on page ${page.id}`)
  const nums = arrowHalf.d.match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number)
  const tipX = nums[0]!
  const tipY = nums[1]!
  const notchX = nums[4]!
  const notchY = nums[5]!
  // Upright north points in -Y (0°); turning clockwise increases +X, -Y -> atan2(dx, -dy).
  return (Math.atan2(tipX - notchX, -(tipY - notchY)) * 180) / Math.PI
}

describe('PDF export per-page angles, splits, and print_setup persistence (2c-4b)', () => {
  it('a north-up overview and a detail page at 32° each print their north arrow to true north', () => {
    const text = testText()
    const input = makeInput(4)
    const setup: PdfSetup = {
      paper: 'A4',
      layers: ['plants'],
      northArrow: true,
      areas: [{ id: '1', name: 'Terrace A', bounds: { x: -12, y: -8, width: 18, height: 12 }, angleDeg: 32 }],
      views: { overview: { angleDeg: 0 } },
    }
    const plan = buildPdfPlan(input, setup, text, LABELS)
    const overview = plan.pages.find((p) => p.kind === 'overview')!
    const detail = plan.pages.find((p) => p.id === 'area:1')!
    expect(overview.angleDeg).toBe(0)
    expect(detail.angleDeg).toBe(32)
    expect(northArrowAngleDeg(overview)).toBeCloseTo(0, 1)
    expect(northArrowAngleDeg(detail)).toBeCloseTo(-32, 1)
  })

  it("a split's sheets turn together", async () => {
    const text = testText()
    const input = makeInput(160)
    const identity = {}
    let persisted: PrintSetupV10 | null = null
    const workflow = createPdfWorkflow({
      capture: () => ({ identity, input, isCurrent: () => true }),
      resolveDisplayNames: async () => ({ names: { 'Malus domestica': 'Apple' }, englishFallbacks: [] }),
      resolveHabits: async () => ({ 'Malus domestica': 'Tree' }),
      prepare: async (prep) => ({ plan: buildPdfPlan(prep.input, prep.setup, text, prep.labels), bytes: new Uint8Array([37, 80, 68, 70]) }),
      delivery: { deliverFile: vi.fn().mockResolvedValue('saved') },
      labels: () => LABELS,
      namePrintArea: (n) => `Print area ${n}`,
      printSetup: {
        read: () => persisted,
        write: (next) => { persisted = next },
        endCoalesce: () => {},
      },
    })

    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))

    const addedId = workflow.addPrintArea({ x: -12, y: -7, width: 32, height: 14 })!
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))

    workflow.previewSplit(addedId)
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    workflow.applySplit()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))

    const splitAreas = workflow.setup.value.areas ?? []
    expect(splitAreas.length).toBeGreaterThanOrEqual(2)
    const splitId = splitAreas[0]!.splitId
    expect(splitId).toBeTruthy()
    expect(splitAreas.every((a) => a.splitId === splitId)).toBe(true)

    workflow.setPageAngle(`area:${splitAreas[0]!.id}`, 37)
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))

    const afterTurn = workflow.setup.value.areas ?? []
    expect(afterTurn.every((a) => a.angleDeg === 37)).toBe(true)
    const detailPages = workflow.state.value.result!.plan.pages.filter((p) => p.kind === 'detail')
    expect(detailPages.length).toBe(afterTurn.length)
    for (const page of detailPages) {
      expect(page.angleDeg).toBe(37)
      expect(northArrowAngleDeg(page)).toBeCloseTo(-37, 1)
    }
    workflow.dispose()
  })

  it('a reopened Design restores its print setup, and the reader release opens it read-only', async () => {
    const core = createTestDesignCore()
    const created = await core.newDesign({
      name: 'Saved Print Plan',
      created_at: '2026-11-27T12:00:00Z',
    })

    const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    let setup = defaultPrintSetup(['plants', 'zones'])
    setup = applyPrintEdit(setup, { kind: 'set-paper', paper: 'Letter' }, plane)
    setup = applyPrintEdit(setup, { kind: 'add-box', id: '1', name: 'Bed 1', bounds: { x: -8, y: -6, width: 16, height: 12 }, angleDeg: 32 }, plane)
    setup = applyPrintEdit(setup, { kind: 'set-page-scale', pageId: 'area:1', scale: { kind: 'ratio', denominator: 200 } }, plane)

    const encoded = await core.encode({ ...created, print_setup: setup })
    expect('ok' in encoded).toBe(true)
    if (!('ok' in encoded)) return

    const decoded = await core.decode(encoded.ok)
    expect('ok' in decoded).toBe(true)
    if (!('ok' in decoded)) return
    expect(decoded.ok.design.print_setup?.paper).toBe('Letter')
    expect(decoded.ok.design.print_setup?.pages).toHaveLength(1)
    expect(decoded.ok.design.print_setup?.pages?.[0]?.scale).toEqual({ kind: 'ratio', denominator: 200 })

    const writes = vi.fn()
    const workflow = createPdfWorkflow({
      capture: () => ({ identity: {}, input: makeInput(4), isCurrent: () => true }),
      resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }),
      resolveHabits: async () => ({}),
      prepare: async () => ({ plan: { pages: [], angleDeg: 0, outlines: {}, blocked: null }, bytes: new Uint8Array([37, 80, 68, 70]) }),
      delivery: { deliverFile: vi.fn().mockResolvedValue('saved') },
      labels: () => LABELS,
      namePrintArea: (n) => `Print area ${n}`,
      printSetup: {
        read: () => decoded.ok.design.print_setup ?? null,
        write: writes,
        endCoalesce: () => {},
      },
    })
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value.paper).toBe('Letter')
    expect(workflow.setup.value.areas).toHaveLength(1)
    expect(workflow.setup.value.areas![0]!.angleDeg).toBe(32)
    expect(workflow.setup.value.views?.['area:1']?.scale).toEqual({ kind: 'ratio', denominator: 200 })
    expect(writes).not.toHaveBeenCalled()
    workflow.dispose()

    // Reader release compatibility: v10 optional addition `print_setup` is ignored by the 2.0.5 reader release.
    const raw = JSON.parse(new TextDecoder().decode(encoded.ok)) as Record<string, unknown>
    expect(raw.version).toBe(10)
    expect(raw.print_setup).toBeDefined()
    delete raw.print_setup
    const readerDecode = await core.decode(new TextEncoder().encode(JSON.stringify(raw)))
    expect('ok' in readerDecode).toBe(true)
  })

  it('draws zone dimensions and assigns colliding plant enclosures in a 32° detail page frame when overview is north-up', () => {
    const text = testText()
    // Place the zone and colliding plants far enough from the origin that a 32° rotation separates the 0° and 32° frames.
    const zone = {
      id: 'z-far',
      name: 'South Bed',
      fill: '#d8e2dc',
      stroke: '#3a5a40',
      opacity: 0.4,
      path: 'M26 2 L34 2 L34 6 L26 6 Z',
      bounds: { x: 26, y: 2, width: 8, height: 4 },
      geometry: {
        kind: 'polygon' as const,
        points: [
          { x: 26, y: 2 },
          { x: 34, y: 2 },
          { x: 34, y: 6 },
          { x: 26, y: 6 },
        ],
      },
    }
    const plants = [
      { id: 'p-a1', canonicalName: 'Malus domestica', position: { x: 28, y: 4 }, color: '#2d6a4f', symbol: 'apple', mark, pinnedName: false },
      { id: 'p-a2', canonicalName: 'Malus domestica', position: { x: 29, y: 4 }, color: '#2d6a4f', symbol: 'apple', mark, pinnedName: false },
      { id: 'p-b1', canonicalName: 'Pyrus communis', position: { x: 31, y: 4 }, color: '#2d6a4f', symbol: 'apple', mark, pinnedName: false },
      { id: 'p-b2', canonicalName: 'Pyrus communis', position: { x: 32, y: 4 }, color: '#2d6a4f', symbol: 'apple', mark, pinnedName: false },
    ]
    const input: PdfInput = {
      ...makeInput(0),
      commonNames: { 'Malus domestica': 'Apple', 'Pyrus communis': 'Pear' },
      canvas: { ...makeInput(0).canvas, plants, zones: [zone] },
    }
    const setup: PdfSetup = {
      paper: 'A4',
      layers: ['plants', 'zones'],
      northArrow: true,
      areas: [{ id: '1', name: 'Rotated Bed', bounds: { x: 24, y: 0, width: 12, height: 8 }, angleDeg: 32 }],
      views: { overview: { angleDeg: 0 } },
    }
    const plan = buildPdfPlan(input, setup, text, LABELS)
    const detail = plan.pages.find((p) => p.id === 'area:1')!
    const texts = detail.operations
      .filter((op): op is Extract<PdfPage['operations'][number], { kind: 'text' }> => op.kind === 'text')
      .map((op) => op.line.runs.map((r) => r.text).join(''))
    // Zone label and outer dimensions must be drawn in the 32° detail frame (not missed due to 0° overview coordinates).
    expect(texts).toContain('Z01')
    expect(texts.some((t) => /8\s*m/.test(t))).toBe(true)
    // Both colliding species on the 32° sheet receive distinct enclosure styles in the legend.
    expect(detail.legend).toHaveLength(2)
    expect(new Set(detail.legend.flatMap((entry) => entry.enclosures ?? [])).size).toBe(2)
  })

  it('re-syncs print_setup after Undo and reopen on the same Design', async () => {
    const identity = {}
    const store: { current: PrintSetupV10 | null } = { current: null }
    const readStore = (): PrintSetupV10 | null => store.current
    const endCoalesce = vi.fn()
    const workflow = createPdfWorkflow({
      capture: () => ({ identity, input: makeInput(4), isCurrent: () => true }),
      resolveDisplayNames: async () => ({ names: { 'Malus domestica': 'Apple' }, englishFallbacks: [] }),
      resolveHabits: async () => ({ 'Malus domestica': 'Tree' }),
      prepare: async () => ({ plan: { pages: [], angleDeg: 0, outlines: {}, blocked: null }, bytes: new Uint8Array([37, 80, 68, 70]) }),
      delivery: { deliverFile: vi.fn().mockResolvedValue('saved') },
      labels: () => LABELS,
      namePrintArea: (n) => `Print area ${n}`,
      printSetup: {
        read: readStore,
        write: (next) => { store.current = next },
        endCoalesce,
      },
    })

    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    workflow.configure({ paper: 'Letter' })
    workflow.addPrintArea({ x: -5, y: -5, width: 10, height: 10 })
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value.paper).toBe('Letter')
    expect(workflow.setup.value.areas).toHaveLength(1)
    expect(readStore()?.paper).toBe('Letter')

    workflow.close()
    expect(endCoalesce).toHaveBeenCalledTimes(1)

    // Simulate Undo reverting design.print_setup back to absent (null) on the same Design identity.
    store.current = null
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value.paper).toBe('A4')
    expect(workflow.setup.value.areas ?? []).toHaveLength(0)

    // A subsequent edit builds on the reverted state rather than reviving the undone Letter/area.
    workflow.configure({ northArrow: false })
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    const saved = readStore()
    expect(saved?.paper).toBe('A4')
    expect(saved?.pages ?? []).toHaveLength(0)
    expect(saved?.north_arrow).toBe(false)
    workflow.dispose()
  })
})
