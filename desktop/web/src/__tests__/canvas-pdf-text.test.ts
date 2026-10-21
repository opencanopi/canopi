import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
const bytes = new Map<PdfFontId, Uint8Array>([
  ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')],
  ['jp', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKjp-Regular.otf')],
  ['sc', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKsc-Regular.otf')],
  ['kr', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKkr-Regular.otf')],
])
describe('PDF shared shaping', () => {
  it('reports ink bounds including accents and descenders for print coverage', () => {
    const text = createPdfTextEngine(bytes, 'fr')
    const plain = text.line('E', 10), accented = text.line('É', 10), descender = text.line('g', 10)
    expect(accented.ink!.y).toBeLessThan(plain.ink!.y)
    expect(descender.ink!.y + descender.ink!.height).toBeGreaterThan(0)
    expect(text.line(' ', 10).ink).toBeNull()
  })
  it('preserves mixed scripts, full long names and combining accents while wrapping at a fixed readable size', () => {
    const text = createPdfTextEngine(bytes, 'fr')
    const source = 'Érable Яблоня 庭園 정원 ローズマリー Rosmarinus officinalis var. angustifolius e\u0301'
    const lines = text.wrap(source, 10, 90)
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.every((line) => line.width <= 90)).toBe(true)
    expect(lines.flatMap((line) => line.runs.map((run) => run.text)).join('').replace(/\s/g, ''))
      .toBe(source.normalize('NFC').replace(/\s/g, ''))
    expect(Object.keys(text.outlines).length).toBeGreaterThan(20)
    expect(text.line('ローズマリー', 10).width).toBeCloseTo(59.5, 5)
  })
  it('refuses a missing glyph instead of substituting or omitting text', () => {
    expect(() => createPdfTextEngine(bytes, 'en').line(String.fromCodePoint(0x10ffff), 10)).toThrow('unsupported-text')
  })
})
