import { composeSpeciesDisplayNames } from '../app/plant-browser/workbench'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { recolorPlants } from '../app/canvas-pdf/print-colors'
import { createPdfWorkflow } from '../app/canvas-pdf/workflow'
import type { PdfPreparation } from '../app/canvas-pdf/prepare'
import type { PrintPlant } from '../canvas/print'
import type { PdfInput, PdfLabels, PdfPage, PdfSetup, PreparedPdf } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'

const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Print at actual size',
  symbolNames: { square: 'Canopy tree', round: 'Round mark' } }
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
const mark = [{ d: 'M-1 -1 H1 V1 H-1 Z', paint: 'symbol' as const }]
const plant = (id: string, canonicalName: string, x: number, color = '#2f7d32', symbol = 'square'): PrintPlant =>
  ({ id, canonicalName, position: { x, y: 10 }, color, symbol, mark, pinnedName: false })
function garden(extra: Partial<PdfInput> = {}): PdfInput {
  return { name: 'Garden', locale: 'fr', viewBearingDeg: 0, commonNames: { 'Malus domestica': 'Pommier', 'Ribes nigrum': 'Blackcurrant', 'Mentha spicata': 'Menthe' }, canvas: {
    layers: [{ name: 'plants', visible: true, opacity: 1 }], zones: [], annotations: [], measurements: [],
    plants: [plant('a', 'Malus domestica', 4, '#c0392b'), plant('b', 'Ribes nigrum', 10, '#2f7d32', 'round'), plant('c', 'Mentha spicata', 16, '#8e44ad', 'round'),
      plant('d', 'Unknown species', 22, '#f1c40f')],
  }, ...extra }
}
const setup: PdfSetup = { paper: 'A4', layers: ['plants'], areas: [{ id: 'bed', name: 'Bed', bounds: { x: 0, y: 0, width: 26, height: 20 } }] }
const words = (page: PdfPage) => page.operations.flatMap(op => op.kind === 'text' ? [op.line.runs.map(run => run.text).join('')] : [])
const allWords = (pages: readonly PdfPage[]) => pages.flatMap(words)

