/**
 * app/canvas-pdf/print-setup.ts: Sole frame-crossing module between persisted WGS84 `PrintSetupV10`
 * and session-plane `PlanePrintSetup` (`2.1-Q151`, `2.1-Q152`, `2.1-M90`, `2.1-M161`, `2.1-Q356`,
 * ADR 0008, contracts §10).
 *
 * Invariants:
 * - `inPlane(setup, plane)` returns a branded `PlanePrintSetup` (never stored in signals, stores, or writes).
 * - `applyPrintEdit(setup, edit, plane)` returns the next `PrintSetupV10` with untouched pages and splits
 *   preserved by reference (byte-identical on encode).
 * - A `SplitSheet` page's centre, offset (`along_page`), and size are projected at its split `pivot`'s
 *   ground scale so sibling sheets tile seamlessly at any latitude (`2.1-M161`).
 * - A `Box` page uses its own `centre`'s ground scale.
 */
import type {
  PrintAreaV10,
  PrintFramingV10,
  PrintPageV10,
  PrintScaleV10,
  PrintSetupV10,
  PrintSplitV10,
} from '../../generated/contracts'
import type { PdfScaleSpec } from '../../generated/quantity-table'
import type { PrintBounds, PrintPoint } from '../../canvas/print'
import type { SessionPlane } from '../../geo/session-plane'
import { CONVERSION_CONSTANTS, formatNumber, pdfScalesForSystem, type UnitSystem } from '../../utils/format'
import { MM } from './page-drawing'
import {
  PDF_PLANT_COLORS,
  pdfAreaKey,
  type PdfPageView,
  type PdfPaper,
  type PdfPlantColors,
  type PdfPrintArea,
  type PdfSetup,
} from './types'

declare const PLANE_PRINT_SETUP_BRAND: unique symbol

/** Branded session-plane projection of `PrintSetupV10`; never stored in signals, stores, or writes. */
export interface PlanePrintSetup extends PdfSetup {
  readonly [PLANE_PRINT_SETUP_BRAND]: true
}

type PrintOrientationChoice = 'auto' | 'portrait' | 'landscape'

export type PrintSetupEdit =
  | { readonly kind: 'set-paper'; readonly paper: PdfPaper }
  | { readonly kind: 'set-layers'; readonly layers: readonly string[] }
  | { readonly kind: 'set-plant-colors'; readonly plantColors: PdfPlantColors }
  | { readonly kind: 'set-north-arrow'; readonly northArrow: boolean }
  | { readonly kind: 'set-page-angle'; readonly pageId: string; readonly angleDeg: number }
  | { readonly kind: 'set-page-scale'; readonly pageId: string; readonly scale: PrintScaleV10 }
  | {
      readonly kind: 'set-page-framing'
      readonly pageId: string
      readonly orientation?: PrintOrientationChoice
      readonly offset?: PrintPoint
    }
  | {
      readonly kind: 'add-box'
      readonly id: string
      readonly name: string
      readonly bounds: PrintBounds
      readonly angleDeg: number
    }
  | {
      readonly kind: 'add-whole-design'
      readonly id: string
      readonly name: string
      readonly fallbackBounds: PrintBounds
      readonly angleDeg: number
    }
  | { readonly kind: 'remove-page'; readonly pageId: string }
  | {
      readonly kind: 'apply-split'
      readonly parentPageId: string
      readonly splitId: string
      readonly pivot: PrintPoint
      readonly angleDeg: number
      readonly parts: readonly { readonly id: string; readonly name: string; readonly bounds: PrintBounds }[]
    }

const DEFAULT_FALLBACK_BOX: PrintBounds = { x: -5, y: -5, width: 10, height: 10 }

export function normalisePrintAngle(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) return 0
  const mod = ((angleDeg % 360) + 360) % 360
  return Object.is(mod, -0) ? 0 : mod
}

function meanGroundScale(plane: SessionPlane, point: PrintPoint): number {
  const s = plane.groundScaleAt(point)
  return Math.sqrt(s.x * s.y)
}

function centreOf(box: PrintBounds): PrintPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function boxAbout(centre: PrintPoint, width: number, height: number): PrintBounds {
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height }
}

