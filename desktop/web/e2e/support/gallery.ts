// The UI gallery's browser checks (canopi-f47t.42, plan section 4 "Surfaces and checks"). The gallery
// (ui-gallery/, its dev server on GALLERY_PORT in playwright.config.ts) mounts the Desktop panels and the shared
// workspace over memory fixtures, so a spec reaches no network and needs no Tauri. Every gallery spec
// imports `test` and `expect` from this file: it keeps the page on the gallery's origin, fails on any
// console error or uncaught page error, and stubs the clipboard so a copy can be read back.
import { test as base, expect, type Page } from '@playwright/test'
import { GALLERY_PORT } from './ports'

/** The gallery dev server of playwright.config.ts; the only origin a scenario may reach. */
export const GALLERY_ORIGIN = `http://127.0.0.1:${GALLERY_PORT}`

declare global {
  interface Window { __galleryClipboard?: string[] }
}

export const test = base.extend<{ galleryRule: void, expectedConsoleErrors: readonly string[] }>({
  /** Starts of the console errors a spec causes on purpose; a spec sets them with test.use. */
  expectedConsoleErrors: [[], { option: true }],
  galleryRule: [async ({ context, expectedConsoleErrors }, use) => {
    await context.route('**/*', (route) => new URL(route.request().url()).origin === GALLERY_ORIGIN
      ? route.continue()
      : route.abort('internetdisconnected'))
    // The clipboard is written from a click and read back here: `navigator.clipboard` needs a permission
    // grant in Chromium and has no grant in WebKit, and a real clipboard would leak between parallel tests.
    await context.addInitScript(() => {
      const copied: string[] = []
      window.__galleryClipboard = copied
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => { copied.push(text) },
          readText: async () => copied.at(-1) ?? '',
        },
      })
    })
    const unexpected: string[] = []
    context.on('console', (message) => {
      if (message.type() !== 'error' || expectedConsoleErrors.some((prefix) => message.text().startsWith(prefix))) return
      unexpected.push(`console error: ${message.text()} (${message.location().url})`)
    })
    context.on('weberror', (error) => unexpected.push(`uncaught: ${error.error().stack ?? error.error().message}`))
    await use()
    expect(unexpected, 'console errors and uncaught page errors').toEqual([])
  }, { auto: true }],
})

export { expect }

/**
 * Opens one gallery surface (`surface`, `state`, `open`, `locale`, `theme`, `sampleDelay`, …; ui-gallery/README.md)
 * and waits until its workspace canvas is ready (`data-gallery-ready`).
 */
export async function openGallery(page: Page, params: Readonly<Record<string, string>>): Promise<void> {
  await page.goto(`/?${new URLSearchParams(params).toString()}`)
  await expect(page.locator('[data-gallery-ready="true"]'), 'the gallery workspace is ready').toBeAttached()
}

/** The text each clipboard write received, oldest first. */
export async function copiedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__galleryClipboard ?? [])])
}

/** Turns on Desktop's raster renderer timeline (`raster-display/diagnostics.ts`) for the pages `page` opens next. */
export async function recordRasterTiles(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('canopi.rasterDiagnostics', '1'))
}

/** Tiles the raster renderer's worker pool has rendered since the page opened (after `recordRasterTiles`). */
export async function renderedRasterTiles(page: Page): Promise<number> {
  return page.evaluate(() => {
    const timeline = (window as { __CANOPI_RASTER_DIAGNOSTICS__?: { events: { kind: string }[] } }).__CANOPI_RASTER_DIAGNOSTICS__
    return timeline?.events.filter((event) => event.kind === 'tile').length ?? 0
  })
}

/**
 * Waits until the raster renderer has rendered tiles beyond `after`, then until two captures in a row agree (MapLibre
 * draws them on a later frame). The map holds a steady picture for seconds before the first tile lands, so two equal
 * captures alone can be the empty map.
 */
export async function settledRaster(page: Page, capture: () => Promise<Buffer>, after: number): Promise<Buffer> {
  await expect.poll(() => renderedRasterTiles(page), { timeout: 20_000, message: 'the renderer renders tiles' }).toBeGreaterThan(after)
  let drawn = await capture()
  await expect.poll(async () => {
    const next = await capture()
    const same = next.equals(drawn)
    drawn = next
    return same
  }, { timeout: 20_000 }).toBe(true)
  return drawn
}
