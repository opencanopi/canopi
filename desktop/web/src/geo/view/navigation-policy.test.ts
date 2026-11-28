import { signal } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import { MAPLIBRE_WORLD_TILE_SIZE } from '../projection'
import { geoToMercator } from '../web-mercator'
import {
  angularDistanceToNorth,
  constrainCamera,
  createNavigationPolicy,
  nextStep,
  normaliseBearing,
  roundToStep,
  shortestArc,
  snapBearing,
  worldZoomFloor,
} from './navigation-policy'
import type { ViewCamera, ViewScreen } from './types'

const POLICY = createNavigationPolicy(0, signal(false))
const LANDSCAPE: ViewScreen = { width: 1000, height: 800, devicePixelRatio: 1 }
const PORTRAIT: ViewScreen = { width: 700, height: 2000, devicePixelRatio: 2 }
const SMALL: ViewScreen = { width: 400, height: 300, devicePixelRatio: 1 }

function camera(lon: number, lat: number, zoom: number, bearingDeg: number): ViewCamera {
  return { center: { lon, lat }, zoom, bearingDeg, pitchDeg: 0 }
}

/** The four screen corners on the Mercator square [0, 1]², computed here, not with the view module's maths. */
function groundCornersMercator(view: ViewCamera, screen: ViewScreen): Array<{ x: number; y: number }> {
  const centre = geoToMercator(view.center.lon, view.center.lat)
  const worldSize = MAPLIBRE_WORLD_TILE_SIZE * 2 ** view.zoom
  const radians = view.bearingDeg * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [[0, 0], [screen.width, 0], [screen.width, screen.height], [0, screen.height]].map(([x, y]) => {
    const dx = x! - screen.width / 2
    const dy = y! - screen.height / 2
    return { x: centre.x + (cos * dx - sin * dy) / worldSize, y: centre.y + (sin * dx + cos * dy) / worldSize }
  })
}

function lonLat(view: ViewCamera): [number, number] {
  return [view.center.lon, view.center.lat]
}

function expectInsideOneWorld(view: ViewCamera, screen: ViewScreen): void {
  for (const corner of groundCornersMercator(view, screen)) {
    expect(corner.x).toBeGreaterThanOrEqual(-1e-9)
    expect(corner.x).toBeLessThanOrEqual(1 + 1e-9)
    expect(corner.y).toBeGreaterThanOrEqual(-1e-9)
    expect(corner.y).toBeLessThanOrEqual(1 + 1e-9)
  }
}

