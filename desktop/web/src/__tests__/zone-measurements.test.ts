import { describe, expect, it } from 'vitest'
import {
  formatMetricArea,
  formatMetricDistance,
} from '../canvas/runtime/zone-measurements'

describe('zone measurements', () => {
  it('formats compact metric distances and areas', () => {
    expect(formatMetricDistance(0.42)).toBe('42 cm')
    expect(formatMetricDistance(12.4)).toBe('12 m')
    expect(formatMetricArea(0.42)).toBe('4,200 cm²')
    expect(formatMetricArea(12500)).toBe('1.25 ha')
  })

  it('formats US customary distances and areas', () => {
    expect(formatMetricDistance(0.2, 'us_customary', 'en')).toBe('8 in')
    expect(formatMetricDistance(2, 'us_customary', 'en')).toBe('6′ 7″')
    expect(formatMetricDistance(10, 'us_customary', 'en')).toBe('33 ft')
    expect(formatMetricArea(50, 'us_customary', 'en')).toBe('538 ft²')
    expect(formatMetricArea(10000, 'us_customary', 'en')).toBe('2.47 ac')
  })
})
