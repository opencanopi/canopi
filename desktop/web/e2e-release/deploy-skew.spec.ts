// The deploy-skew check (2.1-Q83, Q197), real artifacts only: scripts/publish-web-release.sh deploys release N-1 to
// the preview project on its custom domain, runs this spec alone (CANOPI_WEB_RELEASE_HANDOFF set) in the pinned
// image, and hands off by files in that mounted directory: this tab writes `n1-ready` once N-1 is open and edited;
// the host deploys merged N, waits for N's manifest and writes `n-deployed`. The N-1 tab then loads the PDF job chunk
// the host named in `carried-chunks` (one N's own files do not name), reads the plant catalog and keeps saving.
// N-1 (2.0.3 or later) runs the release watch (2.1-Q197), so its New version notice shows and Reload loads N.
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page, type Response } from '@playwright/test'
import { collectPageProblems } from './page-problems'

const handoff = process.env.CANOPI_WEB_RELEASE_HANDOFF ?? ''
const MANIFEST = '/canopi-web-edition-manifest.json'
/** How long the host may take to deploy N and see it served; publish-web-release.sh waits as long. */
const DEPLOY_WAIT_MS = 20 * 60_000

interface EditionManifest { readonly version: string; readonly files: readonly { readonly path: string }[] }

async function servedManifest(page: Page): Promise<EditionManifest> {
  const response = await page.request.get(`${MANIFEST}?skew=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } })
  expect(response.status()).toBe(200)
  return await response.json() as EditionManifest
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { await access(path); return } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`${path} did not appear within ${timeoutMs / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

async function draftStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])))
}

async function drawRectangle(page: Page, offset: number): Promise<void> {
  await page.keyboard.press('r')
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('the map canvas has no box')
  await page.mouse.move(box.x + 420 + offset, box.y + 420)
  await page.mouse.down()
  await page.mouse.move(box.x + 560 + offset, box.y + 520, { steps: 8 })
  await page.mouse.up()
}

test('Q83, canopi-eon8.19: a release N-1 tab loads a lazy chunk, reads the catalog, keeps saving and reloads into N after N deploys (F3c-c1, canopi-f47t.52.228.11)', async ({ page }) => {
  test.skip(!handoff, 'run by scripts/publish-web-release.sh with CANOPI_WEB_RELEASE_HANDOFF')
  test.fail(true, 'F3c-c1 (canopi-f47t.52.228.11): the release tools still carry 2.0.2-only paths until canopi-eon8.19 lands')
  test.setTimeout(DEPLOY_WAIT_MS + 10 * 60_000)
  const problems = collectPageProblems(page)
  const afterDeploy: Response[] = []
  let deployed = false
  page.on('response', (response) => { if (deployed) afterDeploy.push(response) })

  await page.goto('/', { waitUntil: 'networkidle' })
  const previous = await servedManifest(page)

  await test.step(`a ${previous.version} tab opens a Design and edits it`, async () => {
    await page.getByRole('button', { name: 'New Design', exact: true }).first().click()
    await page.getByPlaceholder('Place or coordinates').fill('Lyon')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: /Lyon/ }).or(page.getByRole('option', { name: /Lyon/ })).first().click()
    await expect(page.getByRole('button', { name: /Map scale/ })).not.toHaveAccessibleName(/17,000,000/)
    await drawRectangle(page, 0)
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
  })

  let current: EditionManifest | null = null
  await test.step('the host deploys release N while the tab stays open', async () => {
    await writeFile(join(handoff, 'n1-ready'), `${previous.version}\n`)
    await waitForFile(join(handoff, 'n-deployed'), DEPLOY_WAIT_MS)
    deployed = true
    current = await servedManifest(page)
    expect(current.version, 'the preview serves release N').not.toBe(previous.version)
  })
  const own = new Set(current!.files.map((file) => `/${file.path}`))

  await test.step('a lazy chunk N does not name still loads (File › Export › Planting plan)', async () => {
    // The host's skew-check named N-1's PDF job chunks N lacks; none only with --allow-unchanged-pdf-chunk, which
    // waives this proof alone.
    const expected = (await readFile(join(handoff, 'carried-chunks'), 'utf8')).split('\n').filter(Boolean)
    for (const path of expected) expect(own.has(`/${path}`), `${path} is not N's`).toBe(false)
    if (expected.length === 0) {
      test.info().annotations.push({ type: 'waived', description: 'no carried PDF chunk (--allow-unchanged-pdf-chunk)' })
    }
    // The skew proof is the chunk's own response, registered before the click, so a slow render cannot hide it.
    const chunk = expected.length === 0 ? null : page.waitForResponse(
      (response) => expected.includes(new URL(response.url()).pathname.slice(1)), { timeout: 30_000 })
    await page.getByRole('menuitem', { name: 'File' }).or(page.getByRole('button', { name: 'File', exact: true })).first().click()
    await page.getByRole('menuitem', { name: 'Export' }).first().hover()
    await page.getByRole('menuitem', { name: 'Planting plan (PDF)…' }).click()
    if (chunk) {
      const response = await chunk
      expect(response.status(), `${new URL(response.url()).pathname}, which only N-1 names, loads after N deployed`).toBe(200)
    }
    // Then the render, for longer than N-1's own budget (its worker reports prepare-timeout after 120 s): the dialog
    // shows a page count or its own error; no retry.
    const dialog = page.getByRole('dialog', { name: 'Export to PDF' })
    const pageCount = dialog.getByText(/Page \d+ of \d+/)
    const appError = dialog.getByRole('alert')
    await expect.poll(async () => await pageCount.count() + await appError.count(), {
      timeout: 180_000, message: 'the N-1 PDF dialog left "Preparing pages…"',
    }).toBeGreaterThan(0)
    expect(await appError.allInnerTexts(), "the N-1 app's own PDF error").toEqual([])
    await expect(dialog.getByText(/Page 1 of 1/).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the plant catalog answers from the files the tab was built with', async () => {
    await page.getByRole('button', { name: 'Plant catalog', exact: true }).click()
    await page.getByLabel('Search the plant catalog').fill('apple')
    await expect(page.getByText('Malus domestica').first()).toBeVisible({ timeout: 180_000 })
    const catalog = afterDeploy.filter((response) => /\.parquet$|\/manifest\.json$/.test(new URL(response.url()).pathname))
    expect(catalog.length, 'catalog files read after N deployed').toBeGreaterThan(0)
    await page.keyboard.press('Escape')
  })

  await test.step('the tab keeps saving: the Draft changes and Download a copy works', async () => {
    const before = await draftStorage(page)
    await drawRectangle(page, 160)
    await expect.poll(() => draftStorage(page), { timeout: 30_000 }).not.toBe(before)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download a copy' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.canopi$/)
    expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toBeTruthy()
  })

  await test.step('the New version notice shows and Reload loads N', async () => {
    // The watch reads the manifest on window focus, as when the user comes back to the tab.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const notice = page.locator('[data-web-shell-notice][data-release]')
    await expect(notice).toContainText('New version')
    const entry = page.waitForResponse((response) => /\/assets\/web-[^/]+\.js$/.test(new URL(response.url()).pathname))
    await notice.getByRole('button', { name: 'Reload' }).click()
    const loaded = new URL((await entry).url()).pathname
    expect(own.has(loaded), `the reloaded page runs N's entry, not ${loaded}`).toBe(true)
  })
  expect(problems).toEqual([])
})
