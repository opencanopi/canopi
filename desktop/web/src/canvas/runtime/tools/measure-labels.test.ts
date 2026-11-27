import { describe, expect, it } from 'vitest'
import { rectZone, sceneStoreWith } from '../../../__tests__/support/tool-harness'
import type { SceneZoneEntity } from '../scene'
import type { WorldPoint } from '../../../geo/view/types'
import {
  createEllipticalZoneMeasurements,
  createLinearZoneMeasurements,
  createPolygonalZoneMeasurements,
  createRectangularZoneMeasurements,
  type ZoneMeasurementLabel,
} from '../zone-measurements'
import { measureLabelShapes, selectedZoneMeasurementLabels } from './measure-labels'

const RECT = rectZone('rect', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }])
const ELLIPSE: SceneZoneEntity = { ...rectZone('ellipse', [{ x: 20, y: 20 }, { x: 4, y: 2 }]), zoneType: 'ellipse', rotationDeg: 30 }
const LINE: SceneZoneEntity = { ...rectZone('line', [{ x: 0, y: 40 }, { x: 12, y: 40 }]), zoneType: 'line' }
const POLYGON: SceneZoneEntity = {
  ...rectZone('polygon', [{ x: 50, y: 0 }, { x: 60, y: 0 }, { x: 55, y: 8 }]),
  zoneType: 'polygon',
}

/** Screen distance at a scale, as ToolView.screenDistance measures it at bearing 0. */
function screenDistanceAt(pixelsPerMetre: number) {
  return (a: WorldPoint, b: WorldPoint) => Math.hypot(b.x - a.x, b.y - a.y) * pixelsPerMetre
}

describe('zone measurement labels', () => {
  it('measures the one selected zone as today\'s overlay did, by zone type', () => {
    const store = sceneStoreWith({ zones: [RECT, ELLIPSE, LINE, POLYGON] })

    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'rect' }]))
      .toEqual(createRectangularZoneMeasurements(RECT.points))
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'ellipse' }]))
      .toEqual(createEllipticalZoneMeasurements(ELLIPSE.points[0]!, ELLIPSE.points[1]!, 30))
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'line' }]))
      .toEqual(createLinearZoneMeasurements(LINE.points[0]!, LINE.points[1]!))
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'polygon' }]))
      .toEqual(createPolygonalZoneMeasurements(POLYGON.points))
  })

  it('measures nothing unless exactly one visible, ungrouped zone is selected', () => {
    const store = sceneStoreWith({
      zones: [RECT, POLYGON],
      groups: [{ kind: 'group', id: 'g', locked: false, name: null, members: [{ kind: 'zone', id: 'polygon' }] }],
    })

    expect(selectedZoneMeasurementLabels(store.persisted, [])).toEqual([])
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'rect' }, { kind: 'zone', id: 'polygon' }])).toEqual([])
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'plant', id: 'rect' }])).toEqual([])
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'polygon' }])).toEqual([])
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'missing' }])).toEqual([])

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'zones' ? { ...layer, visible: false } : layer)
    })
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'rect' }])).toEqual([])

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'zones' ? { ...layer, visible: true, opacity: 0 } : layer)
    })
    expect(selectedZoneMeasurementLabels(store.persisted, [{ kind: 'zone', id: 'rect' }])).toEqual([])
  })

  it('draws area chips as measure and edge and dimension chips as measure-quiet, at the label point', () => {
    const labels: ZoneMeasurementLabel[] = [
      { id: 'edge-0', kind: 'edge', text: '10 m', worldPosition: { x: 5, y: 0 }, worldStart: { x: 0, y: 0 }, worldEnd: { x: 10, y: 0 } },
      { id: 'ellipse-dimensions', kind: 'dimension', text: '8 m × 4 m', worldPosition: { x: 1, y: 2 } },
      { id: 'area', kind: 'area', text: '50 m²', worldPosition: { x: 5, y: 2.5 } },
    ]

    expect(measureLabelShapes(labels, screenDistanceAt(10))).toEqual([
      { kind: 'label', anchor: { x: 5, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '10 m', tone: 'measure-quiet' },
      { kind: 'label', anchor: { x: 1, y: 2 }, offsetPx: { x: 0, y: 0 }, text: '8 m × 4 m', tone: 'measure-quiet' },
      { kind: 'label', anchor: { x: 5, y: 2.5 }, offsetPx: { x: 0, y: 0 }, text: '50 m²', tone: 'measure' },
    ])
  })

  it('drops an edge chip whose edge is shorter than 36 px on screen', () => {
    const labels = createRectangularZoneMeasurements(RECT.points)

    // At 5 px/m the 5 m edges are 25 px and the 10 m edges 50 px.
    const texts = measureLabelShapes(labels, screenDistanceAt(5)).map((shape) => shape.kind === 'label' ? shape.text : null)
    expect(texts).toEqual(['10 m', '10 m', '50 m²'])
    expect(measureLabelShapes(labels, screenDistanceAt(7.2))).toHaveLength(5)
  })
})
