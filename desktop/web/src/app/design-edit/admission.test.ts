import { describe, expect, it } from 'vitest'
import { isAdmittedColourRange, isAdmittedOpacity } from './admission'

describe('app/design-edit/admission', () => {
  it('admits finite unit-interval opacities only', () => {
    expect(isAdmittedOpacity(0)).toBe(true)
    expect(isAdmittedOpacity(0.5)).toBe(true)
    expect(isAdmittedOpacity(1)).toBe(true)
    expect(isAdmittedOpacity(-0.01)).toBe(false)
    expect(isAdmittedOpacity(1.01)).toBe(false)
    expect(isAdmittedOpacity(Number.NaN)).toBe(false)
    expect(isAdmittedOpacity(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('admits auto colour ranges and finite ascending custom ranges', () => {
    expect(isAdmittedColourRange(null)).toBe(true)
    expect(isAdmittedColourRange({ mode: 'Data' })).toBe(true)
    expect(isAdmittedColourRange({ mode: 'CutOutliers' })).toBe(true)
    expect(isAdmittedColourRange({ mode: 'Custom', min: 10, max: 20 })).toBe(true)
    expect(isAdmittedColourRange({ mode: 'Custom', min: 20, max: 20 })).toBe(false)
    expect(isAdmittedColourRange({ mode: 'Custom', min: 25, max: 20 })).toBe(false)
    expect(isAdmittedColourRange({ mode: 'Custom', min: Number.NaN, max: 20 })).toBe(false)
    expect(isAdmittedColourRange({ mode: 'Custom', min: 0, max: Number.POSITIVE_INFINITY })).toBe(false)
  })
})