function readOrientation(framing: PrintFramingV10 | null | undefined): PrintOrientationChoice | undefined {
  if (framing?.orientation === 'portrait' || framing?.orientation === 'landscape') return framing.orientation
  return undefined
}

function readOffset(framing: PrintFramingV10 | null | undefined): PrintPoint | undefined {
  if (framing?.offset_x_m !== undefined && framing.offset_x_m !== null && framing.offset_y_m !== undefined && framing.offset_y_m !== null) {
    return { x: framing.offset_x_m, y: framing.offset_y_m }
  }
  return undefined
}

function readPaper(paper: string | null | undefined): PdfPaper {
  return paper === 'Letter' ? 'Letter' : 'A4'
}

function readPlantColors(mode: string | null | undefined): PdfPlantColors {
  return PDF_PLANT_COLORS.includes(mode as PdfPlantColors) ? (mode as PdfPlantColors) : 'design'
}

/** Creates an empty persisted `PrintSetupV10` seed from default visible layers (never written until edited). */
export function defaultPrintSetup(layers: readonly string[]): PrintSetupV10 {
  return {
    paper: 'A4',
    layers: [...layers],
    plant_colors: 'design',
    north_arrow: true,
    overview_angle_deg: 0,
    overview_scale: { kind: 'fit' },
    splits: [],
    pages: [],
  }
}

function projectPrintPage(
  page: PrintPageV10,
  plane: SessionPlane,
  splitsById: ReadonlyMap<string, PrintSplitV10>,
): PdfPrintArea {
  if (page.area.kind === 'box') {
    const centre = plane.toPlane(page.area.centre)
    const scale = meanGroundScale(plane, centre)
    return {
      id: page.id,
      name: page.name,
      bounds: boxAbout(centre, page.area.size.width_m / scale, page.area.size.height_m / scale),
      angleDeg: normalisePrintAngle(page.area.angle_deg),
    }
  }
  if (page.area.kind === 'whole_design') {
    let bounds = DEFAULT_FALLBACK_BOX
    if (page.area.fallback) {
      const centre = plane.toPlane(page.area.fallback.centre)
      const scale = meanGroundScale(plane, centre)
      bounds = boxAbout(centre, page.area.fallback.size.width_m / scale, page.area.fallback.size.height_m / scale)
    }
    return {
      id: page.id,
      name: page.name,
      bounds,
      wholeDesign: true,
      angleDeg: normalisePrintAngle(page.area.angle_deg),
    }
  }
  const split = splitsById.get(page.area.split)
  if (!split) throw new Error(`Missing print_setup split "${page.area.split}"`)
  const pivot = plane.toPlane(split.pivot)
  const pivotScale = meanGroundScale(plane, pivot)
  const centre: PrintPoint = {
    x: pivot.x + page.area.along_page.right_m / pivotScale,
    y: pivot.y + page.area.along_page.down_m / pivotScale,
  }
  return {
    id: page.id,
    name: page.name,
    bounds: boxAbout(centre, page.area.size.width_m / pivotScale, page.area.size.height_m / pivotScale),
    pivot,
    splitId: split.id,
    angleDeg: normalisePrintAngle(split.angle_deg),
  }
}

function buildPageView(scale: PrintScaleV10, framing: PrintFramingV10 | null | undefined, angleDeg?: number): PdfPageView {
  const orientation = readOrientation(framing)
  const offset = readOffset(framing)
  return {
    ...(angleDeg !== undefined ? { angleDeg } : {}),
    scale,
    ...(orientation ? { orientation } : {}),
    ...(offset ? { offset } : {}),
  }
}

/**
 * Projects a persisted WGS84 `PrintSetupV10` into the active `SessionPlane`, producing a branded
 * `PlanePrintSetup` for layout and preview. Split sheets use their split pivot's ground scale (`2.1-M161`).
 */
