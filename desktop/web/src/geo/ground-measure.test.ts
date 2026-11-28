import { describe, expect, expectTypeOf, it } from 'vitest'
import { createSessionPlane, type Metres, type SquareMetres } from './session-plane'
import { measureZone } from '../canvas/runtime/zone-geometry'
import {
  createEllipticalZoneMeasurements,
  createLinearZoneMeasurements,
  createPolygonalZoneMeasurements,
  createRectangularZoneMeasurements,
} from '../canvas/runtime/zone-measurements'
import { createMeasurementGuidePresentation } from '../canvas/runtime/measurement-guides'
import { plantAlongPath } from '../canvas/plant-path/spacing'
import { readMapSelectionSummary } from '../app/map-selection/summary'
import { zoneLabel } from '../app/map-selection/zone-label'
import { groundScale } from '../app/canvas-pdf/page-furniture'
import { createTestCanvasQuerySurface } from '../__tests__/support/canvas-query-surface'
import { zoneMeasurements } from '../app/canvas-pdf/zone-measurements'
import { pageFrame, turnSnapshot } from '../app/canvas-pdf/page-frame'
import { buildCanvasPrintSnapshot } from '../canvas/runtime/print-snapshot'
import { screenAngleForWorldAngle } from './view/view-transform'
import { createTestView } from '../__tests__/support/test-view'

/** Independent WGS84 local-ellipsoid ground distance between two lon/lat points (no SessionPlane reuse). */
function independentWgs84Length(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const A = 6_378_137
  const E2 = 2 / 298.257223563 - (1 / 298.257223563) ** 2
  const phi = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi)
  const w = Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const nu = A / w
  const rho = (A * (1 - E2)) / (w * w * w)
  const east = (((b.lon - a.lon) * Math.PI) / 180) * nu * cosPhi
  const north = (((b.lat - a.lat) * Math.PI) / 180) * rho
  return Math.hypot(east, north)
}

