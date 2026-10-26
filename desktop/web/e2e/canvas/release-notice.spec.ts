// The New version: Reload notice (2.1-Q83, Q186 to Q189, M179; Step 2.0.3 serving chunk 2), with a routed edition
// manifest: `vite preview` serves none, so every test here answers it. The real deploy pair is the release check's
// (e2e-release/deploy-skew.spec.ts, 2.1-Q197): a 2.0.2 tab has no notice.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Locator, Page, Route } from '@playwright/test'
import { expectDownloadName } from '../support/download'
import { boxOf, expectHitAtCentre, overlap, type Box } from '../support/layout'
import { expect, test } from '../support/offline'
import { draftsKeptStub } from '../support/storage-persistence'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
/** The PDF preview's lazy `job` chunk (app/canvas-pdf/live.ts): never loaded before the export opens, and offline-safe. */
const PDF_JOB_CHUNK = /\/assets\/job-[^/]+\.js$/

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

/** Firefox in the pinned image has no WebGL, so its map reports failing; nothing here needs the map. */
const NO_WEBGL = 'Shared workspace map failed:'

// The browser's line for a chunk a test answers 404, and Firefox's map.
test.use({ expectedConsoleErrors: async ({ browserName }, use) => { await use(browserName === 'firefox' ? [NOT_FOUND, NO_WEBGL] : [NOT_FOUND]) } })

/** This build's release (the manifest of a packaged build names desktop/web/package.json's, which release-candidate keeps equal). */
const OWN_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../tauri.conf.json', import.meta.url)), 'utf8')) as { version: string }).version
const OTHER_VERSION = `${OWN_VERSION}-next`
const MANIFEST = '**/canopi-web-edition-manifest.json'
const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'
const DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'
const SAVE_FAILED = 'Continuous save failed:'

