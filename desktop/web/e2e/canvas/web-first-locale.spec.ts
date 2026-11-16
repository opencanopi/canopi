// Phase 2 commit 0: 2.1-Q345, written before 2e-1 builds it (test.fail until then). A new Web profile, with no saved
// settings, starts in the browser's language through the shared locale matcher: a French browser opens the start screen
// in French. 2e-1 drops test.fail. Chromium is enough; the matcher is engine-free. DOM assertions only.
import { expect, test } from '../support/offline'

test.describe('a French browser', () => {
  test.use({ locale: 'fr-FR' })

  test('Q345 (2e-1): a new Web profile starts in the browser language', async ({ page }) => {
    test.fail()
    await page.goto('')
    await expect(page.locator('[data-start-screen]')).toBeVisible()
    await expect(page.locator('html'), 'the page language follows the browser').toHaveAttribute('lang', 'fr', { timeout: 5_000 })
  })
})
