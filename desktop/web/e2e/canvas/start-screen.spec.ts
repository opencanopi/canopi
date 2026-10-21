// The start screen takes every tap (canopi-u85o; plan section 4 "2.0 release close", A12 and Q13). On a narrow window or a
// landscape phone the start screen is one page that scrolls (intro, then Drafts and recent Designs): each of its rows is
// as tall as its content, so the library never lies over the intro's buttons. On a phone the panel sheet's peek stays
// up, and the start screen ends above it through the visible-map-area seam (`--map-inset-bottom` on the map area), so the
// library's own New Design is not under the sheet. In landscape the sheet covers the right edge, yet at its peek it is a
// box in the bottom right corner; the start screen also ends above that box (`--map-clear-bottom`), so a full library's
// last rows, their action menus and a Draft's Delete confirm are not under it. Both engines, touch where the layout is a
// phone. DOM assertions only, no baselines.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expectHitAtCentre } from '../support/layout'
import { expect, test } from '../support/offline'

const SIZES = [
  { width: 360, height: 560 },
  { width: 740, height: 360 },
  { width: 844, height: 390 },
  { width: 700, height: 500 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const DRAFT_COUNT = 6

/**
 * Opens the start screen with `DRAFT_COUNT` Drafts, so the library overflows: writes them in the Web Edition's Drafts
 * record before the page loads, then closes the latest Draft, which the load reopens.
 */
async function openWithDrafts(page: Page): Promise<void> {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const drafts = Array.from({ length: DRAFT_COUNT }, (_, index) => ({
    id: `draft-${index}`,
    name: `Draft ${index + 1}`,
    updatedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
  }))
  const record = {
    version: 3,
    drafts,
    draftFiles: Object.fromEntries(drafts.map(({ id, name }) => [id, { ...file, name }])),
  }
  await page.goto('')
  await page.evaluate((value) => localStorage.setItem('canopi:web-app-data:v3:drafts', value), JSON.stringify(record))
  await page.reload()
  const compact = page.getByRole('menubar', { name: 'Menus' }).getByRole('menuitem', { name: 'Menu' })
  if (await compact.isVisible()) await compact.click()
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Close Design' }).click()
  await expect(startScreen(page)).toBeVisible()
}

function startScreen(page: Page) {
  return page.locator('[data-start-screen]')
}

for (const size of SIZES) {
  const name = `${size.width}×${size.height}`
  test.describe(name, () => {
    test.use({ viewport: size, hasTouch: size.width < 900 })

    test(`(canopi-u85o) every start screen button takes a tap at its centre once scrolled into view (${name})`, async ({ page }) => {
      await page.goto('')
      await expect(startScreen(page)).toBeVisible()
      const buttons = startScreen(page).getByRole('button')
      const count = await buttons.count()
      expect(count, 'the start screen shows its buttons').toBeGreaterThan(3)
      for (let index = 0; index < count; index++) {
        const button = buttons.nth(index)
        await button.scrollIntoViewIfNeeded()
        const label = (await button.textContent())?.trim() || `button ${index}`
        await expectHitAtCentre(button, `${label} (${name})`)
      }
    })

    test(`(canopi-u85o) with a full library every row and its action menu take a tap, and so does the last Draft's Delete (${name})`, async ({ page }) => {
      await openWithDrafts(page)
      const library = startScreen(page).locator('[data-start-library]')
      await expect(library.locator('[data-design-drafts] li')).toHaveCount(DRAFT_COUNT)
      const buttons = library.getByRole('button')
      const count = await buttons.count()
      for (let index = 0; index < count; index++) {
        const button = buttons.nth(index)
        // Scrolled to the middle, as a finger brings a row up; the last rows stop where the library ends.
        await button.evaluate((element) => element.scrollIntoView({ block: 'center' }))
        const label = (await button.getAttribute('aria-label')) || (await button.textContent())?.trim() || `button ${index}`
        await expectHitAtCentre(button, `${label} (${name})`)
      }
      const last = library.locator('[data-design-drafts] li').last()
      await last.locator('[aria-haspopup="menu"]').click()
      await page.locator('[data-action-menu]').getByRole('menuitem', { name: 'Delete draft…' }).click()
      const confirm = last.getByRole('alertdialog')
      await expect(confirm).toBeVisible()
      for (const button of await confirm.getByRole('button').all()) {
        await button.evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await expectHitAtCentre(button, `the confirm's ${(await button.textContent())?.trim()} (${name})`)
      }
    })

    test(`(canopi-u85o) Open asks for a file (${name})`, async ({ page }) => {
      await page.goto('')
      const open = startScreen(page).getByRole('button').filter({ hasText: /\.canopi/ }).first()
      await open.scrollIntoViewIfNeeded()
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()])
      expect(chooser.isMultiple(), 'Open asks for one file').toBe(false)
    })
  })
}

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('(canopi-u85o) opening a Draft keeps the start screen\'s layout until the Design shows', async ({ page }) => {
    // The Design's chrome is laid out, transparent, while its first scene is drawn; it frames the camera but takes no room
    // from the start screen covering the wait (visible-map-area's `--map-clear-*`), so the library does not shift.
    await openWithDrafts(page)
    await page.evaluate(() => {
      const samples: string[] = []
      ;(window as unknown as { __clearSamples: string[] }).__clearSamples = samples
      const sample = () => {
        const start = document.querySelector('[data-start-screen]')
        if (!start) return
        const style = getComputedStyle(start)
        samples.push(['top', 'right', 'bottom', 'left'].map((edge) => style.getPropertyValue(`--map-clear-${edge}`).trim()).join(' '))
        requestAnimationFrame(sample)
      }
      sample()
    })
    await startScreen(page).locator('[data-design-drafts] li').first().getByRole('button').first().click()
    await expect(startScreen(page)).toHaveCount(0)
    await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible()
    const samples = await page.evaluate(() => (window as unknown as { __clearSamples: string[] }).__clearSamples)
    expect(samples.length, 'frames were sampled while the Design opened').toBeGreaterThan(1)
    expect(new Set(samples), `the start screen's clearance per frame: ${JSON.stringify(samples)}`).toEqual(new Set([samples[0]]))
  })
})
