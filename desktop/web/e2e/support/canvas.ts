// Readiness of the canvas for the Web Edition browser checks. The DOM (chips, pressed tools,
// Undo) changes as soon as the Design does; the canvas draws it a frame and an asynchronous
// render step later. The runtime marks the Design map aria-busy from a Design change until
// its renderer has drawn it (canvas/runtime/scene-runtime.ts), and never for a camera frame:
// a step that flies the camera emulates reduced motion first, so the camera jumps instead
// (page.emulateMedia({ reducedMotion: 'reduce' }), as base.spec.ts does to present a story).
import type { Page } from '@playwright/test'
import { expect } from './offline'

/** The map host: the keyboard stop the canvas draws in. */
export function designMap(page: Page) {
  return page.getByRole('application', { name: 'Design map' })
}

/**
 * Waits until the canvas has drawn the latest Design edit, undo, selection or opened Design.
 * Call it before a screenshot, after the DOM checks that say the change happened.
 */
export async function expectCanvasDrawn(page: Page): Promise<void> {
  await expect(designMap(page), 'the canvas has drawn the latest change').not.toHaveAttribute('aria-busy')
}

/**
 * Presses a `mod` shortcut as the page's own platform spells it: Cmd where the user agent names a Mac, Ctrl elsewhere
 * (app/keyboard/key-chord.ts; a physical Ctrl on a Mac is `ctrl`, never `mod`). Playwright's WebKit reports a Mac
 * user agent on every host, and its `ControlOrMeta` follows the host, not the page.
 */
export async function pressMod(page: Page, key: string): Promise<void> {
  const mac = await page.evaluate(() => /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent))
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+${key}`)
}

/**
 * Seeds the pointing device before every navigation, so a wheel step reads the same in every engine: a new profile on a
 * Mac starts on Trackpad (2.1-Q309, platform/settings.browser.ts), and Playwright's WebKit reports a Mac user agent on
 * every host. Adds `scroll_wheel` to the Web settings record (web/browser-app-data.ts) only where it has none, so a
 * spec's own record and the app's later writes stay as they are.
 */
export async function seedPointingDevice(page: Page, scrollWheel: 'zoom' | 'pan' = 'zoom'): Promise<void> {
  await page.addInitScript((seed) => {
    const key = 'canopi:web-app-data:v3:settings'
    const raw = localStorage.getItem(key)
    const record = raw === null ? { version: 3, settings: {} } : JSON.parse(raw) as { settings?: Record<string, unknown> | null }
    const settings = record.settings ?? {}
    if ('scroll_wheel' in settings) return
    localStorage.setItem(key, JSON.stringify({ ...record, settings: { ...settings, scroll_wheel: seed } }))
  }, scrollWheel)
}

/** The view's bearing in degrees clockwise from north, read from the compass needle (`rotate(-bearing 10 10)`). */
export async function bearing(page: Page): Promise<number> {
  const transform = await page.locator('[data-compass] [data-needle]').first().getAttribute('transform')
  const match = /rotate\(([-\d.e]+)/.exec(transform ?? '')
  if (!match) throw new Error(`the compass needle has no rotation: ${transform}`)
  const deg = -Number(match[1])
  return deg === 0 ? 0 : deg   // never -0
}
