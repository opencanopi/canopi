import type { CanvasPrintSnapshot, PrintBounds } from '../../canvas/print'
import type { PdfTextEngine } from './text'
import { MM, PRINT, fitOverview, textOp, pathOp, rectPath } from './page-drawing'
import { moveCoverage, zoomCoverage, fitArea } from './coverage'
import { drawField, fieldReferences, measurementReferences, visibleFieldCanvas, type FieldDrawing } from './field-layout'
import { drawOverview } from './overview'
import { fieldKey } from './field-key'
import { integratedKey } from './integrated-key'
import { zoneMeasurements } from './zone-measurements'
import { groupedGuides, overviewMeasurements } from './overview-measurements'
import { detailFurniture, groundScale, symbolLegend } from './page-furniture'
import { fieldSummary } from './field-summary'
import { drawOverviewGuideChain, overviewGuideChain, readableOverviewChain } from './overview-guides'
import { contains, rotatedBounds } from './field-geometry'
import { paperPlantRadius } from './plant-marks'
import { FieldSpace } from './field-placement'
import { recolorPlants } from './print-colors'
import { pdfAreaKey } from './types'
import { areaToFrame, layoutAngle, pageFrame, turnSnapshot } from './page-frame'
import type { PdfPlantColors, PdfInput, PdfLabels, PdfOperation, PdfPage, PdfPlan, PdfSetup, PdfPageView, PdfLayoutCache, PdfLayoutCacheEntry } from './types'

type Geometry = Pick<PdfPage, 'width' | 'height' | 'frame'> & { bodyTop?: number; keyFrame?: PrintBounds }
const orientations = (view: PdfPageView = {}) => !view.orientation || view.orientation === 'auto' ? ['portrait', 'landscape'] as const : [view.orientation]
export function printableCanvas(canvas: CanvasPrintSnapshot, layers: readonly string[], plantColors?: PdfPlantColors): CanvasPrintSnapshot {
  const selected = (name: string) => layers.includes(name) && (canvas.layers.find(l => l.name === name)?.opacity ?? 1) > 0
  return { layers: canvas.layers, plants: selected('plants') ? recolorPlants(canvas.plants, plantColors) : [], zones: selected('zones') ? canvas.zones : [],
    annotations: selected('annotations') ? canvas.annotations : [], measurements: selected('measurement-guides') ? canvas.measurements : [] }
}

export interface PdfLayoutOptions {
  readonly cache?: PdfLayoutCache
  readonly priority?: string
  readonly retain?: (id: string, entry: PdfLayoutCacheEntry) => void
  readonly progress?: (pages: readonly PdfPage[]) => void
}
export function buildPdfPlan(input: PdfInput, setup: PdfSetup, text: PdfTextEngine, labels: PdfLabels, options: PdfLayoutOptions = {}): PdfPlan {
  const plan = buildPages(input, setup, text, labels, options)
  const used = new Set([...plan.pages, ...plan.pickerPage ? [plan.pickerPage] : []].flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.flatMap(r => r.glyphs.map(g => g.key)) : [])))
  return { ...plan, outlines: Object.fromEntries([...used].sort().map(key => [key, text.outlines[key]!])) }
}

