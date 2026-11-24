import { beforeEach, describe, expect, it } from 'vitest'
import { activePanel, sidePanel } from '../app/shell/state'
import {
  parseGallerySurface,
  selectGalleryPanel,
} from '../editions/gallery/surface-routing'

beforeEach(() => {
  activePanel.value = 'canvas'
  sidePanel.value = null
})

describe('UI gallery surface routing', () => {
  it('keeps Calendar mounted while switching between its review variants', () => {
    selectGalleryPanel('calendar')
    selectGalleryPanel('calendar-expanded')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('calendar')
  })

  it('falls back to a known memory-gallery surface for invalid URLs', () => {
    expect(parseGallerySurface('unknown')).toBe('color')
    expect(parseGallerySurface(null)).toBe('color')
  })
})
