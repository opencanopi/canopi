// canvas/plant-path/curve.ts
//
// The curve a row of plants follows (plan §4 "2.0 plant along a path", A3; spec §1.11): a smooth curve through every
// point of a path, flattened to a polyline with its cumulative lengths. Each run of points between sharp points is a
// centripetal Catmull-Rom spline (alpha 0.5, knot intervals the square root of the chord), whose ends take a phantom
// neighbour reflected through them; a sharp point breaks the curve, so a segment between two sharp points (or a path's
// open ends) is straight. A curve segment is sampled 64 times, about 1.5 mm off the curve in 60 m. Points within 1e-6 m
// of the one before collapse into it. Only +, -, *, / and Math.sqrt touch the coordinates, all correctly rounded in every
// engine, so V8 and JavaScriptCore flatten a path to the same bits. Pure: it imports only types (P54).

import type { WorldPoint } from '../../geo/view/types'

/** One point of a path: where it is, and whether the curve breaks there. */
export interface PathPoint {
  readonly position: WorldPoint
  readonly sharp: boolean
}

/** A row's or a zone's points in order; a closed path returns from its last point to its first. */
export interface PathPoints {
  readonly points: readonly PathPoint[]
  readonly closed: boolean
}

/** A path as a polyline: `vertices[i]` lies `lengths[i]` metres along it. */
export interface FlatPath {
  readonly vertices: readonly WorldPoint[]
  readonly lengths: readonly number[]
  /** For segment i of the path (point i to the next, the closing one last on a loop): its first vertex. */
  readonly segmentStarts: readonly number[]
  /** Whether the path is a loop once its coincident points collapsed (3 points at least). */
  readonly closed: boolean
}

/** Samples per curve segment. */
const SAMPLES_PER_SEGMENT = 64
/** Points this close (metres, on both axes) are one point. */
const COLLAPSE_M = 1e-6

/** The path as a polyline through every point, its curve flattened. */
export function flattenPath(path: PathPoints): FlatPath {
  const { unique, map } = collapse(path)
  const closed = path.closed && unique.length >= 3
  const segments = closed ? unique.length : unique.length - 1
  const vertices: WorldPoint[] = unique.length > 0 ? [unique[0]!.position] : []
  // The vertex of each collapsed point, then the loop's end (its first point again).
  const uniqueVertex: number[] = [0]
  for (let index = 0; index < segments; index += 1) {
    appendSegment(vertices, unique, index, closed)
    uniqueVertex.push(vertices.length - 1)
  }
  const loopEnd = vertices.length - 1
  const count = path.closed ? path.points.length : path.points.length - 1
  const segmentStarts: number[] = []
  for (let index = 0; index <= count && path.points.length > 0; index += 1) {
    const point = map[index % path.points.length]!
    // A loop's points that collapsed into its first point end it, as does the closing segment's end.
    segmentStarts.push(closed && index > 0 && point === 0 ? loopEnd : uniqueVertex[point]!)
  }
  return { vertices, lengths: cumulativeLengths(vertices), segmentStarts, closed }
}

/** The point `distance` metres along a flattened path, clamped to its ends. */
export function pointAlong(flat: FlatPath, distance: number): WorldPoint {
  const { vertices, lengths } = flat
  const total = lengths[lengths.length - 1] ?? 0
  if (vertices.length === 0) return { x: 0, y: 0 }
  if (distance <= 0) return vertices[0]!
  if (distance >= total) return vertices[vertices.length - 1]!
  return lerpAt(vertices, lengths, segmentAt(lengths, distance), distance)
}

/** The direction of a flattened path `distance` metres along it, clamped to its ends: its segment's there, not
 *  normalised (zero on a path of fewer than 2 vertices). */
export function tangentAlong(flat: FlatPath, distance: number): WorldPoint {
  const { vertices, lengths } = flat
  if (vertices.length < 2) return { x: 0, y: 0 }
  const total = lengths[lengths.length - 1]!
  const index = segmentAt(lengths, Math.min(Math.max(distance, 0), total))
  const a = vertices[index]!
  const b = vertices[index + 1]!
  return { x: b.x - a.x, y: b.y - a.y }
}

/** The segment `distance` metres along a polyline of 2 vertices or more lies on: the last vertex at or before it (the
 *  last segment at the far end). */
function segmentAt(lengths: readonly number[], distance: number): number {
  let low = 0
  let high = lengths.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (lengths[middle]! <= distance) low = middle
    else high = middle
  }
  return low
}

/** The point of each segment halfway along it on the curve: where its midpoint dot sits (point-editor/layout.ts). */
export function segmentMidpoints(path: PathPoints): WorldPoint[] {
  const flat = flattenPath(path)
  const count = path.closed ? path.points.length : path.points.length - 1
  const midpoints: WorldPoint[] = []
  for (let index = 0; index < count; index += 1) {
    const from = flat.lengths[flat.segmentStarts[index]!] ?? 0
    const to = flat.lengths[flat.segmentStarts[index + 1]!] ?? from
    midpoints.push(pointAlong(flat, (from + to) / 2))
  }
  return midpoints
}

