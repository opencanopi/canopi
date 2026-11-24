// app/lidar/profile-chart.ts
//
// The profile chart's pure geometry (canopi-f47t.42, spec §1.10 "Profile"), adapted from GeoLibre's
// `packages/plugins/src/plugins/elevation-profile/chart/profileChart.ts` (MIT; THIRD_PARTY_NOTICES.md): scales, SVG
// paths and the pointer-to-sample lookup, with no DOM. Canopi's changes: several curves share one axis, no data breaks a
// path into runs (a lone value is a short dash), a height plot starts at zero, round distance ticks, and a curve style
// per draw-order index.

/** Where a plot draws, in SVG pixels: x0 to x1 across, top to bottom down. */
export interface PlotArea {
  readonly x0: number
  readonly x1: number
  readonly top: number
  readonly bottom: number
}

interface ProfilePlotInput extends PlotArea {
  /** Distance of each sample from the start, ascending, in metres. */
  readonly distances: readonly number[]
  /** One value list per curve, aligned with `distances`; null is no data. */
  readonly series: readonly (readonly (number | null)[])[]
  /** Heights above ground: the axis starts at zero. */
  readonly fromZero?: boolean
}

interface ProfilePlot {
  /** One SVG `d` per curve; empty for a curve with no value. */
  readonly paths: readonly string[]
  /** The axis' ends, labelled on the chart; null when no curve has a value. */
  readonly min: number | null
  readonly max: number | null
  x(distance: number): number
  y(value: number): number
}

const px = (value: number) => value.toFixed(2)
/** A value with no data on both sides is a level dash this wide either side of it, so every value counted is drawn. */
const LONE_HALF_WIDTH = 1.5

export function buildProfilePlot(input: ProfilePlotInput): ProfilePlot {
  const present = input.series.flatMap((values) => values.filter((value): value is number => value !== null))
  const min = present.length > 0 ? Math.min(...present, ...(input.fromZero ? [0] : [])) : null
  const max = present.length > 0 ? Math.max(...present) : null
  const total = input.distances[input.distances.length - 1] ?? 0
  const x = (distance: number) => total > 0 ? input.x0 + ((input.x1 - input.x0) * distance) / total : input.x0
  const y = (value: number) => {
    // A flat plot sits in the middle rather than dividing by zero.
    if (min === null || max === null || max === min) return (input.top + input.bottom) / 2
    return input.bottom - ((input.bottom - input.top) * (value - min)) / (max - min)
  }
  const paths = input.series.map((values) => {
    let path = ''
    let run: { readonly x: number; readonly y: number }[] = []
    const flush = () => {
      if (run.length === 1) {
        const { x: atX, y: atY } = run[0]!
        path += `M${px(atX - LONE_HALF_WIDTH)} ${px(atY)}L${px(atX + LONE_HALF_WIDTH)} ${px(atY)}`
      } else {
        run.forEach((point, index) => {
          path += `${index === 0 ? 'M' : 'L'}${px(point.x)} ${px(point.y)}`
        })
      }
      run = []
    }
    values.forEach((value, index) => {
      if (value === null) {
        flush()
        return
      }
      run.push({ x: x(input.distances[index]!), y: y(value) })
    })
    flush()
    return path
  })
  return { paths, min, max, x, y }
}

/** 3 to 5 round distance ticks from zero (steps of 1, 2 or 5 × 10ⁿ metres), the first at the start. */
export function distanceTicks(total: number): number[] {
  if (!(total > 0)) return [0]
  const exponent = Math.floor(Math.log10(total)) - 1
  for (let power = exponent; power <= exponent + 2; power += 1) {
    for (const mantissa of [1, 2, 5]) {
      const step = mantissa * 10 ** power
      const count = Math.floor(total / step + 1e-9) + 1
      if (count <= 5) return Array.from({ length: count }, (_, index) => Number((index * step).toPrecision(12)))
    }
  }
  return [0, total]
}

/** The sample nearest the pointer's x, clamped to the plot; null with no samples. */
export function indexAtX(pointerX: number, distances: readonly number[], area: Pick<PlotArea, 'x0' | 'x1'>): number | null {
  if (distances.length === 0) return null
  const total = distances[distances.length - 1]!
  const clamped = Math.min(area.x1, Math.max(area.x0, pointerX))
  const target = total > 0 && area.x1 > area.x0 ? ((clamped - area.x0) / (area.x1 - area.x0)) * total : 0
  let nearest = 0
  for (let index = 1; index < distances.length; index += 1) {
    if (Math.abs(distances[index]! - target) < Math.abs(distances[nearest]! - target)) nearest = index
  }
  return nearest
}

/** A curve's colour (ink, ochre, green, plum) by draw-order index; a fifth and later reuse them dashed. */
export function curveStyle(index: number): { readonly colour: 1 | 2 | 3 | 4; readonly dashed: boolean } {
  return { colour: ((index % 4) + 1) as 1 | 2 | 3 | 4, dashed: index >= 4 }
}
