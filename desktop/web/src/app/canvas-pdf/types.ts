import type { CanvasPrintSnapshot, PrintBounds, PrintPlant, PrintPoint } from '../../canvas/print'
import type { UnitSystem } from '../../utils/format'
import type { GlyphOutline, TextLine } from './text'
export type PdfPaper = 'A4' | 'Letter'
type PdfOrientation = 'auto' | 'portrait' | 'landscape'
/** Print-only plant colouring; the Design is never recoloured. */
export type PdfPlantColors = 'design' | 'grayscale' | 'black'
export const PDF_PLANT_COLORS: readonly PdfPlantColors[] = ['design', 'grayscale', 'black']
/** Key groups in print order; species without a catalog habit are `other`. */
export type PdfHabit = 'tree' | 'shrub' | 'herbaceous' | 'climber' | 'other'
export const PDF_HABITS: readonly PdfHabit[] = ['tree', 'shrub', 'herbaceous', 'climber', 'other']
export const PDF_ZOOM = { min: 1, max: 1000 } as const
export interface PdfPageView {
  readonly zoom?: number
  readonly orientation?: PdfOrientation
  /** Displacement from the fitted centre, in plan metres (independent of the layout angle). */
  readonly offset?: { readonly x: number; readonly y: number }
}
/** Print-only map angle (spec §4.12): North up draws every page at 0, As on screen at the view's bearing. */
export type PdfMapOrientation = 'north-up' | 'as-on-screen'
export const PDF_MAP_ORIENTATIONS: readonly PdfMapOrientation[] = ['north-up', 'as-on-screen']
export interface PdfPrintArea {
  readonly id: string
  readonly name: string
  /** A box in plan metres whose sides lie along the page axes whatever the layout angle (`page-frame.ts`). */
  readonly bounds: PrintBounds
  /** Split sheets: the plan point every sheet of the split turns about, so they keep tiling at any angle.
   *  Absent, the area turns about its own centre. */
  readonly pivot?: PrintPoint
  /** Add whole design: each build refits the area to the printed design at the layout angle; `bounds` is the fit it was
   *  added with, kept for when nothing is printed. */
  readonly wholeDesign?: true
}
export function pdfAreaKey(area: PdfPrintArea): string { return `area:${area.id}` }
export interface PdfSetup {
  readonly paper: PdfPaper
  readonly layers: readonly string[]
  readonly areas?: readonly PdfPrintArea[]
  readonly views?: Readonly<Record<string, PdfPageView>>
  /** Defaults to `design`. */
  readonly plantColors?: PdfPlantColors
  /** North arrow and ground scale bar on map pages; defaults to on. */
  readonly northArrow?: boolean
  /** Defaults to `north-up`. In memory only, like the rest of the setup. */
  readonly mapOrientation?: PdfMapOrientation
}
export interface PdfInput {
  readonly name: string
  readonly locale: string
  readonly unitSystem: UnitSystem
  readonly canvas: CanvasPrintSnapshot
  /** Display names by canonical name: the chosen language, else English. */
  readonly commonNames: Readonly<Record<string, string>>
  /** Canonical names whose display name is the English fallback, printed with "(en)". */
  readonly englishFallbacks?: readonly string[]
  /** Catalog habit by canonical name. */
  readonly habits?: Readonly<Record<string, PdfHabit>>
  /** The view's exact bearing at capture (`captureView().camera.bearingDeg`), the As on screen angle. */
  readonly viewBearingDeg: number
}
/** Every printed word, localized by the caller (`live.ts`). */
export interface PdfLabels {
  readonly notes: string; readonly observations: string; readonly keyAndNotes: string; readonly overview: string; readonly plants: string; readonly actualSize: string
  readonly detail: string; readonly measurementSummary: string; readonly zone: string; readonly longSide: string; readonly width: string; readonly guides: string
  readonly metres: string; readonly diameters: string; readonly outerSides: string; readonly quantity: string; readonly species: string; readonly plantKey: string
  readonly habitTree: string; readonly habitShrub: string; readonly habitHerbaceous: string; readonly habitClimber: string; readonly habitOther: string
  readonly continued: string; readonly englishFallback: string; readonly englishMark: string; readonly symbols: string; readonly north: string
  /** Localized plant symbol names by symbol id, for the page 1 symbol legend. */
  readonly symbolNames?: Readonly<Record<string, string>>
}
type PdfMatrix = readonly [number, number, number, number, number, number]
export type PdfOperation =
  | { readonly kind: 'path'; readonly d: string; readonly matrix: PdfMatrix; readonly fill: string | null; readonly stroke: string | null; readonly width: number; readonly opacity: number }
  | { readonly kind: 'text'; readonly line: TextLine; readonly x: number; readonly y: number; readonly size: number; readonly rotation: number; readonly opacity: number; readonly color?: string }
  | { readonly kind: 'clip'; readonly bounds: PrintBounds }
  | { readonly kind: 'unclip' }
export type PdfEnclosure = 'plain' | 'circle' | 'square' | 'diamond' | 'code'
export interface PdfLegendEntry {
  readonly reference?: string; readonly count?: number; readonly code?: string; readonly canonicalName: string; readonly name: string
  readonly appearances: readonly PrintPlant[]; readonly enclosures?: readonly PdfEnclosure[]
  readonly habit?: PdfHabit
  /** The name is the English fallback for a missing chosen-language name. */
  readonly englishFallback?: boolean
}
export interface PdfLink { readonly bounds: PrintBounds; readonly target: string }
export interface PdfDestination { readonly id: string; readonly bounds?: PrintBounds }
export interface PdfPageReference { readonly target: string; readonly x: number; readonly y: number; readonly size: number }
export interface PdfPage {
  readonly pageReferences?: readonly PdfPageReference[]
  readonly links?: readonly PdfLink[]
  readonly destinations?: readonly PdfDestination[]
  readonly identifiedPlants?: readonly { readonly ids: readonly string[]; readonly reference: string; readonly bounds: PrintBounds }[]
  readonly annotationIds?: readonly string[]
  readonly measurementIds?: readonly string[]
  /** Field identity is independent of the physical PDF page index. */
  readonly detailNumber?: number
  readonly number: number
  readonly width: number
  readonly height: number
  readonly kind: 'overview' | 'detail' | 'legend'
  readonly id: string
  readonly sourceId?: string
  readonly continuationIds?: readonly string[]
  readonly areaName?: string
  readonly frame: PrintBounds
  readonly ground: PrintBounds
  readonly pointsPerMeter: number
  readonly operations: readonly PdfOperation[]
  readonly legend: readonly PdfLegendEntry[]
  /** Symbol ids in the page 1 symbol legend, in printed order. */
  readonly symbols?: readonly string[]
}
export interface PdfPlan {
  /** Fitted navigation surface for adding areas; never encoded as a PDF page. */
  readonly pickerPage?: PdfPage
  readonly pages: readonly PdfPage[]
  /** The one layout angle every map page is drawn at (`page-frame.ts`). Page grounds are in its frame. */
  readonly angleDeg: number
  readonly outlines: Record<string, GlyphOutline>
  readonly blocked: 'empty' | null
}
export interface PdfLayoutCacheEntry { readonly key: string; readonly pages: readonly PdfPage[]; readonly outlines: Record<string, GlyphOutline> }
export type PdfLayoutCache = Readonly<Record<string, PdfLayoutCacheEntry>>
export interface PreparedPdf { readonly layoutCache?: PdfLayoutCache; readonly plan: PdfPlan; readonly bytes: Uint8Array | null }
