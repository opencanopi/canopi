// canvas/runtime/view/navigation-policy.ts  (pure; shared by both drivers)
//
// Owns the navigation limits both camera drivers apply: the policy values, the one constrain function
// (zoom range, the bearing-free world floor, the one-world hold of the screen diagonal), and the bearing
// arithmetic (normalising, snapping, steps, shortest arcs).

import type { ReadonlySignal } from '@preact/signals'
import { MAPLIBRE_WORLD_TILE_SIZE, mercatorToGeo } from '../projection'
import { mapZoomToStageScale } from '../session-plane'
import { WORKSPACE_MAP_MAX_ZOOM, WORKSPACE_MAP_MIN_ZOOM } from '../workspace-camera-policy'
import type { ViewCamera, ViewScreen } from './types'

/**
 * Built by createNavigationPolicy(referenceLatitudeDeg, reducedMotion) from the workspace camera's limits
 * (canvas/workspace-camera-policy.ts: pure, and P4 lets view/ import it). The reference latitude turns zooms into px/m (scaleBoundsAt →
 * ViewFrame.scaleBounds).
 */
export interface NavigationPolicy {
  readonly referenceLatitudeDeg: number    // the session plane's latitude (the driver host's, per plane)
  readonly minZoom: number                 // 0
  readonly maxZoom: number                 // 27
  /** prefers-reduced-motion: reduce, a live matchMedia signal made in app/canvas-runtime/app-adapter.ts, declared on canvas/runtime/app-adapter.ts and
   *  passed to createCameraDriverHost; view/ never calls matchMedia (P4). Flights become jumps while true (turns always jump, U34). */
  readonly reducedMotion: ReadonlySignal<boolean>
}

export const ROTATE_DEG_PER_PX = 0.8                                  // MapLibre's rate
/** Free gestures and the compass snap to north within this angle on release. */
const SNAP_TO_NORTH_DEG = 7

/** Bearings this close to a whole multiple of 360 read as north. */
const FULL_TURN_EPSILON_DEG = 1e-9
/** A step count this close to a whole number is that multiple (bearings arrive through float arithmetic). */
const STEP_EPSILON = 1e-9
const DEGREES_TO_RADIANS = Math.PI / 180

export function createNavigationPolicy(referenceLatitudeDeg: number, reducedMotion: ReadonlySignal<boolean>): NavigationPolicy {
  return Object.freeze({
    referenceLatitudeDeg,
    minZoom: WORKSPACE_MAP_MIN_ZOOM,
    maxZoom: WORKSPACE_MAP_MAX_ZOOM,
    reducedMotion,
  })
}

/**
 * Clamp zoom to [max(policy.minZoom, worldZoomFloor(screen)), policy.maxZoom], then hold the screen centre at least half the
 * screen diagonal (in px at that zoom) inside one world: latitude inside ±85.05° and longitude inside ±180°. Bearing-free (U34): the
 * floor and the hold cover the viewport at every bearing, so a turn never changes them. It replaces all of MapLibre's
 * defaultConstrain (setConstrainOverride replaces the zoom range and the longitude hold too). Idempotent. The floor depends on the
 * screen only, never on the centre, because MapLibre calls the guard on intermediate (old centre, new zoom) states. A camera that
 * needs no change is returned as the same object.
 */
export function constrainCamera(camera: ViewCamera, screen: ViewScreen, policy: NavigationPolicy): ViewCamera {
  const minimum = Math.min(policy.maxZoom, Math.max(policy.minZoom, worldZoomFloor(screen)))
  const zoom = Math.min(policy.maxZoom, Math.max(minimum, camera.zoom))

  const half = screenDiagonal(screen) / 2 / (MAPLIBRE_WORLD_TILE_SIZE * 2 ** zoom)
  const west = half <= 0.5 ? mercatorToGeo(half, 0.5).lng : 0
  const east = half <= 0.5 ? mercatorToGeo(1 - half, 0.5).lng : 0
  const north = half <= 0.5 ? mercatorToGeo(0.5, half).lat : 0
  const south = half <= 0.5 ? mercatorToGeo(0.5, 1 - half).lat : 0
  const lon = Math.min(east, Math.max(west, camera.center.lon))
  const lat = Math.min(north, Math.max(south, camera.center.lat))

  if (zoom === camera.zoom && lon === camera.center.lon && lat === camera.center.lat) return camera
  const center = lon === camera.center.lon && lat === camera.center.lat ? camera.center : { lon, lat }
  return { center, zoom, bearingDeg: camera.bearingDeg, pitchDeg: 0 }
}