type Strings = { webRelease: Record<string, string>, error: Record<string, string>, webShell: Record<string, string>, saveProblem: Record<string, string>, canvas: { file: Record<string, string> } }
function strings(locale: string): Strings {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/i18n/${locale}.json`, import.meta.url)), 'utf8')) as Strings
}

/** Answers the edition manifest with `version()` at each read and counts the reads. */
async function routeManifest(page: Page, version: () => string): Promise<{ reads: () => number }> {
  let reads = 0
  await page.route(MANIFEST, (route: Route) => {
    reads += 1
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ name: 'Canopi Web Edition', version: version(), commit: 'e2e', files: [] }),
    })
  })
  return { reads: () => reads }
}

function releaseNotice(page: Page): Locator {
  return page.locator('[data-web-shell-notice][data-release]')
}

/** Window focus, as when the user comes back to the tab; the watch reads on it at most once a minute. */
async function focusWindow(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

// The event contract the watch relies on: a lazy chunk that fails to load reaches `window` as Vite's `vite:preloadError`,
// in Chromium, WebKit and Firefox (the `firefox` project, 2.1-Q196); the 404 PDF `job` chunk below proves it per engine.
test('Q83: another release named by the manifest shows one New version: Reload notice', async ({ page }) => {
  let version = OWN_VERSION
  await page.clock.install()
  const manifest = await routeManifest(page, () => version)
  await page.route(PDF_JOB_CHUNK, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }))
  await page.goto('')
  await openFixtureFromStart(page)

  // This tab's own release: no notice.
  await focusWindow(page)
  await expect.poll(manifest.reads).toBe(1)
  await expect(page.locator('[data-web-shell-notice]')).toHaveCount(0)

  // A deploy drops the PDF preview's chunk this tab's release named; the failed import reads the manifest at once.
  version = OTHER_VERSION
  await openPdfExport(page)
  await expect.poll(manifest.reads).toBe(2)
  const pdf = page.getByRole('dialog', { name: 'Export to PDF' })
  if (await pdf.isVisible()) await pdf.getByRole('button', { name: /Back to the Design/ }).click()
  const notice = releaseNotice(page)
  await expect(notice).toBeVisible()
  await expect(page.locator('[data-web-shell-notice]'), 'one notice row').toHaveCount(1)
  await expect(notice).toHaveAttribute('role', 'status')
  await expect(notice).toContainText('New version')
  await expect(notice).toContainText('Canopi was updated. Reload to use it; your Design is saved first.')
  await expect(notice.getByRole('button')).toHaveText(['Reload', ''])
  await expect(notice.getByRole('button', { name: 'Dismiss' })).toBeVisible()

  // While it shows, focus reads nothing more and no second notice appears, even past the minute that spaces focus reads.
  await page.clock.fastForward(61_000)
  await focusWindow(page)
  await focusWindow(page)
  await expect(page.locator('[data-web-shell-notice]')).toHaveCount(1)

  // Dismissed, it stays away for the same release and returns after another failed import (Q187).
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true })))
  await expect(notice).toBeVisible()
  // Counted behind that read: a focus read while the notice showed would have been answered first, making four.
  expect(manifest.reads(), 'focus read nothing while the notice showed').toBe(3)
  await expect(page.locator('[data-web-shell-notice]')).toHaveCount(1)
})

test.describe('a Draft write that fails', () => {
  // The app's own line for the write the browser refused.
  test.use({ expectedConsoleErrors: async ({ browserName }, use) => { await use(browserName === 'firefox' ? [SAVE_FAILED, NO_WEBGL] : [SAVE_FAILED]) } })

  test('Q83: Reload saves first, and a failed save offers Download a copy', async ({ page }) => {
    await page.addInitScript(() => {
      // The browser's storage full for Drafts while `__failDrafts` is set (a quota refusal).
      const setItem = Storage.prototype.setItem
      // What the Drafts record holds when the page starts to unload: after Reload's own write, before the pagehide one.
      window.addEventListener('beforeunload', () => {
        sessionStorage.setItem('e2e:drafts-at-unload', localStorage.getItem('canopi:web-app-data:v3:drafts') ?? '')
      })
      Storage.prototype.setItem = function failingSetItem(this: Storage, key: string, value: string) {
        if ((window as unknown as { __failDrafts?: boolean }).__failDrafts && key === 'canopi:web-app-data:v3:drafts') {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        }
        setItem.call(this, key, value)
      }
    })
    await routeManifest(page, () => OTHER_VERSION)
    await page.goto('')
    await openFixtureFromStart(page)
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) !== null, DRAFTS_KEY), 'the opened Design is a Draft').toBe(true)

    // An edit the browser cannot write.
    await page.evaluate(() => { (window as unknown as { __failDrafts: boolean }).__failDrafts = true })
    await renameDesign(page, 'Orchard before the deploy')
    await focusWindow(page)
    const notice = releaseNotice(page)
    await expect(notice).toBeVisible()

    // Reload writes first; the failed write asks, with Download a copy (Q188).
    await notice.getByRole('button', { name: 'Reload' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Your Design couldn\'t be saved in this browser. Download a copy before you reload.')
    await expect(dialog.getByRole('button')).toHaveText(['Retry', 'Download a copy', 'Reload without saving', 'Cancel'])
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download a copy' }).click()])
    expectDownloadName(download, 'Orchard before the deploy.canopi')
    expect((JSON.parse(readFileSync(await download.path(), 'utf8')) as { name: string }).name).toBe('Orchard before the deploy')
    // The copy downloaded, the same question again: the Draft is still unwritten.
    await expect(dialog.getByRole('button')).toHaveText(['Retry', 'Download a copy', 'Reload without saving', 'Cancel'])
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(notice.getByRole('button', { name: 'Reload' }), 'Cancel keeps the tab and the notice').toBeEnabled()
    // canopi-eon8.15: closing the dialog returns focus to Reload, which opened it.
    await expect(notice.getByRole('button', { name: 'Reload' }), 'focus is back on Reload').toBeFocused()

    // Room again, and another tab wrote a newer Draft meanwhile: Reload writes this tab's edit and reopens its Design
    // (Q189), not the newest Draft.
    await page.evaluate((key) => {
      (window as unknown as { __failDrafts: boolean }).__failDrafts = false
      const record = JSON.parse(localStorage.getItem(key)!) as { drafts: { id: string, name: string, updatedAt: string }[], draftFiles: Record<string, { name: string }> }
      const [first] = record.drafts
      record.drafts.unshift({ id: 'draft-other-tab', name: 'Other tab', updatedAt: '2099-01-01T00:00:00.000Z' })
      record.draftFiles['draft-other-tab'] = { ...record.draftFiles[first!.id]!, name: 'Other tab' }
      localStorage.setItem(key, JSON.stringify(record))
    }, DRAFTS_KEY)
    const draftNames = (text: string | null) => (JSON.parse(text || '{"drafts":[]}') as { drafts: { name: string }[] }).drafts.map((draft) => draft.name)
    expect(draftNames(await page.evaluate((key) => localStorage.getItem(key), DRAFTS_KEY)), 'the edit is unwritten before Reload').not.toContain('Orchard before the deploy')
    await Promise.all([
      page.waitForEvent('framenavigated'),
      notice.getByRole('button', { name: 'Reload' }).click(),
    ])
    // Reload wrote the edit before the page unloaded: the pagehide write comes later.
    expect(draftNames(await page.evaluate(() => sessionStorage.getItem('e2e:drafts-at-unload'))), 'saved before the reload').toContain('Orchard before the deploy')
    await expect(page.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
    await expect(page.locator('[data-workspace-title-bar]').getByRole('button', { name: /^Rename Design/ })).toHaveText('Orchard before the deploy')
    await expect(page.locator('[data-web-shell-notice]'), 'the reloaded tab runs the served release').toHaveCount(0)
  })
})

async function renameDesign(page: Page, name: string): Promise<void> {
  await page.locator('[data-workspace-title-bar]').getByRole('button', { name: /^Rename Design/ }).click()
  const field = page.locator('[data-workspace-title-bar]').getByRole('textbox', { name: 'Design name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.locator('[data-workspace-title-bar]').getByRole('button', { name: /^Rename Design/ })).toHaveText(name)
}

// The neighbour matrix (agentic-delivery "Design check"): the notice row at seven sizes, in English and German (the
// longest webRelease strings), with and without the save status's may-be-cleared warning (2.1-Q82, persist), overlaps
// none of the shell's controls, and Reload, Dismiss and every title bar control take a click at their centre.
const SIZES = [
  { width: 360, height: 560 },
  { width: 740, height: 360 },
  { width: 844, height: 390 },
  { width: 700, height: 500 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 1400, height: 900 },
] as const
const LOCALES = ['en', 'de'] as const

/** Opens with a stored Draft, which reopens at launch; `kept` forces the browser to keep Drafts, so no warning shows. */
async function launchWithDraft(page: Page, locale: string, kept: boolean): Promise<void> {
  if (kept) await page.addInitScript(draftsKeptStub)
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const records = {
    [SETTINGS_KEY]: JSON.stringify({ version: 3, settings: { locale, basemap_visible: false } }),
    [DRAFTS_KEY]: JSON.stringify({
      version: 3,
      drafts: [{ id: 'draft-orchard', name: 'Orchard', updatedAt: '2026-10-01T00:00:00.000Z' }],
      draftFiles: { 'draft-orchard': { ...file, name: 'Orchard' } },
    }),
  }
  await page.goto('')
  await page.evaluate((values) => {
    localStorage.clear()
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  }, records)
  await page.reload()
  await expect(page.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
  await expect(page.locator('[data-save-status] [data-draft-warning]')).toHaveCount(kept ? 0 : 1)
}

/** Visible leaf controls and texts in the shell outside the notice. */
async function shellNeighbours(page: Page, notice: Locator): Promise<{ name: string, box: Box }[]> {
  const handle = await notice.elementHandle()
  return await page.locator('[data-testid="browser-app-shell"]').evaluate((shell, target) => {
    const found: { name: string, box: { x: number, y: number, width: number, height: number } }[] = []
    for (const leaf of shell.querySelectorAll<HTMLElement>('button, input, h1, h2, p, img, [role="status"], [role="combobox"], a, label')) {
      if (!target || leaf === target || target.contains(leaf) || leaf.contains(target)) continue
      if (!leaf.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      const rect = leaf.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const name = leaf.getAttribute('aria-label') || leaf.textContent?.trim().slice(0, 40) || leaf.tagName
      found.push({ name, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    }
    return found
  }, handle)
}

for (const locale of LOCALES) {
  for (const size of SIZES) {
    for (const kept of [false, true]) {
      const name = `${size.width}×${size.height}, ${locale}, ${kept ? 'no' : 'with the'} persistence warning`
      test.describe(name, () => {
        test.use({ viewport: size, hasTouch: size.width < 900 })

        test(`Q83 neighbours: the New version notice overlaps no shell control, and its buttons and the bar's take a click (${name})`, async ({ page }) => {
          const text = strings(locale)
          await routeManifest(page, () => OTHER_VERSION)
          await launchWithDraft(page, locale, kept)
          await focusWindow(page)
          const notice = releaseNotice(page)
          await expect(notice).toBeVisible()
          await expect(notice).toContainText(text.webRelease.message!)
          const noticeBox = await boxOf(notice)
          const barBox = await boxOf(page.locator('[data-workspace-title-bar]'))
          expect(noticeBox.x, 'the notice starts on screen').toBeGreaterThanOrEqual(0)
          expect(noticeBox.x + noticeBox.width, 'the notice ends on screen').toBeLessThanOrEqual(size.width)
          expect(noticeBox.y, 'the notice is a row below the title bar').toBeGreaterThanOrEqual(barBox.y + barBox.height)
          expect(noticeBox.y + noticeBox.height, 'the notice leaves most of the map').toBeLessThanOrEqual(size.height / 2)
          for (const neighbour of await shellNeighbours(page, notice)) {
            expect(overlap(noticeBox, neighbour.box), `the notice overlaps ${neighbour.name} (${name})`).toBe(false)
          }
          const phone = await page.locator('[data-phone-layout]').count() > 0
          for (const label of [text.error.reload!, text.webShell.dismissNotice!]) {
            const button = notice.getByRole('button', { name: label, exact: true })
            await expect(async () => { await expectHitAtCentre(button, `${label} (${name})`) }).toPass({ timeout: 5000 })
            if (phone) expect((await boxOf(button)).height, `${label} is a 44 px phone target`).toBeGreaterThanOrEqual(44 - 0.5)
          }
          for (const button of await page.locator('[data-workspace-title-bar]').getByRole('button').filter({ visible: true }).all()) {
            await expectHitAtCentre(button, `${(await button.getAttribute('aria-label')) || (await button.textContent())?.trim()} (${name})`)
          }
          if (phone) expect(barBox.height, 'the phone bar keeps one row').toBeLessThanOrEqual(52.5)
        })
      })
    }
  }
}
