// The Web Edition asks the browser to keep its Drafts (2.1-Q82; Q190 to Q194; Step 2.0.3 persist). The welcome screen
// shows a one-line reason before the first New or Open of a launch, which asks once in its click (Q191, M180); when the
// browser refuses, the welcome screen warns in amber and each Draft row offers Download a copy (Q193), and the save
// status warns, muted with an alert icon, keeping its Download a copy link above 760 px (Q192, Q194).
// Chromium, WebKit and Firefox (2.1-Q196), each forced granted and refused as support/storage-persistence.ts measured.
// Then the neighbour matrix (agentic-delivery "Design check"): the welcome warning and the save-status warning at seven
// sizes, in English and the longest locale, overlap none of their neighbours, and every neighbouring control takes a
// click at its centre. DOM assertions only, no baselines.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { boxOf, expectHitAtCentre, overlap, type Box } from '../support/layout'
import { expect, test } from '../support/offline'
import { pageWithPersistence, type PersistenceAnswer } from '../support/storage-persistence'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const SETTINGS_KEY = 'canopi:web-app-data:v3:settings'

// Firefox in the pinned image has no WebGL, so its map reports that it failed; nothing here needs the map.
test.use({ expectedConsoleErrors: async ({ browserName }, use) => { await use(browserName === 'firefox' ? ['Shared workspace map failed:'] : []) } })
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

type Strings = { titleBar: Record<string, string>, menu: Record<string, string> }
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

    // The save status: muted, an alert icon, the reason on hover, and Download a copy beside it (above 760 px).
    const status = app.locator('[data-save-status="draft"]')
    const warning = status.locator('[data-draft-warning]')
    await expect(warning).toHaveText('May be cleared by this browser')
    await expect(warning).toHaveAttribute('title', /may clear your Drafts/)
    await expect(warning.locator('svg')).toHaveCount(1)
    await expect(status.locator('[role="alert"]')).toHaveCount(0)
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
  expect(download.suggestedFilename()).toBe(`${second}.canopi`)
  const text = readFileSync(await download.path(), 'utf8')
  expect((JSON.parse(text) as { name: string }).name).toBe(second)
  await expect(startScreen(page), 'downloading a Draft leaves it closed').toBeVisible()
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