export function inPlane(
  setup: PrintSetupV10,
  plane: SessionPlane,
  defaultLayers: readonly string[] = [],
): PlanePrintSetup {
  const splits = setup.splits ?? []
  const pages = setup.pages ?? []
  const splitsById = new Map<string, PrintSplitV10>(splits.map((s) => [s.id, s]))
  const areas: PdfPrintArea[] = []
  const views: Record<string, PdfPageView> = {
    overview: buildPageView(
      setup.overview_scale ?? { kind: 'fit' },
      setup.overview_framing,
      normalisePrintAngle(setup.overview_angle_deg ?? 0),
    ),
  }

  for (const page of pages) {
    const area = projectPrintPage(page, plane, splitsById)
    areas.push(area)
    views[pdfAreaKey(area)] = buildPageView(page.scale, page.framing)
  }

  return {
    paper: readPaper(setup.paper),
    layers: setup.layers ? [...setup.layers] : [...defaultLayers],
    plantColors: readPlantColors(setup.plant_colors),
    northArrow: setup.north_arrow ?? true,
    areas,
    views,
  } as unknown as PlanePrintSetup
}

function pageIdFromKey(key: string): string {
  return key.startsWith('area:') ? key.slice('area:'.length) : key
}

function resolveFramingOrientation(
  existing: PrintFramingV10 | null | undefined,
  orientation: PrintOrientationChoice | undefined,
): string | null {
  if (orientation === undefined) return existing?.orientation ?? null
  return orientation === 'auto' ? null : orientation
}

function resolveFramingOffset(
  existing: PrintFramingV10 | null | undefined,
  offset: PrintPoint | undefined,
): PrintPoint | null {
  if (offset === undefined) {
    return existing?.offset_x_m != null && existing.offset_y_m != null
      ? { x: existing.offset_x_m, y: existing.offset_y_m }
      : null
  }
  return offset.x === 0 && offset.y === 0 ? null : offset
}

function mergeFraming(
  existing: PrintFramingV10 | null | undefined,
  orientation: PrintOrientationChoice | undefined,
  offset: PrintPoint | undefined,
): PrintFramingV10 | null {
  const nextOrientation = resolveFramingOrientation(existing, orientation)
  const nextOffset = resolveFramingOffset(existing, offset)
  const paper = existing?.paper ?? null
  if (paper === null && nextOrientation === null && nextOffset === null) return null
  return {
    ...(paper !== null ? { paper } : {}),
    ...(nextOrientation !== null ? { orientation: nextOrientation } : {}),
    ...(nextOffset !== null ? { offset_x_m: nextOffset.x, offset_y_m: nextOffset.y } : {}),
  }
}

function applySetPageAngle(
  setup: PrintSetupV10,
  pageId: string,
  rawAngleDeg: number,
): PrintSetupV10 {
  const angleDeg = normalisePrintAngle(rawAngleDeg)
  if (pageId === 'overview') return { ...setup, overview_angle_deg: angleDeg }
  const currentPages = setup.pages ?? []
  const currentSplits = setup.splits ?? []
  const targetId = pageIdFromKey(pageId)
  const target = currentPages.find((p) => p.id === targetId)
  if (!target) return setup
  if (target.area.kind === 'split_sheet') {
    const splitId = target.area.split
    return { ...setup, splits: currentSplits.map((s) => (s.id === splitId ? { ...s, angle_deg: angleDeg } : s)) }
  }
  return {
    ...setup,
    pages: currentPages.map((p) => (p.id === targetId ? { ...p, area: { ...p.area, angle_deg: angleDeg } } : p)),
  }
}

