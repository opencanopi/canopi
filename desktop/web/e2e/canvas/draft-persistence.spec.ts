// The Web Edition asks the browser to keep its Drafts (2.1-Q82; Q190 to Q194; Step 2.0.3 persist). The welcome screen
// shows a one-line reason before the first New or Open of a launch, which asks once in its click (Q191, M180); when the
// browser refuses, the welcome screen warns in amber and each Draft row offers Download a copy (Q193), and the save
// status warns, muted with an alert icon, keeping its Download a copy link above 1100 px (Q192, Q194).
// Chromium, WebKit and Firefox (2.1-Q196), each forced granted and refused as support/storage-persistence.ts measured.
// Then the neighbour matrix (agentic-delivery "Design check"): the welcome warning and the save-status warning at seven
// sizes, in English and the longest locale, overlap none of their neighbours, and every neighbouring control takes a
// click at its centre. DOM assertions only, no baselines.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expectDownloadName } from '../support/download'
import { boxOf, expectHitAtCentre, overlap, type Box } from '../support/layout'
import { expect, test } from '../support/offline'
import { pageWithPersistence, type PersistenceAnswer } from '../support/storage-persistence'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'

const DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'

function startScreen(page: Page): Locator {
  return page.locator('[data-start-screen]')
}

async function persistCalls(page: Page): Promise<{ calls: number, reasonShown: boolean[] }> {
  return await page.evaluate(() => {
    const spy = window as unknown as { __persistCalls: number, __persistReasonShown: boolean[] }
    return { calls: spy.__persistCalls, reasonShown: spy.__persistReasonShown }
  })
}