describe('WGS84 ground measure everywhere (2m-2)', () => {
  it('brands groundLength as Metres and groundArea as SquareMetres', () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    const length = plane.groundLength({ x: 0, y: 0 }, { x: 10, y: 0 })
    const area = plane.groundArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])

    expectTypeOf(length).toEqualTypeOf<Metres>()
    expectTypeOf(area).toEqualTypeOf<SquareMetres>()
    expect(length).toBeGreaterThan(0)
    expect(area).toBeGreaterThan(0)
  })

  it('measures zones, guides, plant rows, selection summary, and PDF dimensions in true WGS84 ground metres', () => {
    // At lat 65°, a 10 km north displacement shifts Mercator cos(lat) noticeably, so groundLength/groundArea
    // diverge measurably from naive Euclidean plane arithmetic.
    const plane = createSessionPlane({ lon: 18.06, lat: 65 })
    const rectPoints = [
      { x: 0, y: -10_000 },
      { x: 100, y: -10_000 },
      { x: 100, y: -9_900 },
      { x: 0, y: -9_900 },
    ]
    const expectedTopWidth = independentWgs84Length(plane.toGeo(rectPoints[0]!), plane.toGeo(rectPoints[1]!))
    const expectedBottomWidth = independentWgs84Length(plane.toGeo(rectPoints[3]!), plane.toGeo(rectPoints[2]!))
    const expectedWidth = expectedTopWidth
    const expectedHeight = independentWgs84Length(plane.toGeo(rectPoints[1]!), plane.toGeo(rectPoints[2]!))
    const expectedArea = ((expectedTopWidth + expectedBottomWidth) / 2) * expectedHeight
    // Confirm the test point actually differs from naive 100 m / 10_000 m² by > 0.2%.
    expect(Math.abs(expectedWidth - 100)).toBeGreaterThan(0.2)
    expect(Math.abs(expectedArea - 10_000)).toBeGreaterThan(40)

    const rectZone = {
      kind: 'zone' as const,
      id: 'z-rect',
      name: 'North bed',
      locked: false,
      zoneType: 'rect' as const,
      points: rectPoints,
      rotationDeg: 0,
      fillColor: null,
      notes: null,
    }
    const measured = measureZone(rectZone, plane)
    expect(measured).not.toBeNull()
    expect(measured!.areaM2).toBeCloseTo(expectedArea, 2)
    expect(measured!.perimeterM).toBeCloseTo(expectedTopWidth + expectedBottomWidth + 2 * expectedHeight, 2)

    // Zone measurement labels (rect, ellipse, polygon, line) route through groundMeasure.
    const rectLabels = createRectangularZoneMeasurements(rectPoints, plane)
    expect(rectLabels.find((l) => l.kind === 'area')?.text.replaceAll(',', '')).toContain(String(Math.round(expectedArea)))

    const polyLabels = createPolygonalZoneMeasurements(rectPoints, plane)
    expect(polyLabels.find((l) => l.kind === 'area')?.text.replaceAll(',', '')).toContain(String(Math.round(expectedArea)))

    const ellipseLabels = createEllipticalZoneMeasurements({ x: 50, y: -9_950 }, { x: 50, y: 20 }, 0, plane)
    const ellipseMeasured = measureZone({
      kind: 'zone', id: 'z-ell', name: null, locked: false, zoneType: 'ellipse',
      points: [{ x: 50, y: -9_950 }, { x: 50, y: 20 }], rotationDeg: 0, fillColor: null, notes: null,
    }, plane)!
    const sEll = plane.groundScaleAt({ x: 50, y: -9_950 })
    expect(ellipseMeasured.areaM2).toBeCloseTo(Math.PI * 50 * 20 * sEll.x * sEll.y, 4)
    expect(ellipseLabels.find((l) => l.kind === 'area')?.text.replaceAll(',', '')).toContain(String(Math.round(ellipseMeasured.areaM2!)))

    const lineLabels = createLinearZoneMeasurements({ x: 0, y: -10_000 }, { x: 300, y: -10_000 }, plane)
    expect(lineLabels[0]!.text).toBe(`${Math.round(plane.groundLength({ x: 0, y: -10_000 }, { x: 300, y: -10_000 }))} m`)
    expect(lineLabels[0]!.text).not.toBe('300 m')

    // Measurement guide presentation uses groundLength.
    const guide = createMeasurementGuidePresentation({
      kind: 'measurement-guide',
      id: 'g-1',
      locked: false,
      start: rectPoints[0]!,
      end: rectPoints[1]!,
    }, plane)
    expect(guide).not.toBeNull()
    expect(guide!.lengthWorld).toBeCloseTo(expectedWidth, 6)

    // Plant along path uses groundLength for row length.
    const row = plantAlongPath(
      { points: [{ position: rectPoints[0]!, sharp: true }, { position: rectPoints[1]!, sharp: true }], closed: false },
      { kind: 'interval', metres: 10 },
      plane,
    )
    expect(row.lengthM).toBeCloseTo(expectedWidth, 6)

    // Selection summary uses sessionPlane for zone area/perimeter and guide length.
    const queries = createTestCanvasQuerySurface({
      sessionPlane: plane,
      selection: [{ kind: 'zone', id: 'z-rect' }],
      scene: {
        plants: [],
        zones: [rectZone],
        annotations: [],
        measurementGuides: [],
        groups: [],
        layers: [],
        plantSpeciesColors: {},
        plantSpeciesSymbols: {},
        plantSpeciesCodes: {},
      },
    })
    const summary = readMapSelectionSummary(queries)
    expect(summary?.zones[0]?.areaM2).toBeCloseTo(expectedArea, 6)

    // PDF zoneMeasurements uses groundDistance through the inverse page frame and preserves planeOrigin.
    const printSnapshot = buildCanvasPrintSnapshot(
      {
        plants: [],
        zones: [rectZone],
        annotations: [],
        measurementGuides: [],
        groups: [],
        layers: [{ kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 }],
        plantSpeciesColors: {},
        plantSpeciesSymbols: {},
        plantSpeciesCodes: {},
      },
      undefined,
      plane,
    )
    expect(printSnapshot.planeOrigin).toEqual(plane.origin)
    const frame = pageFrame(30)
    const turned = turnSnapshot(printSnapshot, frame)
    expect(turned.planeOrigin).toEqual(plane.origin)
    const pdfDims = zoneMeasurements(
      turned.zones,
      printSnapshot.zones,
      (a, b) => plane.groundLength(frame.fromFrame(a), frame.fromFrame(b)),
    )
    const rectLengths = pdfDims[0]?.dimensions.map((d) => d.metres) ?? []
    expect(rectLengths).toHaveLength(2)
    // Rect dimensions measure the longer/shorter edges in true WGS84 ground metres (distinct from plane 100 m).
    for (const length of rectLengths) {
      expect(Math.abs(length - 100)).toBeGreaterThan(0.2)
      expect(length).toBeCloseTo(expectedWidth, 2)
    }
    expect(rectLengths).toContainEqual(expect.closeTo(expectedHeight, 4))
  })

  it('maps world angles to screen angles through the exact linear view affine', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const testView = createTestView({
      plane,
      camera: { center: { lon: 0, lat: 0 }, zoom: 18, bearingDeg: 25 },
    })
    const view = testView.view()
    const worldAngle = (35 * Math.PI) / 180
    const screenAngle = screenAngleForWorldAngle(view, worldAngle)
    const delta = view.worldDeltaToScreen({ x: Math.cos(worldAngle), y: Math.sin(worldAngle) })
    expect(screenAngle).toBeCloseTo(Math.atan2(delta.y, delta.x), 12)
    testView.dispose()
  })

  it('uses SessionPlane ground measure for planning-list zone labels 3.6 km from anchor (#350 B1)', () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 49 })
    // 100 x 50 m bed centred 3.6 km north of anchor: plane shoelace is 5,000 m², ground area differs noticeably.
    const pts = [{ x: 0, y: -3_600 }, { x: 100, y: -3_600 }, { x: 100, y: -3_550 }, { x: 0, y: -3_550 }]
    const zone = {
      kind: 'zone' as const, id: 'z-far', name: null, locked: false, zoneType: 'rect' as const,
      points: pts, rotationDeg: 0, fillColor: null, notes: null,
    }
    const groundArea = plane.groundArea(pts)
    expect(Math.abs(groundArea - 5_000)).toBeGreaterThan(5)
    const label = zoneLabel(zone, 'en', plane)
    expect(label).toContain(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(groundArea))
    expect(label).not.toContain('5,000')
  })

  it('computes mean nearest plant spacing via k-d tree + single groundLength per plant at 3,000 plants (#350 B2)', () => {
    const plane = createSessionPlane({ lon: 18.06, lat: 65 })
    const plants = Array.from({ length: 3_000 }, (_, i) => ({
      kind: 'plant' as const,
      id: `p-${i}`,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      canopySpreadM: null,
      position: { x: (i % 60) * 3, y: -10_000 + Math.floor(i / 60) * 3 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: null,
      locked: false,
    }))
    const queries = createTestCanvasQuerySurface({
      sessionPlane: plane,
      selection: plants.map((p) => ({ kind: 'plant' as const, id: p.id })),
      scene: {
        plants, zones: [], annotations: [], measurementGuides: [], groups: [], layers: [],
        plantSpeciesColors: {}, plantSpeciesSymbols: {}, plantSpeciesCodes: {},
      },
    })
    const start = performance.now()
    const summary = readMapSelectionSummary(queries)
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(2000)
    const expectedSpacing = plane.groundLength({ x: 0, y: -10_000 }, { x: 3, y: -10_000 })
    expect(summary?.plantSpacingM).toBeCloseTo(expectedSpacing, 2)
  })

  it('scales the PDF footer scale bar by groundScaleFactor (#350 NB1)', () => {
    const makeLine = (value: string, size: number) => ({
      runs: [{ text: value, font: 'latin' as const, width: value.length * size * 0.5, glyphs: [] }],
      width: value.length * size * 0.5,
      ink: null,
    })
    const text = { outlines: {}, line: makeLine, wrap: (value: string, size: number) => [makeLine(value, size)] }
    const page = { width: 595, height: 842, pointsPerMeter: 10 }
    const barWidth = (factor: number) => {
      const op = groundScale(page, 'en', text, 'N', 0, factor, 'metric').find((o) => o.kind === 'path')!
      const match = /h([\d.]+)/.exec(op.kind === 'path' ? op.d : '')
      return Number(match![1])
    }
    expect(barWidth(1.005)).toBeCloseTo(barWidth(1) / 1.005, 6)
  })
})