function applySplitEdit(
  setup: PrintSetupV10,
  edit: Extract<PrintSetupEdit, { kind: 'apply-split' }>,
  plane: SessionPlane,
): PrintSetupV10 {
  const currentPages = setup.pages ?? []
  const currentSplits = setup.splits ?? []
  const parentId = pageIdFromKey(edit.parentPageId)
  const parent = currentPages.find((p) => p.id === parentId)
  if (!parent) return setup
  const existingSplitId = parent.area.kind === 'split_sheet' ? parent.area.split : null
  const splitId = existingSplitId ?? edit.splitId
  const existingSplit = existingSplitId ? currentSplits.find((s) => s.id === existingSplitId) : undefined
  const pivotPlane = existingSplit ? plane.toPlane(existingSplit.pivot) : edit.pivot
  const pivotScale = meanGroundScale(plane, pivotPlane)
  const pivotGeo = plane.toGeo(pivotPlane)
  const splits: PrintSplitV10[] = existingSplit
    ? [...currentSplits]
    : [...currentSplits, { id: splitId, pivot: { lon: pivotGeo.lon, lat: pivotGeo.lat }, angle_deg: normalisePrintAngle(edit.angleDeg) }]
  const replacement: PrintPageV10[] = edit.parts.map((part) => {
    const c = centreOf(part.bounds)
    const area: PrintAreaV10 = {
      kind: 'split_sheet',
      split: splitId,
      along_page: { right_m: (c.x - pivotPlane.x) * pivotScale, down_m: (c.y - pivotPlane.y) * pivotScale },
      size: { width_m: part.bounds.width * pivotScale, height_m: part.bounds.height * pivotScale },
    }
    return { id: part.id, name: part.name, area, scale: parent.scale }
  })
  return { ...setup, splits, pages: currentPages.flatMap((p) => (p.id === parentId ? replacement : [p])) }
}

function buildBoxPage(edit: Extract<PrintSetupEdit, { kind: 'add-box' }>, plane: SessionPlane): PrintPageV10 {
  const centre = centreOf(edit.bounds)
  const scale = meanGroundScale(plane, centre)
  const geo = plane.toGeo(centre)
  return {
    id: edit.id,
    name: edit.name,
    area: {
      kind: 'box',
      centre: { lon: geo.lon, lat: geo.lat },
      size: { width_m: edit.bounds.width * scale, height_m: edit.bounds.height * scale },
      angle_deg: normalisePrintAngle(edit.angleDeg),
    },
    scale: { kind: 'fit' },
  }
}

function buildWholeDesignPage(edit: Extract<PrintSetupEdit, { kind: 'add-whole-design' }>, plane: SessionPlane): PrintPageV10 {
  const centre = centreOf(edit.fallbackBounds)
  const scale = meanGroundScale(plane, centre)
  const geo = plane.toGeo(centre)
  return {
    id: edit.id,
    name: edit.name,
    area: {
      kind: 'whole_design',
      angle_deg: normalisePrintAngle(edit.angleDeg),
      fallback: {
        centre: { lon: geo.lon, lat: geo.lat },
        size: { width_m: edit.fallbackBounds.width * scale, height_m: edit.fallbackBounds.height * scale },
      },
    },
    scale: { kind: 'fit' },
  }
}

function applySetPageScale(setup: PrintSetupV10, pageId: string, scale: PrintScaleV10): PrintSetupV10 {
  if (pageId === 'overview') return { ...setup, overview_scale: scale }
  const targetId = pageIdFromKey(pageId)
  return { ...setup, pages: (setup.pages ?? []).map((p) => (p.id === targetId ? { ...p, scale } : p)) }
}

function applySetPageFraming(
  setup: PrintSetupV10,
  pageId: string,
  orientation: PrintOrientationChoice | undefined,
  offset: PrintPoint | undefined,
): PrintSetupV10 {
  if (pageId === 'overview') {
    return { ...setup, overview_framing: mergeFraming(setup.overview_framing, orientation, offset) }
  }
  const targetId = pageIdFromKey(pageId)
  return {
    ...setup,
    pages: (setup.pages ?? []).map((p) =>
      p.id === targetId ? { ...p, framing: mergeFraming(p.framing, orientation, offset) } : p,
    ),
  }
}

function applyRemovePage(setup: PrintSetupV10, pageId: string): PrintSetupV10 {
  const targetId = pageIdFromKey(pageId)
  const pages = (setup.pages ?? []).filter((p) => p.id !== targetId)
  const referencedSplits = new Set(pages.flatMap((p) => (p.area.kind === 'split_sheet' ? [p.area.split] : [])))
  return { ...setup, splits: (setup.splits ?? []).filter((s) => referencedSplits.has(s.id)), pages }
}

