/**
 * Tests for projection.ts — canonical canvas↔map projection utilities.
 *
 * Plane-to-geographic conversion is the session plane's (session-plane.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { createSessionPlane } from '../geo/session-plane'

// ---------------------------------------------------------------------------
// stageScaleToMapZoom
// ---------------------------------------------------------------------------
describe('stageScaleToMapZoom', () => {
  it('at equator, stageScale=1 gives zoom ~16.25 in MapLibre 512px world units', () => {
    const zoom = createSessionPlane({ lon: 0, lat: 0 }).zoomForPixelsPerMetre(1)
    expect(zoom).toBeCloseTo(16.255, 1)
  })

  it('higher stageScale gives higher zoom (monotonic)', () => {
    const zoom1 = createSessionPlane({ lon: 0, lat: 45 }).zoomForPixelsPerMetre(1)
    const zoom2 = createSessionPlane({ lon: 0, lat: 45 }).zoomForPixelsPerMetre(2)
    const zoom4 = createSessionPlane({ lon: 0, lat: 45 }).zoomForPixelsPerMetre(4)
    expect(zoom2).toBeGreaterThan(zoom1)
    expect(zoom4).toBeGreaterThan(zoom2)
    expect(zoom2 - zoom1).toBeCloseTo(1, 5)
    expect(zoom4 - zoom2).toBeCloseTo(1, 5)
  })

  it('at 60N, stageScale=1 gives lower zoom than equator', () => {
    const zoomEquator = createSessionPlane({ lon: 0, lat: 0 }).zoomForPixelsPerMetre(1)
    const zoom60 = createSessionPlane({ lon: 0, lat: 60 }).zoomForPixelsPerMetre(1)
    expect(zoom60).toBeLessThan(zoomEquator)
    // On WGS84, Gaussian radius grows slightly from 0° to 60°N, so delta is ~0.9927 (2.1-Q78d)
    expect(zoomEquator - zoom60).toBeCloseTo(0.992738, 5)
  })

  it('at equator, stageScale=0.1 gives zoom ~12.93', () => {
    const zoom = createSessionPlane({ lon: 0, lat: 0 }).zoomForPixelsPerMetre(0.1)
    expect(zoom).toBeCloseTo(12.934, 1)
  })
})
