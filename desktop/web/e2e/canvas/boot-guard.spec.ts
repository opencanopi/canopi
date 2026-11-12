// The start-up guard (canopi-4kfl; 2.1-M471, 2.1-M489): on an engine below the floor the app's module never
// acknowledges its boot, and a separate classic script shows "Canopi couldn't start" with the update hint instead of an
// empty window. The engine is made too old here the two ways a real one is: the entry module does not parse (newer
// syntax than the engine reads) and a chunk it needs answers 404. The guard script itself is left as served, since it
// is written in the oldest syntax and is a classic script, not the module.
//
// Written failing in commit 0 and marked expected-fail (`test.fail`): U-4 removes the markers. The parse-failure case
// also needs `support/offline.ts` to accept the page error it causes on purpose (it fails a test on every uncaught page
// error today), which U-4 requests with the guard.
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
const MISSING_CHUNK = '/assets/reader-release-missing-entry.js'
const BROKEN_ENTRY = '/assets/reader-release-broken-entry.js'

// The browser's line for the module the test answers 404.
test.use({ expectedConsoleErrors: [NOT_FOUND] })

/** Serves the Web Edition's page with its entry module (the one `type="module"` script) pointed at `entry`. */
async function pointEntryAt(page: Page, entry: string): Promise<void> {
  await page.route('**/web.html', async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    const rewritten = html.replace(/(<script\b[^>]*\btype="module"[^>]*\bsrc=")[^"]+(")/, `$1${entry}$2`)
    expect(rewritten, 'the page has an entry module to point elsewhere').not.toBe(html)
    await route.fulfill({ response, body: rewritten })
  })
}

async function expectGuard(page: Page): Promise<void> {
  // Today nothing is shown: the window stays empty.
  const guard = page.getByRole('alert').filter({ hasText: /Canopi couldn.t start/ })
  await expect(guard, 'the guard says Canopi could not start').toBeVisible({ timeout: 15_000 })
  await expect(guard, 'and how to get an engine that runs it').toContainText(/update/i)
}

test.fail('U canopi-4kfl: the start-up guard shows on an engine below the floor (a chunk answers 404)', async ({ page }) => {
  await page.route(`**${MISSING_CHUNK}`, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }))
  await pointEntryAt(page, MISSING_CHUNK)
  await page.goto('')
  await expectGuard(page)
})

test.fail('U canopi-4kfl: the start-up guard shows on an engine below the floor (the module does not parse)', async ({ page }) => {
  // Syntax no engine reads, as an old engine meets a newer build's syntax.
  await page.route(`**${BROKEN_ENTRY}`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const = ;\n' }))
  await pointEntryAt(page, BROKEN_ENTRY)
  await page.goto('')
  await expectGuard(page)
})
