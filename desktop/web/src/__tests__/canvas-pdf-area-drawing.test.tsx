// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { expect, it, vi } from 'vitest'
import { PdfPageEditor } from '../components/canvas-pdf/PdfPageEditor'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { areaFromFrame, pageFrame } from '../app/canvas-pdf/page-frame'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfPage, PdfPlan, PdfSetup } from '../app/canvas-pdf/types'
import type { PrintBounds, PrintPoint } from '../canvas/print'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const page: PdfPage = { id: 'overview', kind: 'overview', number: 1, width: 200, height: 100,
  frame: { x: 20, y: 10, width: 160, height: 80 }, ground: { x: 100, y: 200, width: 16, height: 8 },
  pointsPerMeter: 10, operations: [], legend: [] }
/** Renders the editor on a 200x100 page centred in a 1000x1000 box (top whitespace 250 px) and drives one pointer. */
async function editor(props: Partial<Parameters<typeof PdfPageEditor>[0]> & { plan: PdfPlan }) {
  const container = document.createElement('div'); document.body.append(container)
  await act(async () => { render(<PdfPageEditor page={page} {...props} />, container) })
  const svg = container.querySelector('svg')!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 1000))
  const captured = new Set<number>()
  svg.setPointerCapture = (id) => { captured.add(id) }
  svg.hasPointerCapture = (id) => captured.has(id)
  svg.releasePointerCapture = (id) => { captured.delete(id) }
  const pointer = async (type: string, clientX: number, clientY: number) => {
    const event = new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    await act(async () => { svg.dispatchEvent(event) })
  }
  const key = async (init: KeyboardEventInit) => { await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })) }) }
  return { pointer, key, dispose: () => { render(null, container); container.remove() } }
}
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const labels = { ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }
const garden = (viewBearingDeg: number): PdfInput => ({ name: 'Garden', locale: 'en', commonNames: {}, viewBearingDeg, canvas: {
  layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
  plants: [0, 1, 2].map(i => ({ id: String(i), canonicalName: 'Malus domestica', position: { x: 100 + i * 6, y: 200 + i * 3 }, color: '#123456', symbol: 'round', mark: [], pinnedName: false })),
} })
const centreOf = (b: PrintBounds): PrintPoint => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
function detail(viewBearingDeg: number, mapOrientation: PdfSetup['mapOrientation'], bounds: PrintBounds) {
  const plan = buildPdfPlan(garden(viewBearingDeg), { paper: 'A4', layers: ['plants'], mapOrientation, areas: [{ id: 'a', name: 'A', bounds }] }, text(), labels)
  return { plan, ground: plan.pages.find(p => p.kind === 'detail')!.ground }
}
async function drawArea(angleDeg: number): Promise<PrintBounds> {
  const onPrintArea = vi.fn()
  const view = await editor({ plan: { pages: [page], outlines: {}, blocked: null, angleDeg }, adding: true, onPrintArea })
  try { await view.pointer('pointerdown', 200, 400); await view.pointer('pointerup', 500, 550) } finally { view.dispose() }
  expect(onPrintArea).toHaveBeenCalledOnce()
  return onPrintArea.mock.lastCall![0]
}

