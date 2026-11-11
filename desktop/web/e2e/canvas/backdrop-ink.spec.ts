// Canvas label ink through the real cascade (canopi-f47t.52.253): text, annotations, halos, stack badges and plant edges
// drawn over the map follow the map backdrop, not the UI theme, and the Inspection Lens paper, which does follow the UI
// theme, still gets ink it can carry. The Web Edition's own stylesheet supplies each theme's tokens: the page sets
// `data-theme` as utils/theme.ts does, and the canvas colour cache (canvas/theme-refresh.ts) reads them from computed
// style, as the scene runtime does, so a token renamed, moved or overridden in the cascade is seen here. The ink rules
// themselves (canvas/runtime/scene-visuals.ts) run in the page as one bundled slice. DOM and colour arithmetic only, no
// baselines; the rest of the backdrop rules are unit tests in src/__tests__/canvas-map-backdrop-ink.test.ts.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import { pageBundle } from '../support/page-bundle'

const THEMES = ['light', 'dark'] as const
const BACKDROPS = ['basemap', 'dark-basemap', 'satellite', 'paper'] as const

type Theme = (typeof THEMES)[number]
type Backdrop = (typeof BACKDROPS)[number]

/** What one theme over one backdrop draws, with the contrast of each pair a reader needs to tell apart. */
interface Reading {
  readonly ink: string
  readonly halo: string
  readonly badge: string
  readonly contrast: {
    readonly inkOnBackdrop: number
    readonly inkOnHalo: number
    readonly badgeOnBackdrop: number
    readonly badgeTextOnBadge: number
    readonly edgeOnBackdropColouredPlant: number
  }
}

/** What the Inspection Lens draws on its paper in one theme. */
interface LensReading {
  readonly paper: string
  readonly inkOnPaper: number
  readonly badgeOnPaper: number
  readonly edgeOnPaper: number
}

interface InkSlice {
  readonly CANVAS_MAP_BACKDROP_COLORS: Readonly<Record<Backdrop, string>>
  refreshCanvasColorCache(container: HTMLElement): void
  getCanvasColor(name: 'background'): string
  setCanvasMapBackdrop(backdrop: Backdrop): boolean
  getMapTextColor(): string
  getLabelHalo(size: number): { color: string }
  getStackBadgeBackgroundColor(): string
  getStackBadgeTextColor(): string
  getPlantSymbolEdgeColor(fill: string, background?: string): string
  resolveBackdropInk(background: string): { text: string, badgeBackground: string }
  contrastRatio(a: string, b: string): number
}

declare global {
  interface Window { __backdropInk?: InkSlice }
}

/** The ink rules and the colour cache, bundled from the app's source as one script that sets `window.__backdropInk`. */
function inkScript(): Promise<string> {
  return pageBundle(
    "export * from './scene-visuals'\nexport { getCanvasColor, refreshCanvasColorCache } from '../theme-refresh'\nexport { contrastRatio } from '../plant-colors'",
    fileURLToPath(new URL('../../src/canvas/runtime/', import.meta.url)),
    '__backdropInk',
  )
}

/** The Web Edition's start screen (its global stylesheet loaded) with the ink slice in the page. */
async function openWithInk(page: Page): Promise<void> {
  const script = await inkScript()
  await page.goto('')
  await expect(page.locator('[data-start-screen]')).toBeVisible()
  await page.addScriptTag({ content: script })
}

