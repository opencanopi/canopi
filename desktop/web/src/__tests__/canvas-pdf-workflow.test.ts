import type { SpeciesDisplayNames } from '../app/plant-browser/workbench'
import type { CanvasPrintSnapshot, PrintPlant } from '../canvas/print'
import type { PdfPreparation } from '../app/canvas-pdf/prepare'
import { describe, expect, it, vi } from 'vitest'
import { createPdfWorkflow, type PdfCapture } from '../app/canvas-pdf/workflow'
import { pdfAreaKey, type PdfInput, type PdfPage, type PreparedPdf } from '../app/canvas-pdf/types'
import { areaContains, areaFromFrame, areaToFrame, layoutAngle, pageFrame } from '../app/canvas-pdf/page-frame'
import { splitPrintArea } from '../app/canvas-pdf/split-sheets'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
const result: PreparedPdf = { bytes: new Uint8Array([37, 80, 68, 70]), plan: { pages: [], angleDeg: 0, outlines: {}, blocked: null } }
function fixture(plants: PrintPlant[] = [], view: Pick<PdfInput, 'viewBearingDeg'> = { viewBearingDeg: 0 }) {
  const identity = {}
  let current = true
  const capture: PdfCapture = { identity, isCurrent: () => current, input: { name: 'Garden', locale: 'fr', commonNames: {}, ...view,
    canvas: { layers: [{ name: 'plants', visible: true, opacity: 1 }, { name: 'base', visible: true, opacity: 1 }],
      plants, zones: [], annotations: [], measurements: [] } } }
  const prepare = vi.fn<(input: PdfPreparation, signal: AbortSignal) => Promise<PreparedPdf>>(async () => result)
  const save = vi.fn(async () => 'saved' as const)
  const resolveDisplayNames = vi.fn(async (_names: readonly string[], _locale: string): Promise<SpeciesDisplayNames> => ({ names: {}, englishFallbacks: [] }))
  let currentCanvas = capture.input.canvas
  let bearing = view.viewBearingDeg, turning = false, settles = 0
  const workflow = createPdfWorkflow({ capture: () => {
    const canvas = currentCanvas, turningNow = turning, settled = settles
    return { ...capture, input: { ...capture.input, canvas, viewBearingDeg: bearing },
      ...(turningNow ? { turning: true } : {}), isCurrent: () => current && canvas === currentCanvas && (!turningNow || settled === settles) }
  }, prepare, resolveDisplayNames, resolveHabits: async () => ({}),
    delivery: { save, dispose: vi.fn() }, labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }), namePrintArea: (number) => `Print area ${number}` })
  return { workflow, prepare, save, resolveDisplayNames, capture, setCanvas: (canvas: CanvasPrintSnapshot) => { currentCanvas = canvas },
    turnView: (deg: number) => { bearing = deg },
    startTurn: (deg: number) => { bearing = deg; turning = true },
    settleView: (deg: number) => { bearing = deg; turning = false; settles++; workflow.synchronize(identity) }, replace: () => { current = false; workflow.synchronize({}) } }
}
describe('PDF workflow lifetime', () => {
  it('As on screen stores Whole Design and split sheets in plan metres and looks split names up in the turned sheets', async () => {
    const frame = pageFrame(30), plant = (id: string, canonicalName: string, x: number, y: number): PrintPlant =>
      ({ id, canonicalName, position: { x, y }, color: '#123456', symbol: 'round', mark: [], pinnedName: false })
    const along = frame.fromFrame({ x: 9, y: 0 })
    const plants = [plant('a', 'Malus domestica', along.x, along.y), plant('b', 'Prunus avium', 9, 0),
      ...Array.from({ length: 200 }, (_, i) => frame.fromFrame({ x: 1 + i * .09, y: .5 })).map((p, i) => plant(`r${i}`, 'Malus domestica', p.x, p.y))]
    const { workflow, prepare, resolveDisplayNames } = fixture(plants, { viewBearingDeg: 30 })
    const picker = { x: 0, y: -1, width: 20, height: 2 }
    prepare.mockImplementation(async ({ input, setup }) => {
      const angle = pageFrame(layoutAngle(setup, input))
      const page = (id: string, ground: PdfPage['ground'], kind: PdfPage['kind']): PdfPage =>
        ({ id, kind, number: 1, width: 600, height: 800, frame: ground, ground, pointsPerMeter: 1, operations: [], legend: [] })
      return { bytes: new Uint8Array([1]), plan: { angleDeg: angle.angleDeg, outlines: {}, blocked: null, pickerPage: page('overview', picker, 'overview'),
        pages: (setup.areas ?? []).map(area => page(pdfAreaKey(area), areaToFrame(angle, area.bounds, area.pivot), 'detail')) } }
    })
    try {
      workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(workflow.setup.value.mapOrientation).toBeUndefined()
      workflow.configure({ mapOrientation: 'as-on-screen' }); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(workflow.state.value.result!.plan.angleDeg).toBe(30)
      const id = workflow.addWholeDesign()!
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      const stored = workflow.setup.value.areas![0]!.bounds
      expect(stored).toEqual(areaFromFrame(frame, picker))
      expect(stored.x).not.toBeCloseTo(picker.x, 3)
      // Whole design refits to the design at every build, so it looks up every plant.
      expect(workflow.setup.value.areas![0]!.wholeDesign).toBe(true)
      expect(resolveDisplayNames.mock.lastCall![0]).toEqual(['Malus domestica', 'Prunus avium'])
      workflow.previewSplit(id); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      const parts = workflow.splitPreview.value!.areas!.map(({ bounds, pivot }) => ({ bounds, pivot }))
      expect(parts).toEqual(splitPrintArea(picker, plants, frame))
      expect(workflow.splitPreview.value!.areas!.some(area => area.wholeDesign)).toBe(false)
      expect(resolveDisplayNames.mock.lastCall![0]).toEqual(['Malus domestica'])
      expect(parts.length).toBeGreaterThan(1)
      for (const p of plants.filter(p => areaContains(frame, stored, p.position))) expect(parts.some(part => areaContains(frame, part.bounds, p.position, part.pivot))).toBe(true)
      // A split sheet split again keeps the first split's pivot, so every sheet still tiles after a switch.
      workflow.applySplit(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      workflow.previewSplit(pdfAreaKey(workflow.setup.value.areas![0]!)); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      const family = workflow.splitPreview.value!.areas!
      expect(family.length).toBeGreaterThan(parts.length)
      for (const area of family) expect(area.pivot).toEqual(parts[0]!.pivot)
    } finally { workflow.dispose() }
  })
  it('waits for a flight still turning on open and holds the bearing it lands at', async () => {
    // A saved view flies from 0 to 15; Ctrl+P during the flight reads about 9 on the live camera.
    const { workflow, prepare, startTurn, settleView } = fixture()
    const angle = () => layoutAngle(prepare.mock.lastCall![0].setup, prepare.mock.lastCall![0].input)
    try {
      startTurn(9)
      workflow.show(); workflow.configure({ mapOrientation: 'as-on-screen' })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(prepare).not.toHaveBeenCalled()
      expect(workflow.state.value).toMatchObject({ status: 'preparing', error: null, result: null })
      expect(workflow.availableLayers.value).toEqual(['plants'])
      settleView(15)
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(angle()).toBe(15)
      expect(prepare.mock.calls.every(([preparation]) => preparation.input.viewBearingDeg === 15)).toBe(true)
    } finally { workflow.dispose() }
  })
  it('holds the bearing read on open until the workspace closes, however the view turns behind it', async () => {
    // A settled view read on open: any later turn behind the modal never moves the pages on the next setting change.
    const { workflow, prepare, turnView, setCanvas, capture } = fixture([], { viewBearingDeg: 9 })
    const angle = () => layoutAngle(prepare.mock.lastCall![0].setup, prepare.mock.lastCall![0].input)
    try {
      workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      workflow.configure({ mapOrientation: 'as-on-screen' }); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(angle()).toBe(9)
      turnView(15)
      workflow.configure({ paper: 'Letter' }); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(angle()).toBe(9)
      setCanvas({ ...capture.input.canvas, zones: [] }); workflow.synchronize(capture.identity)
      await vi.waitFor(() => expect(prepare.mock.lastCall![0].input.canvas.zones).not.toBe(capture.input.canvas.zones))
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(angle()).toBe(9)
      workflow.close(); workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(workflow.setup.value.mapOrientation).toBe('as-on-screen')
      expect(angle()).toBe(15)
    } finally { workflow.dispose() }
  })
  it('exports automatically prepared pages and clears temporary choices on Design replacement', async () => {
    const { workflow, save, replace } = fixture()
    try {
      workflow.show()
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      workflow.addPrintArea({ x: 0, y: 0, width: 5, height: 5 })
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      await workflow.save()
      expect(save).toHaveBeenCalledOnce()
      replace()
      expect(workflow.setup.value.areas).toBeUndefined()
      expect(workflow.state.value.result).toBeNull()
    } finally { workflow.dispose() }
  })
  it('refreshes changed content automatically, coalesces revisions, and cancels refresh on close', async () => {
    vi.useFakeTimers()
    const { workflow, capture, setCanvas, prepare, save } = fixture()
    try {
      workflow.show(); await Promise.resolve()
      workflow.setPageView('overview', { offset: { x: 5, y: 3 }, zoom: 120 })
      await Promise.resolve()
      prepare.mockClear()
      setCanvas({ ...capture.input.canvas, annotations: [] })
      workflow.synchronize(capture.identity)
      expect(workflow.state.value.result).toBeNull()
      await workflow.save(); expect(save).not.toHaveBeenCalled()
      workflow.synchronize(capture.identity)
      await vi.advanceTimersByTimeAsync(150)
      expect(prepare).toHaveBeenCalledOnce()
      expect(workflow.state.value.status).toBe('ready')
      expect(prepare.mock.lastCall![0].setup.views?.overview).toEqual({ offset: { x: 5, y: 3 }, zoom: 120 })
      setCanvas({ ...capture.input.canvas }); workflow.synchronize(capture.identity)
      workflow.close(); await vi.advanceTimersByTimeAsync(150)
      expect(prepare).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { workflow.dispose(); vi.useRealTimers() }
  })
  it('owns framing values and restores zoom and centre together while retaining orientation', async () => {
    const { workflow, prepare } = fixture()
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    const offset = { x: 10, y: -5 }
    workflow.setPageView('overview', { offset, zoom: 125, orientation: 'portrait' })
    offset.x = 500
    expect(workflow.setup.value.views?.overview?.offset?.x).toBe(10)
    const before = workflow.setup.peek()
    workflow.setPageView('overview', { offset: { x: NaN, y: 0 } })
    expect(workflow.setup.peek()).toBe(before)
    workflow.fitPage('overview')
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(prepare.mock.lastCall![0].setup.views?.overview).toEqual({ offset: { x: 0, y: 0 }, zoom: 100, orientation: 'portrait' })
    workflow.dispose()
  })
  it('prepares and delivers derived bytes without including map layers', async () => {
    const { workflow, prepare, save } = fixture()
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value.layers).toEqual(['plants'])
    expect(prepare).toHaveBeenCalledOnce()
    await workflow.save()
    expect(save).toHaveBeenCalledWith(result.bytes, 'Garden', expect.any(AbortSignal))
    expect(workflow.state.value.status).toBe('saved')
    await workflow.save()
    expect(save).toHaveBeenCalledTimes(2)
    workflow.dispose()
  })
  it('retains independent choices across close/edit/reopen and flags missing selections', async () => {
    const { workflow, prepare, capture, setCanvas, replace } = fixture()
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.availableLayers.value).toEqual(['plants'])
    workflow.configure({ paper: 'Letter', layers: [] })
    workflow.close()
    setCanvas({ ...capture.input.canvas, layers: [{ name: 'plants', visible: true, opacity: 1 }, { name: 'annotations', visible: true, opacity: 1 }] })
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value).toEqual({ paper: 'Letter', layers: [] })
    workflow.configure({ layers: ['plants'] }); workflow.close()
    setCanvas({ ...capture.input.canvas, layers: [{ name: 'annotations', visible: true, opacity: 1 }] })
    prepare.mockClear()
    workflow.show()
    expect(workflow.state.value.error).toBe('selection-missing')
    expect(workflow.setup.value.layers).toEqual(['plants'])
    expect(prepare).not.toHaveBeenCalled()
    workflow.configure({ layers: ['annotations'] })
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(prepare.mock.calls[0]![0].setup.layers).toEqual(['annotations'])
    expect(capture.input.canvas.layers[0]!.visible).toBe(true)
    replace()
    expect(workflow.setup.value.layers).toEqual([])
    expect(workflow.availableLayers.value).toEqual([])
    workflow.dispose()
  })
  it('retains independent Print Areas when Zones are resized, renamed or removed', async () => {
    const { workflow, prepare, capture, setCanvas } = fixture()
    const zone = { name: 'Orchard', bounds: { x: 0, y: 0, width: 10, height: 10 }, path: 'M0 0 L10 0 L10 10 L0 10 Z', geometry: { kind: 'rect' as const, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }, fill: null }
    setCanvas({ ...capture.input.canvas, zones: [zone] })
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(workflow.setup.value.areas ?? []).toEqual([])
    workflow.addPrintArea({ x: 1, y: 2, width: 3, height: 4 })
    workflow.setPageView('area:1', { zoom: 75, orientation: 'landscape' })
    for (const zones of [[{ ...zone, bounds: { ...zone.bounds, width: 20 } }], [{ ...zone, name: 'Renamed' }], []]) {
      workflow.close(); setCanvas({ ...capture.input.canvas, zones })
      workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      expect(workflow.state.value.error).toBeNull()
      expect(prepare.mock.lastCall![0].input.canvas.zones).toEqual(zones)
      expect(prepare.mock.lastCall![0].setup.areas).toEqual([{ id: '1', name: 'Print area 1', bounds: { x: 1, y: 2, width: 3, height: 4 } }])
      expect(prepare.mock.lastCall![0].setup.views?.['area:1']).toEqual({ zoom: 75, orientation: 'landscape' })
    }
    workflow.dispose()
  })
  it('owns Print Areas and individual page views only for the current session', async () => {
    const { workflow, prepare, capture, replace } = fixture()
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    const bounds = { x: 1, y: 2, width: 4, height: 5 }
    workflow.addPrintArea(bounds); bounds.width = 99
    workflow.addPrintArea({ x: 10, y: 20, width: 3, height: 6 })
    workflow.setPageView('area:1', { zoom: 125.5, orientation: 'portrait' }); workflow.setPageView('area:2', { zoom: 80, orientation: 'landscape' })
    workflow.close(); workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(prepare.mock.lastCall![0].setup.areas).toEqual([
      { id: '1', name: 'Print area 1', bounds: { x: 1, y: 2, width: 4, height: 5 } },
      { id: '2', name: 'Print area 2', bounds: { x: 10, y: 20, width: 3, height: 6 } },
    ])
    expect(prepare.mock.lastCall![0].setup.views).toEqual({ 'area:1': { zoom: 125.5, orientation: 'portrait' }, 'area:2': { zoom: 80, orientation: 'landscape' } })
    expect(capture.input.canvas.zones).toEqual([])
    workflow.removeArea('area:1')
    expect(workflow.setup.value.views).toEqual({ 'area:2': { zoom: 80, orientation: 'landscape' } })
    replace()
    expect(workflow.setup.value.areas ?? []).toEqual([])
    expect(workflow.setup.value.views).toBeUndefined()
    workflow.dispose()
  })
  it('ignores invalid zoom edits and aborts superseded page preparations', async () => {
    const { workflow, prepare } = fixture()
    workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    workflow.setPageView('overview', { zoom: 75 })
    const before = workflow.setup.peek()
    for (const zoom of [NaN, Infinity, 0, -1, 1001]) workflow.setPageView('overview', { zoom })
    expect(workflow.setup.peek()).toBe(before)
    prepare.mockImplementation(() => new Promise(() => {}))
    workflow.setPageView('overview', { zoom: 120 })
    const previous = prepare.mock.lastCall![1]
    workflow.setPageView('overview', { orientation: 'landscape' })
    expect(previous.aborted).toBe(true)
    expect(workflow.setup.value.views?.overview).toEqual({ zoom: 120, orientation: 'landscape' })
    workflow.dispose()
  })
  it('keeps full canonical names when the catalog is unavailable', async () => {
    const { workflow, prepare, resolveDisplayNames } = fixture([{ id: 'a', canonicalName: 'Malus domestica', position: { x: 0, y: 0 }, color: '#000000', symbol: 'round', mark: [], pinnedName: false }])
    resolveDisplayNames.mockRejectedValue(new Error('catalog unavailable'))
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(prepare.mock.calls[0]![0].input.commonNames).toEqual({})
    workflow.dispose()
  })
  it('discards late preparation after Design replacement and never delivers it', async () => {
    const { workflow, prepare, save, replace } = fixture()
    let finish!: (result: PreparedPdf) => void
    prepare.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    workflow.show(); replace(); finish(result)
    await Promise.resolve(); await workflow.save()
    expect(workflow.open.value).toBe(false)
    expect(workflow.state.value.result).toBeNull()
    expect(save).not.toHaveBeenCalled()
    workflow.dispose()
  })
  it('cancels a preparing job when the preview closes', async () => {
    const { workflow, prepare } = fixture()
    prepare.mockImplementation(() => new Promise(() => {}))
    workflow.show()
    const signal = prepare.mock.calls[0]![1]
    workflow.close()
    expect(signal.aborted).toBe(true)
    expect(workflow.state.value.status).toBe('idle')
    workflow.dispose()
  })
})