/** The world floor: log2(hypot(width, height) / 512), so the screen diagonal never exceeds one world (U34); −∞ for an empty screen. */
export function worldZoomFloor(screen: ViewScreen): number {
  return Math.log2(screenDiagonal(screen) / MAPLIBRE_WORLD_TILE_SIZE)
}

/**
 * ViewFrame.scaleBounds (spec §1.1b): the policy's zoom range with the world floor, in px/m at the reference latitude. On a screen
 * whose diagonal is at most 512 px, the policy's zoom range alone: the world floor does not bite.
 */
export function scaleBoundsAt(screen: ViewScreen, policy: NavigationPolicy): { readonly min: number; readonly max: number } {
  const minZoom = Math.min(policy.maxZoom, Math.max(policy.minZoom, worldZoomFloor(screen)))
  return Object.freeze({
    min: mapZoomToStageScale(minZoom, policy.referenceLatitudeDeg),
    max: mapZoomToStageScale(policy.maxZoom, policy.referenceLatitudeDeg),
  })
}

/** Any angle to [0, 360); results ≥ 360 − 1e-9 become 0 (so normaliseBearing(-1e-14) === 0). */
export function normaliseBearing(deg: number): number {
  let bearing = deg % 360
  if (bearing < 0) bearing += 360
  return bearing >= 360 - FULL_TURN_EPSILON_DEG || bearing === 0 ? 0 : bearing
}

/** min(b mod 360, 360 − b mod 360): the one test for "near north". */
export function angularDistanceToNorth(deg: number): number {
  const bearing = normaliseBearing(deg)
  return Math.min(bearing, 360 - bearing)
}

/** End of a free gesture: angularDistanceToNorth(deg) ≤ 7 → 0, else deg. */
export function snapBearing(deg: number): number {
  return angularDistanceToNorth(deg) <= SNAP_TO_NORTH_DEG ? 0 : deg
}

/** Absolute 15° multiples: round(deg / 15) * 15, normalised. */
export function roundToStep(deg: number, stepDeg: 15): number {
  return normaliseBearing(Math.round(deg / stepDeg) * stepDeg)
}

/** Key and compass steps: the next absolute multiple of 15 strictly in `direction` (22 → 15 → 0; 0 → 345). */
export function nextStep(deg: number, direction: 1 | -1, stepDeg: 15): number {
  const steps = normaliseBearing(deg) / stepDeg
  const whole = Math.round(steps)
  const from = Math.abs(steps - whole) < STEP_EPSILON ? whole : steps
  const next = direction > 0 ? Math.floor(from) + 1 : Math.ceil(from) - 1
  return normaliseBearing(next * stepDeg)
}

/** Shortest signed arc from a to b, in (-180, 180]. */
export function shortestArc(fromDeg: number, toDeg: number): number {
  const arc = normaliseBearing(toDeg - fromDeg)
  return arc > 180 ? arc - 360 : arc
}

/**
 * cos and sin of a bearing, exact at the four right angles (so bearing 0 is the unturned arithmetic bit for bit). Screen and plane
 * rotations in view/ all go through it.
 */
export function bearingCosSin(deg: number): readonly [number, number] {
  const bearing = normaliseBearing(deg)
  if (bearing === 0) return [1, 0]
  if (bearing === 90) return [0, 1]
  if (bearing === 180) return [-1, 0]
  if (bearing === 270) return [0, -1]
  const radians = bearing * DEGREES_TO_RADIANS
  return [Math.cos(radians), Math.sin(radians)]
}

function screenDiagonal(screen: ViewScreen): number {
  return Math.hypot(finiteSize(screen.width), finiteSize(screen.height))
}

function finiteSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
