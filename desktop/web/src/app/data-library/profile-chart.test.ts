import { describe, expect, it } from 'vitest'
import { buildProfilePlot, curveStyle, distanceTicks, indexAtX } from './profile-chart'

const AREA = { x0: 50, x1: 250, top: 10, bottom: 110 }

describe('profile chart geometry', () => {
  it('N series share one axis: min and max over them all, each its own path', () => {
    const plot = buildProfilePlot({ ...AREA, distances: [0, 50, 100], series: [[100, 110, 120], [105, 130, 125]] })

    expect([plot.min, plot.max]).toEqual([100, 130])
    expect(plot.paths).toEqual([
      'M50.00 110.00L150.00 76.67L250.00 43.33',
      'M50.00 93.33L150.00 10.00L250.00 26.67',
    ])
  })

  it('no data breaks the path: a gap starts a new run, and a lone point between gaps is a short level dash', () => {
    const plot = buildProfilePlot({ ...AREA, distances: [0, 25, 50, 75, 100, 125, 150, 175, 200], series: [[1, 2, null, 3, null, 4, 5, null, null]] })

    expect(plot.paths).toEqual(['M50.00 110.00L75.00 85.00M123.50 60.00L126.50 60.00M175.00 35.00L200.00 10.00'])
  })

  it('a value alone among no data is drawn where it sets the axis', () => {
    const plot = buildProfilePlot({ ...AREA, distances: [0, 50, 100, 150, 200], series: [[null, null, 12.3, null, null]], fromZero: true })

    expect(plot.max).toBe(12.3)
    expect(plot.paths).toEqual(['M148.50 10.00L151.50 10.00'])
  })

  it('a flat series sits in the middle, and a series with no value draws nothing', () => {
    const plot = buildProfilePlot({ ...AREA, distances: [0, 100], series: [[12, 12], [null, null]] })

    expect([plot.min, plot.max]).toEqual([12, 12])
    expect(plot.paths).toEqual(['M50.00 60.00L250.00 60.00', ''])
    expect(buildProfilePlot({ ...AREA, distances: [0, 100], series: [[null, null]] })).toMatchObject({ min: null, max: null, paths: [''] })
  })

  it('a height plot starts at zero', () => {
    const plot = buildProfilePlot({ ...AREA, distances: [0, 100], series: [[4, 8]], fromZero: true })

    expect([plot.min, plot.max]).toEqual([0, 8])
    expect(plot.y(0)).toBe(110)
    expect(plot.y(8)).toBe(10)
  })

  it('3 to 5 round distance ticks from zero', () => {
    expect(distanceTicks(184)).toEqual([0, 50, 100, 150])
    expect(distanceTicks(10)).toEqual([0, 5, 10])
    expect(distanceTicks(1)).toEqual([0, 0.5, 1])
    expect(distanceTicks(4000)).toEqual([0, 1000, 2000, 3000, 4000])
    expect(distanceTicks(0)).toEqual([0])
  })

  it('the cursor index is the nearest point, clamped to the plot', () => {
    const distances = [0, 10, 20, 30, 40]
    expect(indexAtX(50, distances, AREA)).toBe(0)
    expect(indexAtX(148, distances, AREA)).toBe(2)
    expect(indexAtX(-40, distances, AREA)).toBe(0)
    expect(indexAtX(900, distances, AREA)).toBe(4)
    expect(indexAtX(100, [], AREA)).toBeNull()
  })

  it('curves take ink, ochre, green, plum, then the same again dashed', () => {
    expect([0, 1, 2, 3, 4, 7, 8].map(curveStyle)).toEqual([
      { colour: 1, dashed: false },
      { colour: 2, dashed: false },
      { colour: 3, dashed: false },
      { colour: 4, dashed: false },
      { colour: 1, dashed: true },
      { colour: 4, dashed: true },
      { colour: 1, dashed: true },
    ])
  })
})
