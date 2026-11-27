// The reader release's Web stores (Step 2.0.4 R3, canopi-f47t.52.272; contracts §11 "Web Drafts move to IndexedDB",
// 2.1-Q321, 2.1-Q322, 2.1-Q323, 2.1-M486). After a rollback from 2.1, the Web Edition lists the Drafts 2.1 keeps in
// the IndexedDB database `canopi-drafts` (version 4; stores `drafts`, key `id`, and `meta`, key `key`, holding the move
// record) read-only beside the editable ones, hides every old-key Draft the 2.1 move copied, restores nothing at launch
// while 2.1 Drafts exist, creates no database on an origin without one, and never blocks 2.1's upgrade.
//
// Written failing in commit 0 and marked expected-fail (`test.fail`); R3-3 and R3-4 built these paths and removed the
// markers. The later cases are R3-3's failure states: a 2.1 Draft opened, downloaded, deleted by 2.1 after the list, opened without its worker,
// a version change while a read is open, and a hidden id at restore.
//
// R3-4 (2.1-Q320, 2.1-M483, 2.1-M486): settings record 2 and the species-list record 1, each under its own 2.1 key and
// seeded from its frozen form (spec/web/frozen/), are read for the fields this release knows and never written, moved
// aside or copied to the 2.0 keys; each store reads as saved by a newer Canopi and says so once, at launch; a setting
// changed applies for the session only; a 2.1 key that is not JSON, or of a later version, is never moved aside; and
// under either, a favourite star is off, says why, and a click or Enter on it writes nothing.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/offline'
import { DRAFT_DATABASE, DRAFT_DATABASE_VERSION, createDraftStore, draftStoreDump, type DraftRecord } from '../support/web-storage'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const V3_DRAFTS_KEY = 'canopi:web-app-data:v3:drafts'

function baseDesign(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
}

/** A Design as 2.1 writes it: `.canopi` v10, with the plant `scale` renamed `canopy_spread_m` (2.1-Q314). */
function v10Content(name: string): string {
  const design = baseDesign()
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return JSON.stringify({ ...design, version: 10, name, plants })
}

function draftRecord(id: string, name: string, day: number): DraftRecord {
  const updated_at = new Date(Date.UTC(2026, 11, day)).toISOString()
  return { id, canopi_version: '2.1.0', version: 3, name, updated_at, content: v10Content(name) }
}

/** Writes the 2.1 Draft store as 2.1 leaves it: its Draft records and the move record naming the copied ids. */
async function seedDraftStore(page: Page, records: readonly DraftRecord[], copiedIds: readonly string[]): Promise<void> {
  await page.evaluate(createDraftStore, { name: DRAFT_DATABASE, version: DRAFT_DATABASE_VERSION, records, copiedIds })
}

/** Every record of the Draft store and every localStorage entry: what "writes nothing" compares. */
async function storageDump(page: Page): Promise<unknown> {
  const local = await page.evaluate(() => Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]))
  return { local, stores: await page.evaluate(draftStoreDump, DRAFT_DATABASE) }
}

function startScreen(page: Page) {
  return page.locator('[data-start-screen]')
}

function draftRow(page: Page, name: string) {
  return startScreen(page).locator('li').filter({ hasText: name })
}

/** Seeds one 2.1 Draft (no old-key Draft) and reloads directly onto the start screen listing it without auto-opening. */
async function startWithOneNewerDraft(page: Page): Promise<DraftRecord> {
  const record = draftRecord('orchard', 'Orchard in 2.1', 3)
  await page.goto('')
  await seedDraftStore(page, [record], [])
  await page.evaluate(() => {
    sessionStorage.setItem('canopi:web-session:reload-home', JSON.stringify({ draft: null }))
  })
  await page.reload()
  await expect(startScreen(page)).toBeVisible()
  await expect(draftRow(page, 'Orchard in 2.1')).toHaveCount(1)
  return record
}