type Strings = { titleBar: Record<string, string>, menu: Record<string, string>, webStorage: Record<string, string>, webShell: Record<string, string> }
function strings(locale: string): Strings {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/i18n/${locale}.json`, import.meta.url)), 'utf8')) as Strings
}

/** File › Close Design, through the compact Menu where the bar folds its menus, in `locale`. */
async function closeDesign(page: Page, locale = 'en'): Promise<void> {
  const { titleBar, menu } = strings(locale)
  const compact = page.getByRole('menubar', { name: titleBar.menus }).getByRole('menuitem', { name: titleBar.menu, exact: true })
  if (await compact.isVisible()) await compact.click()
  await page.getByRole('menuitem', { name: menu.file, exact: true }).click()
  await page.getByRole('menuitem', { name: menu['file.close'] }).click()
  await expect(startScreen(page)).toBeVisible()
}

/**
 * Opens the save-status warning's popover: the warning itself where it is a control, File › Keep my drafts… on a
 * phone, where the warning is text and the status leaves its action to File (P3-6).
 */
async function openDraftWarning(page: Page, locale = 'en'): Promise<void> {
  if (await page.locator('[data-phone-layout]').count() === 0) {
    await page.locator('[data-save-status] [data-draft-warning]').click()
    return
  }
  const { titleBar, menu, webStorage } = strings(locale)
  await page.getByRole('menubar', { name: titleBar.menus }).getByRole('menuitem', { name: titleBar.menu, exact: true }).click()
  await page.getByRole('menuitem', { name: menu.file, exact: true }).click()
  const row = page.getByRole('menuitem', { name: webStorage.keepDraftsMenu })
  const rowBox = await boxOf(row)
  expect(rowBox.height, 'Keep my drafts… is a 44 px phone menu row').toBeGreaterThanOrEqual(44 - 0.5)
  await row.click()
}

async function openFixtureFromStart(page: Page): Promise<void> {
  const open = startScreen(page).getByRole('button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(FIXTURE)
  // The Design's title bar, not the map: Firefox in the pinned image has no WebGL, so its map never draws.
  await expect(page.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
  await expect(startScreen(page)).toHaveCount(0)
}

// One describe per answer, so each test's own title is the plan's exact title.
for (const answer of ['granted', 'refused'] as const satisfies readonly PersistenceAnswer[]) test.describe(`persistence ${answer}`, () => {
  test('Q82: the first Draft requests persistence once, after its reason line', async ({ page, browserName }, testInfo) => {
    const forced = await pageWithPersistence({ page, browserName, testInfo }, answer)
    try {
      const app = forced.page
      await app.goto('')
      const reason = startScreen(app).locator('[data-start-notice="info"]')
      await expect(reason).toBeVisible()
      await expect(startScreen(app).locator('[data-start-notice="warning"]')).toHaveCount(0)
      expect((await persistCalls(app)).calls, 'nothing is asked before a Draft starts').toBe(0)

      await forced.armAnswer()
      await startScreen(app).getByRole('button', { name: 'New Design' }).first().click()
      await expect.poll(async () => (await persistCalls(app)).calls).toBe(1)
      expect((await persistCalls(app)).reasonShown, 'the reason line was on screen when the request was made').toEqual([true])

      // A second Draft in the same launch asks nothing.
      await closeDesign(app)
      await openFixtureFromStart(app)
      await closeDesign(app)
      expect((await persistCalls(app)).calls, 'asked once per launch').toBe(1)
      if (answer === 'granted') {
        await expect(startScreen(app).locator('[data-start-notice]'), 'nothing left to say once kept').toHaveCount(0)
      } else {
        await expect(startScreen(app).locator('[data-start-notice="warning"]')).toBeVisible()
      }
      expect(forced.errors).toEqual([])
    } finally {
      await forced.close()
    }
  })
})

test('Q82: a refused request warns on the welcome screen and in the save status and offers Download a copy', async ({ page, browserName }, testInfo) => {
  const forced = await pageWithPersistence({ page, browserName, testInfo }, 'refused')
  try {
    const app = forced.page
    await app.goto('')
    await openFixtureFromStart(app)

    // The save status: muted, an alert icon, and Download a copy beside it (above 1100 px); the warning opens what may
    // happen and Download a copy, with no second ask (2.1-Q198).
    const status = app.locator('[data-save-status="draft"]')
    const warning = status.locator('[data-draft-warning]')
    await expect(warning).toHaveText('May be cleared by this browser')
    await expect(warning.locator('svg')).toHaveCount(1)
    await expect(status.locator('[role="alert"]')).toHaveCount(0)
    await warning.click()
    const popover = status.locator('[data-draft-warning-popover]')
    await expect(popover).toContainText('may clear your Drafts')
    await expect(popover.getByRole('button')).toHaveText(['Download a copy'])
    await app.keyboard.press('Escape')
    await expect(warning).toBeFocused()
    // Focus returns before the closed popover unmounts on the next render (canopi-f47t.52.228.19).
    await expect(popover).toHaveCount(0)
    const [fromStatus] = await Promise.all([app.waitForEvent('download'), status.getByRole('button', { name: 'Download a copy' }).click()])
    expect(fromStatus.suggestedFilename()).toMatch(/\.canopi$/)

    // The welcome screen: the amber warning, which names the Draft row's Download a copy.
    await closeDesign(app)
    const welcomeWarning = startScreen(app).locator('[data-start-notice="warning"]')
    await expect(welcomeWarning).toContainText('Download a copy')
    await expect(startScreen(app).locator('[data-start-notice="info"]')).toHaveCount(0)
    const row = startScreen(app).locator('[data-design-drafts] li').first()
    await row.locator('[aria-haspopup="menu"]').click()
    const [fromRow] = await Promise.all([
      app.waitForEvent('download'),
      app.locator('[data-action-menu]').getByRole('menuitem', { name: 'Download a copy' }).click(),
    ])
    expect(fromRow.suggestedFilename()).toMatch(/\.canopi$/)
    await expect(startScreen(app), 'downloading a Draft leaves it closed').toBeVisible()
    expect(forced.errors).toEqual([])
  } finally {
    await forced.close()
  }
})

// 2.1-Q198: an existing user with unkept Drafts is asked from the save-status warning, never by New or Open.
for (const answer of ['granted', 'refused'] as const satisfies readonly PersistenceAnswer[]) test.describe(`persistence ${answer}`, () => {
  test('Q198: an existing user opens the warning, reads the reason and Keep my drafts asks once', async ({ page, browserName }, testInfo) => {
    const forced = await pageWithPersistence({ page, browserName, testInfo }, answer)
    try {
      const app = forced.page
      await launchWithUnkeptDrafts(app, 'en')
      // P3-4: New from the welcome screen while its reason and Keep my drafts are on screen, so only the
      // Drafts-at-launch guard keeps it from asking.
      await closeDesign(app)
      const welcome = app.locator('[data-start-notice="warning"]')
      await expect(welcome.locator('[data-notice="draft-persistence-reason"]')).toBeVisible()
      await expect(welcome.getByRole('button', { name: 'Keep my drafts' })).toBeVisible()
      await app.locator('[data-start-screen]').getByRole('button', { name: 'New Design' }).click()
      await app.locator('[data-site-locate]').getByRole('button', { name: 'Skip, I’ll find it on the map' }).click()
      await expect(app.locator('[data-workspace-title-bar] [data-save-status]')).toBeVisible()
      expect((await persistCalls(app)).calls, 'New does not ask an existing user').toBe(0)

      const warning = app.locator('[data-save-status] [data-draft-warning]')
      await warning.click()
      const popover = app.locator('[data-draft-warning-popover]')
      await expect(popover.locator('[data-notice="draft-persistence-reason"]')).toContainText('Canopi asks this browser to keep your Drafts')
      await expect(popover.getByRole('button').first(), 'focus moves into the popover').toBeFocused()
      await forced.armAnswer()
      await popover.getByRole('button', { name: 'Keep my drafts' }).click()
      await expect.poll(async () => (await persistCalls(app)).calls).toBe(1)
      expect((await persistCalls(app)).reasonShown, 'the reason was on screen when the request was made').toEqual([true])
      await expect(popover).toHaveCount(0)
      if (answer === 'granted') {
        await expect(warning, 'kept: the warning leaves').toHaveCount(0)
      } else {
        await expect(warning, 'refused: the warning stays (Q194)').toBeVisible()
        await warning.click()
        await expect(popover.getByRole('button')).toHaveText(['Download a copy'])
      }
      expect((await persistCalls(app)).calls, 'one ask per launch').toBe(1)
      expect(forced.errors).toEqual([])
    } finally {
      await forced.close()
    }
  })
})

// P3-6 (2.1-Q198): on a phone the warning is text; File › Keep my drafts… opens the reason before the ask.
for (const answer of ['granted', 'refused'] as const satisfies readonly PersistenceAnswer[]) test.describe(`phone, persistence ${answer}`, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('Q198: on a phone File › Keep my drafts… shows the reason and Keep my drafts asks once', async ({ page, browserName }, testInfo) => {
    const forced = await pageWithPersistence({ page, browserName, testInfo }, answer)
    try {
      const app = forced.page
      // Firefox's forced context takes the project's viewport, not this describe's.
      await app.setViewportSize({ width: 390, height: 844 })
      await launchWithUnkeptDrafts(app, 'en')
      const warning = app.locator('[data-save-status] [data-draft-warning]')
      await expect(warning).toHaveText('May be cleared by this browser')
      await expect(app.locator('[data-save-status]').getByRole('button', { name: 'May be cleared by this browser' })).toHaveCount(0)
      await openDraftWarning(app, 'en')
      const popover = app.locator('[data-draft-warning-popover]')
      await expect(popover.locator('[data-notice="draft-persistence-reason"]')).toContainText('Canopi asks this browser to keep your Drafts')
      await expect(popover.getByRole('button')).toHaveText(['Download a copy', 'Keep my drafts'])
      await expect(popover.getByRole('button').first(), 'focus moves into the popover').toBeFocused()
      expect((await persistCalls(app)).calls, 'opening it does not ask').toBe(0)
      await forced.armAnswer()
      await popover.getByRole('button', { name: 'Keep my drafts' }).click()
      await expect.poll(async () => (await persistCalls(app)).calls).toBe(1)
      expect((await persistCalls(app)).reasonShown, 'the reason was on screen when the request was made').toEqual([true])
      await expect(popover).toHaveCount(0)
      if (answer === 'granted') {
        await expect(warning, 'kept: the warning leaves').toHaveCount(0)
      } else {
        await expect(warning, 'refused: the warning stays (Q194)').toBeVisible()
      }
      const { titleBar, menu } = strings('en')
      await app.getByRole('menubar', { name: titleBar.menus }).getByRole('menuitem', { name: titleBar.menu, exact: true }).click()
      await app.getByRole('menuitem', { name: menu.file, exact: true }).click()
      await expect(app.getByRole('menuitem', { name: 'Keep my drafts…' }), 'answered: File no longer offers it').toHaveCount(0)
      expect((await persistCalls(app)).calls, 'one ask per launch').toBe(1)
      expect(forced.errors).toEqual([])
    } finally {
      await forced.close()
    }
  })
})

// P3-5 (2.1-Q198, R2-2): an existing user on the welcome screen is asked by its Keep my drafts, beside the reason.
for (const answer of ['granted', 'refused'] as const satisfies readonly PersistenceAnswer[]) test.describe(`welcome, persistence ${answer}`, () => {
  test('Q198: the welcome warning shows the reason and Keep my drafts asks once', async ({ page, browserName }, testInfo) => {
    const forced = await pageWithPersistence({ page, browserName, testInfo }, answer)
    try {
      const app = forced.page
      await launchWithUnkeptDrafts(app, 'en')
      await closeDesign(app)
      const welcome = app.locator('[data-start-notice="warning"]')
      await expect(welcome.locator('[data-notice="draft-persistence-reason"]')).toContainText('Canopi asks this browser to keep your Drafts')
      await forced.armAnswer()
      await welcome.getByRole('button', { name: 'Keep my drafts' }).click()
      await expect.poll(async () => (await persistCalls(app)).calls).toBe(1)
      expect((await persistCalls(app)).reasonShown, 'the reason was on screen when the request was made').toEqual([true])
      if (answer === 'granted') {
        await expect(app.locator('[data-start-notice]'), 'kept: the warning leaves').toHaveCount(0)
        await expect(app.locator('[data-start-screen]').getByRole('button', { name: 'New Design' }), 'focus lands on New Design').toBeFocused()
      } else {
        await expect(welcome, 'refused: the warning stays (Q194)').toBeVisible()
        await expect(welcome.getByRole('button'), 'no second ask').toHaveCount(0)
        await expect(welcome.locator('[data-notice="draft-persistence-reason"]')).toHaveCount(0)
      }
      expect((await persistCalls(app)).calls, 'one ask per launch').toBe(1)
      expect(forced.errors).toEqual([])
    } finally {
      await forced.close()
    }
  })
})

test('Q193: Download a copy in the second Draft row downloads that Draft, not the first', async ({ page }) => {
  await launchWithUnkeptDrafts(page, 'en')
  await closeDesign(page)
  const rows = startScreen(page).locator('[data-design-drafts] li')
  await expect(rows).toHaveCount(2)
  const second = (await rows.nth(1).locator('[aria-haspopup="menu"]').getAttribute('aria-label'))!.replace('Actions for ', '')
  expect(['Draft 1', 'Draft 2']).toContain(second)
  expect(await rows.nth(0).locator('[aria-haspopup="menu"]').getAttribute('aria-label')).not.toBe(`Actions for ${second}`)
  await rows.nth(1).locator('[aria-haspopup="menu"]').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action-menu]').getByRole('menuitem', { name: 'Download a copy' }).click(),
  ])
  expectDownloadName(download, `${second}.canopi`)
  const text = readFileSync(await download.path(), 'utf8')
  expect((JSON.parse(text) as { name: string }).name).toBe(second)
  await expect(startScreen(page), 'downloading a Draft leaves it closed').toBeVisible()
})

// canopi-eon8.15 (S1): a release Reload from the start screen reopens no Draft (2.1-Q189), yet the Drafts are still
// stored, so the reloaded launch is not a first visit: the amber warning and Keep my drafts are back (Q190, Q198).
test('canopi-eon8.15: Reload from the start screen with an unkept Draft keeps the warning and Keep my drafts', async ({ page }) => {
  const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../tauri.conf.json', import.meta.url)), 'utf8')) as { version: string }).version
  await page.route('**/app/canopi-web-edition-manifest.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-cache' },
    body: JSON.stringify({ name: 'Canopi Web Edition', version: `${version}-next`, commit: 'e2e', files: [] }),
  }))
  await launchWithUnkeptDrafts(page, 'en')
  await closeDesign(page)
  const welcome = startScreen(page).locator('[data-start-notice="warning"]')
  await expect(welcome.getByRole('button', { name: 'Keep my drafts' })).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const notice = page.locator('[data-web-shell-notice][data-release]')
  await expect(notice).toBeVisible()
  await expect(notice, 'no Design is open, so none is saved first').toContainText('Canopi was updated. Reload to use it.')
  await expect(notice).not.toContainText('saved first')
  await Promise.all([page.waitForEvent('framenavigated'), notice.getByRole('button', { name: 'Reload' }).click()])

  await expect(startScreen(page), 'the tab comes back to the start screen').toBeVisible()
  await expect(welcome, 'the Drafts are still not kept: the amber warning').toBeVisible()
  await expect(welcome.getByRole('button', { name: 'Keep my drafts' })).toBeVisible()
  await expect(startScreen(page).locator('[data-start-notice="info"]'), 'not the first-visit reason').toHaveCount(0)
})

// The neighbour matrix. A launch with Drafts the browser does not keep warns at once (Q190): every engine reads
// not kept in a fresh context, so no forcing is needed, and no request is made until New or Open.
const SIZES = [
  { width: 360, height: 560 },
  { width: 740, height: 360 },
  { width: 844, height: 390 },
  { width: 700, height: 500 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 1400, height: 900 },
] as const
/** English, and French, whose webStorage strings are the longest (the status warning 34 characters, the welcome warning 153). */
const LOCALES = ['en', 'fr'] as const

async function launchWithUnkeptDrafts(page: Page, locale: string): Promise<void> {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const drafts = [0, 1].map((index) => ({ id: `draft-${index}`, name: `Draft ${index + 1}`, updatedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString() }))
  const records = {
    [SETTINGS_KEY]: JSON.stringify({ version: 3, settings: { locale, basemap_visible: false } }),
    [DRAFTS_KEY]: JSON.stringify({ version: 3, drafts, draftFiles: Object.fromEntries(drafts.map(({ id, name }) => [id, { ...file, name }])) }),
  }
  await page.goto('')
  await page.evaluate((values) => {
    localStorage.clear()
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  }, records)
  await page.reload()
  await expect(page.locator('[data-save-status] [data-draft-warning]')).toBeVisible()
}

/** Visible leaf boxes inside `root` that are neither `subject` nor inside it nor around it. */
async function neighbourBoxes(root: Locator, subject: Locator): Promise<{ name: string, box: Box }[]> {
  const handle = await subject.elementHandle()
  return await root.evaluate((element, target) => {
    const found: { name: string, box: { x: number, y: number, width: number, height: number } }[] = []
    const leaves = element.querySelectorAll<HTMLElement>('button, input, h1, h2, p, img, [role="status"], [role="combobox"], a, label')
    for (const leaf of leaves) {
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
    const name = `${size.width}×${size.height}, ${locale}`
    test.describe(name, () => {
      test.use({ viewport: size, hasTouch: size.width < 900 })

      test(`Q82 neighbours: the save-status warning overlaps nothing in the title bar, and every bar control takes a click (${name})`, async ({ page }) => {
        await launchWithUnkeptDrafts(page, locale)
        const bar = page.locator('[data-workspace-title-bar]')
        const warning = bar.locator('[data-draft-warning]')
        const warningBox = await boxOf(warning)
        const barBox = await boxOf(bar)
        expect(warningBox.x, 'the warning starts on screen').toBeGreaterThanOrEqual(0)
        expect(warningBox.x + warningBox.width, 'the warning ends on screen').toBeLessThanOrEqual(size.width)
        expect(warningBox.y + warningBox.height, 'the warning stays in the bar').toBeLessThanOrEqual(barBox.y + barBox.height)
        for (const neighbour of await neighbourBoxes(bar, warning)) {
          expect(overlap(warningBox, neighbour.box), `the warning overlaps ${neighbour.name} (${name})`).toBe(false)
        }
        for (const button of await bar.getByRole('button').filter({ visible: true }).all()) {
          await expectHitAtCentre(button, `${(await button.getAttribute('aria-label')) || (await button.textContent())?.trim()} (${name})`)
        }
        // The phone top bar keeps its one row (52 px, 44 px buttons: controls-and-shell "Web on phones").
        if (await page.locator('[data-phone-layout]').count()) expect(barBox.height, 'the phone bar keeps one row').toBeLessThanOrEqual(52.5)
      })

      test(`Q198 neighbours: the warning's popover opens on screen over the map, and its buttons take a click (${name})`, async ({ page }) => {
        await launchWithUnkeptDrafts(page, locale)
        const warning = page.locator('[data-save-status] [data-draft-warning]')
        const phone = await page.locator('[data-phone-layout]').count() > 0
        // P3-6: on a phone the warning is text, leaving no undersized target under the Design name; File opens it.
        if (phone) {
          expect(await warning.evaluate((element) => element.closest('button') === null && element.querySelector('button') === null), `the warning is text on a phone (${name})`).toBe(true)
        } else {
          // The bar settles its layout after load (WebKit): retry the hit until it does.
          await expect(async () => { await expectHitAtCentre(warning, `the warning (${name})`) }).toPass({ timeout: 5000 })
        }
        // P3-6: the warning's target reaches no further up than itself, so the Design name above it keeps its edge.
        const edges = await warning.evaluate((trigger) => {
          const name = document.querySelector('[data-workspace-title-bar] button[aria-keyshortcuts="F2"]')
          const height = trigger.getBoundingClientRect().height
          if (!name) return { height, nameEdge: true }
          const box = name.getBoundingClientRect()
          const nameEdge = [0.25, 0.5, 0.75].map((share) => box.left + box.width * share).every((x) => {
            const top = document.elementFromPoint(x, box.bottom - 2)
            return top !== null && name.contains(top)
          })
          return { height, nameEdge }
        })
        expect(edges.nameEdge, `the Design name's bottom edge renames, not opens the warning (${name})`).toBe(true)
        if (!phone) expect(edges.height, `the warning's target is taller than its text (${name})`).toBeGreaterThanOrEqual(21)
        await openDraftWarning(page, locale)
        const popover = page.locator('[data-draft-warning-popover]')
        await expect(popover).toBeVisible()
        const box = await boxOf(popover)
        expect(box.x, 'the popover starts on screen').toBeGreaterThanOrEqual(0)
        expect(box.x + box.width, 'the popover ends on screen').toBeLessThanOrEqual(size.width)
        expect(box.y + box.height, 'the popover ends above the bottom').toBeLessThanOrEqual(size.height)
        // It opens under its warning, over the bar's edge as Details… does, and covers none of the bar's controls.
        expect(overlap(await boxOf(warning), box), 'the popover leaves its warning visible').toBe(false)
        for (const control of await page.locator('[data-workspace-title-bar]').getByRole('button').filter({ visible: true }).all()) {
          if (await popover.evaluate((element, other) => element.contains(other), await control.elementHandle())) continue
          expect(overlap(await boxOf(control), box), `the popover covers ${await control.getAttribute('aria-label') ?? await control.textContent()} (${name})`).toBe(false)
        }
        for (const button of await popover.getByRole('button').all()) {
          await expectHitAtCentre(button, `${(await button.textContent())?.trim()} (${name})`)
        }
      })

      test(`Q82 neighbours: the welcome warning overlaps nothing on the start screen, and New Design and Open take a click (${name})`, async ({ page }) => {
        await launchWithUnkeptDrafts(page, locale)
        await closeDesign(page, locale)
        const start = startScreen(page)
        const warning = start.locator('[data-start-notice="warning"]')
        await warning.scrollIntoViewIfNeeded()
        const warningBox = await boxOf(warning)
        expect(warningBox.x).toBeGreaterThanOrEqual(0)
        expect(warningBox.x + warningBox.width).toBeLessThanOrEqual(size.width)
        for (const neighbour of await neighbourBoxes(start, warning)) {
          expect(overlap(warningBox, neighbour.box), `the warning overlaps ${neighbour.name} (${name})`).toBe(false)
        }
        const intro = start.locator('button').filter({ visible: true })
        for (const button of await intro.all()) {
          await button.evaluate((element) => element.scrollIntoView({ block: 'center' }))
          await expectHitAtCentre(button, `${(await button.getAttribute('aria-label')) || (await button.textContent())?.trim()} (${name})`)
        }
      })
    })
  }
}

