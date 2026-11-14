// The start-up guard (canopi-4kfl; 2.1-M471, 2.1-M489): on an engine below the floor the app's module never
// acknowledges its boot, and a separate classic script shows "Canopi couldn't start" with the update hint instead of an
// empty window. The engine is made too old here the ways a real one is: the entry module does not parse (newer syntax
// than the engine reads), a chunk it needs answers 404, or an API the app calls is missing. The guard script itself is
// left as served: it is a classic script lowered to the oldest syntax at build time (vite.config.ts bootGuardPlugin),
// not the module. A normal boot, a slow one included, never shows it, and a guard that fails to load never stops the
// app. Both editions' pages carry the tag: the plugin fails either build that has no module script to put it before.
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
const MISSING_CHUNK = '/assets/reader-release-missing-entry.js'
const BROKEN_ENTRY = '/assets/reader-release-broken-entry.js'
const GUARD_SCRIPT = /^<script src="\/assets\/boot-guard-[\w-]{16}\.js"><\/script>$/
const ENGLISH_TITLE = /^Canopi couldn.t start$/

// The browser's line for the module (or the guard) the test answers 404.
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

/** Answers the entry module 404, as an engine that cannot fetch a chunk the build needs. */
async function missEntry(page: Page): Promise<void> {
  await page.route(`**${MISSING_CHUNK}`, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }))
  await pointEntryAt(page, MISSING_CHUNK)
}

function guardOf(page: Page) {
  return page.locator('[data-boot-guard]')
}

async function expectGuard(page: Page, title: RegExp = ENGLISH_TITLE): Promise<void> {
  const guard = guardOf(page)
  await expect(guard, 'the guard says Canopi could not start').toBeVisible({ timeout: 15_000 })
  await expect(guard, 'as an alert').toHaveAttribute('role', 'alert')
  await expect(guard.getByRole('heading', { level: 1 })).toHaveText(title)
}

/** The app booted (its start screen shows), the load event has passed, and the guard never showed. */
async function expectBootWithoutGuard(page: Page): Promise<void> {
  await expect(page.locator('[data-start-screen]'), 'the app boots').toBeVisible({ timeout: 30_000 })
  await page.waitForLoadState('load')
  expect(await page.evaluate(() => document.readyState)).toBe('complete')
  await expect(guardOf(page), 'and the guard never shows').toHaveCount(0)
}

test('U canopi-4kfl: the start-up guard shows on an engine below the floor (a chunk answers 404)', async ({ page }) => {
  await missEntry(page)
  await page.goto('')
  await expectGuard(page)
  await expect(guardOf(page), 'and how to get an engine that runs it').toContainText(/update/i)
})

test.describe('a module that does not parse', () => {
  // The uncaught SyntaxError is the scenario itself.
  test.use({ expectedPageErrors: [/^SyntaxError: /] })

  test('U canopi-4kfl: the start-up guard shows on an engine below the floor (the module does not parse)', async ({ page }) => {
    // Syntax no engine reads, as an old engine meets a newer build's syntax.
    await page.route(`**${BROKEN_ENTRY}`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const = ;\n' }))
    await pointEntryAt(page, BROKEN_ENTRY)
    await page.goto('')
    await expectGuard(page)
  })
})

test('canopi-4kfl: the start-up guard shows at once when an API the app calls is missing', async ({ page }) => {
  // The app itself boots behind it: the guard tells the user before a later step fails without a word.
  await page.addInitScript(() => {
    // One the guard requires and every floor engine has (Firefox 95, Chrome 92, Safari 15.4).
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true, writable: true })
  })
  await page.goto('')
  await expectGuard(page)
})

test('canopi-4kfl: a slow normal boot never shows the start-up guard', async ({ page }) => {
  await page.route('**/assets/web-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await route.continue()
  })
  await page.goto('')
  await expectBootWithoutGuard(page)
})

test('canopi-4kfl: a start-up guard that fails to load leaves the app to boot', async ({ page }) => {
  let missed = 0
  await page.route('**/assets/boot-guard-*.js', (route) => {
    missed += 1
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
  })
  await page.goto('')
  await expectBootWithoutGuard(page)
  expect(missed, 'the page asked for the guard').toBe(1)
})

test('canopi-4kfl: the page loads the start-up guard as a classic script before the entry module', async ({ page }) => {
  const response = await page.request.get('')
  const html = await response.text()
  const guard = html.match(/<script\b[^>]*boot-guard[^>]*><\/script>/)
  expect(guard?.[0], 'one classic script, its name hashed').toMatch(GUARD_SCRIPT)
  const entry = html.search(/<script\b[^>]*\btype="module"/)
  expect(entry, 'the page has an entry module').toBeGreaterThan(0)
  expect(guard!.index!, 'the guard runs before the entry module').toBeLessThan(entry)
})

test.describe('in the system language', () => {
  test.use({ locale: 'fr-FR' })

  test('canopi-4kfl: the start-up guard speaks the system language', async ({ page }) => {
    await missEntry(page)
    await page.goto('')
    await expectGuard(page, /^Canopi n.a pas pu démarrer$/)
    await expect(guardOf(page)).toHaveAttribute('lang', 'fr')
  })
})

test('canopi-4kfl: the start-up guard falls back to English for a language Canopi has no strings in', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'language', { get: () => 'tlh-Latn', configurable: true })
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['tlh-Latn'], configurable: true })
  })
  await missEntry(page)
  await page.goto('')
  await expectGuard(page)
  await expect(guardOf(page)).toHaveAttribute('lang', 'en')
})
