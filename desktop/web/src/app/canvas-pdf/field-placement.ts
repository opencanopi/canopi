import type { PrintBounds as Bounds, PrintPoint as Point } from '../../canvas/print'
import type { PdfTextEngine, TextLine } from './text'
import { MM } from './print-style'
import { PaperIndex, contains, crossing, distance, distanceToSegment, edge, fits, hits, inflate, overlaps, segmentBounds, type Segment } from './field-geometry'

export interface FieldLabel {
  opacity?: number
  origin?: Point
  rotation?: number
  bounds: Bounds
  lines: readonly TextLine[]
  size: number
  leading: number
  baseline: number
  inset: number
  color: string
  route: Segment[]
  target: string
  ids: readonly string[]
  repeated?: boolean
  boxed?: boolean
}
export interface FieldMeasure { lines: readonly TextLine[]; width: number; height: number; size: number; leading: number; baseline: number; inset: number }

/** All geometry inside this module is in physical millimetres. */
export class FieldSpace {
  readonly labels: FieldLabel[] = []
  readonly marks = new Map<string, Bounds>()
  private markerBounds = new Set<Bounds>()
  private markerIds = new Map<Bounds, string>()
  readonly segments: Segment[] = []
  private rectangles = new PaperIndex<Bounds>()
  private paths = new PaperIndex<Segment>()
  private crossingPaths = new Set<Segment>()
  /** Each guide code placed `beside` its guide: its centre and its distance to that guide (Q16). */
  private besideCodes: { centre: Point; reach: number }[] = []
  constructor(readonly frame: Bounds, readonly text: PdfTextEngine) {}