/** The vertex `index` of the polyline moved `distance - lengths[index]` metres towards the next one. */
export function lerpAt(vertices: readonly WorldPoint[], lengths: readonly number[], index: number, distance: number): WorldPoint {
  const a = vertices[index]!
  const b = vertices[index + 1] ?? a
  const span = lengths[index + 1]! - lengths[index]!
  if (!(span > 0)) return a
  const t = (distance - lengths[index]!) / span
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** The path's points with coincident neighbours merged, and the merged point each given point became. */
function collapse(path: PathPoints): { readonly unique: PathPoint[]; readonly map: number[] } {
  const unique: PathPoint[] = []
  const map: number[] = []
  for (const point of path.points) {
    const last = unique[unique.length - 1]
    if (last && same(last.position, point.position)) {
      // The merged point keeps a sharp break if either had one.
      if (point.sharp && !last.sharp) unique[unique.length - 1] = { position: last.position, sharp: true }
      map.push(unique.length - 1)
      continue
    }
    unique.push(point)
    map.push(unique.length - 1)
  }
  if (path.closed && unique.length > 1 && same(unique[0]!.position, unique[unique.length - 1]!.position)) {
    const merged = unique.length - 1
    unique.pop()
    for (let index = 0; index < map.length; index += 1) if (map[index] === merged) map[index] = 0
  }
  return { unique, map }
}

/** Appends segment `index` (point `index` to the next) without its first vertex, which is already there. */
function appendSegment(vertices: WorldPoint[], points: readonly PathPoint[], index: number, closed: boolean): void {
  const count = points.length
  const from = points[index]!
  const to = points[(index + 1) % count]!
  const p1 = from.position
  const p2 = to.position
  const before = breaksBefore(points, index, closed) ? null : points[(index - 1 + count) % count]!.position
  const after = breaksAfter(points, index + 1, closed) ? null : points[(index + 2) % count]!.position
  if (!before && !after) {
    vertices.push(p2)
    return
  }
  const p0 = before ?? reflect(p2, p1)
  const p3 = after ?? reflect(p1, p2)
  const t1 = knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  for (let sample = 1; sample < SAMPLES_PER_SEGMENT; sample += 1) {
    vertices.push(catmullRom(p0, p1, p2, p3, t1, t2, t3, t1 + ((t2 - t1) * sample) / SAMPLES_PER_SEGMENT))
  }
  vertices.push(p2)
}

/** The curve breaks at point `index` going into its segment: a sharp point, or an open path's first point. */
function breaksBefore(points: readonly PathPoint[], index: number, closed: boolean): boolean {
  return points[index]!.sharp || (!closed && index === 0)
}

/** The curve breaks at point `index` (mod the count on a loop) leaving its segment: sharp, or an open path's last. */
function breaksAfter(points: readonly PathPoint[], index: number, closed: boolean): boolean {
  const count = points.length
  return points[index % count]!.sharp || (!closed && index === count - 1)
}

/** The phantom neighbour of `through`, mirrored from `away` (the curve leaves an end straight at it). */
function reflect(away: WorldPoint, through: WorldPoint): WorldPoint {
  return { x: through.x + (through.x - away.x), y: through.y + (through.y - away.y) }
}

/** The centripetal knot interval: the square root of the chord length. */
function knot(a: WorldPoint, b: WorldPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(Math.sqrt(dx * dx + dy * dy))
}

/** Barry and Goldman's pyramid for the Catmull-Rom point at `t` in [t1, t2], with t0 = 0. */
function catmullRom(
  p0: WorldPoint, p1: WorldPoint, p2: WorldPoint, p3: WorldPoint,
  t1: number, t2: number, t3: number, t: number,
): WorldPoint {
  const a1 = mix(p0, p1, (t1 - t) / t1, t / t1)
  const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1))
  const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2))
  const b1 = mix(a1, a2, (t2 - t) / t2, t / t2)
  const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1))
  return mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1))
}

function mix(a: WorldPoint, b: WorldPoint, wa: number, wb: number): WorldPoint {
  return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb }
}

function cumulativeLengths(vertices: readonly WorldPoint[]): number[] {
  const lengths: number[] = []
  let total = 0
  for (let index = 0; index < vertices.length; index += 1) {
    if (index > 0) {
      const dx = vertices[index]!.x - vertices[index - 1]!.x
      const dy = vertices[index]!.y - vertices[index - 1]!.y
      total += Math.sqrt(dx * dx + dy * dy)
    }
    lengths.push(total)
  }
  return lengths
}

function same(a: WorldPoint, b: WorldPoint): boolean {
  return Math.abs(a.x - b.x) <= COLLAPSE_M && Math.abs(a.y - b.y) <= COLLAPSE_M
}