describe('navigation policy', () => {
  it('is built from the workspace camera limits at the reference latitude', () => {
    const reducedMotion = signal(true)
    const policy = createNavigationPolicy(48.85, reducedMotion)

    expect(policy).toMatchObject({
      referenceLatitudeDeg: 48.85,
      minZoom: 0,
      maxZoom: 27,
    })
    expect(policy.reducedMotion).toBe(reducedMotion)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('the world floor is log2(hypot(w, h)/512) at every bearing', () => {
    for (const screen of [SMALL, LANDSCAPE, PORTRAIT, { width: 1920, height: 1080, devicePixelRatio: 1.5 }]) {
      const floor = Math.log2(Math.hypot(screen.width, screen.height) / MAPLIBRE_WORLD_TILE_SIZE)
      expect(worldZoomFloor(screen)).toBeCloseTo(floor, 6)
      for (const bearingDeg of [0, 20, 45, 90, 135, 200, 359.5]) {
        const constrained = constrainCamera(camera(170, 80, -1, bearingDeg), screen, POLICY)
        expect(constrained.zoom).toBeCloseTo(Math.max(POLICY.minZoom, floor), 6)
        expect(constrained.bearingDeg).toBe(bearingDeg)
      }
    }
  })

  it('at the world floor the screen diagonal is the whole world, so the centre cannot move', () => {
    for (const bearingDeg of [0, 45, 90]) {
      const constrained = constrainCamera(camera(170, 80, 0, bearingDeg), LANDSCAPE, POLICY)
      expect(constrained.center.lon).toBeCloseTo(0, 6)
      expect(constrained.center.lat).toBeCloseTo(0, 6)
      expectInsideOneWorld(constrained, LANDSCAPE)
    }
  })

  it('a turn at the world floor keeps the zoom and the centre', () => {
    const atNorth = constrainCamera(camera(0, 0, 0, 0), LANDSCAPE, POLICY)
    expect(constrainCamera(atNorth, LANDSCAPE, POLICY)).toBe(atNorth)

    for (const bearingDeg of [15, 45, 90, 200]) {
      const turned = { ...atNorth, bearingDeg }
      // The floor and the hold already cover the screen at every bearing: a turn has nothing to constrain.
      expect(constrainCamera(turned, LANDSCAPE, POLICY)).toBe(turned)
      expectInsideOneWorld(turned, LANDSCAPE)
    }
  })

  it('the pan hold keeps half the screen diagonal inside one world on both axes, at every bearing', () => {
    const zoom = 3
    const half = Math.hypot(LANDSCAPE.width, LANDSCAPE.height) / 2 / (MAPLIBRE_WORLD_TILE_SIZE * 2 ** zoom)
    const held = constrainCamera(camera(250, 89, zoom, 0), LANDSCAPE, POLICY)
    const centre = geoToMercator(held.center.lon, held.center.lat)
    expect(centre.x).toBeCloseTo(1 - half, 6)
    expect(centre.y).toBeCloseTo(half, 6)
    const opposite = geoToMercator(...lonLat(constrainCamera(camera(-250, -89, zoom, 0), LANDSCAPE, POLICY)))
    expect(opposite.x).toBeCloseTo(half, 6)
    expect(opposite.y).toBeCloseTo(1 - half, 6)
    for (const bearingDeg of [0, 30, 45, 90, 135, 300]) {
      // The same hold at every bearing, and the held screen stays inside the world turned to any bearing.
      const turned = constrainCamera(camera(250, 89, zoom, bearingDeg), LANDSCAPE, POLICY)
      expect(turned.center.lon).toBeCloseTo(held.center.lon, 6)
      expect(turned.center.lat).toBeCloseTo(held.center.lat, 6)
      expectInsideOneWorld(turned, LANDSCAPE)
    }
  })

  it('constrain is idempotent', () => {
    const screens = [SMALL, LANDSCAPE, PORTRAIT, { width: 0, height: 0, devicePixelRatio: 1 }]
    for (const screen of screens) {
      for (const zoom of [-3, 0, 0.7, 5, 30]) {
        for (const lon of [-250, -179.99, 0, 13.4, 179.99, 400]) {
          for (const lat of [-89, -60, 0, 85.05, 89]) {
            for (const bearingDeg of [0, 30, 45, 90, 200, 359.5]) {
              const once = constrainCamera(camera(lon, lat, zoom, bearingDeg), screen, POLICY)
              expect(constrainCamera(once, screen, POLICY)).toBe(once)
            }
          }
        }
      }
    }
  })

  it('constrain clamps zoom to the policy range and holds longitude inside one world', () => {
    expect(constrainCamera(camera(0, 0, 30, 0), SMALL, POLICY).zoom).toBe(27)
    expect(constrainCamera(camera(0, 0, -2, 0), SMALL, POLICY).zoom).toBe(0)

    const pastTheAntimeridian = constrainCamera(camera(200, 10, 5, 0), SMALL, POLICY)
    expect(pastTheAntimeridian.zoom).toBe(5)
    expect(pastTheAntimeridian.center.lon).toBeLessThan(180)
    expectInsideOneWorld(pastTheAntimeridian, SMALL)

    const westOfTheWorld = constrainCamera(camera(-181, -10, 5, 30), SMALL, POLICY)
    expect(westOfTheWorld.center.lon).toBeGreaterThan(-180)
    expectInsideOneWorld(westOfTheWorld, SMALL)

    const pastThePole = constrainCamera(camera(0, 89, 5, 0), SMALL, POLICY)
    expect(pastThePole.center.lat).toBeLessThan(85.0511287798066)
    expectInsideOneWorld(pastThePole, SMALL)

    const inside = camera(13.4, 52.5, 18, 30)
    expect(constrainCamera(inside, SMALL, POLICY)).toBe(inside)
  })

  it('the zoom floor does not depend on the centre or the bearing', () => {
    const centres = [[0, 0], [179, 85], [-120, -60], [45, 30]] as const
    const zooms = [0, 20, 45, 90].flatMap((bearingDeg) =>
      centres.map(([lon, lat]) => constrainCamera(camera(lon, lat, -1, bearingDeg), LANDSCAPE, POLICY).zoom))
    expect(new Set(zooms).size).toBe(1)
    expect(zooms[0]).toBeCloseTo(Math.log2(Math.hypot(1000, 800) / MAPLIBRE_WORLD_TILE_SIZE), 6)
  })

  it('bearing helpers follow the spec examples', () => {
    expect(normaliseBearing(-1e-14)).toBe(0)
    expect(normaliseBearing(360)).toBe(0)
    expect(normaliseBearing(-0)).toBe(0)
    expect(normaliseBearing(-90)).toBe(270)
    expect(normaliseBearing(725)).toBe(5)
    expect(angularDistanceToNorth(359.99)).toBeLessThan(0.05)
    expect(angularDistanceToNorth(200)).toBe(160)
    expect(snapBearing(5)).toBe(0)
    expect(snapBearing(353)).toBe(0)
    expect(snapBearing(8)).toBe(8)
    expect(roundToStep(22, 15)).toBe(15)
    expect(roundToStep(353, 15)).toBe(0)
    expect([0, 22, 352].map((deg) => nextStep(deg, 1, 15))).toEqual([15, 30, 0])
    expect([0, 22, 352].map((deg) => nextStep(deg, -1, 15))).toEqual([345, 15, 345])
    expect(nextStep(15.0000000001, 1, 15)).toBe(30)
    expect(nextStep(29.9999999999, -1, 15)).toBe(15)
    expect(shortestArc(350, 10)).toBe(20)
    expect(shortestArc(10, 350)).toBe(-20)
    expect(shortestArc(0, 180)).toBe(180)
    expect(shortestArc(180, 0)).toBe(180)
  })
})
