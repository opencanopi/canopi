import type { PlantSymbolId } from './scene/plant-symbols'

/** Native path commands, normalized to the Placed Plant radius (the symbol box is -1..1). */
type PlantSymbolCommand =
  | readonly ['M' | 'L', number, number]
  | readonly ['C', number, number, number, number, number, number]
/** One closed contour; the close back to the first point is implicit. */
export type PlantSymbolContour = readonly PlantSymbolCommand[]

/**
 * A single-colour symbol. Every contour winds the same way, so one nonzero fill
 * of `body` is the union of its parts and a stroke under that fill is a halo
 * around the whole silhouette. `cutouts` are painted over the body in the
 * cut-out colour: the outline colour on the map, a contrasting ink in print and
 * true holes in UI glyphs. They are never subtracted geometrically.
 */
export interface PlantSymbolArt {
  readonly body: readonly PlantSymbolContour[]
  readonly cutouts: readonly PlantSymbolContour[]
}

/** Compact drops detail that falls below a pixel at working canvas sizes. */
export interface PlantSymbolRecipe {
  readonly compact: PlantSymbolArt
  readonly detailed: PlantSymbolArt
}

export type PlantSymbolFamily = 'form' | 'gives' | 'does' | 'abstract'

const PLANT_SYMBOL_DETAIL_DIAMETER_PX = 16
export const ROUND_PLANT_SYMBOL_RADIUS = 0.8

// ---------------------------------------------------------------------------
// Authoring kit. The approved artwork is drawn on a 24-unit grid: plant forms
// stand on the ground line y = 22, produce and role icons are centred objects.
// Every part is a filled shape (no strokes). Builders emit native M/L/C
// contours in grid units; `finish()` normalizes them. No SVG is parsed.
// ---------------------------------------------------------------------------

type Point = readonly [number, number]
type GridContour = PlantSymbolCommand[]
/** Absolute grid-unit contours, closed implicitly. */
type GridPath = readonly (readonly PlantSymbolCommand[])[]

const KAPPA = 0.5522847498307936
const RAD = Math.PI / 180

function ellipse(cx: number, cy: number, rx: number, ry: number, rotationDeg = 0): GridContour {
  const cos = Math.cos(rotationDeg * RAD)
  const sin = Math.sin(rotationDeg * RAD)
  const p = (x: number, y: number): Point => [cx + x * rx * cos - y * ry * sin, cy + x * rx * sin + y * ry * cos]
  return [
    ['M', ...p(1, 0)],
    ['C', ...p(1, KAPPA), ...p(KAPPA, 1), ...p(0, 1)],
    ['C', ...p(-KAPPA, 1), ...p(-1, KAPPA), ...p(-1, 0)],
    ['C', ...p(-1, -KAPPA), ...p(-KAPPA, -1), ...p(0, -1)],
    ['C', ...p(KAPPA, -1), ...p(1, -KAPPA), ...p(1, 0)],
  ]
}

function circle(cx: number, cy: number, r: number): GridContour {
  return ellipse(cx, cy, r, r)
}

