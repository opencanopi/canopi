import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createPdfTextEngine, type PdfFontId } from '../app/canvas-pdf/text'
import { buildPdfPlan } from '../app/canvas-pdf/layout'
import { encodePdf } from '../app/canvas-pdf/encode'
import { englishPdfLabels } from '../../scripts/pdf-validation/fixtures'
import { pdfFontUrls } from '../app/canvas-pdf/font-urls'

it('encodes the shared mixed-script overview as vector PDF bytes with embedded fonts', async () => {
  const fonts = new Map<PdfFontId, Uint8Array>([
    ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')],
    ['jp', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKjp-Regular.otf')],
    ['kr', readFileSync('src/app/canvas-pdf/fonts/NotoSansCJKkr-Regular.otf')],
  ])
  const input = { name: 'Érable Яблоня 庭園 정원', locale: 'ja', viewBearingDeg: 0, commonNames: {}, canvas: {
    layers: [{ name: 'annotations', visible: true, opacity: 1 }], plants: [], zones: [], measurements: [],
    annotations: [{ id: 'name', position: { x: 0, y: 0 }, text: 'ローズマリー AVATAR office', fontSize: 16, rotation: 0 }],
  } }
  const plan = buildPdfPlan(input, { paper: 'Letter', views: { overview: { orientation: 'landscape' } }, layers: ['annotations'] }, createPdfTextEngine(fonts, 'ja'),
    { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Print at actual size' })
  const bytes = await encodePdf(plan, fonts, input.name)
  const pdf = new TextDecoder().decode(bytes)
  expect(pdf.startsWith('%PDF-')).toBe(true)
  expect(pdf.endsWith('%%EOF\n')).toBe(true)
  expect(pdf).toContain('/MediaBox [0 0 792 612]')
  expect(pdf).toContain('/ToUnicode')
  expect(pdf).toContain('/FontFile')
  expect(pdf).not.toContain('/Subtype /Image')
  expect(bytes.byteLength).toBeLessThan(200_000)
})

it('loads every regional font needed when mixed-script names wrap onto different lines', async () => {
  const { preparePdf } = await import('../app/canvas-pdf/prepare')
  const { vi } = await import('vitest')
  vi.stubGlobal('fetch', async (url: string) => new Response(new Uint8Array(readFileSync(`src/app/canvas-pdf/fonts/${new URL(url).pathname.split('/').at(-1)}`))))
  try {
    const result = await preparePdf({
      input: { name: 'Field garden · 庭園 정원', locale: 'en', viewBearingDeg: 0, commonNames: {}, canvas: {
        layers: [{ name: 'annotations', visible: true, opacity: 1 }], plants: [], zones: [], measurements: [],
        annotations: [{ id: 'note', position: { x: 0, y: 0 }, text: 'Érable Яблоня ローズマリー 정원', fontSize: 16, rotation: 0 }],
      } }, setup: { paper: 'A4', layers: ['annotations'] },
      labels: { ...englishPdfLabels, notes: 'Notes', observations: 'Field observations', keyAndNotes: 'Key and notes', overview: 'Overview', plants: 'Plants', actualSize: 'Print at actual size' }, fontUrls: pdfFontUrls('https://app.test/'),
    })
    expect(result.plan.blocked).toBeNull()
    expect(result.bytes?.byteLength).toBeGreaterThan(1000)
  } finally { vi.unstubAllGlobals() }
})
