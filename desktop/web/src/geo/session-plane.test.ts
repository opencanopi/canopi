// @vitest-environment jsdom
// geo/session-plane.test.ts
// Behavioural & contract tests for the WGS84 per-axis session plane, ground measure,
// point brands, Pixi WorldRootContainer affine seam, and input/navigation seams
// (ADR 0001, ADR 0016, contracts §20, 2.1-Q78d, 2.1-M519, 2.1-M520).

import 'pixi.js/unsafe-eval'
import { AlphaFilter, Container, Graphics } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { createTestView } from '../__tests__/support/test-view'
import { createWorldLayers } from '../canvas/runtime/renderers/world-layers'
import { WorldRootContainer, writeWorldAffine } from '../canvas/runtime/renderers/scene-paint'
import type { GeoPoint } from '../types/design'
import { WGS84_FLATTENING, WGS84_SEMI_MAJOR_AXIS_M } from '../generated/canopi-design-format'
import {
  conformalFixturePlaneForTests,
  conformalPoint,
  createSessionPlane,
  roundGeoDegrees,
  type ConformalPoint,
  type PlanePoint,
} from './session-plane'
import { buildViewTransform } from './view/view-transform'

const planePoint = (x: number, y: number): PlanePoint => ({ x, y })

const DEG_TO_RAD = Math.PI / 180

/** Independent WGS84 Vincenty inverse geodesic distance (metres) for 1 ppm verification. */
function vincentyDistanceM(a: GeoPoint, b: GeoPoint): number {
  const f = WGS84_FLATTENING
  const aAxis = WGS84_SEMI_MAJOR_AXIS_M
  const bAxis = aAxis * (1 - f)
  const phi1 = a.lat * DEG_TO_RAD
  const phi2 = b.lat * DEG_TO_RAD
  const L = (b.lon - a.lon) * DEG_TO_RAD
  const U1 = Math.atan((1 - f) * Math.tan(phi1))
  const U2 = Math.atan((1 - f) * Math.tan(phi2))
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2)

  let lambda = L
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0
  for (let iter = 0; iter < 100; iter++) {
    const sinLambda = Math.sin(lambda)
    const cosLambda = Math.cos(lambda)
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    if (sinSigma === 0) return 0
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cosSqAlpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha))
    const prev = lambda
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (Math.abs(lambda - prev) < 1e-13) break
  }
  const uSq = (cosSqAlpha * (aAxis * aAxis - bAxis * bAxis)) / (bAxis * bAxis)
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const deltaSigma = B * sinSigma * (
    cos2SigmaM
    + (B / 4) * (
      cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
      - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
    )
  )
  return bAxis * A * (sigma - deltaSigma)
}

/** Exact WGS84 authalic latitude-band area of a [lonMin..lonMax] × [latMin..latMax] box (m²). */
function wgs84GeoBoxAreaM2(west: number, south: number, east: number, north: number): number {
  const e2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING)
  const e = Math.sqrt(e2)
  const b2 = WGS84_SEMI_MAJOR_AXIS_M * WGS84_SEMI_MAJOR_AXIS_M * (1 - e2)
  const q = (latDeg: number): number => {
    const s = Math.sin(latDeg * DEG_TO_RAD)
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)))
  }
  const dLonRad = (east - west) * DEG_TO_RAD
  return Math.abs((b2 * dLonRad * (q(north) - q(south))) / (2 * (1 - e2)))
}