  reserve(bounds: Bounds): void { this.rectangles.add(bounds, bounds) }
  mark(id: string, bounds: Bounds): void { this.marks.set(id, bounds); this.markerBounds.add(bounds); this.markerIds.set(bounds, id); this.reserve(bounds) }
  addSegments(segments: readonly Segment[], crossingObstacle = false): void {
    for (const s of segments) { this.segments.push(s); this.paths.add(s, inflate(segmentBounds(s), .1)); if (crossingObstacle) this.crossingPaths.add(s) }
  }
  measure(value: string, size = 9.5, width = Infinity, strong = false): FieldMeasure {
    const lines = Number.isFinite(width) ? this.text.wrap(value, size, width * MM, strong) : [this.text.line(value, size, strong)]
    const leading = size * 1.1 / MM
    const left = Math.min(0, ...lines.map(l => (l.ink?.x ?? 0) / MM))
    const top = Math.min(-size * .7 / MM, ...lines.map((l, i) => (l.ink?.y ?? 0) / MM + i * leading))
    const bottom = Math.max(0, ...lines.map((l, i) => ((l.ink?.y ?? 0) + (l.ink?.height ?? 0)) / MM + i * leading))
    return { lines, width: Math.max(0, ...lines.map(l => Math.max(l.width, (l.ink?.x ?? 0) + (l.ink?.width ?? 0)))) / MM - left + .8,
      height: bottom - top + .4, size, leading, baseline: .2 - top, inset: .4 - left }
  }
  clear(bounds: Bounds, ignored?: FieldLabel): boolean {
    if (!fits(this.frame, inflate(bounds, .2))) return false
    if (this.rectangles.query(bounds).some(b => b !== ignored?.bounds && overlaps(bounds, b))) return false
    return !this.paths.query(bounds).some(s => !ignored?.route.includes(s) && hits(s, inflate(bounds, .2)))
  }
  pathClear(route: readonly Segment[], ids: readonly string[], ignored?: FieldLabel): boolean {
    const exempt = new Set(ids.map(id => this.marks.get(id)))
    for (const s of route) {
      if (!contains(this.frame, s.a) || !contains(this.frame, s.b)) return false
      if (this.rectangles.query(segmentBounds(s)).some(r => r !== ignored?.bounds && !exempt.has(r)
        && !(this.markerBounds.has(r) && contains(inflate(r, .1), route[0]!.a)) && hits(s, inflate(r, .1)))) return false
    }
    return true
  }
  crossings(route: readonly Segment[], ignored?: FieldLabel): number {
    return route.reduce((n, s) => n + this.paths.query(segmentBounds(s)).filter(p => this.crossingPaths.has(p) && !ignored?.route.includes(p) && crossing(s, p)).length, 0)
  }
  place(measured: FieldMeasure, anchors: readonly Point[], ids: readonly string[], target: string,
    options: { association?: boolean; associationPeers?: readonly string[]; avoid?: readonly Segment[]; color?: string; boxed?: boolean; near?: boolean; name?: boolean; note?: boolean; ignored?: FieldLabel; preferred?: number; axis?: 'x' | 'y'; outside?: Bounds } = {}): FieldLabel | null {
    const { width, height } = measured
    const peers = options.associationPeers ? new Set(options.associationPeers) : undefined
    let best: FieldLabel | null = null, score = Infinity
    const extent = options.axis === 'y' ? height : width
    const offsets = options.association ? [0, ...[1.2, 2, 3, 4].flatMap(gap => [-extent / 2 - gap, extent / 2 + gap])] : options.name ? [2, 4, 7, 10, 14].flatMap(gap => [-extent / 2 - gap, extent / 2 + gap]) : options.near ? [-4, 4, -6, 6, -8, 8, -11, 11] : [-4, 4, -5, 5, -6, 6, -8, 8, -10, 10, -13, 13, -16, 16, -20, 20, -24, 24, -28, 28, -34, 34, -40, 40]
    const crossExtent = options.axis === 'y' ? width : height
    const vertical = options.association ? [0, ...[1.2, 2, 3].flatMap(gap => [-crossExtent / 2 - gap, crossExtent / 2 + gap])] : options.name ? [0, -4, 4, -8, 8, -12, 12] : options.near ? [0, -2, 2, -4, 4, -7, 7] : options.note ? [0, -4, 4, -8, 8, -12, 12, -16, 16, -20, 20, -25, 25, -30, 30]
      : [0, -.75, .75, -1.5, 1.5, -2.25, 2.25, -3, 3, -4, 4, -5, 5, -7.5, 7.5, -12, 12, -18, 18]
    for (const anchor of anchors) {
      for (const dx of offsets) {
        for (const dy of vertical) {
          const baseCost = Math.abs(dx) + Math.abs(dy) * 3 + (options.preferred && Math.sign(dx) !== options.preferred ? 6 : 0)
          if (baseCost >= score) continue
          const bounds = { x: anchor.x + (options.axis === 'y' ? dy : dx) - width / 2, y: anchor.y + (options.axis === 'y' ? dx : dy) - height / 2, width, height }
          if (options.outside && overlaps(bounds, options.outside)) continue
          if (!this.clear(bounds, options.ignored) || options.avoid?.some(s => hits(s, inflate(bounds, .2)))) continue
          const end = edge(bounds, anchor)
          if (options.association) {
            const own = new Set(ids), reach = distance(end, anchor)
            if (this.rectangles.query(inflate(bounds, reach + .1)).some(mark => {
              const id = this.markerIds.get(mark)
              if (!id) return false
              const center = { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 }
              return !own.has(id) && (!peers || peers.has(id)) && distance(edge(bounds, center), center) < reach - .01
            })) continue
          }
          const routes: Segment[][] = [[{ a: anchor, b: end }]]
          const straightClear = this.pathClear(routes[0]!, ids, options.ignored)
          if (options.association && !straightClear) continue
          if (!options.association && (!straightClear || this.crossings(routes[0]!, options.ignored))) {
            for (const [x, y] of [[0, -2], [0, 2], [0, -3], [0, 3], [0, -4], [0, 4], [-2, 0], [2, 0], [-3, 0], [3, 0]]) {
              const elbow = { x: anchor.x + (options.axis === 'y' ? y! : x!), y: anchor.y + (options.axis === 'y' ? x! : y!) }
              routes.push([{ a: anchor, b: elbow }, { a: elbow, b: end }])
            }
          }
          for (const route of routes) {
            const cost = baseCost + route.reduce((n, s) => n + distance(s.a, s.b), 0) + (route.length > 1 ? 2 : 0)
            if (cost >= score || !this.pathClear(route, ids, options.ignored)) continue
            const total = cost + this.crossings(route, options.ignored) * 25
            if (total >= score) continue
            score = total
            best = { ...measured, bounds, route, ids, target, color: options.color ?? '#24211c', boxed: options.boxed }
          }
        }
      }
    }
    return best
  }
  /**
   * A box beside segment `s` (the `fieldDimensions` frame): offset along its normal, positioned along it, its near edge
   * at most 2.5 mm from the segment whatever its width, and its centre nearer `s` than any of the `others` (the page's
   * other guides), so it never names the next guide; null when no spot is clear, so the caller keeps the code in the key.
   */
  beside(measured: FieldMeasure, s: Segment, others: readonly Segment[]): Bounds | null {
    const length = distance(s.a, s.b)
    if (length < 1e-8) return null
    const u = { x: (s.b.x - s.a.x) / length, y: (s.b.y - s.a.y) / length }, n = { x: -u.y, y: u.x }
    const across = (Math.abs(n.x) * measured.width + Math.abs(n.y) * measured.height) / 2
    for (const gap of [.8, 1.5, 2.5]) {
      for (const side of [-1, 1]) {
        for (const t of [.5, .4, .6, .3, .7, .2, .8, .1, .9, 0, 1]) {
          const offset = side * (across + gap)
          const centre = { x: s.a.x + u.x * t * length + n.x * offset, y: s.a.y + u.y * t * length + n.y * offset }
          const bounds = { x: centre.x - measured.width / 2, y: centre.y - measured.height / 2, width: measured.width, height: measured.height }
          const own = distanceToSegment(centre, s)
          if (this.clear(bounds) && others.every(o => own < distanceToSegment(centre, o))) return bounds
        }
      }
    }
    return null
  }
  /** `guide`: the label is a code placed `beside` that guide, which later ink must not come nearer (`keepsCodesBeside`). */
  admit(label: FieldLabel, guide?: Segment): void {
    this.labels.push(label); this.reserve(label.bounds); this.addSegments(label.route, true)
    if (!guide) return
    const centre = { x: label.bounds.x + label.bounds.width / 2, y: label.bounds.y + label.bounds.height / 2 }
    this.besideCodes.push({ centre, reach: distanceToSegment(centre, guide) })
  }
  /** Whether ink drawn after the guide codes leaves each code nearer its own guide than `segments`, so a dimension
   *  placed later never takes a code's reading (Q16). */
  keepsCodesBeside(segments: readonly Segment[]): boolean {
    return this.besideCodes.every(code => segments.every(s => distanceToSegment(code.centre, s) > code.reach))
  }
}
