// canvas/plant-path/spacing.ts
//
// Where a row's plants go along its path (plan §4 "2.0 plant along a path", A3; spec §1.11). The picked plant is the
// path's first point and is never placed again: the row adds the others. "Every N m" on an open row adds a plant at each
// whole interval along the curve, the source excluded as before (U57); on a loop the interval rounds to the nearest equal
// gap (round(length / interval) gaps, at least 3), so the loop closes with no short gap (U58 Q6). "N plants" counts every
// plant of the row, the picked one included: an open row puts N plants end to end, a loop N plants with N equal gaps
// (U58 Q5). An open 2-point row in "every N m" is the straight row, computed by plant-spacing-sequence.ts unchanged, so
// its positions stay bit-identical to before (its tests are the oracle). `positions(limit)` caps the plants made, never
// the count, as the preview's 250 discs do. Pure: it imports only the curve, the straight-row maths and types (P54).

import { computePlantSpacingCount, computePlantSpacingPositions } from '../plant-spacing-sequence'
import type { WorldPoint } from '../../geo/view/types'
import { flattenPath, lerpAt, type FlatPath, type PathPoints } from './curve'

/** How a row is spaced: a plant every `metres`, or `count` plants in all. */
export type PathSpacing =
  | { readonly kind: 'interval'; readonly metres: number }
  | { readonly kind: 'count'; readonly count: number }

export interface PathPlanting {
  /** The plants the row adds beside the picked one. */
  readonly count: number
  /** The gap between neighbouring plants: the interval, a loop's rounded gap or an even count's gap (0 with none). */
  readonly effectiveSpacingM: number
  /** The path's length in metres. */
  readonly lengthM: number
  /** The added plants in path order, at most `limit` of them. */
  positions(limit?: number): WorldPoint[]
}

/** A plant this close to the path's end sits exactly on it (plant-spacing-sequence.ts's rule). */
const EXACT_END_M = 0.000001
/** The fewest gaps a loop is planted with. */
const MIN_LOOP_GAPS = 3

const NOTHING: PathPlanting = Object.freeze({ count: 0, effectiveSpacingM: 0, lengthM: 0, positions: () => [] })

/** The row along `path` from its first point, spaced as `spacing` says. */
export function plantAlongPath(path: PathPoints, spacing: PathSpacing): PathPlanting {
  const [first, second] = path.points
  if (!first) return NOTHING
  if (!path.closed && path.points.length === 2 && second && spacing.kind === 'interval') {
    return straightRow(first.position, second.position, spacing.metres)
  }
  const flat = flattenPath(path)
  const lengthM = flat.lengths[flat.lengths.length - 1] ?? 0
  const gaps = gapsOf(flat, lengthM, spacing)
  if (gaps === null) return { ...NOTHING, lengthM }
  const { count, gap } = gaps
  return {
    count,
    effectiveSpacingM: gap,
    lengthM,
    positions: (limit) => positionsAlong(flat, gap, count, flat.closed ? null : flat.vertices[flat.vertices.length - 1]!, limit),
  }
}

/** The straight row: today's maths, unchanged. */
function straightRow(start: WorldPoint, end: WorldPoint, metres: number): PathPlanting {
  const count = computePlantSpacingCount(start, end, metres)
  return {
    count,
    effectiveSpacingM: count > 0 ? metres : 0,
    lengthM: Math.hypot(end.x - start.x, end.y - start.y),
    positions: (limit) => computePlantSpacingPositions(start, end, metres, limit === undefined ? {} : { limit }),
  }
}

/** How many plants the row adds and the gap between them; null when it adds none. */
function gapsOf(flat: FlatPath, lengthM: number, spacing: PathSpacing): { readonly count: number; readonly gap: number } | null {
  if (!(lengthM > EXACT_END_M)) return null
  if (spacing.kind === 'interval') {
    const metres = spacing.metres
    if (!Number.isFinite(metres) || metres <= 0) return null
    if (flat.closed) {
      const gaps = Math.max(MIN_LOOP_GAPS, Math.round(lengthM / metres))
      return { count: gaps - 1, gap: lengthM / gaps }
    }
    const count = Math.floor((lengthM + EXACT_END_M) / metres)
    return count > 0 ? { count, gap: metres } : null
  }
  const plants = spacing.count
  if (!Number.isInteger(plants) || plants < 2) return null
  // A loop's N plants leave N gaps; an open row's leave N - 1, its last plant on the path's end.
  return { count: plants - 1, gap: lengthM / (flat.closed ? plants : plants - 1) }
}

/** `count` plants `gap` apart from the start, the last on `end` when it lands within the tolerance of it. */
function positionsAlong(flat: FlatPath, gap: number, count: number, end: WorldPoint | null, limit: number | undefined): WorldPoint[] {
  const made = limit === undefined ? count : Number.isFinite(limit) && limit > 0 ? Math.min(count, Math.floor(limit)) : 0
  const { vertices, lengths } = flat
  const total = lengths[lengths.length - 1]!
  const positions: WorldPoint[] = []
  let segment = 0
  for (let index = 1; index <= made; index += 1) {
    const distance = gap * index
    if (end && index === count && Math.abs(total - distance) <= EXACT_END_M) {
      positions.push({ ...end })
      continue
    }
    while (segment < lengths.length - 2 && lengths[segment + 1]! <= distance) segment += 1
    positions.push(lerpAt(vertices, lengths, segment, distance))
  }
  return positions
}
