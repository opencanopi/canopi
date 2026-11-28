import type { PrintPoint, PrintZone } from '../../canvas/print'
import {
  isPointInPrintZoneGeometry,
  isPrintEllipseGeometry,
  isPrintLineGeometry,
  isPrintRectGeometry,
} from '../../canvas/runtime/zone-geometry'

interface ZoneDimension { id: string; start: PrintPoint; end: PrintPoint; metres: number }
export interface ZoneMeasurements { zone: PrintZone; reference: string; lengths: number[]; widths: number[]; dimensions: ZoneDimension[]; diameter: boolean }

export function insideZone(zone: PrintZone, point: PrintPoint): boolean {
  return isPointInPrintZoneGeometry(zone.geometry, point)
}

/**
 * Physical sizes derive from the captured primitive, never its axis-aligned bounds. `planZones` are the same zones,
 * index for index, unturned: E codes follow their plan order (top, then left, then name), so a code names the same
 * zone at every Map orientation.
 */
export function zoneMeasurements(
  zones: readonly PrintZone[],
  planZones: readonly PrintZone[] = zones,
  groundDistance: (a: PrintPoint, b: PrintPoint) => number,
): ZoneMeasurements[] {
  const ellipses = zones.map((_, i) => i).filter(i => isPrintEllipseGeometry(zones[i]!.geometry)).sort((a, b) => {
    const p = planZones[a]!.bounds, q = planZones[b]!.bounds
    return p.y - q.y || p.x - q.x || (zones[a]!.name ?? '').localeCompare(zones[b]!.name ?? '')
  })
  const reserved = new Set(zones.flatMap(z => z.name !== null && /^[ZE]\d+$/.test(z.name) ? [z.name] : [])), assigned = new Set<string>()
  let polygons = 0
  return zones.flatMap((zone, index): ZoneMeasurements[] => {
    const geometry = zone.geometry
    while (reserved.has(`Z${String(polygons + 1).padStart(2, '0')}`)) polygons++
    const generated = isPrintEllipseGeometry(geometry) ? `E${String(ellipses.indexOf(index) + 1).padStart(2, '0')}` : `Z${String(++polygons).padStart(2, '0')}`
    let reference = zone.name !== null && /^[ZE]\d+$/.test(zone.name) && !assigned.has(zone.name) ? zone.name : generated
    while (assigned.has(reference) || reserved.has(reference) && reference !== zone.name) reference = `Z${String(++polygons).padStart(2, '0')}`
    assigned.add(reference)
    if (!isPrintEllipseGeometry(geometry)) {
      const points = geometry.points
      if (points.length < 2) return []
      const isLine = isPrintLineGeometry(geometry)
      const edges = points.slice(0, isLine ? -1 : undefined).map((start, i) => {
        const end = points[(i + 1) % points.length]!
        return { id: `${reference}:${i}`, start, end, metres: groundDistance(start, end) }
      })
      const distinct = (values: number[]) => [...values].sort((a, b) => a - b).filter((n, i, all) => !i || Math.abs(n - all[i - 1]!) >= .005)
      let lengths: ZoneDimension[], widths: ZoneDimension[] = []
      if (isPrintRectGeometry(geometry) && points.length === 4) {
        const longest = edges.reduce((best, edge, i) => edge.metres > edges[best]!.metres ? i : best, 0)
        lengths = [edges[longest]!]
        widths = [edges[(longest + 1) % 4]!, edges[(longest + 3) % 4]!]
      } else {
        const direction = (e: ZoneDimension) => ({ x: (e.end.x - e.start.x) / e.metres, y: (e.end.y - e.start.y) / e.metres })
        const dot = (a: ZoneDimension, b: ZoneDimension) => { const u = direction(a), v = direction(b); return u.x * v.x + u.y * v.y }
        const parallelAngleRad = (3 * Math.PI) / 180
        const parallel = Math.cos(parallelAngleRad)
        // A bed end joins longer, opposing sides. Tiny notches are not bed widths.
        widths = isLine ? [] : edges.filter((e, i) => {
          const before = edges[(i + edges.length - 1) % edges.length]!, after = edges[(i + 1) % edges.length]!
          return before.metres > e.metres && after.metres > e.metres && dot(before, after) < -parallel
        })
        lengths = edges
        if (widths.length > 0 && widths.length <= 2) {
          const chains: ZoneDimension[][] = []
          for (const edge of edges) {
            const previous = chains[chains.length - 1]
            if (previous && dot(previous[previous.length - 1]!, edge) > parallel) previous.push(edge)
            else chains.push([edge])
          }
          if (chains.length > 1 && dot(chains[chains.length - 1]![0]!, chains[0]![0]!) > parallel) chains[0] = [...chains.pop()!, ...chains[0]!]
          const groups: ZoneDimension[][][] = []
          for (const chain of chains) {
            const group = groups.find(group => Math.abs(dot(group[0]![0]!, chain[0]!)) > parallel)
            if (group) group.push(chain); else groups.push([chain])
          }
          const total = (chain: ZoneDimension[]) => chain.reduce((sum, e) => sum + e.metres, 0)
          const minimum = Math.max(...widths.map(e => e.metres))
          const selected = new Set(groups.map(group => [...group].sort((a, b) => total(b) - total(a))[0]!)
            .filter(chain => total(chain) > minimum + .005).flat())
          const starts = edges.filter((edge, i) => selected.has(edge) && !selected.has(edges[(i + edges.length - 1) % edges.length]!))
          if (starts.length === 1) {
            const longest = edges.reduce((best, edge, i) => selected.has(edge) && edge.metres > edges[best]!.metres ? i : best,
              edges.findIndex(e => selected.has(e)))
            lengths = edges.map((_, i) => edges[(longest - i + edges.length) % edges.length]!).filter(e => selected.has(e))
          } else widths = []
        } else widths = []

      }
      const widthValues = distinct(widths.map(e => e.metres))
      const dimensionWidths = widthValues.map(n => widths.find(e => Math.abs(e.metres - n) < .005)!)
      return [{ zone, reference, lengths: lengths.map(e => e.metres), widths: widthValues,
        dimensions: [...lengths, ...dimensionWidths], diameter: false }]
    }
    const { center, radii, rotation } = geometry, angle = rotation * Math.PI / 180
    const dimensions = [{ x: radii.x, y: 0 }, { x: 0, y: radii.y }].map((p, i) => {
      const dx = p.x * Math.cos(angle) - p.y * Math.sin(angle), dy = p.x * Math.sin(angle) + p.y * Math.cos(angle)
      const start = { x: center.x - dx, y: center.y - dy }
      const end = { x: center.x + dx, y: center.y + dy }
      return { id: `${reference}:${i}`, start, end, metres: groundDistance(start, end) }
    })
    return [{ zone, reference, lengths: [dimensions[0]!.metres], widths: [dimensions[1]!.metres], dimensions, diameter: true }]
  })
}
