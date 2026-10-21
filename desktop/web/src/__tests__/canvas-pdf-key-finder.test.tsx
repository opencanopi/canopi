// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../app/canvas-pdf/live', () => ({ canvasPdf: null }))
import { findInPdfKey, pdfKeyLocations } from '../app/canvas-pdf/key-finder'
import type { PdfLegendEntry, PdfPage, PdfPlan } from '../app/canvas-pdf/types'
import { createPdfWorkflow } from '../app/canvas-pdf/workflow'
import { locale } from '../app/settings/state'
import { CanvasPdfDialog } from '../components/canvas-pdf/CanvasPdfDialog'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const APPLE: PdfLegendEntry = { reference: '1', code: 'MDO', canonicalName: 'Malus domestica', name: 'Apple', appearances: [] }
const MINT: PdfLegendEntry = { reference: '2', code: 'MSP', canonicalName: 'Mentha spicata', name: 'Spearmint', appearances: [], englishFallback: true }
const CRAB: PdfLegendEntry = { reference: '1', code: 'MSY', canonicalName: 'Malus sylvestris', name: 'Crab apple', appearances: [] }

function page(overrides: Partial<PdfPage> & Pick<PdfPage, 'id' | 'number' | 'kind'>): PdfPage {
  return {
    width: 595, height: 842,
    frame: { x: 20, y: 20, width: 555, height: 802 },
    ground: { x: 0, y: 0, width: 10, height: 10 },
    pointsPerMeter: 10,
    operations: [],
    legend: [],
    ...overrides,
  }
}

// The overview, one field sheet whose key runs onto a key page, and a second sheet.
const PLAN: PdfPlan = {
  angleDeg: 0,
  outlines: {},
  blocked: null,
  pages: [
    page({ id: 'overview', number: 1, kind: 'overview' }),
    page({ id: 'area:a', number: 2, kind: 'detail', detailNumber: 1, areaName: 'Orchard', legend: [APPLE],
      destinations: [{ id: 'area:a:key:1', bounds: { x: 400, y: 100, width: 150, height: 20 } }] }),
    page({ id: 'area:a:legend:0', number: 3, kind: 'legend', sourceId: 'area:a', legend: [MINT],
      destinations: [{ id: 'area:a:key:2', bounds: { x: 20, y: 60, width: 250, height: 24 } }] }),
    page({ id: 'area:b', number: 4, kind: 'detail', detailNumber: 2, areaName: 'Hedge', legend: [CRAB, { ...APPLE, reference: '2' }],
      destinations: [
        { id: 'area:b:key:1', bounds: { x: 400, y: 100, width: 150, height: 20 } },
        { id: 'area:b:key:2', bounds: { x: 400, y: 130, width: 150, height: 20 } },
      ] }),
  ],
}

describe('Find in the PDF key', () => {
  it('locates every key entry on the page that prints it', () => {
    const locations = pdfKeyLocations(PLAN)
    expect(locations.map((location) => [location.pageId, location.entry.canonicalName, location.bounds.y])).toEqual([
      ['area:a', 'Malus domestica', 100],
      ['area:a:legend:0', 'Mentha spicata', 60],
      ['area:b', 'Malus sylvestris', 100],
      ['area:b', 'Malus domestica', 130],
    ])
  })

  it('finds entries by name, scientific name and code, best match first, and tolerates typos', () => {
    const locations = pdfKeyLocations(PLAN)
    expect(findInPdfKey(locations, 'apple').results.map((result) => [result.location.pageId, result.location.entry.name]))
      .toEqual([['area:a', 'Apple'], ['area:b', 'Apple'], ['area:b', 'Crab apple']])
    expect(findInPdfKey(locations, 'msp').results.map((result) => result.location.entry.name)).toEqual(['Spearmint'])
    expect(findInPdfKey(locations, 'mentha').results).toHaveLength(1)
    const typo = findInPdfKey(locations, 'spearmitn')
    expect(typo.correction).toBe('spearmint')
    expect(findInPdfKey(locations, ' ').active).toBe(false)
  })
})

describe('Find in key in the export sheet', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('opens the page with the entry, rings it in the preview and scrolls it into view', async () => {
    const scrolled = vi.fn()
    Object.defineProperty(SVGElement.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
    const canvas = { layers: [], plants: [], zones: [], annotations: [], measurements: [] }
    const workflow = createPdfWorkflow({
      capture: () => ({ identity: canvas, isCurrent: () => true, input: { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas } }),
      prepare: async () => ({ plan: PLAN, bytes: new Uint8Array([1]) }),
      resolveDisplayNames: async () => ({ names: {}, englishFallbacks: [] }), resolveHabits: async () => ({}),
      delivery: { save: vi.fn(), dispose: vi.fn() },
      labels: () => ({ ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }),
      namePrintArea: (number) => `Area ${number}`,
    })
    try {
      await act(async () => { workflow.show(); render(<CanvasPdfDialog workflow={workflow} />, container) })
      await act(async () => { await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready')) })
      const field = container.querySelector<HTMLInputElement>('aside input[aria-label="Find in key"]')!
      expect(field).not.toBeNull()

      // Ctrl F anywhere in the export screen goes to the key finder.
      container.querySelector<HTMLButtonElement>('button')!.focus()
      await act(async () => {
        container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
      })
      expect(document.activeElement).toBe(field)

      await act(async () => {
        field.value = 'spearmint'
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const results = [...container.querySelectorAll<HTMLButtonElement>('[data-pdf-key-result]')]
      expect(results).toHaveLength(1)
      expect(results[0]!.querySelector('[lang="en"]')?.textContent).toBe('Spearmint')
      expect(results[0]!.textContent).toContain('(en)')
      expect(results[0]!.querySelector('i[lang="la"]')?.textContent).toBe('Mentha spicata')
      expect(results[0]!.textContent).toContain('Orchard · Page 3')

      await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      const editor = container.querySelector<SVGSVGElement>('[data-pdf-editor]')!
      expect(editor.getAttribute('data-pdf-page')).toBe('3')
      const ring = editor.querySelector('[data-pdf-key-match="current"]')!
      expect([ring.getAttribute('x'), ring.getAttribute('y')]).toEqual(['20', '60'])
      expect(scrolled).toHaveBeenCalled()

      // Every matching entry on the shown page is ringed; the chosen one stands out.
      await act(async () => {
        field.value = 'apple'
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>('[data-pdf-key-result]')].at(-1)!.click()
      })
      expect(container.querySelector('[data-pdf-editor]')!.getAttribute('data-pdf-page')).toBe('4')
      expect(container.querySelectorAll('[data-pdf-key-match]')).toHaveLength(2)
      expect(container.querySelector('[data-pdf-key-match="current"]')!.getAttribute('y')).toBe('100')
    } finally {
      workflow.dispose()
      delete (SVGElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})
