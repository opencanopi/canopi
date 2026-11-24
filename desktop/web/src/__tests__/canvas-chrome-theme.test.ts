// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CANVAS_CHROME_FONT_FAMILY } from '../canvas/chrome-fonts'
import { createTextEntryHost } from '../canvas/runtime/chrome/text-entry-host'
import { parseCssDeclarations } from './support/architecture/css-facts'
import { createTestView } from './support/test-view'

const GLOBAL_DECLS = parseCssDeclarations('src/styles/global.css', readFileSync('src/styles/global.css', 'utf8'))
const LIGHT_TOKENS = readDeclarations(':root')
const DARK_TOKENS = readDeclarations('[data-theme="dark"]')

function readDeclarations(selector: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const decl of GLOBAL_DECLS) {
    if (decl.rule === selector && decl.atRules.length === 0 && decl.property.startsWith('--')) {
      declarations.set(decl.property, decl.value)
    }
  }
  if (declarations.size === 0) throw new Error(`Missing block ${selector}`)
  return declarations
}

function normalizeColor(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function parseRgb(value: string): [number, number, number] | null {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
  const channels = value.match(/^rgba?\(([^)]+)\)$/i)?.[1]?.split(',').slice(0, 3).map(Number)
  return channels?.length === 3 ? channels as [number, number, number] : null
}

function canvasColorTokens(tokens: ReadonlyMap<string, string>): [string, string][] {
  return [...tokens].filter(([name, value]) => name.startsWith('--canvas-') && parseRgb(value))
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return listSourceFiles(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })
}

async function loadFreshThemeRefresh() {
  vi.resetModules()
  return import('../canvas/theme-refresh')
}

describe('canvas chrome fonts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mirrors the bundled --font-sans stack so Pixi and Canvas2D text match the DOM chrome', () => {
    expect(CANVAS_CHROME_FONT_FAMILY.startsWith("'Source Sans 3'")).toBe(true)
    expect(CANVAS_CHROME_FONT_FAMILY).toBe(LIGHT_TOKENS.get('--font-sans'))
  })

  it('keeps the Inter font out of every canvas and map drawing module', () => {
    const files = ['src/canvas', 'src/maplibre'].flatMap(listSourceFiles)
    // The scan must have found the drawing modules, or the check proves nothing.
    expect(files.length).toBeGreaterThan(20)
    const offenders = files
      .filter((path) => /(^|[^A-Za-z])Inter(?![A-Za-z])/.test(readFileSync(path, 'utf8')))
      .map((path) => relative('src', path))
    expect(offenders).toEqual([])
  })

  it('edits Text notes in the font Pixi draws them with', () => {
    const container = document.createElement('div')
    const view = createTestView({ viewport: { x: 0, y: 0, scale: 10 } })
    const entries = createTextEntryHost({
      container,
      frames: view.frames,
      translate: (key) => key,
      focus: { focusMap: vi.fn() },
      openedByTouch: () => false,
    })
    entries.open({
      anchor: { x: 1, y: 1 },
      rotationDeg: 0,
      initialText: 'Pond edge',
      placeholderKey: 'canvas.textNote.placeholder',
      fontSizePx: 16,
    }, () => 'close')

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-canvas-text-entry]')!
    expect(textarea.style.fontFamily.replace(/"/g, "'")).toBe(CANVAS_CHROME_FONT_FAMILY)
    entries.dispose()
    view.dispose()
  })
})

describe('canvas colour tokens', () => {
  it('uses the light --canvas-* tokens as theme-refresh fallbacks before the first refresh', async () => {
    const { CANVAS_COLOR_CSS_VARS, getCanvasColor } = await loadFreshThemeRefresh()
    for (const [name, cssVar] of Object.entries(CANVAS_COLOR_CSS_VARS)) {
      const token = LIGHT_TOKENS.get(cssVar)
      expect(token, `${cssVar} is defined in :root`).toBeDefined()
      expect(normalizeColor(getCanvasColor(name as keyof typeof CANVAS_COLOR_CSS_VARS)), cssVar)
        .toBe(normalizeColor(token!))
    }
  })

  it('defines every refreshed canvas colour in the dark theme and adopts it on refresh', async () => {
    const { CANVAS_COLOR_CSS_VARS, getCanvasColor, refreshCanvasColorCache } = await loadFreshThemeRefresh()
    const container = document.createElement('div')
    for (const cssVar of Object.values(CANVAS_COLOR_CSS_VARS)) {
      const token = DARK_TOKENS.get(cssVar)
      expect(token, `${cssVar} is defined in the dark theme`).toBeDefined()
      container.style.setProperty(cssVar, token!)
    }
    refreshCanvasColorCache(container)
    for (const [name, cssVar] of Object.entries(CANVAS_COLOR_CSS_VARS)) {
      expect(normalizeColor(getCanvasColor(name as keyof typeof CANVAS_COLOR_CSS_VARS)), cssVar)
        .toBe(normalizeColor(DARK_TOKENS.get(cssVar)!))
    }
  })

  it('draws selection in the ochre accent of each theme', () => {
    for (const tokens of [LIGHT_TOKENS, DARK_TOKENS]) {
      expect(tokens.get('--canvas-selection-stroke')).toBe(tokens.get('--color-accent'))
    }
    expect(LIGHT_TOKENS.get('--canvas-selection-stroke')).toBe('#9C5A16')
    expect(DARK_TOKENS.get('--canvas-selection-stroke')).toBe('#E3A04C')
  })

  it('cases light overlay strokes in a dark casing and ochre selection in its theme contrast', () => {
    for (const tokens of [LIGHT_TOKENS, DARK_TOKENS]) {
      const overlay = parseRgb(tokens.get('--canvas-guide-line') ?? '')!
      const overlayCasing = parseRgb(tokens.get('--canvas-overlay-casing') ?? '')!
      expect(luminance(overlay)).toBeGreaterThan(luminance(overlayCasing) + .5)
      const zone = parseRgb(tokens.get('--canvas-zone-stroke') ?? '')!
      expect(luminance(zone)).toBeGreaterThan(luminance(overlayCasing) + .5)
      const selection = parseRgb(tokens.get('--canvas-selection-stroke') ?? '')!
      const selectionCasing = parseRgb(tokens.get('--canvas-interaction-casing') ?? '')!
      expect(Math.abs(luminance(selection) - luminance(selectionCasing))).toBeGreaterThan(.25)
    }
  })

  it('keeps green out of canvas chrome tokens', () => {
    const greens = [...canvasColorTokens(LIGHT_TOKENS), ...canvasColorTokens(DARK_TOKENS)]
      .filter(([, value]) => {
        const [r, g, b] = parseRgb(value)!
        return g > r + 12 && g > b + 12
      })
    expect(greens).toEqual([])
  })
})

function luminance([r, g, b]: [number, number, number]): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
}
