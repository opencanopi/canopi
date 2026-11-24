// canvas/point-editor/anchors.ts
//
// The pure reducer over a path's points (plan §4 "2.0 plant along a path", A15; spec §1.11): add, move, insert after,
// remove (never below §3.2's minimum: 2 points on an open path, 3 on a loop), sharp or smooth, close. A draft being drawn
// also keeps the states its step-backs took away (A17): Esc, Backspace and Ctrl+Z each step back once, removing the last
// point (a closed loop first opens again), and Ctrl+Shift+Z restores the last state taken; any other edit forgets them.
// Every function returns a new path or draft and never changes its argument. Pure: types only (P54).

import type { PathPoint, PathPoints } from '../plant-path/curve'
import type { WorldPoint } from '../../geo/view/types'

/** The fewest points a path keeps: 3 on a loop, 2 on an open path. */
function minimumPoints(path: PathPoints): number {
  return path.closed ? 3 : 2
}

/** A new last point (a loop takes none). */
export function addPoint(path: PathPoints, position: WorldPoint, sharp: boolean): PathPoints {
  if (path.closed) return path
  return { points: [...path.points, { position, sharp }], closed: false }
}

export function movePoint(path: PathPoints, index: number, position: WorldPoint): PathPoints {
  return withPoint(path, index, (point) => ({ ...point, position }))
}

/** A smooth point after point `index`, on the segment to the next (the closing one on a loop's last point). */
export function insertAfter(path: PathPoints, index: number, position: WorldPoint): PathPoints {
  const count = path.points.length
  if (index < 0 || index >= count || (!path.closed && index === count - 1)) return path
  const points = [...path.points]
  points.splice(index + 1, 0, { position, sharp: false })
  return { points, closed: path.closed }
}

/** Without point `index`; null when that would leave fewer than the minimum. */
export function removePoint(path: PathPoints, index: number): PathPoints | null {
  if (index < 0 || index >= path.points.length || path.points.length <= minimumPoints(path)) return null
  return { points: path.points.filter((_, at) => at !== index), closed: path.closed }
}

export function setSharp(path: PathPoints, index: number, sharp: boolean): PathPoints {
  return withPoint(path, index, (point) => (point.sharp === sharp ? point : { ...point, sharp }))
}

/** The path closed into a loop; null with fewer than 3 points. */
export function closePath(path: PathPoints): PathPoints | null {
  if (path.points.length < 3) return null
  return path.closed ? path : { points: path.points, closed: true }
}

function withPoint(path: PathPoints, index: number, change: (point: PathPoint) => PathPoint): PathPoints {
  const point = path.points[index]
  if (!point) return path
  const next = change(point)
  if (next === point) return path
  const points = [...path.points]
  points[index] = next
  return { points, closed: path.closed }
}

// ── A draft's history ──────────────────────────────────────────────────────────────────────────────────────────────

/** A path being drawn and the states its step-backs took away, the latest last. */
export interface PathDraft {
  readonly path: PathPoints
  readonly redo: readonly PathPoints[]
}

/** A draft of one point. */
export function startDraft(first: PathPoint): PathDraft {
  return { path: { points: [first], closed: false }, redo: [] }
}

/** The draft after an edit: the step-backs' states are forgotten. Unchanged when the edit changed nothing. */
export function editDraft(draft: PathDraft, path: PathPoints): PathDraft {
  return path === draft.path ? draft : { path, redo: [] }
}

/** One step back: a loop opens again, else the last point goes; null when an open path has `keep` points or fewer. */
export function stepBack(draft: PathDraft, keep: number): PathDraft | null {
  const { path } = draft
  if (!path.closed && path.points.length <= keep) return null
  const back = path.closed ? { points: path.points, closed: false } : { points: path.points.slice(0, -1), closed: false }
  return { path: back, redo: [...draft.redo, path] }
}

/** The state the last step back took away; null with none. */
export function stepForward(draft: PathDraft): PathDraft | null {
  const restored = draft.redo[draft.redo.length - 1]
  if (!restored) return null
  return { path: restored, redo: draft.redo.slice(0, -1) }
}