function buildPages(original: PdfInput, setup: PdfSetup, text: PdfTextEngine, labels: PdfLabels, options: PdfLayoutOptions): PdfPlan {
  // One frame per plan: everything below runs in it, and page grounds are in its metres.
  const frame = pageFrame(layoutAngle(setup, original))
  const input = { ...original, canvas: turnSnapshot(original.canvas, frame) }
  const offsetOf = (view?: PdfPageView) => view?.offset && frame.toFrame(view.offset)
  const selected = { ...input, canvas: printableCanvas(input.canvas, setup.layers, setup.plantColors) }
  // E, N, P and M are allocated once, from the unturned plan, so a code names the same object at every angle.
  const plan = printableCanvas(original.canvas, setup.layers)
  const dimensions = zoneMeasurements(selected.canvas.zones, plan.zones)
  const details: PdfPage[] = []
  const empty = !(setup.areas?.length || selected.canvas.plants.length || selected.canvas.zones.length || selected.canvas.annotations.length || selected.canvas.measurements.length)
  const asPages = (id: string, geometry: Geometry, ground: PrintBounds, scale: number, drawing: FieldDrawing, areaName?: string): PdfPage[] => {
    const keyGeometry = (index: number) => {
      const view = setup.views?.[`${id}:legend:${index}`]
      const orientation = !view?.orientation || view.orientation === 'auto' ? geometry.width > geometry.height ? 'landscape' : 'portrait' : view.orientation
      return pageGeometry(setup.paper, orientation, 'legend')
    }
    const opacity = selected.canvas.layers.find(l => l.name === 'plants')?.opacity ?? 1
    const integrated = integratedKey(drawing, id, geometry, keyGeometry, text, labels, opacity)
    const bodies = integrated ? [] : fieldKey(drawing, id, keyGeometry, text, labels, opacity)
    const continuations: PdfPage[] = bodies.map((body, index) => ({ ...body, id: `${id}:legend:${index}`, sourceId: id, kind: 'legend', number: 0,
      ground: { x: 0, y: 0, width: 0, height: 0 }, pointsPerMeter: 0, legend: body.entries }))
    const page: PdfPage = { ...geometry, ...drawing, id, kind: 'detail', number: 0, ground, pointsPerMeter: scale,
      ...(areaName === undefined ? {} : { areaName }), continuationIds: continuations.map(p => p.id),
      operations: [...drawing.operations, ...integrated?.operations ?? []], links: [...drawing.links, ...integrated?.links ?? []],
      destinations: [...drawing.destinations, ...integrated?.destinations ?? []] }
    return [page, ...continuations]
  }
  // Add whole design refits at every build, as the picker frames the printed design with no Print Areas, so a new angle
  // never leaves part of the design off its sheet. With nothing printed it keeps the box it was added with.
  const printed = selected.canvas.plants.length || selected.canvas.zones.length || selected.canvas.annotations.length || selected.canvas.measurements.length
  let wholeDesign: PrintBounds | undefined
  const wholeDesignGround = () => wholeDesign ??= orientations().map(orientation =>
    fitOverview(selected, pageGeometry(setup.paper, orientation, 'detail').frame)).sort((a, b) => b.pointsPerMeter - a.pointsPerMeter)[0]!.ground
  const fittedDetails = (setup.areas ?? []).map(area => {
    const id = pdfAreaKey(area), view = setup.views?.[id]
    const requested = area.wholeDesign && printed ? wholeDesignGround() : areaToFrame(frame, area.bounds, area.pivot)
    if (![requested.x, requested.y, requested.width, requested.height].every(Number.isFinite) || requested.width <= 0 || requested.height <= 0) throw new Error('invalid-page-view')
    const choices = requested.width === requested.height && (!view?.orientation || view.orientation === 'auto') ? ['portrait'] as const : orientations(view)
    const candidates = choices.map(orientation => {
      const geometry = pageGeometry(setup.paper, orientation, 'detail')
      const available = { ...geometry.frame }
      const summary = fieldSummary(dimensions, moveCoverage(zoomCoverage({ ground: requested, pointsPerMeter: 1 }, view?.zoom), offsetOf(view)).ground, geometry.width - 20 * MM, input.locale, text)
      const summaryHeight = summary.length ? summary.length * 11 + 5 : 0
      available.y += summaryHeight; available.height -= summaryHeight
      if (available.height < 30 * MM) throw new Error('coverage-too-large')
      const fit = fitArea(requested, available, view?.zoom)
      return { geometry: { ...geometry, frame: fit.frame, bodyTop: available.y }, summary, ...moveCoverage(fit, offsetOf(view)) }
    }).sort((a, b) => b.pointsPerMeter - a.pointsPerMeter)
    const { geometry, ground, pointsPerMeter, summary } = candidates[0]!
    return { id, area, geometry, ground, pointsPerMeter, summary }
  })
  if (fittedDetails.length) {
    // Identity collisions follow the printed colours, so grayscale and black get enclosures where needed.
    const references = fieldReferences({ ...input, canvas: { ...input.canvas, plants: recolorPlants(input.canvas.plants, setup.plantColors) } }, plan, dimensions, fittedDetails.map(p => p.ground))
    references.measurementHomes = new Map(selected.canvas.measurements.flatMap(guide => {
      const home = fittedDetails.filter(p => contains(p.ground, guide.start) && contains(p.ground, guide.end))
        .sort((a, b) => b.pointsPerMeter - a.pointsPerMeter)[0]
      return home ? [[guide.id, home.id]] : []
    }))
    for (const { id, area, geometry, ground, pointsPerMeter, summary } of [...fittedDetails].sort((a, b) => Number(b.id === options.priority) - Number(a.id === options.priority))) {
      const visible = { ...selected, canvas: visibleFieldCanvas(selected.canvas, ground) }
      const names = Object.fromEntries(visible.canvas.plants.map(p => [p.canonicalName,
        [input.commonNames[p.canonicalName], input.habits?.[p.canonicalName], input.englishFallbacks?.includes(p.canonicalName)]]))
      const key = JSON.stringify([visible.canvas, names, input.locale, geometry, ground, pointsPerMeter, area.name, labels,
        Object.entries(setup.views ?? {}).filter(([key]) => key.startsWith(`${id}:legend:`)),
        [...references.species], [...references.notes], [...references.plants], [...references.measurements], [...references.identities ?? []],
        visible.canvas.measurements.map(g => references.measurementHomes?.get(g.id))])
      const cached = options.cache?.[id]
      let local: readonly PdfPage[]
      if (cached?.key === key) {
        Object.assign(text.outlines, cached.outlines)
        local = cached.pages
      } else {
        let integrated: PdfPage[] | undefined
        const spare = geometry.width - geometry.frame.width - 26 * MM
        for (const width of [...new Set([84 * MM, 96 * MM, 108 * MM, spare])].filter(w => w >= 65 * MM && w <= spare)) {
          const keyFrame = { x: geometry.width - 10 * MM - width, y: geometry.bodyTop!, width,
            height: geometry.height - geometry.bodyTop! - 20 * MM }
          const leftWidth = keyFrame.x - 16 * MM
          const shifted = { ...geometry, keyFrame, frame: { ...geometry.frame, x: 10 * MM + (leftWidth - geometry.frame.width) / 2 } }
          const drawing = drawField(visible, shifted.frame, ground, pointsPerMeter, { id, ...shifted, reserved: [keyFrame], summary }, text, references)
          const candidate = asPages(id, shifted, ground, pointsPerMeter, drawing, area.name)
          if (candidate.length === 1) { integrated = candidate; break }
        }
        if (!integrated && geometry.frame.width > geometry.frame.height * 4) {
          for (const height of [50, 65, 80].map(n => n * MM)) {
            const keyFrame = { x: 10 * MM, y: geometry.height - 20 * MM - height, width: geometry.width - 20 * MM, height }
            const available = keyFrame.y - 6 * MM - geometry.bodyTop!
            if (available < geometry.frame.height + 8 * MM) continue
            const shifted = { ...geometry, keyFrame, frame: { ...geometry.frame, y: geometry.bodyTop! + (available - geometry.frame.height) / 2 } }
            const drawing = drawField(visible, shifted.frame, ground, pointsPerMeter, { id, ...shifted, reserved: [keyFrame], summary }, text, references)
            const candidate = asPages(id, shifted, ground, pointsPerMeter, drawing, area.name)
            if (candidate.length === 1) { integrated = candidate; break }
          }
        }
        local = integrated ?? asPages(id, geometry, ground, pointsPerMeter,
          drawField(visible, geometry.frame, ground, pointsPerMeter, { id, ...geometry, summary }, text, references), area.name)
      }
      const glyphs = new Set(local.flatMap(p => p.operations.flatMap(op => op.kind === 'text' ? op.line.runs.flatMap(r => r.glyphs.map(g => g.key)) : [])))
      options.retain?.(id, { key, pages: local, outlines: Object.fromEntries([...glyphs].map(key => [key, text.outlines[key]!])) })
      details.push(...local)
      if (id === options.priority) options.progress?.(local)
      if (details.length > 199) throw new Error('coverage-too-large')
    }
  }
  const order = new Map(fittedDetails.map((p, i) => [p.id, i]))
  details.sort((a, b) => order.get(a.sourceId ?? a.id)! - order.get(b.sourceId ?? b.id)!)
  const detailMaps = details.filter(p => p.kind === 'detail')
  const extents = detailMaps.map(p => p.ground)
  const mapNotes = selected.canvas.annotations.filter(n => !detailMaps.some(p => contains(p.ground, n.position)))
  const overviewInput = { ...selected, canvas: { ...selected.canvas, annotations: mapNotes } }
  const hasSummary = dimensions.length > 0
  const guideHomes = groupedGuides(dimensions, selected.canvas.measurements)
  const chain = overviewGuideChain(selected.canvas.measurements.filter(g => !guideHomes.has(g.id)))
  const fits = orientations(setup.views?.overview).map(orientation => {
    const base = pageGeometry(setup.paper, orientation, 'overview')
    const geometry = { ...base, frame: { ...base.frame, width: base.frame.width - (hasSummary ? 114 * MM : 0), height: base.frame.height - (chain.length ? 18 * MM : 0) } }
    const spatial = selected.canvas.plants.length || selected.canvas.zones.length || selected.canvas.measurements.length || extents.length
    const fitting = spatial ? { ...overviewInput, canvas: { ...overviewInput.canvas, annotations: [] } } : selected
    return { geometry, ...fitOverview(fitting, geometry.frame, empty ? [{ x: -5, y: -5, width: 10, height: 10 }] : extents) }
  }).sort((a, b) => b.pointsPerMeter - a.pointsPerMeter)
  const fitted = fits[0]!, overviewFit = moveCoverage(zoomCoverage(fitted, setup.views?.overview?.zoom), offsetOf(setup.views?.overview))
  const visible = visibleFieldCanvas(overviewInput.canvas, overviewFit.ground)
  const readableChain = readableOverviewChain(chain, fitted.geometry.frame, overviewFit.ground, overviewFit.pointsPerMeter, text, input.locale)
  const drawing = drawOverview({ ...selected, canvas: visible }, fitted.geometry.frame, overviewFit.ground, overviewFit.pointsPerMeter, text,
    new Map([...guideHomes, ...readableChain.map(g => [g.id, 'chain'] as const)]), true, dimensions, measurementReferences(plan))
  drawing.operations.push(...drawOverviewGuideChain(readableChain, fitted.geometry.frame, overviewFit.ground, overviewFit.pointsPerMeter, text, input.locale, labels.guides, selected.canvas.layers.find(l => l.name === 'measurement-guides')?.opacity ?? 1))
  const summaryFrame = { x: fitted.geometry.frame.x + fitted.geometry.frame.width + 6 * MM, y: fitted.geometry.frame.y,
    width: 108 * MM, height: fitted.geometry.height - fitted.geometry.frame.y - 20 * MM }
  const summaryGeometry = (index: number) => {
    const override = setup.views?.[`overview:legend:${index}`]?.orientation
    const orientation = !override || override === 'auto' ? fitted.geometry.width > fitted.geometry.height ? 'landscape' : 'portrait' : override
    const geometry = pageGeometry(setup.paper, orientation, 'legend')
    return { ...geometry, frame: { x: 10 * MM, y: 28 * MM, width: 108 * MM, height: geometry.height - 48 * MM } }
  }
  const guideValues = drawing.notes.filter(n => n.kind === 'distance').map(n => `${n.reference} · ${n.text}`)
  const summaryPages = hasSummary || guideValues.length ? overviewMeasurements(dimensions, selected.canvas.measurements,
    index => hasSummary && index === 0 ? summaryFrame : summaryGeometry(index - (hasSummary ? 1 : 0)).frame, text, input.locale, labels, guideValues) : []
  if (hasSummary) drawing.operations.push(...summaryPages[0] ?? [])
  const overviewContinuations: PdfPage[] = summaryPages.slice(hasSummary ? 1 : 0).map((operations, i) => ({ ...summaryGeometry(i),
    id: `overview:legend:${i}`, sourceId: 'overview', kind: 'legend', number: 0, operations, legend: [],
    ground: { x: 0, y: 0, width: 0, height: 0 }, pointsPerMeter: 0,
  }))
  const overview: PdfPage = { ...fitted.geometry, ...drawing, id: 'overview', kind: 'overview', number: 1,
    ground: overviewFit.ground, pointsPerMeter: overviewFit.pointsPerMeter, continuationIds: overviewContinuations.map(p => p.id) }
  const pages = [overview, ...overviewContinuations, ...details].map((page, i) => ({ ...page, number: i + 1,
    detailNumber: page.kind === 'overview' || page.sourceId === 'overview' ? undefined : order.get(page.sourceId ?? page.id)! + 1 }))
  if (pages.length > 200) throw new Error('coverage-too-large')
  const byId = new Map(pages.map(page => [page.id, page]))
  const showScale = setup.northArrow !== false
  // The north arrow points to true north on the turned page.
  const northAngleDeg = -frame.angleDeg
  const finalized = pages.map((page): PdfPage => {
    const operations = [...page.operations], links = [...page.links ?? []]
    let legendSymbols: readonly string[] | undefined
    for (const reference of page.pageReferences ?? []) {
      const target = byId.get(reference.target)!
      const { x, y, size } = reference, mid = y - size * .35
      operations.push(pathOp(`M${x} ${mid} h${3 * MM} m${-MM} ${-MM} l${MM} ${MM} l${-MM} ${MM}`, '#A06B1F', null, .2 * MM))
      operations.push({ ...textOp(text.line(String(target.detailNumber ?? target.number), size), x + 4 * MM, y, size), color: '#A06B1F' })
    }
    if (page.kind === 'overview') {
      const symbols = symbolLegend(selected.canvas.plants, page.width, labels, input.locale, text)
      if (symbols) { operations.push(...symbols.operations); legendSymbols = symbols.symbols }
      const heading = text.wrap(input.name, 16, Math.max(30 * MM, page.width - 20 * MM - (symbols ? symbols.width + 6 * MM : 0)), true)
      if (heading.length > 2) {
        const second = heading[1]!.runs.map(run => run.text).join('')
        heading[1] = text.line(`${second}…`, 16, true)
      }
      heading.slice(0, 2).forEach((line, i) => operations.push(textOp(line, 10 * MM, (11 + i * 6) * MM, 16)))
      operations.push({ ...textOp(text.line(labels.overview, 9), 10 * MM, 22 * MM, 9), color: '#655f55' })
      operations.push(pathOp(`M${10 * MM} ${25 * MM} h${page.width - 20 * MM}`, '#d8d2c8', null, .2 * MM))
      if (detailMaps.length) drawNavigation(page, pages.filter(p => p.kind === 'detail'), selected.canvas, text, operations, links)
      const y = page.height - 12 * MM
      operations.push(pathOp(`M${10 * MM} ${y} h${50 * MM} M${10 * MM} ${y - 2} v4 M${60 * MM} ${y - 2} v4`, PRINT.ink, null, .25 * MM))
      operations.push(textOp(text.line('50 mm', 7), 10 * MM, page.height - 6 * MM, 7))
      if (showScale) operations.push(...groundScale(page, input.locale, text, labels.north, northAngleDeg))
      const reminder = text.line(`${labels.actualSize} · ${setup.paper}`, 7.5)
      operations.push(textOp(reminder, page.width - 10 * MM - reminder.width, page.height - 8.5 * MM, 7.5))
    } else if (page.kind === 'detail') {
      operations.push(...detailFurniture(page, input, labels, setup.paper, text, showScale, northAngleDeg))
      if (page.continuationIds?.[0]) links.push({ bounds: { x: 8 * MM, y: 8 * MM, width: 13 * MM, height: 11 * MM }, target: `page:${page.continuationIds[0]}` })
    } else {
      const source = byId.get(page.sourceId!)!
      operations.push(textOp(text.line(`${source.detailNumber ?? labels.overview} · ${source.kind === 'overview' ? labels.measurementSummary : labels.keyAndNotes}`, 16), 10 * MM, 13 * MM, 16))
      if (source.legend.length) {
        const count = text.line(`${source.legend.reduce((sum, entry) => sum + (entry.count ?? 0), 0)} ${labels.plants}`, 8.5)
        operations.push(textOp(count, 10 * MM, 18 * MM, 8.5))
        if (source.legend.some(entry => entry.englishFallback)) {
          const lines = text.wrap(labels.englishFallback, 8, page.width - 26 * MM - count.width)
          lines.forEach((line, i) => operations.push({ ...textOp(line, page.width - 10 * MM - line.width, 18 * MM - (lines.length - 1 - i) * 3.2 * MM, 8), color: '#655f55' }))
        }
      }
      links.push({ bounds: { x: 10 * MM, y: 7 * MM, width: 100 * MM, height: 10 * MM }, target: `page:${source.id}` })
    }
    return { ...page, operations, links, ...legendSymbols ? { symbols: legendSymbols } : {} }
  })
  const pickerFits = orientations().map(orientation => {
    const geometry = pageGeometry(setup.paper, orientation, 'detail')
    return { geometry, ...fitOverview(selected, geometry.frame, extents.length ? extents : empty ? [{ x: -5, y: -5, width: 10, height: 10 }] : []) }
  }).sort((a, b) => b.pointsPerMeter - a.pointsPerMeter)
  const picker = pickerFits[0]!
  const pickerDrawing = drawOverview(selected, picker.geometry.frame, picker.ground, picker.pointsPerMeter, text)
  const pickerPage: PdfPage = { id: 'overview', kind: 'overview', number: 1, ...picker.geometry, ...pickerDrawing, ground: picker.ground, pointsPerMeter: picker.pointsPerMeter }
  return { pages: finalized, pickerPage, angleDeg: frame.angleDeg, outlines: text.outlines, blocked: empty ? 'empty' : null }
}

