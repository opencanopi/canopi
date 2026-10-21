import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import type { PdfInput, PdfLabels } from '../app/canvas-pdf/types'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
const labels: PdfLabels = { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Actual size' }
const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')]]), 'en')
it('keeps key identities consistent across frames, locale and layers without changing reserved Design codes', () => {
  const input: PdfInput = { name: 'Garden', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: { layers: [{ name: 'plants', visible: true, opacity: 1 }], annotations: [], measurements: [], zones: [],
    plants: ['Same appearance A', 'Same appearance B'].map((name, i) => ({ id: String(i), canonicalName: name, speciesCode: ['APPLE', 'MSP'][i]!,
      position: { x: i * 10, y: 0 }, color: '#123456', symbol: 'round', mark: [], pinnedName: false })) } }
  const before = structuredClone(input)
  const areas = [0, 10].map((x, i) => ({ id: String(i), name: 'Area', bounds: { x: x - 1, y: -1, width: 2, height: 2 } }))
  const first = buildPdfPlan(input, { paper: 'A4', layers: ['plants'], areas }, text(), labels)
  const second = buildPdfPlan({ ...input, locale: 'fr', viewBearingDeg: 0, commonNames: { 'Same appearance A': 'Z', 'Same appearance B': 'A' } },
    { paper: 'Letter', layers: ['plants'], areas: areas.slice(1) }, text(), labels)
  expect(first.pages.filter(p => p.kind === 'detail').map(p => p.legend[0]!.reference)).toEqual(['01', '02'])
  expect(second.pages.find(p => p.kind === 'detail')!.legend[0]!.reference).toBe('02')
  const keyText = first.pages.filter(p => p.kind !== 'overview').flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.map(r => r.text) : [])).join(' ')
  expect(keyText).toContain('APPLE'); expect(keyText).toContain('MSP')
  expect(input).toEqual(before)
})