test('R3 canopi-f47t.52.272: 2.1-Q40: an open 2.1 tab closes its Draft store on versionchange, shows Reload, and does not block a newer upgrade', async ({ page, context }) => {
  await page.goto('')
  await seedDraftStore(page, [draftRecord('orchard', 'Orchard in 2.1', 3)], [])
  await page.reload()
  await expect(page.locator('[data-workspace-title-bar]')).toContainText('Orchard in 2.1')

  // A newer tab upgrades `canopi-drafts` to v5 while this 2.1 tab holds it open.
  const later = await context.newPage()
  await later.goto('')
  const outcome = await later.evaluate(async (name) => await new Promise<string>((resolve) => {
    const request = indexedDB.open(name, 5)
    request.onblocked = () => resolve('blocked')
    request.onerror = () => resolve(`error ${request.error?.name}`)
    request.onsuccess = () => { request.result.close(); resolve('upgraded') }
  }), DRAFT_DATABASE)
  expect(outcome, 'a newer upgrade is not blocked by an open 2.1 tab').toBe('upgraded')
  await expect(page.getByText('New version'), 'a versionchange shows the Reload notice (2.1-Q40)').toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
})

test('R3 canopi-f47t.52.272: 2.1-Q347: a 2.1 Draft opens natively on 2.1, downloads as 2.1 saved it, and writes nothing to the 2.1 store', async ({ page }) => {
  await startWithOneNewerDraft(page)
  const before = await storageDump(page) as { local: [string, string | null][]; stores: unknown }

  await draftRow(page, 'Orchard in 2.1').getByRole('button', { name: 'Actions for Orchard in 2.1' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download a copy' }).click()])
  // WebKit hands the name with its spaces as underscores.
  expect(download.suggestedFilename()).toMatch(/^Orchard[ _]in[ _]2\.1\.canopi$/)
  expect(JSON.parse(readFileSync(await download.path(), 'utf8')).name, 'the Draft downloads cleanly (2.1-Q323)').toBe('Orchard in 2.1')

  await draftRow(page, 'Orchard in 2.1').getByRole('button').first().click()
  const status = page.locator('[data-workspace-title-bar] [data-save-status]')
  await expect(status, 'the 2.1 v10 Draft opens natively (2.1-Q347)').toHaveAttribute('data-save-status', 'draft')
  await expect(page.locator('[data-workspace-title-bar]')).toContainText('Orchard in 2.1')
  await page.waitForTimeout(1_000)
  const after = await storageDump(page) as { local: [string, string | null][]; stores: unknown }
  expect(after.stores, 'opening and downloading write no record to the 2.1 IndexedDB store').toEqual(before.stores)
  expect(after.local.filter(([k]) => k === V3_DRAFTS_KEY), 'opening writes no forked Draft to localStorage').toEqual(before.local.filter(([k]) => k === V3_DRAFTS_KEY))
  const unexpectedLocalKeys = after.local.map(([k]) => k).filter((k) => !before.local.some(([bk]) => bk === k) && k !== 'canopi:web-app-data:v3:settings')
  expect(unexpectedLocalKeys, 'only settings last_view may be created in localStorage on native open').toEqual([])
})

test('R3 canopi-f47t.52.272: a 2.1 Draft that 2.1 deleted after the list opens nothing, says so and leaves the list', async ({ page }) => {
  await startWithOneNewerDraft(page)
  // Another tab deletes the Draft at the same version: no version change reaches this tab.
  await page.evaluate(async ([name, version]) => await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name as string, version as number)
    request.onsuccess = () => {
      const tx = request.result.transaction('drafts', 'readwrite')
      tx.objectStore('drafts').delete('orchard')
      tx.oncomplete = () => { request.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  }), [DRAFT_DATABASE, DRAFT_DATABASE_VERSION])

  await draftRow(page, 'Orchard in 2.1').getByRole('button').first().click()
  await expect(page.getByText('This Draft is no longer in this browser', { exact: false }), 'a visible failure (design check)').toBeVisible()
  await expect(draftRow(page, 'Orchard in 2.1'), 'the rows re-list without it').toHaveCount(0)
  await expect(startScreen(page), 'nothing opened').toBeVisible()
})

test('R3 canopi-f47t.52.272: a 2.1 Draft opened while the format worker cannot load is refused and says so', async ({ page }) => {
  await startWithOneNewerDraft(page)
  await page.route('**/design-core.worker-*.js', (route) => route.abort())

  await draftRow(page, 'Orchard in 2.1').getByRole('button').first().click()
  await expect(page.getByText('Canopi couldn’t load the part that opens Designs.', { exact: false }), 'format_core_unavailable').toBeVisible()
  await expect(startScreen(page), 'the start screen stays').toBeVisible()
  await expect(draftRow(page, 'Orchard in 2.1'), 'and still lists the Draft, to try again').toHaveCount(1)
})

const FROZEN = fileURLToPath(new URL('../../../../spec/web/frozen/', import.meta.url))
const V3_SETTINGS_KEY = 'canopi:web-app-data:v3:settings'
const V3_SPECIES_KEY = 'canopi:web-app-data:v3:species'
const GERMAN = JSON.parse(readFileSync(fileURLToPath(new URL('../../src/i18n/de.json', import.meta.url)), 'utf8')) as Record<string, unknown>

/** A 2.1 record's frozen form (spec/web/frozen/): its key and the record 2.1 writes there. */
function frozenRecord(name: 'settings' | 'species-lists'): { key: string, record: Record<string, unknown> } {
  return JSON.parse(readFileSync(`${FROZEN}${name}.json`, 'utf8')) as { key: string, record: Record<string, unknown> }
}

/** A German string: the frozen settings record's locale is German. */
/** A German string by its key, whose namespace may hold dotted keys (`menu` > `file.settings`); throws on none. */
function german(key: string, node: unknown = GERMAN): string {
  const at = (node ?? {}) as Record<string, unknown>, value = at[key], dot = key.indexOf('.')
  if (typeof value === 'string') return value
  if (dot < 0) throw new Error(`no German string for ${key}`)
  return german(key.slice(dot + 1), at[key.slice(0, dot)])
}

async function seedLocalStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.evaluate((seed) => { for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value) }, entries)
}

