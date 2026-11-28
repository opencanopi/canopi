import { describe, expect, it } from 'vitest'
import type { GroundMeasure } from '../../geo/session-plane'
import { formatHoverTooltipContent } from './hover-tooltip-content'
import type { ScenePersistedState } from './scene'

const PLANAR_MEASURE: GroundMeasure = {
  groundLength: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) as ReturnType<GroundMeasure['groundLength']>,
  groundArea: (ring) => {
    let sum = 0
    for (let i = 0; i < ring.length; i += 1) {
      const curr = ring[i]!
      const next = ring[(i + 1) % ring.length]!
      sum += curr.x * next.y - next.x * curr.y
    }
    return (Math.abs(sum) / 2) as ReturnType<GroundMeasure['groundArea']>
  },
  groundScaleAt: () => ({ x: 1, y: 1 }),
}

const SCENE: ScenePersistedState = {
  plants: [
    {
      id: 'p1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#4caf50',
      symbol: 'canopy',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      scale: 4,
      locked: false,
      notes: null,
    },
  ],
  zones: [
    {
      id: 'z-closed',
      name: 'Orchard',
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#1b5e20',
      opacity: 0.4,
      locked: false,
      notes: null,
    },
    {
      id: 'z-degenerate',
      name: '',
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#1b5e20',
      opacity: 0.4,
      locked: false,
      notes: null,
    },
    {
      id: 'z-line',
      name: 'Swale',
      zoneType: 'line',
      points: [{ x: 0, y: 0 }, { x: 6, y: 0 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#1b5e20',
      opacity: 0.4,
      locked: false,
      notes: null,
    },
    {
      id: 'z-line-zero',
      name: null,
      zoneType: 'line',
      points: [{ x: 0, y: 0 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#1b5e20',
      opacity: 0.4,
      locked: false,
      notes: null,
    },
  ],
  annotations: [
    {
      id: 'a-short',
      annotationType: 'text',
      position: { x: 0, y: 0 },
      text: 'Mulch bed\nSecond line',
      fontSize: 14,
      rotationDeg: null,
      locked: false,
    },
    {
      id: 'a-long',
      annotationType: 'text',
      position: { x: 0, y: 0 },
      text: 'This is a very long annotation first line exceeding forty characters easily',
      fontSize: 14,
      rotationDeg: null,
      locked: false,
    },
    {
      id: 'a-empty',
      annotationType: 'text',
      position: { x: 0, y: 0 },
      text: '   \n',
      fontSize: 14,
      rotationDeg: null,
      locked: false,
    },
  ],
  measurementGuides: [
    { id: 'g1', start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, locked: false },
  ],
  groups: [
    { id: 'grp-named', name: 'Guild', members: [{ kind: 'plant', id: 'p1' }] },
    { id: 'grp-unnamed', name: null, members: [{ kind: 'plant', id: 'p1' }, { kind: 'zone', id: 'z-closed' }] },
  ],
  plantSpeciesCodes: {},
  layerOrder: ['plants', 'zones', 'annotations', 'measurement-guides'],
  hiddenLayers: [],
  lockedLayers: [],
} as unknown as ScenePersistedState

describe('formatHoverTooltipContent', () => {
  it('formats plant tooltips using localized common names with fallback and returns null when missing', () => {
    expect(
      formatHoverTooltipContent(SCENE, { kind: 'plant', id: 'p1' }, PLANAR_MEASURE, new Map([['Malus domestica', 'Apfel']]), 'metric', 'en'),
    ).toEqual({ title: 'Apfel', subtitle: 'Malus domestica', subtitleItalic: true })
    expect(
      formatHoverTooltipContent(SCENE, { kind: 'plant', id: 'p1' }, PLANAR_MEASURE, new Map(), 'metric', 'en'),
    ).toEqual({ title: 'Apple', subtitle: 'Malus domestica', subtitleItalic: true })
    expect(
      formatHoverTooltipContent(SCENE, { kind: 'plant', id: 'missing' }, PLANAR_MEASURE, new Map(), 'metric', 'en'),
    ).toBeNull()
  })

  it('formats closed and open zones including degenerate fallbacks and missing ids', () => {
    const closed = formatHoverTooltipContent(SCENE, { kind: 'zone', id: 'z-closed' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(closed?.title).toBe('Orchard')
    expect(closed?.subtitle).toContain('50')

    const degenerate = formatHoverTooltipContent(SCENE, { kind: 'zone', id: 'z-degenerate' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(degenerate).toEqual({ title: 'polygon', subtitle: 'polygon', subtitleItalic: false })

    const line = formatHoverTooltipContent(SCENE, { kind: 'zone', id: 'z-line' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(line?.title).toBe('Swale')
    expect(line?.subtitle).toContain('6')

    const lineZero = formatHoverTooltipContent(SCENE, { kind: 'zone', id: 'z-line-zero' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(lineZero).toEqual({ title: 'line', subtitle: 'line', subtitleItalic: false })

    expect(formatHoverTooltipContent(SCENE, { kind: 'zone', id: 'missing' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toBeNull()
  })

  it('formats measurement guides, annotations, and groups including truncation and missing ids', () => {
    const guide = formatHoverTooltipContent(SCENE, { kind: 'measurement-guide', id: 'g1' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(guide?.title).toBeNull()
    expect(guide?.subtitle).toContain('5')
    expect(formatHoverTooltipContent(SCENE, { kind: 'measurement-guide', id: 'missing' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toBeNull()

    expect(formatHoverTooltipContent(SCENE, { kind: 'annotation', id: 'a-short' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toEqual({
      title: null,
      subtitle: 'Mulch bed',
      subtitleItalic: false,
    })
    const longNote = formatHoverTooltipContent(SCENE, { kind: 'annotation', id: 'a-long' }, PLANAR_MEASURE, new Map(), 'metric', 'en')
    expect(longNote?.subtitle.endsWith('…')).toBe(true)
    expect(longNote?.subtitle.length).toBe(40)
    expect(formatHoverTooltipContent(SCENE, { kind: 'annotation', id: 'a-empty' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toBeNull()
    expect(formatHoverTooltipContent(SCENE, { kind: 'annotation', id: 'missing' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toBeNull()

    expect(formatHoverTooltipContent(SCENE, { kind: 'group', id: 'grp-named' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toEqual({
      title: 'Guild',
      subtitle: '1',
      subtitleItalic: false,
    })
    expect(formatHoverTooltipContent(SCENE, { kind: 'group', id: 'grp-unnamed' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toEqual({
      title: null,
      subtitle: '2',
      subtitleItalic: false,
    })
    expect(formatHoverTooltipContent(SCENE, { kind: 'group', id: 'missing' }, PLANAR_MEASURE, new Map(), 'metric', 'en')).toBeNull()
  })
})
