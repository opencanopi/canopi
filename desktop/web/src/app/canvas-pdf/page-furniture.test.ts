import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { groundScale } from './page-furniture'
import { createPdfTextEngine, type PdfFontId } from './text'
import type { PdfOperation } from './types'

const text = () => createPdfTextEngine(new Map<PdfFontId, Uint8Array>([
  ['latin', readFileSync('src/app/canvas-pdf/fonts/NotoSans-Regular.ttf')], ['strong', readFileSync('src/app/canvas-pdf/fonts/NotoSans-SemiBold.ttf')],
]), 'en')
const page = { width: 600, height: 800, pointsPerMeter: 10 }
/** The arrow's two halves share the tip (first point) and the notch (last point before Z). */
function arrow(operations: readonly PdfOperation[]) {
  const halves = operations.filter(op => op.kind === 'path' && op.d.endsWith('Z'))
  expect(halves).toHaveLength(2)
  const points = (halves[0] as Extract<PdfOperation, { kind: 'path' }>).d.match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number)
  const letter = operations.find(op => op.kind === 'text' && op.line.runs.map(r => r.text).join('') === 'N') as Extract<PdfOperation, { kind: 'text' }>
  return { tip: { x: points[0]!, y: points[1]! }, notch: { x: points[4]!, y: points[5]! }, letter }
}

it('groundScale turns the arrow by northAngleDeg', () => {
  const upright = arrow(groundScale(page, 'en', text(), 'N'))
  expect(upright.tip.x).toBeCloseTo(upright.notch.x, 6)
  expect(upright.tip.y).toBeLessThan(upright.notch.y)
  expect(arrow(groundScale(page, 'en', text(), 'N', 0))).toEqual(upright)
  // A layout turned to 90 has east up, so north points left on paper.
  const turned = arrow(groundScale(page, 'en', text(), 'N', -90))
  expect(turned.tip.y).toBeCloseTo(turned.notch.y, 6)
  expect(turned.tip.x).toBeLessThan(turned.notch.x)
  // The letter sits beyond the tip, level on paper.
  expect(turned.letter.rotation).toBe(0)
  expect(turned.letter.x + turned.letter.line.width).toBeLessThan(turned.tip.x)
  const half = arrow(groundScale(page, 'en', text(), 'N', -30))
  const direction = Math.atan2(half.tip.y - half.notch.y, half.tip.x - half.notch.x) * 180 / Math.PI
  expect(direction).toBeCloseTo(-90 - 30, 6)
})