describe('Canvas PDF print options', () => {
  it('groups the key by catalog habit in Tree, Shrub, Herbaceous, Climber, Other order', () => {
    const input = garden({ habits: { 'Malus domestica': 'tree', 'Ribes nigrum': 'shrub', 'Mentha spicata': 'herbaceous' } })
    const printed = allWords(buildPdfPlan(input, setup, text(), labels).pages)
    const order = ['Tree', 'Pommier', 'Shrub', 'Blackcurrant', 'Herbaceous', 'Menthe', 'Other', 'Unknown species'].map(word => printed.findIndex(line => line.startsWith(word)))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
  it('keeps one ungrouped key when no habit is known', () => {
    const printed = allWords(buildPdfPlan(garden(), setup, text(), labels).pages)
    expect(printed.some(line => /^(Tree|Shrub|Other)\b/.test(line))).toBe(false)
  })
  it('marks English fallback names and explains the mark once per key', () => {
    const printed = allWords(buildPdfPlan(garden({ englishFallbacks: ['Ribes nigrum'] }), setup, text(), labels).pages)
    expect(printed.some(line => line.includes('Blackcurrant (en)'))).toBe(true)
    expect(printed.some(line => line.includes('Pommier (en)'))).toBe(false)
    expect(printed.filter(line => line.startsWith('(en) ='))).toHaveLength(1)
  })
  it('recolours only the printed plants and never the Design', () => {
    const input = garden(), before = structuredClone(input)
    const fills = (plantColors: PdfSetup['plantColors']) => new Set(buildPdfPlan(input, { ...setup, areas: [], plantColors }, text(), labels).pages[0]!
      .operations.flatMap(op => op.kind === 'path' && op.fill && op.matrix[0] !== 1 ? [op.fill] : []))
    expect(fills('design')).toEqual(new Set(['#c0392b', '#2f7d32', '#8e44ad', '#f1c40f', '#24211c']))
    expect([...fills('black')]).toEqual(['#24211c'])
    // The symbol legend draws its marks in ink in every mode.
    expect([...fills('grayscale')].every(fill => /^#([0-9a-f]{2})\1\1$/.test(fill) || fill === '#24211c')).toBe(true)
    expect(fills('grayscale').size).toBe(5)
    expect(input).toEqual(before)
  })
  it('gives each distinct colour its own grey, darkest for the darkest colour', () => {
    const plants = [plant('a', 'A', 0, '#000000'), plant('b', 'B', 0, '#ffffff'), plant('c', 'C', 0, '#808080')]
    const greys = new Map(recolorPlants(plants, 'grayscale').map((printed, i) => [plants[i]!.color, printed.color]))
    const level = (color: string) => parseInt(greys.get(color)!.slice(1, 3), 16)
    expect(new Set(greys.values()).size).toBe(3)
    expect(level('#000000')).toBeLessThan(level('#808080'))
    expect(level('#808080')).toBeLessThan(level('#ffffff'))
  })
  it('draws a north arrow beside the scale bar unless turned off', () => {
    const north = (northArrow?: boolean) => buildPdfPlan(garden(), { ...setup, northArrow }, text(), labels).pages
      .filter(page => page.kind !== 'legend').map(page => words(page).includes('N'))
    expect(north()).toEqual([true, true])
    expect(north(false)).toEqual([false, false])
  })
  it('lists the symbols used on page 1 with their localized names', () => {
    const [overview] = buildPdfPlan(garden(), { ...setup, areas: [] }, text(), labels).pages
    expect(overview!.symbols).toEqual(['square', 'round'])
    expect(words(overview!)).toEqual(expect.arrayContaining(['Symbols', 'Canopy tree', 'Round mark']))
  })
})

describe('Canvas PDF name and habit resolution', () => {
  it('fills missing chosen-language names with English, marks them, and maps catalog habits', async () => {
    const input = garden({ commonNames: {} })
    const prepare = vi.fn(async (_preparation: PdfPreparation): Promise<PreparedPdf> => ({ bytes: new Uint8Array([1]), plan: { pages: [], angleDeg: 0, outlines: {}, blocked: null } }))
    // The catalog's projection: the chosen language's names, English marked for the rest.
    const resolveDisplayNames = vi.fn(composeSpeciesDisplayNames(async (names, locale) =>
      locale === 'fr' ? { 'Malus domestica': 'Pommier' } : Object.fromEntries(names.filter(name => name !== 'Unknown species').map(name => [name, `${name} (English)`]))))
    const workflow = createPdfWorkflow({ capture: () => ({ identity: input, isCurrent: () => true, input }), prepare, resolveDisplayNames,
      resolveHabits: async () => ({ 'Malus domestica': 'Tree', 'Ribes nigrum': 'Shrub', 'Mentha spicata': 'Woody' }),
      delivery: { save: vi.fn(), dispose: vi.fn() }, labels: () => labels, namePrintArea: number => `Area ${number}` })
    try {
      workflow.show()
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      workflow.addPrintArea({ x: 0, y: 0, width: 26, height: 20 })
      await vi.waitFor(() => expect(prepare.mock.calls.length).toBeGreaterThan(1))
      await vi.waitFor(() => expect(workflow.state.value.status).toBe('ready'))
      const printed = prepare.mock.lastCall![0].input
      expect(printed.commonNames).toEqual({ 'Malus domestica': 'Pommier', 'Ribes nigrum': 'Ribes nigrum (English)', 'Mentha spicata': 'Mentha spicata (English)' })
      expect(printed.englishFallbacks).toEqual(['Ribes nigrum', 'Mentha spicata'])
      expect(printed.habits).toEqual({ 'Malus domestica': 'tree', 'Ribes nigrum': 'shrub' })
      expect(resolveDisplayNames).toHaveBeenCalledWith(['Malus domestica', 'Ribes nigrum', 'Mentha spicata', 'Unknown species'], 'fr')
    } finally { workflow.dispose() }
  })
})
