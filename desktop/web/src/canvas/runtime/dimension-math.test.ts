import { describe, expect, it } from 'vitest'
import { createSessionPlane } from '../../geo/session-plane'
import { createDefaultScenePersistedState, type ScenePersistedState } from './scene'
import {
  prepareEditAnnotationFields,
  prepareEditGuideDimensions,
  prepareEditPlantFields,
  prepareEditZoneDimensions,
  prepareSetSpeciesCode,
  prepareSetZoneStyle,
  readPolygonDimensions,
  readRectOrEllipseDimensions,
  readSegmentDimensions,
} from './dimension-math'
import { formatHoverTooltipContent } from './hover-tooltip-content'

function makeScene(): ScenePersistedState {
  const s = createDefaultScenePersistedState()
  s.zones = [
    {
      kind: 'zone',
      id: 'z-rect',
      name: 'Rect',
      locked: false,
      zoneType: 'rect',
      points: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      notes: null,
    },
    {
      kind: 'zone',
      id: 'z-poly',
      name: 'Tri',
      locked: false,
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 8 }],
      rotationDeg: 0,
      fillColor: '#8bc34a',
      notes: null,
    },
    {
      kind: 'zone',
      id: 'z-line',
      name: 'Path',
      locked: false,
      zoneType: 'line',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      rotationDeg: 0,
      fillColor: '#03a9f4',
      notes: null,
    },
  ]
  s.measurementGuides = [
    { kind: 'measurement-guide', id: 'g-1', locked: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  ]
  s.plants = [
    {
      kind: 'plant',
      id: 'p-1',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#c00',
      position: { x: 1, y: 1 },
      rotationDeg: 0,
      canopySpreadM: 4,
      notes: null,
      plantedDate: null,
      quantity: 1,
    },
  ]
  s.annotations = [
    {
      kind: 'annotation',
      id: 'a-1',
      locked: false,
      annotationType: 'text',
      position: { x: 2, y: 2 },
      text: 'Hello',
      fontSize: 14,
      rotationDeg: 0,
    },
  ]
  s.groups = [
    {
      kind: 'group',
      id: 'grp-1',
      locked: false,
      name: 'Guild',
      members: [{ kind: 'plant', id: 'p-1' }, { kind: 'zone', id: 'z-rect' }],
    },
  ]
  s.plantSpeciesCodes = { 'Malus domestica': 'MD', 'Prunus avium': 'PA' }
  return s
}