function pageGeometry(paper: 'A4' | 'Letter', orientation: 'portrait' | 'landscape', kind: PdfPage['kind']): Geometry {
  const sides = paper === 'A4' ? [210 * MM, 297 * MM] : [612, 792]
  const width = sides[orientation === 'portrait' ? 0 : 1]!, height = sides[orientation === 'portrait' ? 1 : 0]!
  const margin = (kind === 'detail' ? 8 : 10) * MM, top = (kind === 'detail' ? 26 : kind === 'legend' ? 20 : 28) * MM
  const bottom = (kind === 'overview' ? 20 : kind === 'detail' ? 20 : 10) * MM
  return { width, height, frame: { x: margin, y: top, width: width - 2 * margin, height: height - top - bottom } }
}
function drawNavigation(overview: PdfPage, details: readonly PdfPage[], canvas: CanvasPrintSnapshot, text: PdfTextEngine, operations: PdfOperation[], links: import('./types').PdfLink[]): void {
  const { frame, ground, pointsPerMeter: scale } = overview
  const space = new FieldSpace({ x: frame.x / MM, y: frame.y / MM, width: frame.width / MM, height: frame.height / MM }, text)
  for (const plant of canvas.plants) {
    const r = Math.max(.42, Math.min(1, paperPlantRadius(canvas.plants, plant, scale) / MM))
    space.mark(plant.id, { x: (frame.x + (plant.position.x - ground.x) * scale) / MM - r,
      y: (frame.y + (plant.position.y - ground.y) * scale) / MM - r, width: r * 2, height: r * 2 })
  }
  for (const g of canvas.measurements) {space.addSegments([{ a: { x: (frame.x + (g.start.x - ground.x) * scale) / MM, y: (frame.y + (g.start.y - ground.y) * scale) / MM },
    b: { x: (frame.x + (g.end.x - ground.x) * scale) / MM, y: (frame.y + (g.end.y - ground.y) * scale) / MM } }])}
  for (const op of operations) {if (op.kind === 'text' && op.line.ink) {
    const b = rotatedBounds(op.line.ink, op.rotation, op)
    space.reserve({ x: b.x / MM, y: b.y / MM, width: b.width / MM, height: b.height / MM })
  }}
  operations.push({ kind: 'clip', bounds: frame })
  for (const page of details) {
    const bounds = { x: frame.x + (page.ground.x - ground.x) * scale, y: frame.y + (page.ground.y - ground.y) * scale,
      width: page.ground.width * scale, height: page.ground.height * scale }
    if (bounds.x + bounds.width < frame.x || bounds.x > frame.x + frame.width || bounds.y + bounds.height < frame.y || bounds.y > frame.y + frame.height) continue
    const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
    const strokes: string[] = []
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!, b = corners[(i + 1) % 4]!, length = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)
      for (let t = 0; t < length; t += 2.2 * MM) {
        const end = Math.min(length, t + 1.4 * MM)
        strokes.push(`M${a[0]! + (b[0]! - a[0]!) * t / length} ${a[1]! + (b[1]! - a[1]!) * t / length} L${a[0]! + (b[0]! - a[0]!) * end / length} ${a[1]! + (b[1]! - a[1]!) * end / length}`)
      }
    }
    operations.push(pathOp(strokes.join(' '), '#A06B1F', null, .22 * MM))
    const measured = space.measure(String(page.detailNumber), 9, Infinity, true)
    const x = Math.max(frame.x / MM + .5, Math.min((bounds.x + MM) / MM, (frame.x + frame.width) / MM - measured.width - .5))
    const top = Math.max(frame.y / MM + .5, Math.min(bounds.y / MM - measured.height - 1, (frame.y + frame.height) / MM - measured.height - .5))
    const positions = [[x, top], [x - measured.width - 2, top], [x + measured.width + 2, top], [x, top - measured.height - 1], [x, top + measured.height + 2]]
    const label = positions.map(([x, y]) => ({ x: x!, y: y!, width: measured.width, height: measured.height })).find(b => space.clear(b))
    if (label) {
      space.reserve(label)
      operations.push(pathOp(rectPath({ x: label.x * MM, y: label.y * MM, width: label.width * MM, height: label.height * MM }), '#A06B1F', '#ffffff', .16 * MM))
      operations.push({ ...textOp(measured.lines[0]!, (label.x + measured.inset) * MM, (label.y + measured.baseline) * MM, 9), color: '#A06B1F' })
    }
    links.push({ bounds, target: `page:${page.id}` })
  }
  operations.push({ kind: 'unclip' })
}
