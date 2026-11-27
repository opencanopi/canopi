// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { CANVAS_CHROME_FONT_FAMILY } from '../chrome-fonts'
import { readCanvasPaintTokens, type CanvasPaintTokens } from '../theme-refresh'
const getCanvasColor = (name: keyof CanvasPaintTokens) => readCanvasPaintTokens()[name]
import { getCanvasInteractionStrokeVisual, getDraftLabelVisual, getDraftVisual } from './scene-visuals'

const GLOBAL_CSS = readFileSync('src/styles/global.css', 'utf8')
const MAPLIBRE_CSS = readFileSync('node_modules/maplibre-gl/dist/maplibre-gl.css', 'utf8')
const DOCUMENT_LANG = document.documentElement.lang

/** `--text-xs` in px from the first global.css block that `opener` starts. */
function textXsPx(opener: RegExp): number {
  const block = GLOBAL_CSS.slice(GLOBAL_CSS.search(opener))
  return Number.parseFloat(block.slice(0, block.indexOf('\n}')).match(/--text-xs:\s*([\d.]+)px/)![1]!)
}

afterEach(() => {
  document.documentElement.lang = DOCUMENT_LANG
})

describe('scene visuals', () => {
  it('keeps selected, hover, and locked hover strokes visually distinct', () => {
    const hover = getCanvasInteractionStrokeVisual('hover')
    const selected = getCanvasInteractionStrokeVisual('selected')
    const lockedObject = getCanvasInteractionStrokeVisual('locked-design-object')
    const lockedLayer = getCanvasInteractionStrokeVisual('locked-layer')

    expect(selected.widthPx).toBeGreaterThan(hover.widthPx)
    expect(selected.alpha).toBeGreaterThan(hover.alpha)
    expect(lockedObject.color).not.toBe(lockedLayer.color)
    expect(lockedObject.color).not.toBe(selected.color)
    expect(lockedLayer.color).not.toBe(selected.color)
  })

  it('resolves each draft token to the canvas colour today\'s DOM previews use', () => {
    // Today's (a4c86d39) overlay-ui.ts and polygon-draft-overlay.ts: light drafts on the dark overlay casing, the ochre band on the interaction casing.
    expect(getDraftVisual('draft')).toEqual({ color: getCanvasColor('guide-line'), casing: getCanvasColor('overlay-casing') })
    expect(getDraftVisual('selection'))
      .toEqual({ color: getCanvasColor('selection-stroke'), casing: getCanvasColor('interaction-casing') })
    expect(getDraftVisual('draft-fill')).toEqual({ color: getCanvasColor('zone-fill') })
    expect(getDraftVisual('selection-fill')).toEqual({ color: getCanvasColor('selection-fill') })
  })

  it('gives each draft label tone today\'s chip style', () => {
    const chip = {
      fontSizePx: 12.5,
      border: getCanvasColor('chip-border'),
      borderWidthPx: 1,
      radiusPx: 5,
      shadow: { offsetXPx: 0, offsetYPx: 2, blurPx: 8, color: 'rgba(30, 22, 10, 0.12)' },
    }
    const measure = getDraftLabelVisual('measure')
    expect(measure).toMatchObject({
      ...chip, placement: 'centre', fontFamily: CANVAS_CHROME_FONT_FAMILY, fontWeight: '600',
      color: getCanvasColor('chip-text'), background: getCanvasColor('chip-surface-muted'), paddingPx: { x: 5, y: 2 },
    })
    expect(getDraftLabelVisual('measure-quiet')).toEqual({ ...measure, fontWeight: '400' })
    const hint = getDraftLabelVisual('hint')
    expect(hint).toMatchObject({
      ...chip, placement: 'above', gapPx: 4, fontFamily: CANVAS_CHROME_FONT_FAMILY, fontWeight: '600',
      color: getCanvasColor('chip-text'), background: getCanvasColor('chip-surface'), paddingPx: { x: 6, y: 2 },
    })
    expect(getDraftLabelVisual('hint-primary')).toEqual({ ...hint, color: getCanvasColor('chip-primary'), paddingPx: { x: 8, y: 4 } })
  })

  it('sizes draft label chips as --text-xs in the page language', () => {
    const latin = textXsPx(/\n:root \{/)
    const cjk = textXsPx(/:root:lang\(zh\),\s*:root:lang\(ja\),\s*:root:lang\(ko\)\s*\{/)
    expect([latin, cjk]).toEqual([12.5, 13])
    for (const [lang, size] of [['en', latin], ['fr', latin], ['', latin], ['zh', cjk], ['ja', cjk], ['ko', cjk], ['zh-Hant', cjk]] as const) {
      document.documentElement.lang = lang
      for (const tone of ['measure', 'measure-quiet', 'hint', 'hint-primary'] as const) {
        expect(getDraftLabelVisual(tone).fontSizePx, `${lang} ${tone}`).toBe(size)
      }
      expect(getDraftLabelVisual('measure').lineHeightPx, lang).toBeCloseTo(size * 1.2)
    }
  })

  it('gives hint chips the line box they inherit from the map container', () => {
    // Today's hint chips set no line-height, so they take the one in `.maplibregl-map`'s font shorthand (maplibre-gl.css),
    // the class MapLibre puts on the container they sit in, whatever the font size.
    const inherited = Number.parseFloat(MAPLIBRE_CSS.match(/\.maplibregl-map\{font:[\d.]+px\/([\d.]+)px/)![1]!)
    expect(inherited).toBe(20)
    for (const lang of ['en', 'zh']) {
      document.documentElement.lang = lang
      for (const tone of ['hint', 'hint-primary'] as const) {
        expect(getDraftLabelVisual(tone).lineHeightPx, `${lang} ${tone}`).toBe(inherited)
      }
    }
  })
})