it('bounds an unavailable name lookup and releases its deadline when preview closes', async () => {
  vi.useFakeTimers()
  const { workflow, prepare, resolveDisplayNames } = fixture([{ id: 'a', canonicalName: 'Malus domestica', position: { x: 0, y: 0 }, color: '#000000', symbol: 'round', mark: [], pinnedName: false }])
  resolveDisplayNames.mockImplementation(() => new Promise(() => {}))
  try {
    workflow.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveDisplayNames).not.toHaveBeenCalled()
    workflow.addPrintArea({ x: -1, y: -1, width: 2, height: 2 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(workflow.state.value.status).toBe('ready')
    expect(prepare.mock.lastCall![0].input.commonNames).toEqual({})
    workflow.close(); workflow.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    workflow.close()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    expect(workflow.state.value.status).toBe('idle')
  } finally { workflow.dispose(); vi.useRealTimers() }
})

it('recovers from encoding and delivery failures without rebuilding valid bytes for a delivery retry', async () => {
  const { workflow, prepare, save, capture } = fixture()
  const before = structuredClone(capture.input)
  try {
    prepare.mockRejectedValueOnce(new Error('encoding failed'))
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.error).toBe('prepare-failed'))
    await workflow.rebuild()
    expect(workflow.state.value.status).toBe('ready')
    save.mockRejectedValueOnce(new Error('disk full'))
    await workflow.save()
    expect(workflow.state.value.error).toBe('delivery-failed')
    expect(workflow.state.value.result?.bytes).toBe(result.bytes)
    await workflow.save()
    expect(workflow.state.value.status).toBe('saved')
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(capture.input).toEqual(before)
  } finally { workflow.dispose() }
})

