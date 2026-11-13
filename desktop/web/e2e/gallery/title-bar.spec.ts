// The read-only save status in the title bar (R1 canopi-f47t.52.270, 2.1-Q336): a Design a newer Canopi saved shows its
// icon and the short label "Read-only" whole, on both editions, at the Desktop default window (1280 px) and just above
// the phone layout (761 px), in the locales with the longest labels; no Update sits in the bar, and the label's popover
// holds the sentence and Update. Geometry only, no baselines: each engine lays out its own fonts, as the real app does
// on WebKitGTK and WebView2.
//
// At 761 px the label is still cut on main's title bar layout, which Q336 keeps: the menus, logo, icon buttons and
// window controls leave the Design name, the status and the place field 51 to 162 px between them (Chromium,
// 2026-11-13: Desktop en 68 px for the name and status, de 25 px; "Schreibgeschützt" alone needs 113 px with its
// icon). Those cases are expected to fail until the user decides what gives way (canopi-f47t.52.270).
import { expect, openGallery, test } from '../support/gallery'

const LOCALES = [
  { locale: 'en', label: 'Read-only', sentence: 'Read-only: saved by a newer Canopi', update: 'Update' },
  { locale: 'fr', label: 'Lecture seule', sentence: 'Lecture seule : enregistré par une version plus récente de Canopi', update: 'Mettre à jour' },
  { locale: 'de', label: 'Schreibgeschützt', sentence: 'Schreibgeschützt: von einer neueren Canopi-Version gespeichert', update: 'Aktualisieren' },
] as const

for (const width of [1280, 761]) {
  for (const edition of ['desktop', 'web'] as const) {
    test.describe(`${edition} at ${width} px`, () => {
      test.use({ viewport: { width, height: 800 } })

      for (const { locale, label, sentence, update } of LOCALES) {
        test(`R1 canopi-f47t.52.270: the read-only save status shows "${label}" whole with no inline Update, and its popover holds the sentence and Update (${locale}, 2.1-Q336)`, async ({ page }) => {
          test.fail(width === 761, 'main\'s title bar leaves the status too little room at 761 px (see the header)')
          await openGallery(page, { surface: 'workspace', session: 'read-only', locale, ...(edition === 'web' ? { edition } : {}) })
          const status = page.locator('[data-workspace-title-bar] [data-save-status="read-only"]')
          const trigger = status.getByRole('button', { name: label, exact: true })
          await expect(trigger).toBeVisible()
          await expect(status.getByRole('button'), 'the label is the status\'s only control in the bar').toHaveCount(1)

          const text = trigger.locator('span')
          const { clientWidth, scrollWidth } = await text.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
          expect(clientWidth, 'the label has room').toBeGreaterThan(0)
          expect(scrollWidth, 'the label is not cut short').toBeLessThanOrEqual(clientWidth)

          await trigger.click()
          const popover = status.getByRole('dialog')
          await expect(popover).toContainText(sentence)
          await expect(popover.getByRole('button', { name: update })).toBeVisible()
        })
      }
    })
  }
}
