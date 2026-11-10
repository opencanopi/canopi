// A notice carries long text (a file path in a failure message) beside up to two buttons in a 320 px side panel
// (canopi-6spu): the Site data panel's failed-attachment notice in French, the longest labels, laid out by the browser.
// Geometry only, no baselines.
import type { Locator, Page } from '@playwright/test'
import { expect, openGallery, test } from '../support/gallery'

type Box = { left: number, top: number, right: number, bottom: number }

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('not laid out')
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }
}

/** The failed attachment's notice in a 320 px Site data panel, in French; its icon, words and buttons. */
async function frenchNotice(page: Page) {
  await openGallery(page, { surface: 'site-data', state: 'lidar-failure', locale: 'fr', panelWidth: '320' })
  const notice = page.getByRole('complementary', { name: 'Données du site' }).locator('[data-notice-tone]').filter({ visible: true }).first()
  await expect(notice).toBeVisible()
  return {
    notice,
    icon: notice.locator(':scope > svg'),
    body: notice.locator(':scope > div').first(),
    action: notice.locator(':scope > div').last(),
    buttons: notice.getByRole('button'),
  }
}

test.describe('a notice in a 320 px side panel', () => {
  test('canopi-6spu: a notice wraps its actions under the text when they do not fit beside it', async ({ page }) => {
    const { notice, body, action } = await frenchNotice(page)
    const [text, actions, frame] = [await boxOf(body), await boxOf(action), await boxOf(notice)]
    expect(actions.top, 'the actions start below the words').toBeGreaterThanOrEqual(text.bottom - 0.5)
    expect(actions.right, 'the actions end inside the notice').toBeLessThanOrEqual(frame.right + 0.5)
  })

  test('canopi-6spu: a notice wraps its buttons onto a second line when their labels are wider than the notice (French at 320 px)', async ({ page }) => {
    const { notice, buttons } = await frenchNotice(page)
    await expect(buttons).toHaveCount(2)
    const frame = await boxOf(notice)
    const [first, second] = [await boxOf(buttons.nth(0)), await boxOf(buttons.nth(1))]
    expect(second.top, 'the second button wraps onto its own line').toBeGreaterThanOrEqual(first.bottom - 0.5)
    for (const button of [first, second]) {
      expect(button.left, 'a button starts inside the notice').toBeGreaterThanOrEqual(frame.left - 0.5)
      expect(button.right, 'a button ends inside the notice').toBeLessThanOrEqual(frame.right + 0.5)
    }
  })

  test('canopi-6spu: a notice keeps its buttons at the right edge when they wrap onto a second line (French at 320 px)', async ({ page }) => {
    const { action, buttons } = await frenchNotice(page)
    const edge = (await boxOf(action)).right
    // Each button is alone on its line, so each ends at the actions' right edge.
    for (const index of [0, 1]) {
      expect(Math.abs((await boxOf(buttons.nth(index))).right - edge), `button ${index + 1} at the right edge`).toBeLessThanOrEqual(1)
    }
  })

  test('canopi-6spu: a notice breaks a long word such as a file path and keeps a readable width before wrapping', async ({ page }) => {
    const { notice, icon, body } = await frenchNotice(page)
    await body.evaluate((element) => {
      element.textContent = '/home/someone/Documents/Canopi/Sites/Verger-de-la-colline-nord/lidar/dalle_0874_6512_classée.copc.laz'
    })
    const [text, frame, glyph] = [await boxOf(body), await boxOf(notice), await boxOf(icon)]
    expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth), 'the path breaks inside its box').toBe(true)
    expect(text.right, 'the path ends inside the notice').toBeLessThanOrEqual(frame.right + 0.5)
    expect(text.left, 'the path keeps its place beside the icon').toBeGreaterThan(glyph.right)
  })

  test('canopi-6spu: a notice keeps its text beside the icon at a large browser font size (root 24 px in a 320 px dock)', async ({ page }) => {
    const { icon, body } = await frenchNotice(page)
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px' })
    const [text, glyph] = [await boxOf(body), await boxOf(icon)]
    expect(text.left, 'the words start right of the icon').toBeGreaterThan(glyph.right)
    expect(text.top, 'the words start on the icon\'s line').toBeLessThan(glyph.bottom)
  })
})