/**
 * Applies one edit to `PrintSetupV10`, crossing from session plane to WGS84 only for the edited
 * page or split so untouched pages and splits remain byte-identical (`contracts §10`).
 */
export function applyPrintEdit(
  setup: PrintSetupV10,
  edit: PrintSetupEdit,
  plane: SessionPlane,
): PrintSetupV10 {
  switch (edit.kind) {
    case 'set-paper': return { ...setup, paper: edit.paper }
    case 'set-layers': return { ...setup, layers: [...edit.layers] }
    case 'set-plant-colors': return { ...setup, plant_colors: edit.plantColors }
    case 'set-north-arrow': return { ...setup, north_arrow: edit.northArrow }
    case 'set-page-angle': return applySetPageAngle(setup, edit.pageId, edit.angleDeg)
    case 'set-page-scale': return applySetPageScale(setup, edit.pageId, edit.scale)
    case 'set-page-framing': return applySetPageFraming(setup, edit.pageId, edit.orientation, edit.offset)
    case 'add-box': return { ...setup, pages: [...(setup.pages ?? []), buildBoxPage(edit, plane)] }
    case 'add-whole-design': return { ...setup, pages: [...(setup.pages ?? []), buildWholeDesignPage(edit, plane)] }
    case 'remove-page': return applyRemovePage(setup, edit.pageId)
    case 'apply-split': return applySplitEdit(setup, edit, plane)
  }
}

/** Exact scale denominator (ground length / paper length), or `null` for `fit`. */
function printScaleDenominator(scale: PrintScaleV10 | undefined): number | null {
  if (!scale || scale.kind === 'fit') return null
  if (scale.kind === 'ratio') return scale.denominator > 0 ? scale.denominator : null
  if (scale.inches > 0 && scale.feet > 0) {
    return (scale.feet * CONVERSION_CONSTANTS.inchesPerFoot) / scale.inches
  }
  return null
}

/** Exact PDF points per true ground metre for a fixed `PrintScaleV10`, or `null` for `fit`. */
export function printScalePointsPerGroundMeter(scale: PrintScaleV10 | undefined): number | null {
  const denom = printScaleDenominator(scale)
  return denom ? (1000 * MM) / denom : null
}

/** Converts a `PdfScaleSpec` from `generated/quantity-table` into its persisted `PrintScaleV10` value. */
function pdfScaleSpecToPrintScale(spec: PdfScaleSpec): PrintScaleV10 {
  if (spec.group === 'ratio') {
    return { kind: 'ratio', denominator: spec.denominator }
  }
  if (spec.group === 'us_engineering') {
    return { kind: 'customary', inches: 1, feet: spec.denominator / CONVERSION_CONSTANTS.inchesPerFoot }
  }
  // us_architectural: `denominator = 12 / inches` at 1 ft -> `inches = 12 / denominator`, `feet = 1`.
  return { kind: 'customary', inches: CONVERSION_CONSTANTS.inchesPerFoot / spec.denominator, feet: 1 }
}

/** Stable string key identifying a `PrintScaleV10` in the scale picker dropdown. */
export function printScaleKey(scale: PrintScaleV10 | undefined): string {
  if (!scale || scale.kind === 'fit') return 'fit'
  if (scale.kind === 'ratio') return `ratio:${scale.denominator}`
  return `customary:${scale.inches}:${scale.feet}`
}

export interface ScalePickerOption {
  readonly key: string
  readonly label: string
  readonly scale: PrintScaleV10
}

/** Builds the per-page scale picker options for `unitSystem` (`Fit`, ratios, and US arch/eng scales). */
export function scalePickerOptions(unitSystem: UnitSystem, locale: string, fitLabel: string): readonly ScalePickerOption[] {
  const options: ScalePickerOption[] = [{ key: 'fit', label: fitLabel, scale: { kind: 'fit' } }]
  for (const spec of pdfScalesForSystem(unitSystem)) {
    const scale = pdfScaleSpecToPrintScale(spec)
    const label = spec.label ?? `1:${formatNumber(spec.denominator, locale, { maximumFractionDigits: 0 })}`
    options.push({ key: printScaleKey(scale), label, scale })
  }
  return options
}