function rect(x: number, y: number, width: number, height: number, radius = 0): GridContour {
  if (radius <= 0) return [['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height]]
  const r = Math.min(radius, width / 2, height / 2)
  const k = r * (1 - KAPPA)
  const right = x + width
  const bottom = y + height
  return [
    ['M', x + r, y], ['L', right - r, y], ['C', right - k, y, right, y + k, right, y + r],
    ['L', right, bottom - r], ['C', right, bottom - k, right - k, bottom, right - r, bottom],
    ['L', x + r, bottom], ['C', x + k, bottom, x, bottom - k, x, bottom - r],
    ['L', x, y + r], ['C', x, y + k, x + k, y, x + r, y],
  ]
}

function polygon(points: readonly Point[]): GridContour {
  return points.map(([x, y], index) => [index === 0 ? 'M' : 'L', x, y] as const)
}

function quadTo(from: Point, control: Point, to: Point): PlantSymbolCommand {
  return ['C',
    from[0] + (2 / 3) * (control[0] - from[0]), from[1] + (2 / 3) * (control[1] - from[1]),
    to[0] + (2 / 3) * (control[0] - to[0]), to[1] + (2 / 3) * (control[1] - to[1]),
    to[0], to[1]]
}

/** Pointed leaf from (x0, y0) to (x1, y1) with half-width w. */
function lens(x0: number, y0: number, x1: number, y1: number, w: number, bulge = 0.5): GridContour {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  const nx = -dy / length
  const ny = dx / length
  const ax = x0 + dx * bulge
  const ay = y0 + dy * bulge
  const start: Point = [x0, y0]
  const end: Point = [x1, y1]
  return [['M', x0, y0], quadTo(start, [ax + nx * w * 1.33, ay + ny * w * 1.33], end),
    quadTo(end, [ax - nx * w * 1.33, ay - ny * w * 1.33], start)]
}

/** Keyhole ring: one contour, so every renderer fills it the same way. */
function ring(cx: number, cy: number, rx: number, ry: number, innerRx: number, innerRy: number): GridContour {
  const outer = ellipse(cx, cy, rx, ry)
  const inner = reverseContour(ellipse(cx, cy, innerRx, innerRy))
  return [...outer, ['L', cx + innerRx, cy], ...inner.slice(1), ['L', cx + rx, cy]]
}

/** The first edge of `lens(x0, y0, x1, y1, w)` as a quadratic: start, control, end. */
function lensEdge(x0: number, y0: number, x1: number, y1: number, w: number, bulge = 0.5): readonly [Point, Point, Point] {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  return [[x0, y0], [x0 + dx * bulge - dy / length * w * 1.33, y0 + dy * bulge + dx / length * w * 1.33], [x1, y1]]
}

/**
 * The part of the band (x, y, width, height) above a quadratic edge that starts on
 * the band's right side below it and rises leftwards across it: a cut-out trimmed
 * where a shape painted over it in the artwork covers it.
 */
function bandAboveQuad(x: number, y: number, width: number, height: number, [p0, p1, p2]: readonly [Point, Point, Point]): GridContour {
  const at = (t: number): Point => [
    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
  ]
  // Smallest t in [0, 1] where the edge reaches height `level`.
  const crossing = (level: number): number => {
    const a = p0[1] - 2 * p1[1] + p2[1]
    const b = 2 * (p1[1] - p0[1])
    const c = p0[1] - level
    const roots = Math.abs(a) < 1e-9 ? [-c / b] : [1, -1].map((sign) => (-b + sign * Math.sqrt(b * b - 4 * a * c)) / (2 * a))
    return Math.min(...roots.filter((t) => t >= 0 && t <= 1))
  }
  const bottom = crossing(y + height)
  const top = crossing(y)
  const start = at(bottom)
  const derivative = (t: number): Point => [
    (1 - t) * (p1[0] - p0[0]) + t * (p2[0] - p1[0]),
    (1 - t) * (p1[1] - p0[1]) + t * (p2[1] - p1[1]),
  ]
  const slope = derivative(bottom)
  const control: Point = [start[0] + (top - bottom) * slope[0], start[1] + (top - bottom) * slope[1]]
  const right = x + width
  return [['M', right, y], ['L', right, y + height], ['L', ...start], quadTo(start, control, at(top))]
}

function qbez(p0: Point, p1: Point, p2: Point, n = 24): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n
    const a = (1 - t) ** 2
    const b = 2 * (1 - t) * t
    return [a * p0[0] + b * p1[0] + t * t * p2[0], a * p0[1] + b * p1[1] + t * t * p2[1]] as const
  })
}

function cbez(p0: Point, p1: Point, p2: Point, p3: Point, n = 24): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n
    const a = (1 - t) ** 3
    const b = 3 * (1 - t) ** 2 * t
    const c = 3 * (1 - t) * t * t
    const d = t ** 3
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]] as const
  })
}

function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, n = 20): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const angle = (fromDeg + (toDeg - fromDeg) * i / n) * RAD
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const
  })
}

/** Filled band along a polyline; `width` is a half-width, constant or a function of t in [0, 1]. */
function band(points: readonly Point[], width: number | ((t: number) => number), caps = true): GridContour[] {
  const halfWidth = typeof width === 'number' ? () => width : width
  const left: Point[] = []
  const right: Point[] = []
  const n = points.length
  points.forEach(([x, y], i) => {
    const a = points[Math.max(i - 1, 0)]!
    const b = points[Math.min(i + 1, n - 1)]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / length
    const ny = (b[0] - a[0]) / length
    const w = halfWidth(i / (n - 1))
    left.push([x + nx * w, y + ny * w])
    right.push([x - nx * w, y - ny * w])
  })
  const outline = polygon([...simplify(left), ...simplify(right).reverse()])
  if (!caps) return [outline]
  return [outline, circle(...points[0]!, halfWidth(0)), circle(...points[n - 1]!, halfWidth(1))]
}

/** Douglas-Peucker at 0.02 grid units: invisible at any size, far fewer PDF and Pixi vertices. */
function simplify(points: readonly Point[], tolerance = 0.02): Point[] {
  if (points.length < 3) return [...points]
  const first = points[0]!
  const last = points[points.length - 1]!
  const dx = last[0] - first[0]
  const dy = last[1] - first[1]
  const length = Math.hypot(dx, dy)
  let index = 0
  let distance = 0
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!
    const d = length === 0
      ? Math.hypot(x - first[0], y - first[1])
      : Math.abs(dy * x - dx * y + last[0] * first[1] - last[1] * first[0]) / length
    if (d > distance) { index = i; distance = d }
  }
  if (distance <= tolerance) return [first, last]
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}

