import type { DesignSketch } from '../../generated/contracts'
import styles from './DesignSketchThumbnail.module.css'

/** Margin around the Design's objects, as a share of the sketch's longer side. */
const SKETCH_MARGIN = 0.08

/** Dot size in CSS px: dense Designs get finer dots so their zones stay readable. */
export function plantDotSize(plantCount: number): number {
  return plantCount <= 150 ? 2.4 : plantCount <= 600 ? 1.8 : 1.2
}

/**
 * A Design drawn symbolically from its file: zones as outlines, plants as
 * dots, north up, with no map under it. Decorative: the row names the Design.
 * Each layer is one path, so a dense Design stays cheap to draw.
 */
export function DesignSketchThumbnail({ sketch }: { readonly sketch: DesignSketch }) {
  const margin = Math.max(sketch.width, sketch.height) * SKETCH_MARGIN
  const viewBox = `${-margin} ${-margin} ${sketch.width + margin * 2} ${sketch.height + margin * 2}`
  return (
    <svg className={styles.sketch} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true" data-design-sketch>
      <path className={styles.zones} d={zonesPath(sketch)} />
      <path className={styles.plants} d={plantsPath(sketch.plants)} style={{ strokeWidth: `${plantDotSize(sketch.plants.length / 2)}px` }} />
    </svg>
  )
}

/** Each zone as a polyline; closed zones end with Z. */
export function zonesPath(sketch: DesignSketch): string {
  return sketch.zones.map((zone) => {
    const commands: string[] = []
    for (let index = 0; index + 1 < zone.points.length; index += 2) {
      commands.push(`${index === 0 ? 'M' : 'L'}${zone.points[index]} ${zone.points[index + 1]}`)
    }
    return commands.join('') + (zone.closed ? 'Z' : '')
  }).join('')
}

/** Each plant as a zero-length segment: with round caps it draws a dot. */
export function plantsPath(points: readonly number[]): string {
  let path = ''
  for (let index = 0; index + 1 < points.length; index += 2) {
    path += `M${points[index]} ${points[index + 1]}h0`
  }
  return path
}
