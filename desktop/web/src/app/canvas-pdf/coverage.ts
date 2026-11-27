import type { PrintBounds, PrintPoint } from '../../canvas/print'
import type { PrintScaleV10 } from '../../generated/contracts'
import { printScalePointsPerGroundMeter } from './print-setup'
import { PDF_ZOOM } from './types'

function pageZoom(zoom = 100): number {
  if (!Number.isFinite(zoom) || zoom < PDF_ZOOM.min || zoom > PDF_ZOOM.max) throw new Error('invalid-page-view')
  return zoom
}

export function moveCoverage<T extends { ground: PrintBounds }>(fit: T, offset: PrintPoint = { x: 0, y: 0 }): T {
  const x = fit.ground.x + offset.x, y = fit.ground.y + offset.y
  if (![x, y, x + fit.ground.width, y + fit.ground.height].every(Number.isFinite)) throw new Error('invalid-page-view')
  return { ...fit, ground: { ...fit.ground, x, y } }
}

/**
 * Preserve the exact ground rectangle and centre its physical frame. When a fixed `scale` (`ratio` or
 * `customary`) is chosen, the printed scale (`pointsPerGroundMeter * groundScaleFactor`) is held exact
 * regardless of paper size or area size (`2.1-Q356`).
 */
export function fitArea(
  bounds: PrintBounds,
  frame: PrintBounds,
  zoom = 100,
  scale?: PrintScaleV10,
  groundScaleFactor = 1,
) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('invalid-page-view')
  const fixedPtsPerGroundM = printScalePointsPerGroundMeter(scale)
  if (fixedPtsPerGroundM !== null) {
    const pointsPerMeter = fixedPtsPerGroundM * groundScaleFactor
    const width = frame.width / pointsPerMeter
    const height = frame.height / pointsPerMeter
    const cx = bounds.x + bounds.width / 2
    const cy = bounds.y + bounds.height / 2
    return {
      frame,
      pointsPerMeter,
      ground: { x: cx - width / 2, y: cy - height / 2, width, height },
    }
  }
  const fit = Math.min(frame.width / bounds.width, frame.height / bounds.height)
  const fittedFrame = { x: frame.x + (frame.width - bounds.width * fit) / 2, y: frame.y + (frame.height - bounds.height * fit) / 2,
    width: bounds.width * fit, height: bounds.height * fit }
  return { frame: fittedFrame, ...zoomCoverage({ ground: bounds, pointsPerMeter: fit }, zoom) }
}

export function zoomCoverage(
  fit: { ground: PrintBounds; pointsPerMeter: number },
  zoom = 100,
  scale?: PrintScaleV10,
  groundScaleFactor = 1,
  frame?: PrintBounds,
) {
  const fixedPtsPerGroundM = printScalePointsPerGroundMeter(scale)
  if (fixedPtsPerGroundM !== null && frame) {
    const pointsPerMeter = fixedPtsPerGroundM * groundScaleFactor
    const width = frame.width / pointsPerMeter
    const height = frame.height / pointsPerMeter
    const cx = fit.ground.x + fit.ground.width / 2
    const cy = fit.ground.y + fit.ground.height / 2
    return { pointsPerMeter, ground: { x: cx - width / 2, y: cy - height / 2, width, height } }
  }
  const factor = pageZoom(zoom) / 100
  const width = fit.ground.width / factor, height = fit.ground.height / factor
  return { pointsPerMeter: fit.pointsPerMeter * factor,
    ground: { x: fit.ground.x + (fit.ground.width - width) / 2, y: fit.ground.y + (fit.ground.height - height) / 2, width, height } }
}