it('switching orientation turns each area about its centre', async () => {
  // Drawn on an As on screen page at 30: stored in plan metres about the drawn rectangle's centre.
  const drawn = { x: 102, y: 202, width: 6, height: 3 }
  const box = await drawArea(30)
  expect(box).toEqual(areaFromFrame(pageFrame(30), drawn))
  const onScreen = detail(30, 'as-on-screen', box), northUp = detail(30, 'north-up', box)
  expect(onScreen.plan.angleDeg).toBe(30)
  const turned = centreOf(onScreen.ground), level = centreOf(northUp.ground)
  expect(turned.x).toBeCloseTo(centreOf(drawn).x, 6); expect(turned.y).toBeCloseTo(centreOf(drawn).y, 6)
  expect(level.x).toBeCloseTo(centreOf(box).x, 6); expect(level.y).toBeCloseTo(centreOf(box).y, 6)
  for (const { ground } of [onScreen, northUp]) { expect(ground.width).toBeCloseTo(6, 6); expect(ground.height).toBeCloseTo(3, 6) }
  // A drag on the turned page moves the view centre by the turned-back ground delta.
  const onMove = vi.fn()
  const view = await editor({ plan: { pages: [page], outlines: {}, blocked: null, angleDeg: 30 }, onMove })
  try { await view.pointer('pointerdown', 200, 400); await view.pointer('pointerup', 500, 550) } finally { view.dispose() }
  const delta = pageFrame(30).fromFrame({ x: -6, y: -3 })
  expect(onMove.mock.lastCall![0].x).toBeCloseTo(delta.x, 6); expect(onMove.mock.lastCall![0].y).toBeCloseTo(delta.y, 6)
  // North up stores the drawn rectangle as it is.
  expect(await drawArea(0)).toEqual(drawn)
})

it('reopening at a new bearing keeps each area\'s centre', async () => {
  const box = await drawArea(30)
  const { plan, ground } = detail(60, 'as-on-screen', box)
  expect(plan.angleDeg).toBe(60)
  const centre = pageFrame(60).fromFrame(centreOf(ground))
  expect(centre.x).toBeCloseTo(centreOf(box).x, 6); expect(centre.y).toBeCloseTo(centreOf(box).y, 6)
  expect(ground.width).toBeCloseTo(6, 6); expect(ground.height).toBeCloseTo(3, 6)
})

it('maps a drag through fitted-page whitespace into ground coordinates and cancels interrupted drags', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const page: PdfPage = { id: 'overview', kind: 'overview', number: 1, width: 200, height: 100,
    frame: { x: 20, y: 10, width: 160, height: 80 }, ground: { x: 100, y: 200, width: 16, height: 8 },
    pointsPerMeter: 10, operations: [], legend: [] }
  const onPrintArea = vi.fn()
  try {
    await act(async () => { render(<PdfPageEditor page={page} plan={{ pages: [page], angleDeg: 0, outlines: {}, blocked: null }} adding onPrintArea={onPrintArea} />, container) })
    const svg = container.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 1000))
    const captured = new Set<number>()
    svg.setPointerCapture = vi.fn((id) => { captured.add(id) })
    svg.hasPointerCapture = vi.fn((id) => captured.has(id))
    svg.releasePointerCapture = vi.fn((id) => { captured.delete(id) })
    const pointer = async (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true })
      Object.defineProperty(event, 'pointerId', { value: 7 })
      await act(async () => { svg.dispatchEvent(event) })
    }
    // 200x100 paper centered inside a 1000x1000 SVG: top whitespace is 250 px.
    await pointer('pointerdown', 200, 400)
    await pointer('pointermove', 500, 550)
    expect(svg.querySelector('[data-print-area-draft]')).not.toBeNull()
    await pointer('pointerup', 500, 550)
    expect(onPrintArea).toHaveBeenCalledExactlyOnceWith({ x: 102, y: 202, width: 6, height: 3 })
    expect(captured.size).toBe(0)
    await pointer('pointerdown', 200, 400)
    await pointer('pointermove', 500, 550)
    await pointer('pointercancel', 500, 550)
    expect(svg.querySelector('[data-print-area-draft]')).toBeNull()
    expect(onPrintArea).toHaveBeenCalledOnce()
    expect(captured.size).toBe(0)
  } finally { render(null, container); container.remove() }
})

