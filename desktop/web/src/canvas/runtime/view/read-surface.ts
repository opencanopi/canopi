// canvas/runtime/view/read-surface.ts  (types; the app-facing side, exposed on the canvas session)

import type { ReadonlySignal } from '@preact/signals'
import type { GeoPoint } from '../../../generated/contracts'
import type {
  DesignPinExtent,
  SceneBounds,
  ScreenInsets,
  ScreenPoint,
  TemporaryBoundsFocusOptions,
  ViewCamera,
  ViewScreen,
} from './types'

/** Returned by ViewCommandSurface.beginRotation (the compass) and ViewNavigation.beginRotation; here so app code can name it (P10). */
export interface RotationSession {
  /**
   * totalDeltaDeg: rotation since begin. With step, the published bearing is
   * roundToStep(start + totalDeltaDeg, 15): absolute multiples of 15°, not start + 15k.
   * anchorPx: the turn's pivot from now on, when it moves with the gesture (a two-finger twist turns about its moving
   * centroid, A5); the begin pivot otherwise.
   */
  update(totalDeltaDeg: number, options: { readonly step: boolean; readonly anchorPx?: ScreenPoint }): void
  /** snapBearing: within 7° of north jumps to 0 about the session's last pivot (U34); else keeps. */
  end(): void
  /** Restores the full starting ViewCamera with animation 'none' (Esc during a rotate). */
  cancel(): void
}

/** What app code and components may observe. Each signal changes only when its own value changes. */
export interface ViewReadSurface {
  readonly mode: ReadonlySignal<'site' | 'overview'>
  readonly zoomBand: ReadonlySignal<number>              // floor(log(pixelsPerMetre) / log(1.25)): LOD key
  readonly bearingDeg: ReadonlySignal<number>            // rounded to 0.1° (compass needle); the PDF reads captureView's exact bearing
  readonly northUp: ReadonlySignal<boolean>              // the compass's north-up state; never hides it
  readonly groundMetresPerPixel: ReadonlySignal<number>  // at the screen centre, 3 significant figures (scale bar, ratio)
  readonly zoomLimit: ReadonlySignal<'min' | 'max' | null>
  /** Overview only: the Design origin's screen point, rounded to whole pixels, or null in site mode or within 24 px of an edge.
   *  The one read that changes during a pan (the overview pin must track the Design); it updates per frame only in overview,
   *  where nothing else re-renders, and is the named exception to the coarse-signal rule (P10). */
  readonly designPin: ReadonlySignal<ScreenPoint | null>
  /** The camera after 150 ms without change (the settled frame's camera): last view, map contributions, and the PDF's test
   *  for a view still turning (a flight, or a turn not yet settled: its bearing against captureView's). Never what a user-triggered capture records (captureView). */
  readonly settledCamera: ReadonlySignal<ViewCamera>
  /** The settled frame's revision: changes once per settle, whatever settled (camera, screen, insets, re-origin). The labels count. */
  readonly settledRevision: ReadonlySignal<number>
  /**
   * Saved-view capture, saved-view snapshot, PDF capture, story restore point: the LIVE frame's camera (not the settled
   * one) and the screen it was seen on, so a capture during a pan, zoom or flight records what is on screen now. The last
   * view (settings) uses `settledCamera`.
   */
  captureView(): { readonly camera: ViewCamera; readonly screen: ViewScreen }
}

interface ReturnToDesignOptions {
  /** Where the fallback (an empty or too-large Design) zooms in: the plane origin (default) or the view centre. */
  readonly around?: 'origin' | 'view-centre'
}

/** What app code and components may command. Implemented by ViewNavigation; nothing else is exposed. */
export interface ViewCommandSurface {
  zoomIn(): void
  zoomOut(): void
  zoomBy(factor: number): void                         // the scale menu and plant coverage
  zoomToFit(): void                                    // Fit to Design, Home
  zoomToSelection(): void                              // Shift+2
  /** Return to Design, the Design pin, and a tool picked or a plant dropped in overview: the fit when it reaches site
   *  scale, else a usable scale with the plane origin centred, or (`around: 'view-centre'`) about the view centre. */
  returnToDesign(options?: ReturnToDesignOptions): void
  focusTemporaryBounds(bounds: SceneBounds, options: TemporaryBoundsFocusOptions): boolean          // kept: LiDAR's Fit to data; bookmarks the view before the first unreturned focus
  /** The plant finder's Zoom to them: a temporary focus's framing that sets no bookmark (false when nothing could be framed). */
  frameBounds(bounds: SceneBounds, options: TemporaryBoundsFocusOptions): boolean
  returnFromTemporaryFocus(): boolean                  // kept
  setFramingInsets(insets: ScreenInsets): void         // kept: the visible-map-area seam
  /** The overview's Design pin registers its box about its point once laid out, and null once gone, so a tap on it fits the
   *  Design and a hover shows its cursor and tooltip through the map's input (view/design-pin.ts). */
  setDesignPinExtent(extent: DesignPinExtent | null): void
  resetNorth(): void
  rotateBy(direction: 1 | -1): void                    // next absolute 15° multiple in that direction
  beginRotation(pivot: 'centre'): RotationSession      // compass drag
  showCamera(camera: ViewCamera, options?: { readonly motion?: 'fly' | 'jump' }): void   // saved views, stories
  /** Place search. Returns false when the place cannot be shown. */
  showPlace(place: GeoPoint, zoom: number, options?: { readonly motion?: 'fly' | 'jump' }): boolean
}
