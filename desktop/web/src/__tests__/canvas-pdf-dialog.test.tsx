// @vitest-environment jsdom

import type { PdfPreparation } from '../app/canvas-pdf/prepare'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('../app/canvas-pdf/live', () => ({ canvasPdf: null }))
import { CanvasPdfDialog } from '../components/canvas-pdf/CanvasPdfDialog'
import { createPdfWorkflow } from '../app/canvas-pdf/workflow'
import { readFileSync } from 'node:fs'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { PDF_MAP_ORIENTATIONS, PDF_PLANT_COLORS } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

it('opens with one overview and explicitly adds a whole-design field sheet', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const canvas = { layers: [{ name: 'annotations', visible: true, opacity: 1 }], plants: [], zones: [], measurements: [],
    annotations: ['Water weekly', 'Protect from wind'].map((text, i) => ({ id: String(i), text, position: { x: 0, y: 0 }, fontSize: 14, rotation: 0 })) }
  const text = createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true, input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }),
    prepare: async ({ input, setup, labels }) => {
      const plan = buildPdfPlan(input, setup, text, labels)
      return { plan, bytes: plan.blocked ? null : new Uint8Array([1]) }
    }, resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}), delivery: { save: vi.fn(), dispose: vi.fn() },
    labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }),
    namePrintArea: number => `Area ${number}` })
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    const button = (name: string) => Array.from(container.querySelectorAll('button')).find(node => node.textContent === name || node.getAttribute('aria-label') === name)!
    // Every setup control lives in the side sheet and is reachable with Tab.
    const inSheet = (node: HTMLElement) => { expect(node.closest('aside')).not.toBeNull(); expect(node.tabIndex).toBeGreaterThanOrEqual(0); return node }
    expect(button('Save PDF').disabled).toBe(false)
    inSheet(button('Save PDF'))
    expect(button('Add detail page')).toBeUndefined()
    expect(button('Keep text on overview')).toBeUndefined()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(workflow.state.value.result!.plan.pages).toHaveLength(1)
    await act(async () => { inSheet(button('Add field sheet')).click() })
    await act(async () => { inSheet(button('Whole Design')).click() })
    for (const name of ['Fit', 'Zoom in', 'Zoom out', 'Automatic', 'Portrait', 'Landscape', 'Split into readable sheets']) inSheet(button(name))
    inSheet(container.querySelector<HTMLInputElement>('input[aria-label="Canvas zoom (%)"]')!)
    // Displacement is keyboard-driven on the focusable page editor.
    const editor = container.querySelector<SVGSVGElement>('[data-pdf-editor]')!
    expect(editor.getAttribute('tabindex')).toBe('0')
    const detail = workflow.state.value.result!.plan.pages.find(page => page.kind === 'detail')!.id
    await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.setup.peek().views?.[detail]?.offset?.x).not.toBe(0)
    expect(workflow.state.value.result!.plan.pages.filter(page => page.kind === 'detail')).toHaveLength(1)
    expect(workflow.state.value.result!.plan.pages.flatMap(p => p.annotationIds ?? [])).toEqual(expect.arrayContaining(['0', '1']))
    const original = workflow.setup.peek()
    await act(async () => { button('Split into readable sheets').click(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.setup.peek()).toBe(original)
    expect(workflow.splitPreview.value!.areas).toHaveLength(2)
    expect(container.querySelector('[data-pdf-editor]')!.getAttribute('width')).toBe('100%')
    expect(button('Save PDF').disabled).toBe(true)
    inSheet(button('Apply sheets'))
    await act(async () => { inSheet(button('Cancel')).click(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.setup.peek()).toBe(original)
    await act(async () => { button('View page: Area 1').click() })
    await act(async () => { button('Split into readable sheets').click(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    await act(async () => { button('Apply sheets').click() })
    expect(workflow.splitPreview.value).toBeNull()
    expect(workflow.setup.value.areas).toHaveLength(2)
    expect(button('Save PDF').disabled).toBe(false)

    await act(async () => { workflow.close(); workflow.show(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(button('Save PDF').disabled).toBe(false)
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

// canopi-f47t.52.228.20: the dialog held the modal layer from its commit but took focus after paint (Preact 11 useEffect),
// so an Esc at once went nowhere and the dialog stayed open.
it('canopi-f47t.52.228.20: the PDF dialog has focus as it commits, so an Esc at once closes it', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const workflow = createPdfWorkflow({ capture: () => null, prepare: vi.fn(), resolveDisplayNames: vi.fn(), resolveHabits: vi.fn(),
    delivery: { save: vi.fn(), dispose: vi.fn() }, labels: vi.fn(), namePrintArea: (number) => `Print area ${number}` })
  try {
    workflow.show()
    // A bare render commits and runs layout effects; after-paint work stays queued.
    render(<CanvasPdfDialog workflow={workflow} />, container)
    const first = container.querySelector<HTMLButtonElement>('button')!
    expect(document.activeElement, 'focus is in the dialog as it first shows').toBe(first)
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(container.querySelector('[role="dialog"]'), 'Esc closed it').toBeNull()
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('keeps keyboard commands inside the preview and returns focus when it closes', async () => {
  const launch = document.createElement('button'), container = document.createElement('div')
  document.body.append(launch, container); launch.focus()
  const workflow = createPdfWorkflow({ capture: () => null, prepare: vi.fn(), resolveDisplayNames: vi.fn(), resolveHabits: vi.fn(),
    delivery: { save: vi.fn(), dispose: vi.fn() }, labels: vi.fn(), namePrintArea: (number) => `Print area ${number}` })
  const globalKey = vi.fn()
  window.addEventListener('keydown', globalKey)
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    const first = container.querySelector<HTMLButtonElement>('button')!
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(globalKey).not.toHaveBeenCalled()
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(launch)
  } finally {
    window.removeEventListener('keydown', globalKey)
    render(null, container); workflow.dispose(); container.remove(); launch.remove()
  }
})

it('offers only printable layers and sends checkbox changes to the export setup', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const prepare = vi.fn(async () => ({ bytes: null, plan: { pages: [], angleDeg: 0, outlines: {}, blocked: 'empty' as const } }))
  const canvas = { layers: [{ name: 'plants', visible: true, opacity: 1 }, { name: 'annotations', visible: false, opacity: 1 }, { name: 'base', visible: true, opacity: 1 }], plants: [], zones: [], annotations: [], measurements: [] }
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true,
    input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }), prepare, resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}),
    delivery: { save: vi.fn(), dispose: vi.fn() }, labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }), namePrintArea: (number) => `Print area ${number}` })
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.checked).toBe(true)
    expect(boxes[1]!.checked).toBe(false)
    await act(async () => { boxes[0]!.click(); boxes[1]!.click() })
    expect(workflow.setup.value.layers).toEqual(['annotations'])
    expect(canvas.layers.map((layer) => layer.visible)).toEqual([true, false, true])
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('sets print-only plant colours and the north arrow from the side sheet', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const prepare = vi.fn(async (_preparation: PdfPreparation) => ({ bytes: null, plan: { pages: [], angleDeg: 0, outlines: {}, blocked: 'empty' as const } }))
  const canvas = { layers: [{ name: 'plants', visible: true, opacity: 1 }], plants: [], zones: [], annotations: [], measurements: [] }
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true,
    input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }), prepare, resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}),
    delivery: { save: vi.fn(), dispose: vi.fn() }, labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }), namePrintArea: (number) => `Print area ${number}` })
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    const radios = container.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Plant colors"] input[type="radio"]')
    expect(Array.from(radios, radio => radio.value)).toEqual(['design', 'grayscale', 'black'])
    expect(radios[0]!.checked).toBe(true)
    await act(async () => { radios[1]!.click() })
    expect(workflow.setup.value.plantColors).toBe('grayscale')
    const north = container.querySelector<HTMLInputElement>('input[role="switch"]')!
    expect(north.checked).toBe(true)
    await act(async () => { north.click() })
    expect(workflow.setup.value.northArrow).toBe(false)
    expect(prepare.mock.lastCall![0].setup).toMatchObject({ plantColors: 'grayscale', northArrow: false })
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('offers Map orientation under Plant colours, North up by default, and As on screen draws at the view bearing', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const prepare = vi.fn(async ({ input, setup }: PdfPreparation) => ({ bytes: null, plan: { ...buildPdfPlan(input, setup, createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en'),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }) } }))
  const canvas = { layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
    plants: [{ id: 'p', canonicalName: 'Malus domestica', position: { x: 3, y: 4 }, color: '#123456', symbol: 'round', mark: [], pinnedName: false }] }
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true,
    input: { name: 'Garden', locale: 'en', commonNames: {}, canvas, viewBearingDeg: 30 } }), prepare, resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}),
    delivery: { save: vi.fn(), dispose: vi.fn() }, labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }), namePrintArea: (number) => `Print area ${number}` })
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    const groups = Array.from(container.querySelectorAll('aside [role="radiogroup"]'), group => group.getAttribute('aria-label'))
    expect(groups).toEqual(['Plant colors', 'Map orientation'])
    const radios = container.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Map orientation"] input[type="radio"]')
    expect(Array.from(radios, radio => radio.closest('label')!.textContent)).toEqual(['North up', 'As on screen'])
    expect(radios[0]!.checked).toBe(true)
    expect(workflow.state.value.result!.plan.angleDeg).toBe(0)
    await act(async () => { radios[1]!.click(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.setup.value.mapOrientation).toBe('as-on-screen')
    expect(workflow.state.value.result!.plan.angleDeg).toBe(30)
    await act(async () => { radios[0]!.click(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.state.value.result!.plan.angleDeg).toBe(0)
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('creates explicitly drawn detail pages and edits their zoom and orientation independently', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const canvas = { layers: [{ name: 'zones', visible: true, opacity: 1 }], plants: [], annotations: [], measurements: [], zones: [
    { name: 'Wide bed', bounds: { x: 0, y: 0, width: 30, height: 5 }, path: 'M0 0 L30 0 L30 5 L0 5 Z', geometry: { kind: 'rect' as const, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 5 }, { x: 0, y: 5 }] }, fill: null },
    { name: 'Tall bed', bounds: { x: 40, y: 0, width: 5, height: 30 }, path: 'M40 0 L45 0 L45 30 L40 30 Z', geometry: { kind: 'rect' as const, points: [{ x: 40, y: 0 }, { x: 45, y: 0 }, { x: 45, y: 30 }, { x: 40, y: 30 }] }, fill: null },
  ] }
  const text = createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true, input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }),
    prepare: async ({ input, setup, labels }) => ({ bytes: new Uint8Array([1]), plan: buildPdfPlan(input, setup, text, labels) }),
    resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}), delivery: { save: vi.fn(), dispose: vi.fn() },
    labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }),
    namePrintArea: (number) => `Print area ${number}` })
  const button = (name: string) => Array.from(container.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === name || node.textContent === name)!
  const zoom = () => container.querySelector<HTMLInputElement>('input[type="number"]')!
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    const draw = async (width: number, height: number) => {
      await act(async () => { button('Add field sheet').click() })
      expect(container.querySelector('input[type="search"]')).toBeNull()
      expect(button('Wide bed')).toBeUndefined()
      const overview = workflow.state.value.result!.plan.pickerPage!, svg = container.querySelector<SVGSVGElement>('[data-pdf-editor]')!
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, overview.width, overview.height))
      let captured = false
      svg.setPointerCapture = () => { captured = true }; svg.hasPointerCapture = () => captured; svg.releasePointerCapture = () => { captured = false }
      const pointer = async (type: string, x: number, y: number, target: Element = svg) => {
        const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        await act(async () => { target.dispatchEvent(event) })
      }
      // Authored Zone artwork remains printable, but clicking it creates no page.
      const artwork = svg.querySelector('path[d="M0 0 L30 0 L30 5 L0 5 Z"]')!
      expect(artwork).not.toBeNull()
      const count = workflow.setup.value.areas?.length ?? 0
      await pointer('pointerdown', overview.frame.x + 20, overview.frame.y + 20, artwork)
      await pointer('pointerup', overview.frame.x + 20, overview.frame.y + 20)
      expect(workflow.setup.value.areas?.length ?? 0).toBe(count)
      await pointer('pointerdown', overview.frame.x + 20, overview.frame.y + 20, artwork)
      await pointer('pointerup', overview.frame.x + 20 + width, overview.frame.y + 20 + height)
      expect(workflow.setup.value.areas).toHaveLength(count + 1)
    }
    await draw(200, 50)
    expect(container.querySelector('svg[data-pdf-page="2"]')).not.toBeNull()
    expect(container.querySelector('[data-pdf-editor]')!.getAttribute('viewBox')!.split(' ').map(Number)[2]).toBeGreaterThan(700)
    expect(zoom().value).toBe('100')
    await act(async () => { zoom().value = '137.5'; zoom().dispatchEvent(new Event('input', { bubbles: true })); zoom().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(workflow.setup.value.views?.['area:1']?.zoom).toBe(137.5)
    await act(async () => { button('Portrait').click() })
    expect(workflow.setup.value.views?.['area:1']?.orientation).toBe('portrait')
    await draw(50, 200)
    expect(container.querySelector('svg[data-pdf-page="3"]')).not.toBeNull()
    expect(zoom().value).toBe('100')
    const area = workflow.setup.value.areas![1]!
    const page = workflow.state.value.result!.plan.pages[2]!
    expect(page.width).toBeLessThan(page.height)
    expect(page.ground.x).toBeLessThanOrEqual(area.bounds.x)
    expect(page.ground.x + page.ground.width).toBeGreaterThanOrEqual(area.bounds.x + area.bounds.width)
    expect(page.ground.y).toBeLessThanOrEqual(area.bounds.y)
    expect(page.ground.y + page.ground.height).toBeGreaterThanOrEqual(area.bounds.y + area.bounds.height)
    await act(async () => { button('View page: Print area 1').click() })
    expect(zoom().value).toBe('137.5')
    await act(async () => { zoom().focus(); zoom().value = ''; zoom().dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { zoom().blur() })
    expect(zoom().value).toBe('137.5')
    await act(async () => { button('Fit').click() })
    expect(workflow.setup.value.views?.['area:1']).toEqual({ zoom: 100, orientation: 'portrait', offset: { x: 0, y: 0 } })
    const retained = workflow.setup.peek()
    await act(async () => { button('Add field sheet').click() })
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.activeElement).toBe(container.querySelector('[data-pdf-editor]'))
    expect(workflow.setup.peek()).toBe(retained)
    await act(async () => { button('Inspect text').click() })
    await act(async () => { button('Done inspecting').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[data-pdf-editor]')!.getAttribute('width')).toBe('100%')
    expect(workflow.setup.peek()).toBe(retained)
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('returns to the source page when refreshed content no longer needs the selected legend continuation', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const canvas = { layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
    plants: Array.from({ length: 90 }, (_, i) => ({ id: String(i), canonicalName: 'Species ' + String(i).padStart(3, '0'),
      position: { x: i % 10, y: Math.floor(i / 10) }, color: '#000000', symbol: 'round', mark: [], pinnedName: false })) }
  const text = createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true, input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }),
    prepare: async ({ input, setup, labels }) => ({ bytes: new Uint8Array([1]), plan: buildPdfPlan(input, setup, text, labels) }),
    resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}), delivery: { save: vi.fn(), dispose: vi.fn() },
    labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }),
    namePrintArea: (number) => 'Print area ' + number })
  try {
    await act(async () => {
      workflow.show()
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      render(<CanvasPdfDialog workflow={workflow} />, container)
    })
    await act(async () => { workflow.addWholeDesign(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    const continuation = container.querySelector<HTMLButtonElement>('button[aria-label^="View page: 1 · Key and notes"]')!
    expect(continuation).not.toBeNull()
    await act(async () => { continuation.click() })
    expect(container.querySelector('[data-pdf-editor]')!.getAttribute('data-pdf-page')).toBe('3')
    await act(async () => {
      workflow.selectLayer('plants', false)
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
    })
    expect(container.querySelector('[data-pdf-editor]')!.getAttribute('data-pdf-page')).toBe('2')
    expect(container.querySelector('[aria-current="page"]')!.getAttribute('aria-label')).toBe('View page: Print area 1')
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

it('opens only the overview for an unreadable note and lets the user choose a detail', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const canvas = { layers: [{ name: 'annotations', visible: true, opacity: 1 }], plants: [], zones: [], measurements: [],
    annotations: [{ id: 'long', text: 'Keep the complete instruction '.repeat(20), position: { x: 0, y: 0 }, fontSize: 14, rotation: 0 }] }
  const text = createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
  const workflow = createPdfWorkflow({ capture: () => ({ identity: canvas, isCurrent: () => true, input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }),
    prepare: async ({ input, setup, labels }) => ({ plan: buildPdfPlan(input, setup, text, labels), bytes: new Uint8Array([1]) }),
    resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}), delivery: { save: vi.fn(), dispose: vi.fn() },
    labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Observations', keyAndNotes: 'Key', overview: 'Overview', plants: 'Plants', actualSize: '100%' }),
    namePrintArea: number => `Area ${number}` })
  try {
    await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
    await act(async () => { await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.state.value.result!.plan.pages.map(p => p.kind)).toEqual(['overview'])
    expect(container.querySelectorAll('button[aria-label^="View page:"]')).toHaveLength(1)
    expect(container.querySelector('input[aria-label="Canvas zoom (%)"]')).not.toBeNull()
    await act(async () => { workflow.addWholeDesign(); await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
    expect(workflow.state.value.result!.plan.pages.filter(p => p.kind === 'detail')).toHaveLength(1)
    const card = container.querySelector<HTMLButtonElement>('button[aria-label="View page: Area 1"]')!
    expect(card).not.toBeNull()
    await act(async () => { card.click() })
    expect(container.querySelector('input[aria-label="Canvas zoom (%)"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Remove page: Area 1"]')).not.toBeNull()
  } finally { render(null, container); workflow.dispose(); container.remove() }
})

// jsdom does no layout, so the rule is read as text. Explicit grid tracks are never collapsed when
// empty: a two-option control under a three-column template stops short of the sheet's right edge.
it('PDF segmented controls size their columns from their own option count, so every control spans the sheet', () => {
  expect(new Set([PDF_PLANT_COLORS.length, PDF_MAP_ORIENTATIONS.length]).size).toBeGreaterThan(1)
  const css = readFileSync('src/components/canvas-pdf/canvas-pdf.module.css', 'utf8')
  const group = /\.segmented \[role="radiogroup"\] \{(?<body>[^}]*)\}/.exec(css)?.groups?.body ?? ''
  expect(group).toContain('display: grid')
  expect(group).toContain('grid-auto-flow: column')
  expect(group).not.toContain('grid-template-columns')
})
