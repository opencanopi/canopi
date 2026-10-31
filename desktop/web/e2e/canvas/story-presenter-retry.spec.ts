// The map notice's Retry works during a story presentation (U56). Offline, the base fixture's story step shows Street
// map, whose style cannot load: the full-window presenter, modal over the map, draws the notice and its Retry in its
// own layer, where a click and Enter both reach Retry, which asks for the basemap's style again. The canvas draws no
// notice under the presenter; once Esc leaves, the canvas notice is back with Retry. The notice clears the presenter's
// card and bar, with room for its sentence, in a wide window, a narrow one, one just above phone width and on a phone
// either way up. Tab from the notice, which holds focus after Retry, stays in the presenter. Both engines; no baselines.
// The page has a second requester of the same style: the Stories step's thumbnail, an off-screen map whose capture asks
// for the basemap once, a short while after the panel shows, and waits up to its timeout for it. A Retry while that
// download runs joins it (fetchStyle shares a download per URL) and asks for nothing, so the Retry counts below start
// only once the thumbnail is drawn and every style request has settled (canopi-f47t.52.228.16: under CI load the
// thumbnail's request came between the settle check and Enter, and Enter's Retry joined it).
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { designMap, expectCanvasDrawn } from '../support/canvas'
import { expect, test } from '../support/offline'

const FIXTURE = fileURLToPath(new URL('../fixtures/canvas-base.canopi', import.meta.url))
const STYLE_REQUEST = /^https:\/\/tiles\.openfreemap\.org\/styles\//
const NOTICE_FAILED = 'Basemap couldn’t load'
/** The presenter's room for its notice never drops below this, or a longer locale's sentence stands as a tower of words. */
const NOTICE_MIN_ROOM = 280

const LAYOUTS = [
  { name: 'wide window', viewport: { width: 1400, height: 900 }, hasTouch: false },
  { name: 'narrow window', viewport: { width: 800, height: 700 }, hasTouch: false },
  // Just above phone width, where the room right of the card would be too narrow for the notice's sentence.
  { name: 'window just above phone width', viewport: { width: 640, height: 700 }, hasTouch: false },
  { name: 'phone portrait', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: 'phone landscape', viewport: { width: 844, height: 390 }, hasTouch: true },
] as const

for (const { name, viewport, hasTouch } of LAYOUTS) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch })

    test('the notice and a working Retry show inside the presenter, and the canvas notice is back after Esc', async ({ page }) => {
      let styleRequests = 0
      let styleRequestsSettled = 0
      page.on('request', (request) => { if (STYLE_REQUEST.test(request.url())) styleRequests += 1 })
      const settle = (request: { url(): string }) => { if (STYLE_REQUEST.test(request.url())) styleRequestsSettled += 1 }
      page.on('requestfailed', settle)
      page.on('requestfinished', settle)
      await openBaseFixture(page)
      await expect(page.locator('[data-map-notice]')).toContainText(NOTICE_FAILED)

      await openStories(page)
      await expect(page.locator('[data-story-step] [data-thumbnail-state]'), 'the step\'s thumbnail is drawn, so it asks for no more styles')
        .toHaveAttribute('data-thumbnail-state', /^(ready|none)$/)
      // The step's camera jumps instead of flying, so the presenter settles at once.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: 'Present' }).click()
      const presentation = page.getByRole('dialog', { name: 'Presenting Tour' })
      await expect(presentation).toBeVisible()
      await expect(presentation.getByRole('heading', { name: 'Overview' })).toBeVisible()

      const notice = presentation.locator('[data-map-notice]')
      await expect(notice).toContainText(NOTICE_FAILED)
      await expect(page.locator('[data-map-notice]'), 'the canvas draws no notice under the presenter').toHaveCount(1)
      const retry = notice.getByRole('button', { name: 'Retry', exact: true })
      await expectRetryHit(retry)
      expect(await coveredByNotice(notice), 'the notice covers none of the presenter\'s card and buttons').toEqual([])
      expect(await roomOf(notice), 'the notice has room for its sentence beside Retry').toBeGreaterThanOrEqual(NOTICE_MIN_ROOM)
      expect(await withTallCard(presentation, () => coveredByNotice(notice)), 'a card at its tallest stops short of the notice')
        .toEqual([])

      // A click asks for the style again; offline it fails again and Retry comes back.
      await expect.poll(() => styleRequestsSettled === styleRequests, 'the thumbnail\'s style request has settled').toBe(true)
      let before = styleRequests
      await retry.click()
      await expect.poll(() => styleRequests, 'a click on Retry asks for the basemap style again').toBeGreaterThan(before)
      // When the load settles the notice draws a new Retry, so focus waits for every load (WebKit on main, 2026-10-16:
      // Enter went to the replaced button).
      await expect.poll(() => styleRequestsSettled === styleRequests, 'every style request has settled').toBe(true)
      await expect(retry).toBeVisible()

      // So does Enter on the focused Retry. Held, the request leaves the basemap loading with no Retry, so focus is on
      // the notice, after every control: Tab wraps to the first shown control instead of leaving the page, so the
      // presenter's keys (Esc below) still reach it. Let go, the request fails offline and Retry comes back.
      let letGo!: () => void
      const held = new Promise<void>((resolve) => { letGo = resolve })
      await page.route(STYLE_REQUEST, async (route) => {
        await held
        await route.fallback()
      })
      before = styleRequests
      await retry.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => styleRequests, 'Enter on Retry asks for the basemap style again').toBeGreaterThan(before)
      await expect(retry).toBeHidden()
      await expect(notice).toBeFocused()
      await page.keyboard.press('Tab')
      expect(await presentation.evaluate((presenter) => {
        const first = [...presenter.querySelectorAll('button, a[href]')].find((element) => element.getClientRects().length > 0)
        return first !== undefined && document.activeElement === first
      }), 'Tab from the notice reaches the presenter\'s first control').toBe(true)
      letGo()
      await expect(retry).toBeVisible()
      await expect(presentation, 'the presentation goes on').toBeVisible()

      await page.keyboard.press('Escape')
      await expect(presentation).toBeHidden()
      const canvasNotice = page.locator('[data-map-notice]')
      await expect(canvasNotice).toContainText(NOTICE_FAILED)
      await expect(canvasNotice.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
      await expectRetryHit(canvasNotice.getByRole('button', { name: 'Retry', exact: true }))
    })
  })
}

