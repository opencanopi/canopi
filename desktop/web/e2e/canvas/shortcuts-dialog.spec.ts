// Help › Keyboard shortcuts (F1) lays out its rows in columns at least 300 px wide (KeyboardShortcutsDialog.module.css).
// A gesture row joins the platform's inputs into one key box, and the longest, French on a Mac whose browser delivers
// WebKit gesture events (Shift + right or middle drag, then the trackpad twist), is far wider than a column: the box
// wraps inside its section instead of running past it. jsdom has no layout, so this runs in the browser. The welcome
// screen's Moving around opens it scrolled to the gestures (2.1-Q310), which only a real layout scrolls.
// No baselines: nothing here is compared with a recorded screenshot.
import type { Locator } from '@playwright/test'
import { expect, test } from '../support/offline'

/** Safari on macOS: the shortcuts read the platform from the user agent (canvas/runtime/input/platform.ts). */
test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' })

test('every F1 key box stays inside its section in French on a Mac with trackpad gestures', async ({ page }) => {
  await page.addInitScript(() => {
    // The Web Edition's settings record (web/browser-app-data.ts), with French chosen.
    localStorage.setItem('canopi:web-app-data:v3:settings', JSON.stringify({ version: 3, settings: { locale: 'fr' } }))
    // WebKit's gesture events, which the twist row is shown for.
    const page = window as unknown as { GestureEvent?: unknown }
    page.GestureEvent ??= class GestureEvent extends UIEvent {}
  })
  await page.goto('')
  await expect(page.locator('[data-start-screen]')).toBeVisible()
  await page.keyboard.press('F1')
  const dialog = page.getByRole('dialog', { name: 'Raccourcis clavier' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Tourner deux doigts sur le pavé tactile', { exact: false })).toBeVisible()

  const outside = await dialog.locator('section').evaluateAll((sections) => sections.flatMap((section) => {
    const bounds = section.getBoundingClientRect()
    return Array.from(section.querySelectorAll('kbd'), (key) => {
      const box = key.getBoundingClientRect()
      return box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5 ? `${key.textContent} (${box.left}–${box.right} in ${bounds.left}–${bounds.right})` : null
    }).filter((entry) => entry !== null)
  }))
  expect(outside, 'key boxes that run past their section').toEqual([])
})

test('on a Mac the gestures section pans with two fingers or the Pan tool and removes with Option-click, like the Select hint (canopi-pqxl)', async ({ page }) => {
  await page.goto('')
  await expect(page.locator('[data-start-screen]')).toBeVisible()
  await page.getByRole('button', { name: 'Moving around' }).click()
  const gestures = page.getByRole('dialog', { name: 'Keyboard shortcuts' }).locator('section', { has: page.locator('#shortcuts-gestures') })
  const row = (label: string) => gestures.locator('dl > div', { has: page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) }).getByRole('definition')
  // Right-drag, Control-drag and Space-drag are not yet checked in real Mac browsers, so a Mac is not sent to them.
  await expect(row('Pan the map')).toHaveText('Two fingers on the trackpad (Settings › Canvas › Pointing device), or the Pan tool')
  await expect(row('Remove from the selection')).toHaveText('Option + click')
})

/** The nearest ancestor of the gestures heading that scrolls: the dialog's body. */
async function gesturesScroll(heading: Locator): Promise<{ scrollTop: number; offset: number }> {
  return heading.evaluate((element) => {
    let scroller = element.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
    if (!scroller) throw new Error('nothing scrolls in the shortcuts dialog')
    return { scrollTop: scroller.scrollTop, offset: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top }
  })
}

test('the welcome screen’s Moving around opens Help at the gestures section; a plain reopen starts at the top; an open dialog moves there (2.1-Q310)', async ({ page }) => {
  // Short enough that the gestures sit below the dialog body's fold.
  await page.setViewportSize({ width: 1280, height: 560 })
  await page.goto('')
  await expect(page.locator('[data-start-screen]')).toBeVisible()
  await page.getByRole('button', { name: 'Moving around' }).click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  const heading = dialog.locator('#shortcuts-gestures')
  await expect(heading, 'Help opens at the gestures section').toBeFocused()
  await expect(heading).toBeInViewport()
  const opened = await gesturesScroll(heading)
  expect(opened.scrollTop, 'the body scrolled to the gestures').toBeGreaterThan(0)
  expect(Math.abs(opened.offset), 'the gestures heading at the body top').toBeLessThan(2)

  // Not sticky: F1 after closing starts at the top, focus on Close.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.keyboard.press('F1')
  await expect(dialog.getByRole('button', { name: 'Close' }).last()).toBeFocused()
  expect((await gesturesScroll(heading)).scrollTop, 'a plain reopen starts at the top').toBe(0)

  // Asked again while open (the line sits behind the modal, so a script clicks it): Help moves to the gestures.
  await page.locator('[data-start-help-line]').evaluate((line: HTMLElement) => line.click())
  await expect(heading).toBeFocused()
  expect((await gesturesScroll(heading)).scrollTop).toBeGreaterThan(0)
})