/** A store's health notice key on the notice row (failures/health-presentation.ts). */
function healthKey(store: string, status: Record<string, unknown>): string {
  return `health:${store}:status:${JSON.stringify(status)}`
}

/** Dismisses the notices shown before the one keyed `key` until it shows; fails when it never does. */
async function expectNotice(page: Page, key: string, dismiss = 'Dismiss'): Promise<void> {
  const row = page.locator('[data-notice-row]')
  await expect.poll(async () => {
    const shown = await row.first().getAttribute('data-notice-key', { timeout: 500 }).catch(() => null)
    if (shown === key) return true
    if (shown !== null) await row.first().getByRole('button', { name: dismiss }).click()
    return false
  }, { message: `the notice ${key} shows`, timeout: 15_000 }).toBe(true)
}

/**
 * Every store's bytes, as `storageDump`, less the first-paint theme cache (utils/theme.ts): a copy of the theme shown,
 * rewritten at each launch and at each theme change, which is no store (the settings records are).
 */
async function storesDump(page: Page): Promise<unknown> {
  const { local, stores } = await storageDump(page) as { local: [string, string | null][], stores: unknown }
  return { local: local.filter(([key]) => key !== 'canopi:first-paint-theme'), stores }
}

const SETTINGS_READ_ONLY = healthKey('settings', { kind: 'newer_read_only' })
const SPECIES_READ_ONLY = healthKey('web_species_lists', { kind: 'newer_read_only' })

test('R3 canopi-f47t.52.272: settings record 2 applies its known fields from its 2.1 key over the 2.0 key, and launch and reload write nothing (Web)', async ({ page }) => {
  const settings = frozenRecord('settings')
  await page.goto('')
  await seedLocalStorage(page, {
    [V3_SETTINGS_KEY]: JSON.stringify({ version: 3, settings: { locale: 'en', theme: 'light' } }),
    [settings.key]: JSON.stringify({ ...settings.record, basemap_style: 'liberty' }),
  })
  const before = await storesDump(page)

  for (const load of ['launch', 'reload']) {
    await page.reload()
    await expect(startScreen(page)).toBeVisible()
    await expect(page.locator('html'), `the 2.1 locale applies at ${load}`).toHaveAttribute('lang', 'de')
    await expect(page.locator('html'), `the 2.1 theme applies at ${load}`).toHaveAttribute('data-theme', 'dark')
    await page.waitForTimeout(500)
    expect(await storesDump(page), `${load} writes neither settings record`).toEqual(before)
  }
})

