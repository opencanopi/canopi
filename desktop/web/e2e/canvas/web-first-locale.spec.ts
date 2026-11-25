// Phase 2 (2.1-Q345, shipped in 2e-1): A new Web profile, with no saved settings, starts in the browser's language
// through the shared locale matcher: a French browser opens the start screen in French. Runs in every engine because
// each reports navigator.languages its own way; the matcher's tag corpus (fr_FR, pt-BR, zh-Hant-TW, xx) is its own
// Rust and TS test (contracts §14), so this spec checks only the first-start path. DOM assertions only.
import { expect, test } from '../support/offline'

test.describe('a French browser', () => {
  test.use({ locale: 'fr-FR' })

  test('Q345 (2e-1): a new Web profile starts in the browser language', async ({ page }) => {
    await page.goto('')
    await expect(page.locator('[data-start-screen]')).toBeVisible()
    await expect(page.locator('html'), 'the page language follows the browser').toHaveAttribute('lang', 'fr', { timeout: 2_000 })
  })
})