async function openBaseFixture(page: Page): Promise<void> {
  await page.goto('')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Open a \.canopi file…/ }).first().click(),
  ])
  await chooser.setFiles(FIXTURE)
  await expect(designMap(page)).toBeVisible()
  await expectCanvasDrawn(page)
}

/** Opens Stories: a button of the panel rail, or on a phone the panel sheet's More menu. */
async function openStories(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: 'More panels' })
  if (await more.isVisible()) {
    await more.click()
    await page.getByRole('menuitemcheckbox', { name: 'Stories' }).click()
  } else {
    await page.getByRole('navigation', { name: 'Web Edition panels' }).getByRole('button', { name: 'Stories' }).click()
  }
}

/** What a click at Retry's centre reaches is Retry. */
async function expectRetryHit(retry: Locator): Promise<void> {
  await expect(retry).toBeVisible()
  const box = await boxOf(retry)
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const hit = await retry.evaluate((button, at) => {
    const top = document.elementFromPoint(at.x, at.y)
    return top !== null && button.contains(top)
  }, centre)
  expect(hit, `a click at Retry's centre (${centre.x}, ${centre.y}) reaches Retry`).toBe(true)
}

/** The presenter's card and shown buttons (its bar's included) whose box the notice's box overlaps, by name. */
async function coveredByNotice(notice: Locator): Promise<string[]> {
  return await notice.evaluate((chip) => {
    const presenter = chip.closest('[data-story-presenter]')!
    const a = chip.getBoundingClientRect()
    const others = [presenter.querySelector('[data-presenter-card]')!, ...presenter.querySelectorAll('button')]
      .filter((element) => !chip.contains(element) && element.getClientRects().length > 0)
    return others.filter((element) => {
      const b = element.getBoundingClientRect()
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    }).map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? element.tagName)
  })
}

/** Fills the card past its greatest height, as a long step's text does, for the length of `check`. */
async function withTallCard<T>(presentation: Locator, check: () => Promise<T>): Promise<T> {
  await presentation.locator('[data-presenter-card]').evaluate((card) => {
    const filler = document.createElement('div')
    filler.dataset.tallCardFiller = ''
    filler.style.height = '4000px'
    card.append(filler)
  })
  try {
    return await check()
  } finally {
    await presentation.locator('[data-tall-card-filler]').evaluate((filler) => filler.remove())
  }
}

/** The width of the room the presenter gives its notice. */
async function roomOf(notice: Locator): Promise<number> {
  return await notice.evaluate((chip) => chip.parentElement!.getBoundingClientRect().width)
}

async function boxOf(locator: Locator): Promise<{ x: number, y: number, width: number, height: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no box: the element is not laid out')
  return box
}