test('R3 canopi-f47t.52.272: a setting changed under settings a newer Canopi saved applies for the session, is never written, and the notice names settings', async ({ page }) => {
  const settings = frozenRecord('settings')
  await page.goto('')
  await seedLocalStorage(page, { [settings.key]: JSON.stringify({ ...settings.record, version: 3 }) })
  const before = await storesDump(page)
  await page.reload()
  await expectNotice(page, SETTINGS_READ_ONLY, german('notice.dismiss'))
  await expect(page.locator('[data-notice-row]').first()).toContainText(german('health.newerReadOnlyStore.settings'))

  await startScreen(page).getByRole('button', { name: german('menu.file.settings') }).click()
  const dialog = page.getByRole('dialog', { name: german('settings.title') })
  await dialog.getByRole('radiogroup', { name: german('settings.theme') }).getByRole('radio', { name: german('theme.light') }).click()
  await expect(page.locator('html'), 'the change applies for the session (2.1-Q320)').toHaveAttribute('data-theme', 'light')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1_000)
  expect(await storesDump(page), 'the change is never written').toEqual(before)

  await page.reload()
  await expect(page.locator('html'), 'a reload reads the newer record again').toHaveAttribute('data-theme', 'dark')
  await expectNotice(page, SETTINGS_READ_ONLY, german('notice.dismiss'))
  expect(await storesDump(page)).toEqual(before)
})

test('R3 canopi-f47t.52.272: favourites and recently viewed from their 2.1 key say once at launch that a newer Canopi saved them, and no key is written, after a reload too (Web)', async ({ page }) => {
  const species = frozenRecord('species-lists')
  await page.goto('')
  await seedLocalStorage(page, {
    [V3_SPECIES_KEY]: JSON.stringify({ version: 3, favoriteSpecies: ['Fragaria vesca'], recentlyViewedSpecies: [] }),
    [species.key]: JSON.stringify(species.record),
  })
  const before = await storesDump(page)

  for (const load of ['launch', 'reload']) {
    await page.reload()
    await expectNotice(page, SPECIES_READ_ONLY)
    await expect(page.locator('[data-notice-row]').first(), `the species lists name themselves at ${load} (2.1-Q319)`)
      .toContainText('Your favorites and recently viewed plants were saved by a newer Canopi.')
    await page.waitForTimeout(500)
    expect(await storesDump(page), `${load} writes neither species record`).toEqual(before)
  }
})

test('R3 canopi-f47t.52.272: a 2.1 settings or species record of a later version reads as saved by a newer Canopi and is never moved aside, after a reload too (Web)', async ({ page }) => {
  const settings = frozenRecord('settings')
  const species = frozenRecord('species-lists')
  await page.goto('')
  await seedLocalStorage(page, {
    [settings.key]: JSON.stringify({ ...settings.record, version: 3, locale: 'en', a_field_from_later: { nested: true } }),
    [species.key]: JSON.stringify({ ...species.record, version: 2, starred_collections: [] }),
  })
  const before = await storesDump(page)

  for (const load of ['launch', 'reload']) {
    await page.reload()
    await expect(page.locator('html'), `a later settings record's known fields apply at ${load}`).toHaveAttribute('data-theme', 'dark')
    await expectNotice(page, SPECIES_READ_ONLY)
    await page.waitForTimeout(500)
    expect(await storesDump(page), `${load} moves no record aside and writes none`).toEqual(before)
  }
})

/** Every species-list entry in localStorage, under either key: what "the star wrote nothing" compares. */
async function speciesKeysDump(page: Page): Promise<unknown> {
  return await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(':species')).sort().map((key) => [key, localStorage.getItem(key)]))
}