it('commits framing once, cancels lost capture and Escape, and ignores clicks while drawing', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const page: PdfPage = { id: 'overview', kind: 'overview', number: 1, width: 200, height: 100,
    frame: { x: 20, y: 10, width: 160, height: 80 }, ground: { x: 100, y: 200, width: 16, height: 8 },
    pointsPerMeter: 10, operations: [], legend: [] }
  const onMove = vi.fn(), onPrintArea = vi.fn()
  const plan = { pages: [page], angleDeg: 0, outlines: {}, blocked: null }
  try {
    await act(async () => { render(<PdfPageEditor page={page} plan={plan} onMove={onMove} />, container) })
    const svg = container.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 1000))
    const captured = new Set<number>()
    svg.setPointerCapture = (id) => { captured.add(id) }
    svg.hasPointerCapture = (id) => captured.has(id)
    svg.releasePointerCapture = (id) => {
      captured.delete(id)
      svg.dispatchEvent(new Event('lostpointercapture'))
    }
    const pointer = async (type: string, x: number, y: number, target: Element = svg, id = 7) => {
      const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
      Object.defineProperty(event, 'pointerId', { value: id })
      await act(async () => { target.dispatchEvent(event) })
    }
    await pointer('pointerdown', 200, 400)
    await pointer('pointermove', 500, 550)
    expect(onMove).not.toHaveBeenCalled()
    expect(svg.style.getPropertyValue('--pdf-drag-x')).toBe('60px')
    await pointer('pointerup', 500, 550, svg, 8)
    expect(onMove).not.toHaveBeenCalled()
    await pointer('pointerup', 500, 550)
    expect(onMove).toHaveBeenCalledExactlyOnceWith({ x: -6, y: -3 })
    expect(captured.size).toBe(0)
    await pointer('pointerdown', 200, 400)
    await pointer('pointermove', 500, 550)
    await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await pointer('pointerup', 500, 550)
    expect(onMove).toHaveBeenCalledOnce()
    expect(svg.style.getPropertyValue('--pdf-drag-x')).toBe('')
    await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(onMove).toHaveBeenLastCalledWith({ x: -.5, y: 0 })
    await act(async () => { render(<PdfPageEditor page={page} plan={plan} adding onPrintArea={onPrintArea} />, container) })
    await pointer('pointerdown', 200, 400)
    await pointer('pointerup', 201, 401)
    expect(onPrintArea).not.toHaveBeenCalled()
    await pointer('pointerdown', 200, 400)
    await pointer('pointerup', 500, 550)
    expect(onPrintArea).toHaveBeenCalledExactlyOnceWith({ x: 102, y: 202, width: 6, height: 3 })
    await pointer('pointerdown', 200, 400)
    await act(async () => { render(null, container) })
    expect(captured.size).toBe(0)
  } finally { render(null, container); container.remove() }
})

it('mod+arrow is the large step; Shift+arrow does nothing; the direction is unchanged', async () => {
  for (const mac of [false, true]) {
    const onMove = vi.fn()
    const view = await editor({ plan: { pages: [page], angleDeg: 0, outlines: {}, blocked: null }, onMove, mac })
    try {
      const mod = mac ? { metaKey: true } : { ctrlKey: true }, other = mac ? { ctrlKey: true } : { metaKey: true }
      // ArrowLeft moves the content left, as a drag does (U12): the view centre goes right.
      await view.key({ key: 'ArrowLeft' })
      expect(onMove).toHaveBeenLastCalledWith({ x: .5, y: 0 })
      await view.key({ key: 'ArrowDown', ...mod })
      expect(onMove).toHaveBeenLastCalledWith({ x: 0, y: -3 })
      expect(onMove).toHaveBeenCalledTimes(2)
      for (const modifiers of [{ shiftKey: true }, { altKey: true }, other, { ...mod, shiftKey: true }]) await view.key({ key: 'ArrowRight', ...modifiers })
      expect(onMove).toHaveBeenCalledTimes(2)
    } finally { view.dispose() }
  }
  // On a turned page the press keeps its direction on paper.
  const onMove = vi.fn()
  const view = await editor({ plan: { pages: [page], outlines: {}, blocked: null, angleDeg: 90 }, onMove, mac: false })
  try {
    await view.key({ key: 'ArrowLeft', ctrlKey: true })
    const onPaper = pageFrame(90).toFrame(onMove.mock.lastCall![0])
    expect(onPaper.x).toBeCloseTo(3, 6); expect(onPaper.y).toBeCloseTo(0, 6)
  } finally { view.dispose() }
})