describe('dimension-math and hover-tooltip-content', () => {
  const plane = createSessionPlane({ lon: 10, lat: 50 })

  it('edits rect rotation/center, polygon cornerAngleDeg/center, line length/angle/center, and guide center', () => {
    const s = makeScene()
    const rectRot = prepareEditZoneDimensions(s, plane, 'z-rect', { rotationDeg: 30, center: { lon: 10.001, lat: 50.001 } })
    expect(rectRot).not.toBeNull()
    rectRot!(s)
    const rectDims = readRectOrEllipseDimensions(s.zones[0]!, plane)!
    expect(rectDims.rotationDeg).toBeCloseTo(30, 1)
    expect(rectDims.center.lat).toBeCloseTo(50.001, 4)

    const polyAngle = prepareEditZoneDimensions(s, plane, 'z-poly', { cornerIndex: 0, cornerAngleDeg: 60 })
    expect(polyAngle).not.toBeNull()
    polyAngle!(s)
    const polyMove = prepareEditZoneDimensions(s, plane, 'z-poly', { center: { lon: 10.002, lat: 50.002 } })
    expect(polyMove).not.toBeNull()
    polyMove!(s)
    const polyDims = readPolygonDimensions(s.zones[1]!, plane)!
    expect(polyDims.center.lat).toBeCloseTo(50.002, 4)

    const lineEdit = prepareEditZoneDimensions(s, plane, 'z-line', { lengthM: 15, angleDeg: 90, center: { lon: 10.003, lat: 50.003 } })
    expect(lineEdit).not.toBeNull()
    lineEdit!(s)
    const lineDims = readSegmentDimensions(s.zones[2]!.points[0]!, s.zones[2]!.points[1]!, plane)
    expect(lineDims.lengthM).toBeCloseTo(15, 2)

    const guideEdit = prepareEditGuideDimensions(s, plane, 'g-1', { center: { lon: 10.004, lat: 50.004 } })
    expect(guideEdit).not.toBeNull()
    guideEdit!(s)
    expect(prepareEditZoneDimensions(s, plane, 'missing', { widthM: 2 })).toBeNull()
    expect(prepareEditGuideDimensions(s, plane, 'missing', { lengthM: 2 })).toBeNull()
  })

  it('prepares plant, annotation, zone style, and species code edits including no-ops and validation', () => {
    const s = makeScene()
    expect(prepareEditPlantFields(s, 'missing', { quantity: 2 })).toBeNull()
    expect(prepareEditPlantFields(s, 'p-1', { canopySpreadM: 4, quantity: 1 })).toBeNull()
    const plantMut = prepareEditPlantFields(s, 'p-1', { canopySpreadM: 6, quantity: 3, notes: 'ok', plantedDate: '2026-01-01' })
    expect(plantMut).not.toBeNull()
    plantMut!(s)
    expect(s.plants[0]).toMatchObject({ canopySpreadM: 6, quantity: 3, notes: 'ok', plantedDate: '2026-01-01' })

    expect(prepareEditAnnotationFields(s, 'missing', { text: 'x' })).toBeNull()
    expect(prepareEditAnnotationFields(s, 'a-1', { text: 'Hello', fontSize: 14 })).toBeNull()
    const noteMut = prepareEditAnnotationFields(s, 'a-1', { text: 'Bye', fontSize: 24 })
    expect(noteMut).not.toBeNull()
    noteMut!(s)
    expect(s.annotations[0]).toMatchObject({ text: 'Bye', fontSize: 24 })

    expect(prepareSetZoneStyle(s, 'missing', { opacity: 0.5 })).toBeNull()
    expect(prepareSetZoneStyle(s, 'z-rect', { fillColor: '#4caf50' })).toBeNull()
    const styleMut = prepareSetZoneStyle(s, 'z-rect', { strokeColor: '#000', opacity: 1.5 })
    expect(styleMut).not.toBeNull()
    styleMut!(s)
    expect(s.zones[0]).toMatchObject({ strokeColor: '#000', opacity: 1 })
    const clearOpacity = prepareSetZoneStyle(s, 'z-rect', { opacity: null })
    expect(clearOpacity).not.toBeNull()
    clearOpacity!(s)
    expect(s.zones[0]?.opacity).toBeNull()

    expect(prepareSetSpeciesCode(s, 'Malus domestica', 'bad!')).toBeNull()
    expect(prepareSetSpeciesCode(s, 'Malus domestica', 'MD')).toBeNull()
    expect(prepareSetSpeciesCode(s, 'Malus domestica', 'PA')).toBeNull()
    const codeMut = prepareSetSpeciesCode(s, 'Malus domestica', 'ap1')
    expect(codeMut).not.toBeNull()
    codeMut!(s)
    expect(s.plantSpeciesCodes['Malus domestica']).toBe('AP1')
  })

  it('formats hover tooltips for plants, zones, guides, notes, and groups', () => {
    const s = makeScene()
    const names = new Map<string, string | null>([['Malus domestica', 'Apple']])
    expect(formatHoverTooltipContent(s, { kind: 'plant', id: 'p-1' }, plane, names, 'metric', 'en')?.title).toContain('Apple')
    expect(formatHoverTooltipContent(s, { kind: 'zone', id: 'z-rect' }, plane, names, 'metric', 'en')?.title).toContain('Rect')
    expect(formatHoverTooltipContent(s, { kind: 'zone', id: 'z-line' }, plane, names, 'metric', 'en')?.title).toContain('Path')
    expect(formatHoverTooltipContent(s, { kind: 'measurement-guide', id: 'g-1' }, plane, names, 'metric', 'en')?.subtitle).toContain('10')
    expect(formatHoverTooltipContent(s, { kind: 'annotation', id: 'a-1' }, plane, names, 'metric', 'en')?.subtitle).toContain('Hello')
    expect(formatHoverTooltipContent(s, { kind: 'group', id: 'grp-1' }, plane, names, 'metric', 'en')?.title).toContain('Guild')
    expect(formatHoverTooltipContent(s, { kind: 'zone', id: 'missing' }, plane, names, 'metric', 'en')).toBeNull()
    expect(readRectOrEllipseDimensions({ ...s.zones[0]!, zoneType: 'polygon' }, plane)).toBeNull()
    expect(readPolygonDimensions(s.zones[0]!, plane)).toBeNull()
  })
})