/** SVG-style affine [a, b, c, d, e, f]. */
type Affine = readonly [number, number, number, number, number, number]

function compose(...matrices: Affine[]): Affine {
  return matrices.reduce<Affine>((m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ], [1, 0, 0, 1, 0, 0])
}

function rotateAbout(deg: number, cx: number, cy: number): Affine {
  const cos = Math.cos(deg * RAD)
  const sin = Math.sin(deg * RAD)
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
}

function transform(contours: readonly GridContour[], m: Affine): GridContour[] {
  const map = (x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  return contours.map((contour) => contour.map((command): PlantSymbolCommand => command[0] === 'C'
    ? ['C', ...map(command[1], command[2]), ...map(command[3], command[4]), ...map(command[5], command[6])]
    : [command[0], ...map(command[1], command[2])]))
}

function reverseContour(contour: readonly PlantSymbolCommand[]): GridContour {
  const points = contour.map((command) => command[0] === 'C' ? [command[5], command[6]] as const : [command[1], command[2]] as const)
  const reversed: GridContour = [['M', ...points[points.length - 1]!]]
  for (let i = contour.length - 1; i > 0; i--) {
    const command = contour[i]!
    const [x, y] = points[i - 1]!
    reversed.push(command[0] === 'C' ? ['C', command[3], command[4], command[1], command[2], x, y] : ['L', x, y])
  }
  // The implicit close of the original becomes an explicit edge back to its start.
  reversed.push(['L', ...points[0]!])
  return reversed
}

/** Twice the signed area (y down: positive is clockwise on screen), from the control polygon. */
function signedArea(contour: readonly PlantSymbolCommand[]): number {
  const points: Point[] = []
  for (const command of contour) {
    if (command[0] === 'C') points.push([command[1], command[2]], [command[3], command[4]], [command[5], command[6]])
    else points.push([command[1], command[2]])
  }
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!
    const [x1, y1] = points[(i + 1) % points.length]!
    area += x0 * y1 - x1 * y0
  }
  return area
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4 + 0
const normalize = (value: number) => round4((value - 12) / 12)

function finish(contours: readonly GridContour[]): PlantSymbolContour[] {
  return contours.map((contour) => {
    const wound = signedArea(contour) < 0 ? reverseContour(contour) : contour
    return wound.map((command): PlantSymbolCommand => command[0] === 'C'
      ? ['C', normalize(command[1]), normalize(command[2]), normalize(command[3]), normalize(command[4]), normalize(command[5]), normalize(command[6])]
      : [command[0], normalize(command[1]), normalize(command[2])])
  })
}

interface Drawing {
  readonly body: GridContour[]
  /** Cut-outs kept at every size. */
  readonly cutouts?: GridContour[]
  /** Cut-outs thinner than about two grid units: shown only at the detail size. */
  readonly fine?: GridContour[]
}

const path = (grid: GridPath): GridContour[] => grid.map((contour) => [...contour])

const BAMBOO_LEFT_LEAF = [8.2, 11, 1.4, 7.8] as const

// Literal outlines of the approved artwork, in absolute grid units.
const canopyTrunk: GridPath = [[['M', 10.3, 22], ['L', 10.8, 13], ['L', 13.2, 13], ['L', 13.7, 22]]]
const coniferOutline: GridPath = [[['M', 12, 1.5], ['L', 17.4, 8], ['L', 15, 8], ['L', 19.8, 13.8], ['L', 16.8, 13.8], ['L', 21.5, 19.8], ['L', 13.3, 19.8], ['L', 13.3, 22], ['L', 10.7, 22], ['L', 10.7, 19.8], ['L', 2.5, 19.8], ['L', 7.2, 13.8], ['L', 4.2, 13.8], ['L', 9, 8], ['L', 6.6, 8]]]
const climberLeaves: GridPath = [
  [['M', 13, 16.2], ['C', 14.6, 13.6, 17.4, 13, 20, 13.6], ['C', 20.5, 16.8, 18, 19, 13, 16.2]],
  [['M', 10.6, 12.2], ['C', 8.8, 9.8, 6, 9.4, 3.4, 10.2], ['C', 3.2, 13.4, 6, 15.4, 10.6, 12.2]],
  [['M', 12.6, 5.8], ['C', 14.2, 3.6, 16.6, 3, 19, 3.6], ['C', 19.4, 6.6, 17.2, 8.4, 12.6, 5.8]],
]
const cactusOutline: GridPath = [[['M', 9.5, 22], ['L', 9.5, 15], ['L', 5.5, 15], ['C', 3, 15, 2, 13.4, 2, 11], ['L', 2, 8], ['C', 2, 5, 6, 5, 6, 8], ['L', 6, 10.7], ['L', 9.5, 10.7], ['L', 9.5, 4], ['C', 9.5, 0.5, 14.5, 0.5, 14.5, 4], ['L', 14.5, 13.7], ['L', 18, 13.7], ['L', 18, 10], ['C', 18, 7, 22, 7, 22, 10], ['L', 22, 14], ['C', 22, 16.7, 20.5, 18, 18, 18], ['L', 14.5, 18], ['L', 14.5, 22]]]
const appleFruit: GridPath = [
  [['M', 12, 7.6], ['C', 10.7, 6.7, 9.3, 6.3, 7.9, 6.5], ['C', 4.9, 6.9, 3.4, 9.4, 3.7, 12.7], ['C', 4, 16.4, 6.4, 20.9, 9.3, 21.3], ['C', 10.3, 21.4, 11, 20.8, 12, 20.8], ['C', 13, 20.8, 13.7, 21.4, 14.7, 21.3], ['C', 17.6, 20.9, 20, 16.4, 20.3, 12.7], ['C', 20.6, 9.4, 19.1, 6.9, 16.1, 6.5], ['C', 14.7, 6.3, 13.3, 6.7, 12, 7.6]],
  [['M', 11, 7.4], ['C', 10.7, 5.4, 11.3, 3.6, 12.6, 2.2], ['L', 14, 3.2], ['C', 13, 4.4, 12.6, 5.8, 12.8, 7.4]],
  [['M', 13.4, 5.4], ['C', 14.2, 2.8, 16.6, 1.4, 19.6, 1.6], ['C', 18.9, 4.3, 16.4, 5.8, 13.4, 5.4]],
]
const appleShine: GridPath = [[['M', 6.4, 12.6], ['C', 6.5, 10.6, 7.6, 9.2, 9.3, 8.7], ['C', 8.7, 10.1, 8.4, 11.3, 8.4, 12.8]]]
const acorn: GridPath = [
  [['M', 11.2, 1.8], ['L', 12.8, 1.8], ['L', 12.8, 5], ['L', 11.2, 5]],
  [['M', 4.4, 10.6], ['C', 4.4, 6.9, 7.8, 4.5, 12, 4.5], ['C', 16.2, 4.5, 19.6, 6.9, 19.6, 10.6]],
  [['M', 6, 12], ['L', 18, 12], ['C', 18, 17.4, 15.3, 21.3, 12, 22.6], ['C', 8.7, 21.3, 6, 17.4, 6, 12]],
]
const berrySprig: GridPath = [
  [['M', 11, 9.6], ['C', 10.8, 7, 11.6, 4.8, 13.4, 3.2], ['L', 14.6, 4.2], ['C', 13.2, 5.6, 12.6, 7.4, 12.8, 9.6]],
  [['M', 13.4, 5], ['C', 15.2, 2.6, 18.2, 1.8, 21.2, 2.8], ['C', 19.6, 5.4, 16.6, 6.4, 13.4, 5]],
]
const grapeLeaf: GridPath = [[['M', 12.7, 3.8], ['C', 14.3, 1.7, 16.8, 1, 19.3, 1.8], ['C', 17.9, 4.1, 15.4, 4.9, 12.7, 3.8]]]
const mortar: GridPath = [
  [['M', 2.6, 10], ['L', 21.4, 10], ['L', 21.4, 12], ['L', 2.6, 12]],
  [['M', 3.6, 12], ['L', 20.4, 12], ['C', 20.1, 15.9, 17.4, 19, 13.7, 19.8], ['L', 13.7, 21], ['L', 10.3, 21], ['L', 10.3, 19.8], ['C', 6.6, 19, 3.9, 15.9, 3.6, 12]],
]
const beeSting: GridPath = [[['M', 19.6, 13.6], ['L', 22.8, 14.6], ['L', 19.6, 15.6]]]
// Scissor blades are separate parts; where they cross the artwork shows a cut-out diamond.
const scissorBlades: GridPath = [
  [['M', 7.6, 7.6], ['L', 22, 14.6], ['L', 20.6, 16.8], ['L', 6.4, 10.8]],
  [['M', 7.6, 16.4], ['L', 22, 9.4], ['L', 20.6, 7.2], ['L', 6.4, 13.2]],
]
const scissorCrossing: GridPath = [[['M', 13.205, 10.325], ['L', 16.651, 12], ['L', 13.205, 13.675], ['L', 9.24, 12]]]
const log: GridPath = [
  [['M', 7, 6.2], ['L', 18.5, 6.2], ['C', 20.8196, 6.2, 22.7, 8.7967, 22.7, 12], ['C', 22.7, 15.2033, 20.8196, 17.8, 18.5, 17.8], ['L', 7, 17.8], ['C', 4.6804, 17.8, 2.8, 15.2033, 2.8, 12], ['C', 2.8, 8.7967, 4.6804, 6.2, 7, 6.2]],
  [['M', 12.2, 6.6], ['L', 13.6, 3.4], ['L', 16, 3.4], ['L', 14.7, 6.6]],
]
const cow: GridPath = [
  [['M', 7.2, 7.6], ['L', 17.6, 7.6], ['C', 20, 7.6, 21.2, 9.2, 21.2, 11.4], ['L', 21.2, 13.6], ['C', 21.2, 15.2, 20.2, 16.2, 18.8, 16.2], ['L', 7.4, 16.2], ['C', 5.6, 16.2, 4.6, 15, 4.6, 13.2], ['L', 4.6, 10.4], ['C', 4.6, 8.6, 5.8, 7.6, 7.2, 7.6]],
  [['M', 1.2, 7.6], ['C', 1.2, 6, 2.4, 5, 4, 5], ['L', 5.6, 5], ['C', 7, 5, 8, 6, 8, 7.4], ['L', 8, 10.8], ['C', 8, 12, 7.2, 12.8, 6, 12.8], ['L', 3.2, 12.8], ['C', 2, 12.8, 1.2, 12, 1.2, 10.8]],
]
const mushroom: GridPath = [
  [['M', 1.4, 12.8], ['C', 1.4, 6.8, 6.2, 3.4, 12, 3.4], ['C', 17.8, 3.4, 22.6, 6.8, 22.6, 12.8], ['C', 22.6, 13.7, 22, 14.2, 21.2, 14.2], ['L', 2.8, 14.2], ['C', 2, 14.2, 1.4, 13.7, 1.4, 12.8]],
  [['M', 8.2, 15.4], ['L', 15.8, 15.4], ['L', 16.4, 20.6], ['C', 16.5, 21.6, 15.8, 22.2, 14.8, 22.2], ['L', 9.2, 22.2], ['C', 8.2, 22.2, 7.5, 21.6, 7.6, 20.6]],
]

function fernDrawing(): Drawing {
  const body: GridContour[] = []
  const fronds: [Point, Point, Point][] = [[[11.2, 22], [5, 14.6], [1.6, 5.6]], [[12.8, 22], [19, 14.6], [22.4, 5.6]]]
  for (const [p0, p1, p2] of fronds) {
    const points = qbez(p0, p1, p2, 40)
    body.push(...band(points, (t) => 1.2 - 0.6 * t, false))
    for (let k = 1; k <= 5; k++) {
      const t = k / 6.1
      const i = Math.trunc(t * 40)
      const [x, y] = points[i]!
      const [bx, by] = points[i + 1]!
      const length = Math.hypot(bx - x, by - y)
      const ux = (bx - x) / length
      const uy = (by - y) / length
      const leaflet = 4.6 * (1 - t * 0.55)
      for (const side of [1, -1]) {
        const nx = -uy * side
        const ny = ux * side
        body.push(lens(x, y, x + nx * leaflet + ux * leaflet * 0.6, y + ny * leaflet + uy * leaflet * 0.6, 1.8 * (1 - t * 0.3), 0.45))
      }
    }
  }
  const spiral = Array.from({ length: 31 }, (_, k): Point => {
    const r = 3.6 - 2.5 * k / 30
    const angle = (90 - 330 * k / 30) * RAD
    return [12 + r * Math.cos(angle), 9.6 + r * Math.sin(angle)]
  })
  body.push(rect(10.8, 13, 2.4, 9), ...band(spiral, (t) => 1.35 - 0.35 * t))
  return { body }
}

function soilDrawing(): Drawing {
  const worm = [
    ...cbez([3.2, 18.4], [4.6, 10.4], [9.2, 10.4], [10.2, 15], 16),
    ...cbez([10.2, 15], [11.2, 19.6], [15.4, 19.6], [16.4, 13.6], 16).slice(1),
    ...cbez([16.4, 13.6], [17, 10.4], [18.6, 9.2], [20, 9.4], 10).slice(1),
  ]
  const ticks = [6, 12, 20, 27, 35].map((i) => {
    const [x, y] = worm[i]!
    const [bx, by] = worm[i + 1]!
    return ellipse(x, y, 0.5, 2, Math.atan2(by - y, bx - x) / RAD)
  })
  return { body: [rect(1.4, 20.6, 21.2, 2), ...band(worm, 2.1), circle(20.2, 9.4, 2.5)], fine: [...ticks, circle(21, 8.8, 0.7)] }
}

function drawings(): Record<PlantSymbolId, Drawing> {
  const vine = cbez([8.6, 22], [19.5, 17], [4.6, 10.5], [12.2, 2.6], 40)
  const pod = qbez([2.2, 15.2], [11.5, 7.6], [21.2, 12.6], 40)
  const chili = qbez([10.4, 7.2], [8.2, 17.6], [17.4, 21.6], 40)
  const taper = (from: number) => (t: number) => from * (1 - t) + 0.5 * t
  return {
    // Plant forms: side views standing on the ground line.
    canopy: { body: [circle(12, 7.2, 6.2), circle(6.4, 10, 4.5), circle(17.6, 10, 4.5), circle(9.4, 12.2, 3.4), circle(14.6, 12.2, 3.4), ...path(canopyTrunk)] },
    conifer: { body: path(coniferOutline) },
    palm: {
      body: [
        ...band(qbez([11.2, 22], [11.6, 15], [13.2, 9]), (t) => 1.9 - 0.7 * t, false),
        ...([[[6, 5.4], [1.6, 12.6], 2.0], [[9, 3], [4.4, 3.2], 1.8], [[13.6, 4], [12.8, 1.4], 1.6], [[17.6, 3.2], [21.4, 4.6], 1.8], [[20.6, 5.6], [22.4, 12.6], 2.0]] as const)
          .flatMap(([control, end, w]) => band(qbez([13.2, 9], control, end), taper(w), false)),
        circle(13.2, 9, 1.9),
      ],
    },
    shrub: { body: [circle(12, 9.4, 5.8), circle(6.4, 12.8, 4.8), circle(17.6, 12.8, 4.8), circle(12, 15.4, 5.4), rect(2.4, 14.4, 19.2, 7.6, 3.4)] },
    // A sprout: two broad leaves on a short stem; wide rather than round, unlike the canopy tree.
    herb: { body: [rect(10.8, 12, 2.4, 10), lens(12, 13.6, 1.2, 6.2, 4.1), lens(12, 13.6, 22.8, 6.2, 4.1), lens(12, 12.4, 12, 2.6, 2.5)] },
    grass: {
      body: ([[[10.2, 22], [8, 14], [2.2, 6], 1.9], [[11.8, 22], [10.6, 11], [12.6, 1.8], 2.0], [[13.6, 22], [15.6, 13], [21.6, 5], 1.9],
        [[11, 22], [7.6, 17.2], [3.8, 14.4], 1.5], [[13, 22], [16.6, 17.4], [20.4, 15.2], 1.5]] as const)
        .flatMap(([a, b, c, w]) => band(qbez(a, b, c), (t) => w * (1 - t) + 0.4 * t, false)),
    },
    bamboo: {
      body: [rect(4.6, 4.5, 3.6, 17.5), rect(10.2, 1.8, 3.6, 20.2), rect(15.8, 7, 3.6, 15),
        lens(13.8, 6, 21.6, 3.2, 1.7), lens(...BAMBOO_LEFT_LEAF, 1.6), lens(19.4, 11.8, 23, 15.8, 1.4)],
      // The artwork paints the leaves over the nodes, so the node the left leaf crosses keeps only its uncovered part.
      fine: [
        bandAboveQuad(4.6, 9.2, 3.6, 1.1, lensEdge(...BAMBOO_LEFT_LEAF, 1.6)),
        ...([[4.6, [14.6]], [10.2, [6.6, 12, 17.4]], [15.8, [12, 17]]] as const)
          .flatMap(([x, ys]) => ys.map((y) => rect(x, y, 3.6, 1.1))),
      ],
    },
    fern: fernDrawing(),
    climber: { body: [...band(vine, 1.3), ...path(climberLeaves), circle(17.4, 9.6, 2.7)], cutouts: [circle(17.4, 9.6, 1.1)] },
    groundcover: {
      body: [circle(3.8, 19.4, 2.6), circle(8, 18.6, 3), circle(12, 18.3, 3.1), circle(16, 18.6, 3), circle(20.2, 19.4, 2.6), rect(1.2, 19.4, 21.6, 2.6),
        ellipse(4.6, 16.4, 1.9, 2.3, -40), ellipse(12, 14.6, 2.1, 2.6), ellipse(19.4, 16.4, 1.9, 2.3, 40),
        ellipse(8.2, 15.3, 1.8, 2.3, -18), ellipse(15.8, 15.3, 1.8, 2.3, 18)],
    },
    rosette: {
      body: [...([[-78, 11, 1.9], [-52, 13, 2.1], [-26, 15, 2.3], [0, 17.5, 2.4], [26, 15, 2.3], [52, 13, 2.1], [78, 11, 1.9]] as const)
        .map(([a, length, w]) => lens(12, 21.6, 12 + Math.sin(a * RAD) * length, 21.6 - Math.cos(a * RAD) * length, w, 0.4)),
      rect(6, 20.2, 12, 1.8)],
    },
    cactus: { body: path(cactusOutline) },

    // What it gives: the produce itself, not a plant bearing it.
    apple: { body: path(appleFruit), fine: path(appleShine) },
    nut: { body: transform(path(acorn), compose(rotateAbout(28, 12, 12), [1, 0, 0, 1, 1.2, 0.6], [0.92, 0, 0, 0.92, 0, 0])) },
    berry: {
      body: [...path(berrySprig), circle(7.6, 13.6, 4.2), circle(16.4, 13.6, 4.2), circle(12, 19, 4.2)],
      fine: [circle(6.4, 12.4, 1.2), circle(15.2, 12.4, 1.2), circle(10.8, 17.8, 1.2)],
    },
    grape: {
      body: [rect(11.2, 1.4, 1.6, 4.4), ...path(grapeLeaf),
        ...([[5.2, 8], [9.6, 8], [14.4, 8], [18.8, 8], [7.4, 12], [12, 12], [16.6, 12], [9.7, 16], [14.3, 16], [12, 20]] as const)
          .map(([x, y]) => circle(x, y, 2.45))],
    },
    flower: {
      body: [rect(10.9, 13, 2.2, 9), lens(12, 19.6, 19, 15.2, 2.2),
        ...[0, 60, 120, 180, 240, 300].map((a) => ellipse(12 + 4.7 * Math.sin(a * RAD), 8.2 - 4.7 * Math.cos(a * RAD), 2.5, 3.4, a))],
      cutouts: [circle(12, 8.2, 2.5)],
    },
    // Nitrogen fixer: a pea pod lying horizontally, peas cut out.
    pod: {
      body: [...band(pod, (t) => 0.6 + 4.2 * Math.sin(Math.PI * t) ** 0.7, false), ...band(qbez([20.6, 12.2], [22.2, 10.6], [22, 8.4], 10), 0.8)],
      cutouts: [11, 20, 29].map((i) => circle(...pod[i]!, 2.1)),
    },

    // What it does for the design.
    carrot: {
      body: [polygon([[2.2, 21.8], ...arc(15, 9.6, 4.4, -133.6, 46.4, 20)]),
        lens(15.6, 6.4, 16.4, 0.8, 1.7), lens(16.8, 7, 22.6, 3.2, 1.8), lens(17.8, 8.4, 23.2, 8.6, 1.6)],
      fine: [lens(7.4, 17.2, 10.2, 18.6, 0.55), lens(10.8, 13.2, 13.8, 14.8, 0.6)],
    },
    grain: {
      body: [rect(11.2, 7.5, 1.6, 14.5),
        ...([[9.4, 8.4, -30], [14.6, 8.4, 30], [9.4, 12.6, -30], [14.6, 12.6, 30], [9.4, 16.8, -30], [14.6, 16.8, 30], [12, 4.4, 0]] as const)
          .map(([x, y, r]) => ellipse(x, y, 2.1, 3.2, r)),
        lens(12, 1.6, 12, 0.2, 0.4)],
    },
    chili: { body: [...band(chili, (t) => 3.7 * (1 - t) ** 0.65 + 0.5), ellipse(11.2, 6.4, 4.2, 2, -8), ...band(qbez([11.6, 5.4], [11.8, 2.6], [14.8, 1.6], 10), 0.85)] },
    // Mortar and pestle: avoids the protected medical cross.
    medicinal: { body: [...path(mortar), ...band([[13.4, 9.2], [19.4, 2.6]], 1.7)] },
    bee: {
      body: [ellipse(10.4, 7.2, 2.9, 4.3, -22), ellipse(15.6, 7.2, 2.7, 4, 22), ellipse(13.2, 14.6, 6.8, 4.6), circle(5, 14.2, 2.8), ...path(beeSting)],
      cutouts: [rect(10.3, 10.8, 1.6, 7.6), rect(14, 10.8, 1.6, 7.6)],
    },
    // Chop and drop.
    biomass: {
      body: [...path(scissorBlades), circle(5.2, 6.4, 3.6), circle(5.2, 17.6, 3.6)],
      cutouts: [circle(5.2, 6.4, 1.6), circle(5.2, 17.6, 1.6), ...path(scissorCrossing)],
    },
    timber: { body: path(log), fine: [ring(7, 12, 2.7, 3.6, 1.3, 2.2), circle(7, 12, 0.9)] },
    // A cow in side view, a horizontal body on four legs; unlike any round symbol.
    fodder: {
      body: [...path(cow), lens(4.6, 5.4, 6.4, 2.2, 0.8), lens(3.2, 6.2, 0.4, 4.8, 0.9),
        rect(6.4, 14.4, 2.3, 7.6), rect(9.6, 14.4, 2.3, 7.6), rect(14.2, 14.4, 2.3, 7.6), rect(17.4, 14.4, 2.3, 7.6),
        ...band(qbez([20.8, 9], [22.6, 11], [22.2, 15.4], 12), 0.6), ellipse(22.2, 16.2, 1, 1.4)],
      cutouts: [ellipse(11.8, 10.8, 2.4, 1.6, -10), ellipse(16.6, 12.4, 1.5, 1.1)],
    },
    windbreak: {
      body: [
        ...band([[2.6, 9], ...arc(14, 6, 3, 90, -180, 24)], 1.25),
        ...band([[2.6, 13.5], [18, 13.5], ...arc(18, 16.5, 3, -90, 180, 24).slice(1)], 1.25),
        ...band([[2.6, 18], [9.4, 18]], 1.25),
      ],
    },
    soil: soilDrawing(),
    mushroom: { body: path(mushroom), cutouts: [circle(7.4, 9.2, 1.8), circle(13.2, 6.8, 1.5), circle(17.2, 10.2, 1.6)] },

    // Abstract marks.
    round: { body: [circle(12, 12, 12 * ROUND_PLANT_SYMBOL_RADIUS)] },
    square: { body: [rect(3.6, 3.6, 16.8, 16.8, 1.2)] },
    triangle: {
      body: [[['M', 11.4, 1.2], ['C', 11.76, 0.48, 12.24, 0.48, 12.6, 1.2], ['L', 22.08, 17.76], ['C', 22.56, 18.6, 22.2, 19.2, 21.36, 19.2],
        ['L', 2.64, 19.2], ['C', 1.8, 19.2, 1.44, 18.6, 1.92, 17.76]]],
    },
    cross: { body: [rect(8.16, 1.44, 7.68, 21.12, 0.84), rect(1.44, 8.16, 21.12, 7.68, 0.84)] },
  }
}

export const PLANT_SYMBOL_FAMILIES: Readonly<Record<PlantSymbolFamily, readonly PlantSymbolId[]>> = {
  form: ['canopy', 'conifer', 'palm', 'shrub', 'herb', 'grass', 'bamboo', 'fern', 'climber', 'groundcover', 'rosette', 'cactus'],
  gives: ['apple', 'nut', 'berry', 'grape', 'flower', 'pod'],
  does: ['carrot', 'grain', 'chili', 'medicinal', 'bee', 'biomass', 'timber', 'fodder', 'windbreak', 'soil', 'mushroom'],
  abstract: ['round', 'square', 'triangle', 'cross'],
}

/** Pure and deterministic: the same artwork yields the same contours every time. */
function buildPlantSymbolRecipes(): Record<PlantSymbolId, PlantSymbolRecipe> {
  const recipes = {} as Record<PlantSymbolId, PlantSymbolRecipe>
  for (const [symbol, drawing] of Object.entries(drawings()) as [PlantSymbolId, Drawing][]) {
    const body = finish(drawing.body)
    const cutouts = finish(drawing.cutouts ?? [])
    const compact: PlantSymbolArt = { body, cutouts }
    recipes[symbol] = {
      compact,
      detailed: drawing.fine ? { body, cutouts: [...cutouts, ...finish(drawing.fine)] } : compact,
    }
  }
  return recipes
}

export const PLANT_SYMBOL_RECIPES: Readonly<Record<PlantSymbolId, PlantSymbolRecipe>> = buildPlantSymbolRecipes()

export function getPlantSymbolArt(symbol: PlantSymbolId, diameterPx: number): PlantSymbolArt {
  const recipe = PLANT_SYMBOL_RECIPES[symbol]
  return diameterPx >= PLANT_SYMBOL_DETAIL_DIAMETER_PX ? recipe.detailed : recipe.compact
}

export interface PlantSymbolPathTarget {
  moveTo(x: number, y: number): unknown
  lineTo(x: number, y: number): unknown
  bezierCurveTo(cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number): unknown
  closePath(): unknown
}

export function tracePlantSymbolContour(target: PlantSymbolPathTarget, contour: PlantSymbolContour, x: number, y: number, radius: number): void {
  for (const command of contour) {
    if (command[0] === 'M') target.moveTo(x + command[1] * radius, y + command[2] * radius)
    else if (command[0] === 'L') target.lineTo(x + command[1] * radius, y + command[2] * radius)
    else if (command[0] === 'C') {
      target.bezierCurveTo(x + command[1] * radius, y + command[2] * radius,
        x + command[3] * radius, y + command[4] * radius, x + command[5] * radius, y + command[6] * radius)
    }
  }
  target.closePath()
}

export function tracePlantSymbolContours(
  target: PlantSymbolPathTarget,
  contours: readonly PlantSymbolContour[],
  x: number,
  y: number,
  radius: number,
): void {
  for (const contour of contours) tracePlantSymbolContour(target, contour, x, y, radius)
}

/** One SVG/PDF path for a contour list. Shared winding makes nonzero fill their union. */
export function plantSymbolPath(contours: readonly PlantSymbolContour[]): string {
  return contours
    .map((contour) => contour.map(([kind, ...values]) => `${kind} ${values.join(' ')}`).join(' ') + ' Z')
    .join(' ')
}