describe('WGS84 per-axis session plane (ADR 0001, contracts §20)', () => {
  it('matches WGS84 Vincenty reference within 1 ppm over a 10 km site at 0°, 49°, and 65°', () => {
    for (const lat of [0, 49, 65]) {
      const plane = createSessionPlane({ lon: 2.35, lat })
      expect(plane.anchor).toEqual({ lon: 2.35, lat })
      expect(plane.groundScaleAt(planePoint(0, 0))).toEqual({ x: 1, y: 1 })

      // Segments spanning up to 10 km across the site in E-W, N-S, and diagonal directions
      const segments: ReadonlyArray<readonly [PlanePoint, PlanePoint]> = [
        [planePoint(-5000, 0), planePoint(5000, 0)],
        [planePoint(0, -5000), planePoint(0, 5000)],
        [planePoint(-3500, -3500), planePoint(3500, 3500)],
        [planePoint(2000, -4000), planePoint(-4000, 3000)],
      ]
      for (const [a, b] of segments) {
        const expected = vincentyDistanceM(plane.toGeo(a), plane.toGeo(b))
        const actual = plane.groundLength(a, b)
        const relErrorPpm = (Math.abs(actual - expected) / expected) * 1e6
        expect(relErrorPpm, `lat=${lat} relErrorPpm=${relErrorPpm.toFixed(4)}`).toBeLessThan(1)
      }
    }
  })

  it('matches exact WGS84 ellipsoidal box area within 1 ppm over a 10 km site at 0°, 49°, and 65°', () => {
    for (const lat of [0, 49, 65]) {
      const plane = createSessionPlane({ lon: 10.5, lat })
      const sw = plane.toGeo(planePoint(-5000, 5000))
      const ne = plane.toGeo(planePoint(5000, -5000))
      const ring: readonly PlanePoint[] = [
        plane.toPlane({ lon: sw.lon, lat: sw.lat }),
        plane.toPlane({ lon: ne.lon, lat: sw.lat }),
        plane.toPlane({ lon: ne.lon, lat: ne.lat }),
        plane.toPlane({ lon: sw.lon, lat: ne.lat }),
      ]
      const expected = wgs84GeoBoxAreaM2(sw.lon, sw.lat, ne.lon, ne.lat)
      const actual = plane.groundArea(ring)
      const relErrorPpm = (Math.abs(actual - expected) / expected) * 1e6
      expect(relErrorPpm, `lat=${lat} area relErrorPpm=${relErrorPpm.toFixed(4)}`).toBeLessThan(1)
    }
  })

  it('a rotated 100 m square at 49° keeps its ground sides within 1 cm and corners within 5″', () => {
    const plane = createSessionPlane({ lon: 2.3522, lat: 49 })
    for (const angleDeg of [0, 23, 45, 67]) {
      const rad = angleDeg * DEG_TO_RAD
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const half = 50
      const corners = [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ].map(([u, v]) => planePoint(u! * cos - v! * sin, u! * sin + v! * cos))

      const geoCorners = corners.map((c) => plane.toGeo(c))
      // Check all 4 side lengths via independent Vincenty distance
      const sides = [0, 1, 2, 3].map((i) => vincentyDistanceM(geoCorners[i]!, geoCorners[(i + 1) % 4]!))
      for (const side of sides) {
        expect(Math.abs(side - 100)).toBeLessThan(0.01) // < 1 cm
      }
      // Check all 4 corner angles via spherical/ellipsoidal law of cosines on Vincenty diagonals
      for (let i = 0; i < 4; i++) {
        const a = sides[(i + 3) % 4]!
        const b = sides[i]!
        const diag = vincentyDistanceM(geoCorners[(i + 3) % 4]!, geoCorners[(i + 1) % 4]!)
        const cosAngle = (a * a + b * b - diag * diag) / (2 * a * b)
        const cornerDeg = Math.acos(Math.max(-1, Math.min(1, cosAngle))) / DEG_TO_RAD
        const errArcsec = Math.abs(cornerDeg - 90) * 3600
        expect(errArcsec).toBeLessThan(5) // < 5″
      }
    }
  })

  it('re-origin round-trip at 1e-9° write-back rounding is idempotent', () => {
    const planeA = createSessionPlane({ lon: 2.3522, lat: 49 })
    const planeB = createSessionPlane({ lon: 2.52, lat: 49.08 })
    const initial: GeoPoint = { lon: roundGeoDegrees(2.4123456789), lat: roundGeoDegrees(49.0234567891) }

    const pass1 = planeA.toGeo(planeA.toPlane(initial))
    const written1: GeoPoint = { lon: roundGeoDegrees(pass1.lon), lat: roundGeoDegrees(pass1.lat) }
    expect(written1).toEqual(initial)

    const pass2 = planeB.toGeo(planeB.toPlane(written1))
    const written2: GeoPoint = { lon: roundGeoDegrees(pass2.lon), lat: roundGeoDegrees(pass2.lat) }
    expect(written2).toEqual(written1)
  })

  it('keeps PlanePoint and ConformalPoint distinct at compile time and separates conformalFixturePlaneForTests', () => {
    const truePlane = createSessionPlane({ lon: 0, lat: 0 })
    const fixture = conformalFixturePlaneForTests({ lon: 0, lat: 0 })
    expect(truePlane.axisScale.ax).toBeGreaterThan(1.003)
    expect(truePlane.axisScale.ay).toBeLessThan(0.997)
    expect(fixture.axisScale).toEqual({ ax: 1, ay: 1 })

    const p: PlanePoint = planePoint(10, 20)
    const c: ConformalPoint = truePlane.toView(p)
    // @ts-expect-error PlanePoint cannot be passed directly to fromView without toView
    void (() => truePlane.fromView(p))
    // @ts-expect-error ConformalPoint cannot be passed directly to toGeo without fromView
    void (() => truePlane.toGeo(c))
    const back = truePlane.fromView(c)
    expect(back.x).toBeCloseTo(p.x, 12)
    expect(back.y).toBeCloseTo(p.y, 12)
    expect(conformalPoint(1, 2).x).toBe(1)
  })
})

