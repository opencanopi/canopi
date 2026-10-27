// app/canvas-pdf/text.ts
// Owner of the PDF font fetches (fetch-only-in-owners, ADR 0028; §18 F15) until 2a's
// platform/geocoding.ts page fetch. Invariant: PDF fonts are fetched only here, from the origin table's origins.

import { create, type Font } from 'fontkit'
import assets from './font-assets.json'
import { textGraphemes } from '../../utils/text-graphemes'

export type PdfFontId = 'latin' | 'strong' | 'sc' | 'jp' | 'kr'
interface TextRun {
  readonly text: string
  readonly font: PdfFontId
  readonly width: number
  readonly glyphs: readonly { readonly key: string; readonly x: number; readonly y: number }[]
}
export interface TextLine {
  readonly runs: readonly TextRun[]
  readonly width: number
  /** Actual shaped ink relative to the baseline, in PDF points; whitespace has no ink. */
  readonly ink: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
}
export interface GlyphOutline { readonly path: string; readonly unitsPerEm: number }
export interface PdfTextEngine {
  readonly outlines: Record<string, GlyphOutline>
  line(text: string, size: number, strong?: boolean): TextLine
  wrap(text: string, size: number, width: number, strong?: boolean): TextLine[]
}
export class PdfTextError extends Error {
  constructor(readonly kind: 'unsupported-text' | 'text-too-wide', readonly character?: string) { super(kind) }
}

/** Absolute URL of each font file by its `font-assets.json` name (`font-urls.ts`). */
export type PdfFontUrls = Readonly<Record<string, string>>

export async function loadPdfFonts(texts: readonly string[], locale: string, urls: PdfFontUrls): Promise<Map<PdfFontId, Uint8Array>> {
  const bytes = new Map<PdfFontId, Uint8Array>()
  async function load(id: PdfFontId): Promise<Font> {
    const asset = assets.find((entry) => entry.id === id)!
    const url = urls[asset.file]
    if (!url) throw new Error('font-load')
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 30_000)
    try {
      const response = await fetch(url, { signal: abort.signal })
      if (!response.ok) throw new Error('font-load')
      const data = new Uint8Array(await response.arrayBuffer())
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('')
      if (digest !== asset.sha256) throw new Error('font-integrity')
      bytes.set(id, data)
      return create(data)
    } finally { clearTimeout(timer) }
  }
  const latin = await load('latin')
  await load('strong')
  const needed = new Set<PdfFontId>()
  for (const text of texts) {
    for (const char of text.replace(/[\n\r\t]/g, '')) {
      if (!latin.hasGlyphForCodePoint(char.codePointAt(0)!)) needed.add(regionalFont(char, locale))
    }
  }
  for (const id of needed) await load(id)
  return bytes
}

function regionalFont(character: string, locale: string): PdfFontId {
  if (/[\u3040-\u30ff]/u.test(character)) return 'jp'
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(character)) return 'kr'
  return locale.startsWith('ja') ? 'jp' : locale.startsWith('ko') ? 'kr' : 'sc'
}

export function createPdfTextEngine(bytes: ReadonlyMap<PdfFontId, Uint8Array>, locale: string): PdfTextEngine {
  const fonts = new Map(Array.from(bytes, ([id, data]) => [id, create(data)]))
  const outlines: Record<string, GlyphOutline> = {}
  const latin = fonts.get('latin')!
  const cache = new Map<string, TextLine>()
  function line(raw: string, size: number, strong = false): TextLine {
    const text = raw.normalize('NFC').replace(/\t/g, '    ')
    const key = `${strong}:${size}:${text}`
    const previous = cache.get(key)
    if (previous) return previous
    const parts: { font: PdfFontId; text: string }[] = []
    for (const char of text) {
      const code = char.codePointAt(0)!
      const id: PdfFontId = latin.hasGlyphForCodePoint(code) ? strong && fonts.has('strong') ? 'strong' : 'latin' : regionalFont(char, locale)
      const font = fonts.get(id)
      if (!font?.hasGlyphForCodePoint(code)) throw new PdfTextError('unsupported-text', char)
      const last = parts[parts.length - 1]
      if (last?.font === id) last.text += char
      else parts.push({ font: id, text: char })
    }
    let runOrigin = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const runs = parts.map((part): TextRun => {
      const font = fonts.get(part.font)!
      const layout = font.layout(part.text)
      let x = 0
      const glyphs = layout.glyphs.map((glyph, index) => {
        const position = layout.positions[index]!
        const key = `${part.font}:${glyph.id}`
        outlines[key] ??= { path: glyph.path.toSVG(), unitsPerEm: font.unitsPerEm }
        const item = { key, x: (x + position.xOffset) * size / font.unitsPerEm, y: -position.yOffset * size / font.unitsPerEm }
        const box = glyph.bbox, unit = size / font.unitsPerEm
        if (box.maxX > box.minX && box.maxY > box.minY) {
          minX = Math.min(minX, runOrigin + item.x + box.minX * unit)
          maxX = Math.max(maxX, runOrigin + item.x + box.maxX * unit)
          minY = Math.min(minY, item.y - box.maxY * unit)
          maxY = Math.max(maxY, item.y - box.minY * unit)
        }
        x += position.xAdvance
        return item
      })
      const width = layout.advanceWidth * size / font.unitsPerEm
      runOrigin += width
      return { ...part, width, glyphs }
    })
    const result = { runs, width: runOrigin, ink: Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null }
    cache.set(key, result)
    return result
  }
  function wrap(text: string, size: number, width: number, strong?: boolean): TextLine[] {
    const result: TextLine[] = []
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let current = ''
      // Prefer word boundaries; long words/CJK can break between complete graphemes.
      for (const word of paragraph.split(/(\s+)/u).filter(Boolean)) {
        if (line(current + word, size, strong).width <= width) { current += word; continue }
        if (current.trim()) { result.push(line(current.trimEnd(), size, strong)); current = '' }
        if (!word.trim()) continue
        if (line(word, size, strong).width <= width) { current = word; continue }
        for (const cluster of textGraphemes(word)) {
          if (line(current + cluster, size, strong).width > width) {
            if (!current) throw new PdfTextError('text-too-wide')
            result.push(line(current, size, strong)); current = ''
            if (line(cluster, size, strong).width > width) throw new PdfTextError('text-too-wide')
          }
          current += cluster
        }
      }
      result.push(line(current.trimEnd(), size, strong))
    }
    return result
  }
  return { outlines, line, wrap }
}