it('opens an overview without asking the catalog for any plant names', async () => {
  const { workflow, resolveDisplayNames, prepare } = fixture([{ id: 'a', canonicalName: 'Malus domestica', position: { x: 0, y: 0 }, color: '#000000', symbol: 'round', mark: [], pinnedName: false }])
  try {
    resolveDisplayNames.mockImplementation(() => new Promise(() => {}))
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(resolveDisplayNames).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledOnce()
  } finally { workflow.dispose() }
})

it('does not resolve plant names for uncovered annotations on an overview-only export', async () => {
  const plant = { id: 'remote', canonicalName: 'Prunus avium', speciesCode: 'PAV', position: { x: 30, y: 30 }, color: '#123456', symbol: 'round', mark: [], pinnedName: false }
  const { workflow, capture, setCanvas, resolveDisplayNames } = fixture([plant])
  setCanvas({ ...capture.input.canvas, layers: [...capture.input.canvas.layers, { name: 'annotations', visible: true, opacity: 1 }],
    annotations: [{ id: 'note', text: 'Complete instruction '.repeat(30), fontSize: 16, rotation: 0, position: { x: 30, y: 30 } }] })
  try {
    workflow.show()
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    expect(resolveDisplayNames).not.toHaveBeenCalled()
  } finally { workflow.dispose() }
})
