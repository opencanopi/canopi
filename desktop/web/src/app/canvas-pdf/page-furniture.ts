import type { PrintPlant } from '../../canvas/print'
import { formatScaleBarDistance, niceDistanceAtMost, type UnitSystem } from '../../utils/format'
import type { PdfInput, PdfLabels, PdfOperation, PdfPage, PdfPaper } from './types'
import type { PdfTextEngine } from './text'
import { MM, PRINT, drawMark, pathOp, textOp } from './page-drawing'
import { compareSpeciesByShownName } from '../../utils/species-sort'

export function detailFurniture(page: PdfPage, input: PdfInput, labels: PdfLabels, paper: PdfPaper, text: PdfTextEngine, showScale: boolean, northAngleDeg: number, groundScaleFactor = 1): PdfOperation[] {
  const operations: PdfOperation[] = [], margin = 10 * MM
  const emit = (value: string, x: number, y: number, size: number, right = false) => {
    const line = text.line(value, size)
    operations.push(textOp(line, right ? x - line.width : x, y, size))
  }
  const name = text.wrap(input.name, 8, page.width - 2 * margin)[0]!
  operations.push(textOp(name, margin, 10 * MM, 8))
  const identity = `${labels.detail} ${page.detailNumber}`
  emit(identity, margin, 18 * MM, 18)
  if (page.legend.length) emit(`${page.legend.reduce((n, e) => n + (e.count ?? 0), 0)} ${labels.plants} · ${page.legend.length} ${labels.species}`, page.width - margin, 18 * MM, 8, true)
  operations.push(pathOp(`M${margin} ${22 * MM} h${page.width - 2 * margin}`, '#d8d2c8', null, .2 * MM))
  const y = page.height - 10 * MM
  operations.push(pathOp(`M${margin} ${page.height - 16 * MM} h${page.width - 2 * margin}`, '#d8d2c8', null, .2 * MM))
  emit(identity, margin, y + 1.5 * MM, 8)
  emit(`${labels.actualSize} · ${paper}`, page.width - margin, y + 1.5 * MM, 7.5, true)
  if (showScale) operations.push(...groundScale(page, input.locale, text, labels.north, northAngleDeg, groundScaleFactor))
  return operations
}

/**
 * Ground scale bar centred in the footer, with a north arrow to its right pointing to true north: `northAngleDeg` is the
 * arrow's clockwise turn on paper, minus the layout angle (0 on North up pages). Its letter sits beyond the tip, level.
 */
export function groundScale(page: Pick<PdfPage, 'width' | 'height' | 'pointsPerMeter'>, locale: string, text: PdfTextEngine, north = 'N', northAngleDeg = 0, groundScaleFactor = 1, unitSystem: UnitSystem = 'metric'): PdfOperation[] {
  const operations: PdfOperation[] = [], y = page.height - 10 * MM
  const emit = (value: string, x: number, y: number, size: number, right = false, strong = false) => {
    const line = text.line(value, size, strong)
    operations.push(textOp(line, right ? x - line.width : x, y, size))
    return line
  }
  const pointsPerGroundMeter = page.pointsPerMeter / groundScaleFactor
  const wanted = 35 * MM / pointsPerGroundMeter
  const metres = niceDistanceAtMost(wanted, unitSystem)
  const length = metres * pointsPerGroundMeter, x = (page.width - length) / 2
  operations.push(pathOp(`M${x} ${y + MM} h${length} M${x} ${y} v${2 * MM} M${x + length / 2} ${y} v${2 * MM} M${x + length} ${y} v${2 * MM}`, PRINT.ink, null, .2 * MM))
  emit('0', x, y - MM, 7)
  emit(formatScaleBarDistance(metres, unitSystem, locale), x + length, y - MM, 7, true)
  // Arrow: a filled half and an open half, tip up, with the letter above it.
  const ax = x + length + 8 * MM, tip = y - 1.5 * MM, base = y + 2.5 * MM, half = 1.3 * MM, middle = (tip + base) / 2
  const angle = northAngleDeg % 360 ? northAngleDeg * Math.PI / 180 : 0, c = Math.cos(angle), s = Math.sin(angle)
  // Turned about the arrow's centre; at 0 the points are the upright arrow's own.
  const at = (px: number, py: number) => angle ? `${ax + (px - ax) * c - (py - middle) * s} ${middle + (px - ax) * s + (py - middle) * c}` : `${px} ${py}`
  operations.push(pathOp(`M${at(ax, tip)} L${at(ax + half, base)} L${at(ax, base - MM)} Z`, null, PRINT.ink, 0),
    pathOp(`M${at(ax, tip)} L${at(ax - half, base)} L${at(ax, base - MM)} Z`, PRINT.ink, null, .15 * MM))
  const letter = text.line(north, 6.5, true)
  if (!angle) operations.push(textOp(letter, ax - letter.width / 2, tip - .8 * MM, 6.5))
  else {
    // The letter's centre beyond the tip along true north, with the upright arrow's gap.
    const reach = middle - tip + .8 * MM + 6.5 * .35, cx = ax + s * reach, cy = middle - c * reach
    operations.push(textOp(letter, cx - letter.width / 2, cy + 6.5 * .35, 6.5))
  }
  return operations
}

