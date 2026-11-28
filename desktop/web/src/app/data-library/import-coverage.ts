import { currentCanvasQuerySurface, getCurrentCanvasSession } from '../../canvas/session'
import { createSessionPlane } from '../../geo/session-plane'
import { editionPorts } from '../../platform/edition-ports'
import type { GeoPoint } from '../../types/design'

/** WGS84 `[west, south, east, north]`. */
export type GroundBox = readonly [number, number, number, number]

/**
 * Import › "Covers your site": how the chosen files lie against the Design.
 * `covers` holds the whole Design, `partial` part of it, `apart` none of it.
 * Sizes and distances are true WGS84 ground metres through `SessionPlane`.
 */
export type ImportCoverage =
  | { readonly kind: 'covers' | 'partial'; readonly widthM: number; readonly heightM: number }
  | { readonly kind: 'apart'; readonly distanceM: number }

/** The WGS84 box around geographic outline points; null while empty. */
function groundBoxOfPoints(points: readonly GeoPoint[]): GroundBox | null {
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
  const midLon = (fw + fe) / 2
  const midLat = (fs + fn) / 2
  const plane = createSessionPlane({ lon: midLon, lat: midLat })
  const gapLon = Math.max(0, fw - de, dw - fe)
  const gapLat = Math.max(0, fs - dn, ds - fn)
  if (gapLon > 0 || gapLat > 0) {
    const fileLon = fw > de ? fw : dw > fe ? fe : midLon
    const designLon = fw > de ? de : dw > fe ? dw : midLon
    const fileLat = fs > dn ? fs : ds > fn ? fn : midLat
    const designLat = fs > dn ? dn : ds > fn ? ds : midLat
    return {
      kind: 'apart',
      distanceM: plane.groundLength(
        plane.toPlane({ lon: fileLon, lat: fileLat }),
        plane.toPlane({ lon: designLon, lat: designLat }),
      ),
    }
  }
  const covers = fw <= dw && fs <= ds && fe >= de && fn >= dn
  return {
    kind: covers ? 'covers' : 'partial',
    widthM: plane.groundLength(plane.toPlane({ lon: fw, lat: midLat }), plane.toPlane({ lon: fe, lat: midLat })),
    heightM: plane.groundLength(plane.toPlane({ lon: midLon, lat: fs }), plane.toPlane({ lon: midLon, lat: fn })),
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
  const outline = getCurrentCanvasSession()?.queries.getSettledDesignOutline() ?? null
  const design = outline ? groundBoxOfPoints(outline) : null
  if (!design || paths.length === 0) return null
  try {
    const coverage = await editionPorts().dataLibrary.importCoverage(paths)
    return coverage.bounds ? compareCoverage(coverage.bounds, design) : null
  } catch (error) {
    console.warn('The import coverage check is unavailable:', error)
    return null
  }
}
