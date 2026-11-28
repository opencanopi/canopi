// @vitest-environment jsdom

import { effect } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestCanvasQuerySurface } from '../../__tests__/support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import { createTestView, type TestView } from '../../__tests__/support/test-view'
import { setCurrentCanvasSession } from '../../canvas/session'
import { createViewReadSurface, SETTLE_MS } from '../../geo/view/frame-source'
import { plantLabelCoverage } from './coverage'

let view: TestView | null = null
let stop: (() => void) | null = null

afterEach(() => {
  vi.useRealTimers()
  stop?.()
  stop = null
  setCurrentCanvasSession(null)
  view?.dispose()
  view = null
})

describe('plant label coverage', () => {
  it('the labels count re-reads on settle and on a band change, not on a pan frame', () => {
    vi.useFakeTimers()
    view = createTestView({ viewport: { x: 0, y: 0, scale: 120 } })
    const getPlantLabelCoverage = vi.fn(() => ({ labelled: 70, inView: 282 }))
    const queries = {
      ...createTestCanvasQuerySurface(),
      view: createViewReadSurface(view.frames),
      getPlantLabelCoverage,
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries }))
    const lines: Array<string | undefined> = []
    stop = effect(() => { lines.push(plantLabelCoverage()?.text) })
    expect(lines).toEqual(['Names shown for 70 of 282 plants in view'])
    const settled = () => vi.advanceTimersByTime(SETTLE_MS)
    settled()
    const reads = getPlantLabelCoverage.mock.calls.length

    // A pan frame, and a zoom inside the same band, read nothing until the frame settles.
    view.setViewport({ x: 40, y: -25, scale: 120 })
    view.setViewport({ x: 40, y: -25, scale: 121 })
    expect(getPlantLabelCoverage).toHaveBeenCalledTimes(reads)
    settled()
    expect(getPlantLabelCoverage).toHaveBeenCalledTimes(reads + 1)

    // A zoom into another band re-reads at once.
    view.setViewport({ x: 40, y: -25, scale: 121 * 1.25 })
    expect(getPlantLabelCoverage).toHaveBeenCalledTimes(reads + 2)
  })
})