/** Each theme over each backdrop, the theme's tokens read from the cascade by the canvas colour cache. */
async function readings(page: Page): Promise<Record<Theme, Record<Backdrop, Reading>>> {
  return page.evaluate(({ themes, backdrops }) => {
    const ink = window.__backdropInk!
    const container = document.body.appendChild(document.createElement('div'))
    const out: Record<string, Record<string, unknown>> = {}
    for (const theme of themes) {
      document.documentElement.setAttribute('data-theme', theme)
      ink.refreshCanvasColorCache(container)
      out[theme] = {}
      for (const backdrop of backdrops) {
        ink.setCanvasMapBackdrop(backdrop)
        const background = ink.CANVAS_MAP_BACKDROP_COLORS[backdrop]
        const text = ink.getMapTextColor()
        const halo = ink.getLabelHalo(12).color
        const badge = ink.getStackBadgeBackgroundColor()
        out[theme][backdrop] = {
          ink: text,
          halo,
          badge,
          contrast: {
            inkOnBackdrop: ink.contrastRatio(text, background),
            inkOnHalo: ink.contrastRatio(text, halo),
            badgeOnBackdrop: ink.contrastRatio(badge, background),
            badgeTextOnBadge: ink.contrastRatio(ink.getStackBadgeTextColor(), badge),
            // A plant painted in the backdrop colour still gets a contrasting edge.
            edgeOnBackdropColouredPlant: ink.contrastRatio(ink.getPlantSymbolEdgeColor(background), background),
          },
        }
      }
    }
    container.remove()
    return out
  }, { themes: THEMES, backdrops: BACKDROPS }) as Promise<Record<Theme, Record<Backdrop, Reading>>>
}

test.describe('canvas label ink follows the map backdrop, not the UI theme (canopi-f47t.52.253)', () => {
  for (const theme of THEMES) {
    for (const backdrop of BACKDROPS) {
      test(`${theme} UI over ${backdrop}: labels, annotations and halos contrast with the backdrop`, async ({ page }) => {
        await openWithInk(page)
        const { ink, contrast } = (await readings(page))[theme][backdrop]
        expect(contrast.inkOnBackdrop, `ink ${ink} on the ${backdrop} backdrop`).toBeGreaterThanOrEqual(4.5)
        expect(contrast.inkOnHalo, 'halo under the ink').toBeGreaterThanOrEqual(4.5)
        expect(contrast.badgeOnBackdrop, 'stack badge on the backdrop').toBeGreaterThanOrEqual(4.5)
        expect(contrast.badgeTextOnBadge, 'stack badge text').toBeGreaterThanOrEqual(4.5)
        expect(contrast.edgeOnBackdropColouredPlant, 'edge of a plant painted in the backdrop colour').toBeGreaterThanOrEqual(3)
      })
    }
  }

  test('resolves the same ink in both UI themes', async ({ page }) => {
    await openWithInk(page)
    const all = await readings(page)
    for (const backdrop of BACKDROPS) {
      const drawn = (theme: Theme) => [all[theme][backdrop].ink, all[theme][backdrop].halo, all[theme][backdrop].badge]
      expect(drawn('dark'), backdrop).toEqual(drawn('light'))
    }
  })

  test('resolves ink for the inspection lens paper, which follows the UI theme', async ({ page }) => {
    await openWithInk(page)
    const lens = await page.evaluate((themes) => {
      const ink = window.__backdropInk!
      const container = document.body.appendChild(document.createElement('div'))
      const out: Record<string, LensReading> = {}
      for (const theme of themes) {
        document.documentElement.setAttribute('data-theme', theme)
        ink.refreshCanvasColorCache(container)
        const paper = ink.getCanvasColor('background')
        const resolved = ink.resolveBackdropInk(paper)
        out[theme] = {
          paper,
          inkOnPaper: ink.contrastRatio(resolved.text, paper),
          badgeOnPaper: ink.contrastRatio(resolved.badgeBackground, paper),
          edgeOnPaper: ink.contrastRatio(ink.getPlantSymbolEdgeColor(paper, paper), paper),
        }
      }
      container.remove()
      return out
    }, THEMES) as Record<Theme, LensReading>
    // The cache read each theme's own paper from the cascade, so both themes were measured.
    expect(lens.dark.paper.toLowerCase(), 'the dark theme has its own paper').not.toBe(lens.light.paper.toLowerCase())
    for (const theme of THEMES) {
      expect(lens[theme].inkOnPaper, `${theme} ink on ${lens[theme].paper}`).toBeGreaterThanOrEqual(4.5)
      expect(lens[theme].badgeOnPaper, `${theme} badge on ${lens[theme].paper}`).toBeGreaterThanOrEqual(4.5)
      expect(lens[theme].edgeOnPaper, `${theme} plant edge on ${lens[theme].paper}`).toBeGreaterThanOrEqual(3)
    }
  })
})