describe('true-metres real-path seams (renderer and input)', () => {
  it('renderer seam: WorldRootContainer updateLocalTransform writes exact affine with AlphaFilter at 0°, 49°, 65°', () => {
    for (const lat of [0, 49, 65]) {
      const plane = createSessionPlane({ lon: 2.35, lat })
      const view = buildViewTransform({
        camera: { center: { lon: 2.351, lat: lat + 0.0005 }, zoom: 17, bearingDeg: 37, pitchDeg: 0 },
        screen: { width: 1280, height: 800, devicePixelRatio: 1 },
        plane,
        planeRevision: 1,
      })
      const stage = new Container()
      const root = new WorldRootContainer()
      const child = new Graphics().rect(0, 0, 100, 100).fill(0x2d6a4f)
      child.filters = [new AlphaFilter({ alpha: 0.7 })]
      root.addChild(child)
      stage.addChild(root)

      writeWorldAffine(root, view)
      root.updateLocalTransform()

      const [a, b, c, d, tx, ty] = view.planar.affine
      expect(root.localTransform.a).toBe(a)
      expect(root.localTransform.b).toBe(b)
      expect(root.localTransform.c).toBe(c)
      expect(root.localTransform.d).toBe(d)
      expect(root.localTransform.tx).toBe(tx)
      expect(root.localTransform.ty).toBe(ty)

      for (const wp of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: -250, y: 180 }]) {
        const expected = view.worldToScreen(wp)
        const projected = root.toGlobal(wp)
        expect(Math.hypot(projected.x - expected.x, projected.y - expected.y)).toBeLessThan(1e-6)
      }

      // Also verify createWorldLayers uses WorldRootContainer and updates cleanly on a second affine
      const view2 = buildViewTransform({
        camera: { center: { lon: 2.352, lat: lat + 0.001 }, zoom: 18, bearingDeg: 112, pitchDeg: 0 },
        screen: { width: 1280, height: 800, devicePixelRatio: 1 },
        plane,
        planeRevision: 1,
      })
      writeWorldAffine(root, view2)
      root.updateLocalTransform()
      expect([
        root.localTransform.a,
        root.localTransform.b,
        root.localTransform.c,
        root.localTransform.d,
        root.localTransform.tx,
        root.localTransform.ty,
      ]).toEqual([...view2.planar.affine])
      const wp2 = { x: 42, y: -19 }
      const expected2 = view2.worldToScreen(wp2)
      const projected2 = root.toGlobal(wp2)
      expect(Math.hypot(projected2.x - expected2.x, projected2.y - expected2.y)).toBeLessThan(1e-6)

      const layers = createWorldLayers()
      layers.present(view)
      expect(layers.root).toBeInstanceOf(WorldRootContainer)
      layers.root.updateLocalTransform()
      expect(layers.root.localTransform.a).toBe(a)
      expect(layers.root.localTransform.d).toBe(d)
      stage.destroy({ children: true })
    }
  })

  it('groundArea handles concave L-shapes and both CW/CCW windings at 49° and 65°', () => {
    for (const lat of [49, 65]) {
      const plane = createSessionPlane({ lon: 2.35, lat })
      // 100 m × 100 m square with a 40 m × 50 m corner cutout -> 8000 m²
      const ccw: PlanePoint[] = [
        planePoint(0, 0),
        planePoint(100, 0),
        planePoint(100, 50),
        planePoint(60, 50),
        planePoint(60, 100),
        planePoint(0, 100),
      ]
      const cw = [...ccw].reverse()
      const areaCcw = plane.groundArea(ccw)
      const areaCw = plane.groundArea(cw)
      expect(Math.abs(areaCcw - areaCw)).toBeLessThan(1e-9)
      expect(Math.abs(areaCcw - 8000) / 8000).toBeLessThan(1e-4)
    }
  })

  it('input seam: screenToWorld hit-test and turnToEdge stay exact under anisotropic affine at 49° and 65°', () => {
    for (const lat of [49, 65]) {
      const plane = createSessionPlane({ lon: 10, lat })
      const testView = createTestView({
        plane,
        screen: { width: 1000, height: 800, devicePixelRatio: 1 },
        camera: { center: plane.origin, zoom: 17, bearingDeg: 37, pitchDeg: 0 },
      })
      const view = testView.view()
      for (const wp of [{ x: 12.5, y: -33.2 }, { x: -120, y: 85.4 }, { x: 0, y: 0 }]) {
        const sp = view.worldToScreen(wp)
        const hit = view.screenToWorld(sp)
        expect(Math.hypot(hit.x - wp.x, hit.y - wp.y)).toBeLessThan(1e-9)
      }

      // turnToEdge must make the ground edge truly horizontal on screen under the anisotropic affine
      const edgeA = planePoint(0, 0)
      const edgeB = planePoint(100, 100)
      testView.navigation.turnToEdge(edgeA, edgeB)
      const turned = testView.view()
      const screenA = turned.worldToScreen(edgeA)
      const screenB = turned.worldToScreen(edgeB)
      expect(Math.abs(screenA.y - screenB.y)).toBeLessThan(1e-6)
      testView.dispose()
    }
  })
})