/** Opens the fixture Design unless launch restored its Draft: offline, a species detail opens from Plants in this Design. */
async function openFixtureDesign(page: Page): Promise<void> {
  const map = page.getByRole('application').first()
  await expect(map.or(startScreen(page)).first()).toBeVisible()
  if (await map.isVisible()) return
  const open = startScreen(page).locator('button').filter({ hasText: /\.canopi/ }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
  await chooser.setFiles(FIXTURE)
  await expect(map).toBeVisible()
}

for (const [state, damaged, reason] of [
  ['saved by a newer Canopi', false, 'Saved by a newer Canopi. Update Canopi to change your favorites.'],
  ['not JSON', true, 'Canopi’s saved favorites and recently viewed plants are damaged and couldn’t be set aside, so changes to them won’t be saved this session.'],
] as const) {
  test(`R3 canopi-f47t.52.272: under a 2.1 species key ${state}, the species detail favourite star is off, says why, and a click or Enter writes nothing, after a reload too (Web)`, async ({ page }) => {
    const species = frozenRecord('species-lists')
    await page.goto('')
    await seedLocalStorage(page, {
      [V3_SPECIES_KEY]: JSON.stringify({ version: 3, favoriteSpecies: ['Fragaria vesca'], recentlyViewedSpecies: [] }),
      [species.key]: damaged ? 'not json' : JSON.stringify(species.record),
    })
    const before = await speciesKeysDump(page)
    for (const load of ['launch', 'reload']) {
      await page.reload()
      await openFixtureDesign(page)
      const keyPanel = page.getByRole('region', { name: 'Plants in this Design' })
      if (!(await keyPanel.isVisible())) await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Plants in this Design' }).click()
      await keyPanel.getByRole('button', { name: /^Details for / }).first().click()
      const star = page.locator('[data-testid="species-detail"] button[aria-pressed]')
      await expect(star, `the star is off at ${load} (2.1-Q320)`).toHaveAttribute('aria-disabled', 'true')
      await expect(star, `and says why at ${load}`).toHaveAccessibleDescription(reason)
      await star.hover()
      await expect(page.getByRole('tooltip').getByText(reason, { exact: true }), `its tooltip shows at ${load}`).toBeVisible()
      const pressed = await star.getAttribute('aria-pressed')
      // Playwright counts aria-disabled as disabled and would wait forever; force still clicks as the pointer does.
      await star.click({ force: true })
      await star.focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
      await expect(star, `a refused toggle leaves the star as it was at ${load}`).toHaveAttribute('aria-pressed', pressed!)
      expect(await speciesKeysDump(page), `a click or Enter on the star at ${load} writes neither species key`).toEqual(before)
    }
  })
}

test.describe('a 2.1 key that is not JSON', () => {
  // Settings that cannot be read are reported as the 2.0 key's are (SET-05): the projection's own console line.
  test.use({ expectedConsoleErrors: ['Failed to bootstrap settings:'] })

  test('R3 canopi-f47t.52.272: a 2.1 settings or species key that is not JSON is never moved aside: settings unavailable, species lists refuse writes, after a reload too (Web)', async ({ page }) => {
    const settings = frozenRecord('settings')
    const species = frozenRecord('species-lists')
    await page.goto('')
    await seedLocalStorage(page, {
      [V3_SPECIES_KEY]: JSON.stringify({ version: 3, favoriteSpecies: ['Fragaria vesca'], recentlyViewedSpecies: [] }),
      [settings.key]: '{"version": 2, "locale": "de"',
      [species.key]: 'not json',
    })
    const before = await storesDump(page)

    for (const load of ['launch', 'reload']) {
      await page.reload()
      await expect(startScreen(page)).toBeVisible()
      await expectNotice(page, healthKey('web_species_lists', { kind: 'unavailable', code: { kind: 'invalid' } }))
      await expectNotice(page, healthKey('settings', { kind: 'unavailable', code: { kind: 'invalid' } }))
      await expect(page.locator('html'), `settings that do not read start on defaults at ${load}`).toHaveAttribute('lang', 'en')
      expect(await storesDump(page), `${load} moves neither 2.1 key aside and writes no key`).toEqual(before)
    }
  })
})
