// Layout helpers for the Web Edition's chrome checks (map-notice-layout.spec.ts, plant-path-chrome.spec.ts): open a
// fixture in a fresh browser with Web Edition settings, read boxes, test overlap and what a click at a centre reaches,
// and read the visible map frame the visible-map-area seam publishes for the chips. DOM assertions only, no baselines.
import type { Locator, Page } from '@playwright/test'
import { expect } from './offline'

/** The Web Edition's settings record (web/browser-app-data.ts); its settings are merged over the defaults. */
const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'

export interface Box { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** The Design map; locale-free (its name is translated). */
export function mapHost(page: Page): Locator {
  return page.getByRole('application').first()
}

export interface OpenOptions {
  readonly locale?: string
  /** Hides the basemap, so no map notice shows. */
  readonly basemapHidden?: boolean
  /** Other Web Edition settings, such as `snap_to_grid` or `tool_names_visible`. */
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Writes the settings once instead of before every navigation, so a reload keeps the Draft the open wrote (a spec
   * that reopens the Design from its Draft).
   */
  readonly keepOnReload?: boolean
}

/**
 * Opens `fixture` in a fresh browser (an earlier open's draft would reopen with its camera), whose Web Edition settings
 * take `locale` and the other options.
 */
export async function openFixture(page: Page, fixture: string, options: OpenOptions = {}): Promise<void> {
  const { locale = 'en', basemapHidden = false, settings = {}, keepOnReload = false } = options
  const stored = { key: SETTINGS_KEY, values: { ...settings, locale, ...(basemapHidden ? { basemap_visible: false } : {}) } }
  const write = (record: typeof stored) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem(record.key, JSON.stringify({ version: 3, settings: record.values }))
  }
  if (keepOnReload) {
    await page.goto('')
    await page.evaluate(write, stored)
    await page.reload()
  } else {
    // Unload any earlier open Design before clearing storage so its pagehide flush cannot race WebKit's init script.
    if (page.url() !== 'about:blank') await page.goto('about:blank')
    await page.addInitScript(write, stored)
    await page.goto('')
  }
  const open = page.locator('[data-start-screen] button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(fixture)
  await expect(mapHost(page)).toBeVisible()
  await expect(mapHost(page), 'the canvas has drawn the opened Design').not.toHaveAttribute('aria-busy')
}

export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** Expects a click at the centre of `target` to reach it (or one of its descendants), not chrome stacked above it. */
export async function expectHitAtCentre(target: Locator, name: string): Promise<void> {
  const box = await boxOf(target)
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const hit = await target.evaluate((element, at) => {
    const top = document.elementFromPoint(at.x, at.y)
    return top !== null && element.contains(top)
  }, centre)
  expect(hit, `a click at ${name}'s centre (${centre.x}, ${centre.y}) reaches ${name}`).toBe(true)
}

/** The visible map frame the seam publishes on the map area for the chips (`--map-inset-*`), in page pixels. */
export async function chipFrame(page: Page): Promise<{ top: number, right: number, bottom: number, left: number }> {
  return await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[style*="--map-inset-bottom"]')
    if (!area) throw new Error('no map area publishes its insets')
    const box = area.getBoundingClientRect()
    const inset = (edge: string) => parseFloat(area.style.getPropertyValue(`--map-inset-${edge}`))
    return { top: box.top + inset('top'), right: box.right - inset('right'), bottom: box.bottom - inset('bottom'), left: box.left + inset('left') }
  })
}

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no box: the element is not laid out')
  return box
}

export function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
