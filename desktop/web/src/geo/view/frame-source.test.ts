import { effect } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestView } from '../../__tests__/support/test-view'
import { createSessionPlane } from '../session-plane'
import { createViewFrameSource, createViewReadSurface, SETTLE_MS } from './frame-source'
import type { ViewFrame } from './types'

describe('view frame source', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the tools listeners before the overlays listeners, inside publish', () => {
    vi.useFakeTimers()
    const view = createTestView()
    const initial = view.frames.viewFrame.peek()
    const frames = createViewFrameSource(initial)
    const calls: string[] = []
    frames.onViewFrame('overlays', () => calls.push('overlays'))
    const stopTools = frames.onViewFrame('tools', () => calls.push(`tools, dispatching ${frames.dispatching}`))
    const next = { ...initial, revision: 1 } as ViewFrame

    frames.publish(next)
    expect(calls).toEqual(['tools, dispatching true', 'overlays'])
    expect(frames.dispatching).toBe(false)
    expect(frames.viewFrame.peek()).toBe(next)

    vi.advanceTimersByTime(SETTLE_MS - 1)
    stopTools()
    const last = { ...initial, revision: 2 } as ViewFrame
    frames.publish(last)
    expect(calls).toEqual(['tools, dispatching true', 'overlays', 'overlays'])
    // Each publish restarts the settle: the settled frame is the last one, 150 ms after it.
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(frames.settledViewFrame.peek()).toBe(initial)
    vi.advanceTimersByTime(1)
    expect(frames.settledViewFrame.peek()).toBe(last)
    frames.dispose()
    view.dispose()
  })

  it('a frame published while listeners run reaches every listener after the frame being dispatched', () => {
    const view = createTestView()
    const initial = view.frames.viewFrame.peek()
    const frames = createViewFrameSource(initial)
    const first = { ...initial, revision: 1 } as ViewFrame
    const second = { ...initial, revision: 2 } as ViewFrame
    const seen: Array<readonly [string, number]> = []
    frames.onViewFrame('tools', (frame) => {
      seen.push(['tools', frame.revision])
      if (frame !== first) return
      frames.publish(second)
      seen.push(['viewFrame after the publish', frames.viewFrame.peek().revision])
    })
    frames.onViewFrame('overlays', (frame) => seen.push([`overlays, dispatching ${frames.dispatching}`, frame.revision]))

    frames.publish(first)

    expect(seen).toEqual([
      ['tools', 1],
      ['viewFrame after the publish', 1],
      ['overlays, dispatching true', 1],
      ['tools', 2],
      ['overlays, dispatching true', 2],
    ])
    expect(frames.viewFrame.peek()).toBe(second)
    expect(frames.dispatching).toBe(false)
    frames.dispose()
    view.dispose()
  })

  it('a listener that throws does not keep the frame from the others; its error follows them and ends the dispatch', () => {
    const view = createTestView()
    const initial = view.frames.viewFrame.peek()
    const frames = createViewFrameSource(initial)
    const first = { ...initial, revision: 1 } as ViewFrame
    const waiting = { ...initial, revision: 2 } as ViewFrame
    const fault = new Error('tools listener failed')
    const seen: Array<readonly [string, number]> = []
    frames.onViewFrame('tools', (frame) => {
      seen.push(['first tools', frame.revision])
      frames.publish(waiting)
      throw fault
    })
    frames.onViewFrame('tools', (frame) => seen.push(['second tools', frame.revision]))
    frames.onViewFrame('overlays', (frame) => seen.push(['overlays', frame.revision]))

    expect(() => frames.publish(first)).toThrow(fault)
    expect(seen).toEqual([['first tools', 1], ['second tools', 1], ['overlays', 1]])
    expect(frames.viewFrame.peek()).toBe(first)
    expect(frames.dispatching).toBe(false)
    frames.dispose()
    view.dispose()
  })

  it('the read surface signals change only with their own values', () => {
    const view = createTestView({ screen: { width: 400, height: 300 }, viewport: { x: 0, y: 0, scale: 2 } })
    const surface = createViewReadSurface(view.frames)
    const runs = { mode: 0, zoomBand: 0, bearingDeg: 0, northUp: 0, groundMetresPerPixel: 0, zoomLimit: 0, designPin: 0 }
    const disposers = (Object.keys(runs) as Array<keyof typeof runs>).map((name) => effect(() => {
      void surface[name].value
      runs[name] += 1
    }))

    view.navigation.panByPx({ x: 25, y: -10 })
    view.navigation.panByPx({ x: -3, y: 4 })
    expect(runs).toEqual({ mode: 1, zoomBand: 1, bearingDeg: 1, northUp: 1, groundMetresPerPixel: 1, zoomLimit: 1, designPin: 1 })

    expect(surface.zoomBand.value).toBe(Math.floor(Math.log(2) / Math.log(1.25)))
    expect(surface.groundMetresPerPixel.value).toBe(0.5)
    expect(surface.zoomLimit.value).toBeNull()
    view.setViewport({ x: 0, y: 0, scale: 1e9 })
    expect(surface.zoomLimit.value).toBe('max')
    view.setViewport({ x: 0, y: 0, scale: 1e-9 })
    expect(surface.zoomLimit.value).toBe('min')
    expect(surface.mode.value).toBe('overview')

    // The needle reads a tenth of a degree; north-up allows 0.05°.
    view.host.current().apply({ kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 359.96 })
    expect(surface.bearingDeg.value).toBe(0)
    expect(surface.northUp.value).toBe(true)
    view.host.current().apply({ kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 12.345 })
    expect(surface.bearingDeg.value).toBe(12.3)
    expect(surface.northUp.value).toBe(false)
    for (const dispose of disposers) dispose()
    view.dispose()
  })

  it('the Design pin shows in overview only, rounded, 24 px or more inside every edge', () => {
    const view = createTestView({ screen: { width: 400, height: 300 } })
    const surface = createViewReadSurface(view.frames)

    view.setViewport({ x: 120.4, y: 80.6, scale: 2 })
    expect(surface.designPin.value).toBeNull()
    view.setViewport({ x: 120.4, y: 80.6, scale: 0.05 })
    expect(surface.designPin.value).toEqual({ x: 120, y: 81 })
    // Just inside the 24 px margin (the camera reads a placement back within micropixels, not exactly).
    view.setViewport({ x: 24.001, y: 275.999, scale: 0.05 })
    expect(surface.designPin.value).toEqual({ x: 24, y: 276 })
    view.setViewport({ x: 23.9, y: 150, scale: 0.05 })
    expect(surface.designPin.value).toBeNull()
    view.dispose()
  })

  it('settledRevision changes once per settle, a resize included', () => {
    vi.useFakeTimers()
    const view = createTestView()
    const surface = createViewReadSurface(view.frames)
    const seen: number[] = []
    const stop = effect(() => { seen.push(surface.settledRevision.value) })

    view.navigation.panByPx({ x: 25, y: -10 })
    vi.advanceTimersByTime(SETTLE_MS - 1)
    view.navigation.panByPx({ x: -3, y: 4 })
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(view.frames.viewFrame.peek().revision)

    view.host.current().setScreen({ width: 640, height: 480, devicePixelRatio: 1 })
    vi.advanceTimersByTime(SETTLE_MS)
    expect(seen).toHaveLength(3)
    expect(seen[2]).toBe(view.frames.viewFrame.peek().revision)
    expect(view.frames.settledViewFrame.peek().view.screen.width).toBe(640)

    // Nothing new published: no further settle.
    vi.advanceTimersByTime(SETTLE_MS * 4)
    expect(seen).toHaveLength(3)
    stop()
    view.dispose()
  })

  it('captureView returns the live camera and its screen', () => {
    const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    const view = createTestView({ plane, viewport: { x: -130.5, y: 42.25, scale: 1.75 } })
    const surface = createViewReadSurface(view.frames)

    const captured = surface.captureView()
    expect(captured.camera).toBe(view.view().camera)
    expect(captured.screen).toEqual({ width: 400, height: 300, devicePixelRatio: 1 })

    view.host.current().apply({ kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 30 })
    const turned = surface.captureView()
    expect(turned.camera).toBe(view.view().camera)
    expect(turned.camera.bearingDeg).toBe(30)
    view.dispose()
  })
})