/**
 * The inline Download a copy's line (2.1-Q192, moved from 760 to 1100 px): measured at 761 to 1024 px, the full menu bar
 * leaves the Design group too little room for the link and the warning both, and the warning would shrink to nothing.
 */
const LINK_LINE_SIZES = [
  { width: 761, height: 900, link: false },
  { width: 820, height: 1180, link: false },
  { width: 1024, height: 768, link: false },
  { width: 1101, height: 800, link: true },
] as const

for (const locale of LOCALES) {
  for (const size of LINK_LINE_SIZES) {
    const name = `${size.width}×${size.height}, ${locale}`
    test.describe(name, () => {
      test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.width < 900 })

      test(`Q192: the save status keeps its warning readable, with Download a copy beside it only above 1100 px, else in its popover (${name})`, async ({ page }) => {
        await launchWithUnkeptDrafts(page, locale)
        const bar = page.locator('[data-workspace-title-bar]')
        const status = bar.locator('[data-save-status="draft"]')
        const warning = status.locator('[data-draft-warning]')
        const download = strings(locale).webShell.downloadCopy
        const link = status.getByRole('button', { name: download, exact: true })
        await expect(link).toHaveCount(size.link ? 1 : 0)
        // The warning keeps more than its icon: some of its text shows.
        expect(await warning.evaluate((element) => element.querySelector(':scope > span:last-child')?.getBoundingClientRect().width ?? 0), `the warning's text shows (${name})`).toBeGreaterThan(24)
        const statusBox = await boxOf(status)
        expect(statusBox.x + statusBox.width, 'the status ends on screen').toBeLessThanOrEqual(size.width)
        for (const neighbour of await neighbourBoxes(bar, status)) {
          expect(overlap(statusBox, neighbour.box), `the status overlaps ${neighbour.name} (${name})`).toBe(false)
        }
        if (size.link) await expectHitAtCentre(link, `${download} (${name})`)
        await warning.click()
        await expect(status.locator('[data-draft-warning-popover]').getByRole('button', { name: download, exact: true })).toBeVisible()
      })
    })
  }
}
