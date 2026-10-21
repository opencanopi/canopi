// The New version: Reload notice (2.1-Q83, Q186 to Q189, M179; Step 2.0.3 serving chunk 2).
// Engine contract first (commit 0's probe, kept): a lazy chunk that fails to load reaches a `window` listener as Vite's
// `vite:preloadError`, and the import still rejects, in Chromium, WebKit and Firefox (the `firefox` project, 2.1-Q196).
// Measured 2026-10-21 in mcr.microsoft.com/playwright:v1.63.0-noble with the PDF `job` chunk answered 404: one cancelable
// event per engine, its payload a TypeError (Chromium "Failed to fetch dynamically imported module: <url>", Firefox
// "error loading dynamically imported module: <url>", WebKit "Importing a module script failed." with no URL); a bare
// import() of a missing module rejects with the same TypeError; the app logs no error of its own for the failed chunk.
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** The PDF preview's lazy `job` chunk (app/canvas-pdf/live.ts): never loaded before the export opens, and offline-safe. */
const PDF_JOB_CHUNK = /\/app\/assets\/job-[^/]+\.js$/

/** Each engine's message for a module script that failed to load. */
const IMPORT_FAILED: Record<string, RegExp> = {
  chromium: /^(true:)?TypeError: Failed to fetch dynamically imported module: http/,
  firefox: /^(true:)?TypeError: error loading dynamically imported module: http/,
  webkit: /^(true:)?TypeError: Importing a module script failed\.$/,
}

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)'

async function openFixtureFromStart(page: Page): Promise<void> {
  const open = page.locator('[data-start-screen] button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(FIXTURE)
  // The Design's title bar, not the map: Firefox in the pinned image has no WebGL, so its map never draws.
  await expect(page.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
}

async function openPdfExport(page: Page): Promise<void> {
  await page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'Planting plan (PDF)…' }).click()
}

test.describe('probe', () => {
  // The browser's line for the 404 this test causes; Firefox in the pinned image has no WebGL, so its map reports failing.
  test.use({ expectedConsoleErrors: async ({ browserName }, use) => { await use(browserName === 'firefox' ? [NOT_FOUND, 'Shared workspace map failed:'] : [NOT_FOUND]) } })

  test('probe: a failed lazy chunk reaches window as vite:preloadError and the import still rejects', async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const seen: string[] = []
      ;(window as unknown as { __preloadErrors: string[] }).__preloadErrors = seen
      window.addEventListener('vite:preloadError', (event) => {
        const payload = (event as Event & { payload?: unknown }).payload
        seen.push(`${event.cancelable}:${payload instanceof Error ? `${payload.name}: ${payload.message}` : String(payload)}`)
      })
    })
    await page.route(PDF_JOB_CHUNK, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }))
    await page.goto('')
    await openFixtureFromStart(page)
    await openPdfExport(page)
    await expect.poll(async () => await page.evaluate(() => (window as unknown as { __preloadErrors: string[] }).__preloadErrors.length)).toBeGreaterThan(0)
    const errors = await page.evaluate(() => (window as unknown as { __preloadErrors: string[] }).__preloadErrors)
    expect(errors, 'one cancelable event whose payload is the import TypeError').toEqual([expect.stringMatching(IMPORT_FAILED[browserName]!)])
    const direct = await page.evaluate(async () => {
      try {
        await import(/* @vite-ignore */ `${location.origin}/app/assets/missing-${Date.now()}.js`)
        return 'resolved'
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`
      }
    })
    expect(direct).toMatch(IMPORT_FAILED[browserName]!)
  })
})
