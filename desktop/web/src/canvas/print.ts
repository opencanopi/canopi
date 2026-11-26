/** Read-only, renderer-independent authored Canvas content for physical output. */
import type { GeoPoint } from '../types/design'

export interface PrintPoint { readonly x: number; readonly y: number }
export interface PrintBounds extends PrintPoint { readonly width: number; readonly height: number }
/** A plant symbol path: the body in the plant colour, cut-outs in a contrasting ink. */
export interface PrintMarkPath {
  readonly d: string
  readonly paint: 'symbol' | 'cutout'
}
export interface PrintPlant {
  readonly id: string
  readonly canonicalName: string
  readonly speciesCode?: string
  readonly position: PrintPoint
  readonly color: string
  readonly symbol: string
  readonly mark: readonly PrintMarkPath[]
  readonly smallMark?: readonly PrintMarkPath[]
  readonly pinnedName: boolean
}
export interface PrintZone {
  /** The zone's display name; null until the user names it. */
  readonly name: string | null
  readonly path: string
  readonly bounds: PrintBounds
  readonly fill: string | null
  readonly geometry:
    | { readonly kind: 'ellipse'; readonly center: PrintPoint; readonly radii: PrintPoint; readonly rotation: number }
    | { readonly kind: 'rect' | 'polygon' | 'line'; readonly points: readonly PrintPoint[] }
}
export interface CanvasPrintSnapshot {
  /** Session-plane WGS84 anchor for true ground-metre PDF measurements (contracts §20, 2.1-M520). */
  readonly planeOrigin?: GeoPoint
  readonly layers: readonly { readonly name: string; readonly visible: boolean; readonly opacity: number }[]
  readonly plants: readonly PrintPlant[]
  readonly zones: readonly PrintZone[]
  readonly annotations: readonly {
    readonly id: string
    readonly position: PrintPoint
    readonly text: string
    readonly fontSize: number
    readonly rotation: number
  }[]
  readonly measurements: readonly { readonly id: string; readonly start: PrintPoint; readonly end: PrintPoint }[]
}