export interface SymbolLegend { readonly operations: PdfOperation[]; readonly symbols: readonly string[]; readonly width: number }

/**
 * Legend of the plant symbols printed on page 1, right-aligned in the overview header band.
 * Symbols are drawn in ink so the legend explains shape only; colour belongs to the species key.
 */
export function symbolLegend(plants: readonly PrintPlant[], pageWidth: number, labels: PdfLabels, locale: string, text: PdfTextEngine): SymbolLegend | null {
  const samples = new Map<string, PrintPlant>()
  for (const plant of plants) if (!samples.has(plant.symbol)) samples.set(plant.symbol, plant)
  if (!samples.size) return null
  const nameOf = (symbol: string) => labels.symbolNames?.[symbol]?.trim() || symbol
  const ordered = [...samples.keys()].sort((a, b) => compareSpeciesByShownName(
    { shownName: nameOf(a), canonicalName: a },
    { shownName: nameOf(b), canonicalName: b },
    locale,
  ))
  const size = 7, rows = 4, row = 3.4 * MM, first = 12 * MM, radius = 1.1 * MM, gap = 1.2 * MM, columnGap = 4 * MM
  const right = pageWidth - 10 * MM, budget = Math.max(40 * MM, pageWidth * .45), nameWidth = 32 * MM
  const columns: { symbols: string[]; width: number }[] = []
  let used = 0, printed: string[] = []
  for (let i = 0; i < ordered.length; i += rows) {
    const chunk = ordered.slice(i, i + rows)
    const width = 2 * radius + gap + Math.min(nameWidth, Math.max(...chunk.map(s => text.line(nameOf(s), size).width)))
    if (columns.length && used + columnGap + width > budget) break
    used += (columns.length ? columnGap : 0) + width
    columns.push({ symbols: chunk, width }); printed = printed.concat(chunk)
  }
  const operations: PdfOperation[] = []
  const hidden = ordered.length - printed.length
  const titleLine = text.line(hidden ? `${labels.symbols} (+${hidden})` : labels.symbols, size, true)
  const width = Math.max(used, titleLine.width), left = right - width
  operations.push({ ...textOp(titleLine, left, 8 * MM, size), color: '#655f55' })
  let x = left
  for (const column of columns) {
    column.symbols.forEach((symbol, i) => {
      const baseline = first + i * row
      drawMark({ ...samples.get(symbol)!, color: PRINT.ink }, x + radius, baseline - size * .35, radius, 1, operations)
      // Names are measured whole for the column width; only a name wider than the cap is cut to its first line.
      const room = column.width - 2 * radius - gap, full = text.line(nameOf(symbol), size)
      const line = full.width <= room + .5 ? full : text.wrap(nameOf(symbol), size, room)[0]!
      operations.push(textOp(line, x + 2 * radius + gap, baseline, size))
    })
    x += column.width + columnGap
  }
  return { operations, symbols: printed, width }
}
