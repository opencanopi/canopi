// Desktop Layers (canopi-f47t.42, plan section 4, gallery g8; pattern dock-panels.md "Layers"): the Design rows, the
// Site data summary row and the Map with its Background. The summary reads "2 of 3 shown" for the fixture's three
// entries (one hidden by its own eye); its eye hides all site data and leaves the item eyes; › opens Site data with
// focus in its header. One row is open at a time; the chosen background's settings show without a re-click. No text
// overflows at 320 px in English, German, Russian and Japanese, light and dark. Chromium and WebKit; DOM assertions only.
import type { Locator, Page } from '@playwright/test'
import { expect, openGallery, test } from '../support/gallery'
import { tooltipOf } from '../support/tooltip'

/** The Layers panel, in any language: the dock's one complementary region on this surface. */
function layers(page: Page): Locator {
  return page.getByRole('complementary').filter({ has: page.getByRole('radiogroup') })
}

/** Elements inside `scope` whose content is wider than their box (clipped or spilling), as "tag: text". */
async function overflowing(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter((element) => {
      // Hidden elements and visually hidden labels (1 px boxes) are not drawn text.
      if (element.getClientRects().length === 0 || element.clientWidth <= 1) return false
      const style = getComputedStyle(element)
      // Ellipsis is the intended truncation of a long name; the panel itself must never scroll sideways.
      if (style.textOverflow === 'ellipsis') return false
      return element.scrollWidth > element.clientWidth + 1 && style.overflowX !== 'visible'
    })
    .map((element) => `${element.tagName.toLowerCase()}: ${element.textContent?.slice(0, 40) ?? ''}`))
}

/** The share of a shown tooltip's box inside the window (it is drawn in the window-level layer, above every frame). */
async function drawnShare(tooltip: Locator): Promise<number> {
  return tooltip.evaluate((element: HTMLElement) => {
    const box = element.getBoundingClientRect()
    const width = Math.max(0, Math.min(box.right, window.innerWidth) - Math.max(box.left, 0))
    const height = Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0))
    return (width * height) / (box.width * box.height)
  })
}

test.describe('Desktop Layers', () => {
  test('the Site data row\'s name shows its shortcut tooltip whole, and its eye and › their names', async ({ page }) => {
    await openGallery(page, { surface: 'layers' })
    const summary = layers(page).getByRole('region', { name: 'Site data' })
    const clipped: string[] = []
    for (const [button, text] of [
      [summary.getByRole('button', { name: /^Site data/ }), /^Site data\s*Alt\+?\s?Shift\+?\s?2$/],
      [summary.getByRole('button', { name: 'Hide Site data' }), /^Hide Site data$/],
      [summary.getByRole('button', { name: 'Open Site data' }), /^Open Site data$/],
    ] as const) {
      await button.hover()
      const tooltip = await tooltipOf(button)
      await expect(tooltip).toHaveText(text)
      await expect(tooltip).toHaveCSS('opacity', '1')
      clipped.push(`${await tooltip.textContent()}: ${(await drawnShare(tooltip)).toFixed(2)}`)
    }
    expect(clipped, 'each tooltip is drawn whole').toEqual(clipped.map((entry) => entry.replace(/[\d.]+$/, '1.00')))
  })


  test('the summary row counts what is shown, and its eye hides all site data but leaves the item eyes', async ({ page }) => {
    await openGallery(page, { surface: 'layers' })
    const panel = layers(page)
    const summary = panel.getByRole('region', { name: 'Site data' })
    await expect(summary).toContainText('2 of 3 shown')
    await summary.getByRole('button', { name: 'Hide Site data' }).click()
    await expect(summary).toContainText('0 of 3 shown')
    await expect(summary.getByRole('button', { name: 'Show Site data' })).toHaveAttribute('aria-pressed', 'false')

    await summary.getByRole('button', { name: 'Open Site data' }).click()
    const siteData = page.getByRole('complementary', { name: 'Site data' })
    await expect(siteData).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const panel = Array.from(document.querySelectorAll('aside[aria-label]')).find((aside) => aside.getAttribute('aria-label') === 'Site data')
      return Boolean(panel?.querySelector('header')?.contains(document.activeElement))
    }), { message: 'focus is in the Site data header' }).toBe(true)
    // The item eyes are as they were: two shown, one hidden by its own eye.
    await expect(siteData.getByRole('button', { name: 'Hide IGN ground elevation', exact: true }).first()).toHaveAttribute('aria-pressed', 'true')
    await expect(siteData.getByRole('button', { name: 'Show Orchard gradient', exact: true }).first()).toHaveAttribute('aria-pressed', 'false')
  })

  test('one row is open at a time, and the chosen background shows its settings without a re-click', async ({ page }) => {
    await openGallery(page, { surface: 'layers' })
    const panel = layers(page)
    const zones = panel.getByRole('button', { name: /^Zones/ })
    const plants = panel.getByRole('button', { name: /^Plants/ })
    await zones.click()
    await expect(zones).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('slider', { name: 'Opacity: Zones' })).toBeVisible()
    await plants.click()
    await expect(zones).toHaveAttribute('aria-expanded', 'false')
    await expect(plants).toHaveAttribute('aria-expanded', 'true')
    await plants.click()
    await expect(panel.locator('[aria-expanded="true"]')).toHaveCount(0)

    const background = panel.getByRole('radiogroup', { name: 'Background' })
    await expect(background.getByRole('radio')).toHaveCount(3)
    for (const name of ['Satellite', 'Street map', 'None']) await expect(background.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeAttached()
    const checked = background.getByRole('radio', { checked: true })
    await expect(checked).toHaveCount(1)
    const choice = (await checked.getAttribute('value')) ?? ''
    if (choice !== 'none') await expect(panel.getByRole('slider', { name: /^Opacity: (Satellite|Street map)$/ })).toBeVisible()
    await background.getByRole('radio', { name: /^Satellite/ }).check()
    await expect(panel.getByRole('slider', { name: 'Opacity: Satellite' })).toBeVisible()
    await expect(panel.getByText('Soften background')).toBeVisible()
  })

  for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'de', 'ru', 'ja']) {
      test(`nothing overflows at 320 px (${locale}, ${theme})`, async ({ page }) => {
        await openGallery(page, { surface: 'layers', panelWidth: '320', locale, theme })
        const panel = layers(page)
        await expect(panel).toBeVisible()
        // An open row and the summary caption are the longest lines.
        await panel.getByRole('button', { expanded: false }).first().click()
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        expect(await overflowing(panel)).toEqual([])
      })
    }
  }
})
