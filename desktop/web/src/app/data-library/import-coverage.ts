import { currentCanvasQuerySurface, getCurrentCanvasSession } from '../../canvas/session'
import type { CanvasDesignObjects } from '../../canvas/runtime/runtime'
import { lidarImportCoverage } from '../../ipc/lidar'

/** WGS84 `[west, south, east, north]`. */
export type GroundBox = readonly [number, number, number, number]

/**
 * Import › "Covers your site": how the chosen files lie against the Design.
 * `covers` holds the whole Design, `partial` part of it, `apart` none of it.
 * Sizes and distances are approximate ground metres.
 */
export type ImportCoverage =
  | { readonly kind: 'covers' | 'partial'; readonly widthM: number; readonly heightM: number }
  | { readonly kind: 'apart'; readonly distanceM: number }

const METRES_PER_DEGREE_LAT = 110_540
const METRES_PER_DEGREE_LON_AT_EQUATOR = 111_320

/** The box around the Design's plants, zones, notes and measurement guides; null while it has none. */
export function designGroundBox(objects: CanvasDesignObjects): GroundBox | null {
  const points = [
    ...objects.plants.map((plant) => plant.position),
    ...objects.zones.flatMap((zone) => zone.points),
    ...objects.annotations.map((annotation) => annotation.position),
    ...objects.measurementGuides.flatMap((guide) => [guide.start, guide.end]),
  ]
  if (points.length === 0) return null
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const point of points) {
    west = Math.min(west, point.lon)
    south = Math.min(south, point.lat)
    east = Math.max(east, point.lon)
    north = Math.max(north, point.lat)
  }
  return [west, south, east, north]
}

/** How the files' box lies against the Design's box. */
export function compareCoverage(files: GroundBox, design: GroundBox): ImportCoverage {
  const [fw, fs, fe, fn] = files
  const [dw, ds, de, dn] = design
  const lonMetres = METRES_PER_DEGREE_LON_AT_EQUATOR * Math.cos((((fs + fn) / 2) * Math.PI) / 180)
  const gapLon = Math.max(0, fw - de, dw - fe)
  const gapLat = Math.max(0, fs - dn, ds - fn)
  if (gapLon > 0 || gapLat > 0) {
    return { kind: 'apart', distanceM: Math.hypot(gapLon * lonMetres, gapLat * METRES_PER_DEGREE_LAT) }
  }
  const covers = fw <= dw && fs <= ds && fe >= de && fn >= dn
  return {
    kind: covers ? 'covers' : 'partial',
    widthM: (fe - fw) * lonMetres,
    heightM: (fn - fs) * METRES_PER_DEGREE_LAT,
  }
}

/**
 * The open Design's canvas, or null before it is ready. Reading it in a
 * render subscribes to it, so a check that could not compare yet runs again.
 */
export function coverageCanvas(): object | null {
  return currentCanvasQuerySurface.value
}

/**
 * Read where the chosen files lie and compare them with the open Design.
 * Null when there is nothing to compare: no Design objects yet, no file
 * extent readable, or the check itself failed (import still validates).
 */
export async function checkImportCoverage(paths: readonly string[]): Promise<ImportCoverage | null> {
  const objects = getCurrentCanvasSession()?.queries.getSettledDesignObjects() ?? null
  const design = objects ? designGroundBox(objects) : null
  if (!design || paths.length === 0) return null
  try {
    const coverage = await lidarImportCoverage(paths)
    return coverage.bounds ? compareCoverage(coverage.bounds, design) : null
  } catch (error) {
    console.warn('The import coverage check is unavailable:', error)
    return null
  }
}
