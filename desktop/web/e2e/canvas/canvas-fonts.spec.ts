// Canvas text drawn before its web font arrives is drawn again in that font once it has loaded (D11,
// canvas/runtime/font-loading.ts). Pixi rasterises a text once and keeps the raster while its text and style stay the
// same, and nothing in Pixi listens for fonts, so the billboard layer asks the loader for each label's font and lets
// every name, stack badge and guide label go when the loader's epoch moves. This runs in the browser, in every engine:
// the interface font's files are held back while a Design with a pinned plant name, a stack of two plants and a
// measurement guide opens, so all three are drawn in a fallback font; once the files are let through, each is drawn
// again at its width in the web font. A screenshot waits for the page's fonts, so the widths are read where Pixi draws
// them: every fillText records its text and the width its context measures for it in the font it draws with. No
// baselines: nothing here is compared with a recorded screenshot.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))

/** A text the canvas drew: its characters, the context's font and the width that font gives them, and when. */
interface CanvasTextDraw {
  readonly text: string
  readonly font: string
  readonly width: number
  readonly at: number
}

type Kind = 'name' | 'badge' | 'guide'

/** Which label a drawn text is: the pinned apple's name, the stack's count, or the guide's length in metres. */
function kindOf(text: string): Kind | null {
  if (/Apple|Malus/.test(text)) return 'name'
  if (text === '2') return 'badge'
  if (/^\d[\d.,]*\s?m$/.test(text)) return 'guide'
  return null
}

/** Records every text a 2D context draws (Pixi rasterises its Text through one), with the width its font gives it. */
function recordCanvasText(): void {
  const draws: CanvasTextDraw[] = []
  ;(window as unknown as { __canvasTextDraws: CanvasTextDraw[] }).__canvasTextDraws = draws
  const contexts = [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]
  for (const context of contexts) {
    if (!context) continue
    const proto = context.prototype as CanvasRenderingContext2D
    const fillText = proto.fillText
    proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
      const characters = String(text)
      draws.push({ text: characters, font: this.font, width: this.measureText(characters).width, at: performance.now() })
      if (maxWidth === undefined) fillText.call(this, characters, x, y)
      else fillText.call(this, characters, x, y, maxWidth)
    }
  }
}

async function canvasTextDraws(page: Page): Promise<CanvasTextDraw[]> {
  return page.evaluate(() => (window as unknown as { __canvasTextDraws: CanvasTextDraw[] }).__canvasTextDraws.slice())
}

/** The last width each label was drawn at up to `until` (page time), or null for a label not drawn by then. */
function widthsUntil(draws: readonly CanvasTextDraw[], until = Infinity): Record<Kind, number | null> {
  const widths: Record<Kind, number | null> = { name: null, badge: null, guide: null }
  for (const draw of draws) {
    const kind = kindOf(draw.text)
    if (kind && draw.at <= until) widths[kind] = draw.width
  }
  return widths
}

/** Which labels were drawn after `since` (page time) at a width other than `before`'s. */
function redrawnSince(draws: readonly CanvasTextDraw[], since: number, before: Record<Kind, number | null>): Record<Kind, boolean> {
  const redrawn: Record<Kind, boolean> = { name: false, badge: false, guide: false }
  for (const draw of draws) {
    const kind = kindOf(draw.text)
    if (kind && draw.at > since && Math.abs(draw.width - before[kind]!) > 0.01) redrawn[kind] = true
  }
  return redrawn
}

/** Holds back every file of the interface font (Source Sans 3, src/styles/fonts.css) until the returned release is called. */
async function holdInterfaceFont(page: Page): Promise<{ release: () => void, held: () => number }> {
  let release = (): void => {}
  let held = 0
  const arrived = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/source-sans-3-*.woff2', async (route: Route) => {
    held += 1
    await arrived
    await route.continue()
  })
  return { release, held: () => held }
}

/**
 * The base fixture with the first apple's name pinned, a second hazel on the first hazel's spot (a stack of two, so a
 * count badge) and a measurement guide across the planting, written beside the test's output.
 */
async function fixtureWithLabels(path: string): Promise<string> {
  const design = JSON.parse(await readFile(FIXTURE, 'utf8')) as {
    plants: Array<Record<string, unknown> & { id: string, canonical_name: string }>
    measurement_guides: unknown[]
  }
  const apple = design.plants.find((plant) => plant.canonical_name === 'Malus domestica')!
  apple.pinned_name = true
  const hazel = design.plants.find((plant) => plant.canonical_name === 'Corylus avellana')!
  design.plants.push({ ...hazel, id: 'b6d2a4e0-5f0c-4c8e-9d61-3c1f0e7a2b55' })
  design.measurement_guides = [{
    id: 'guide-5d0e9c1a-2b47-4f63-8a1e-7c9d4b2f6e10',
    locked: false,
    start: { lon: 3.87715, lat: 43.61100 },
    end: { lon: 3.87745, lat: 43.61100 },
  }]
  await writeFile(path, JSON.stringify(design, null, 2))
  return path
}

test('a pinned plant name, a stack badge and a guide label drawn before the web font arrives are drawn again in it once it loads (canopi-f47t.52.36)', async ({ page }, testInfo) => {
  const fixture = await fixtureWithLabels(testInfo.outputPath('labels.canopi'))
  await page.addInitScript(recordCanvasText)
  const font = await holdInterfaceFont(page)
  // The load event waits for the held fonts: only the document is waited for.
  await page.goto('', { waitUntil: 'domcontentloaded' })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /\.canopi/ }).first().click(),
  ])
  await chooser.setFiles(fixture)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)

  await expect.poll(async () => widthsUntil(await canvasTextDraws(page)), 'the three labels are drawn in a fallback font')
    .toEqual({ name: expect.any(Number), badge: expect.any(Number), guide: expect.any(Number) })
  expect(font.held(), 'the interface font is held back').toBeGreaterThan(0)
  const releasedAt = await page.evaluate(() => performance.now())
  const fallback = widthsUntil(await canvasTextDraws(page), releasedAt)

  // Whether a label widens or narrows depends on the fallback the host has (Noto Sans and DejaVu Sans are wider).
  font.release()
  await expect.poll(async () => redrawnSince(await canvasTextDraws(page), releasedAt, fallback), 'each label is drawn again at its width in the web font')
    .toEqual({ name: true, badge: true, guide: true })
})
