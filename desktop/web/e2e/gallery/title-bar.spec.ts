// The read-only save status in the title bar (R1 canopi-f47t.52.270, 2.1-Q336, Q337): a Design a newer Canopi saved
// shows its icon and the short label "Read-only", on both editions, in the locales with the longest labels; no Update
// sits in the bar, and the label's popover holds the sentence and Update. At the Desktop default window (1280 px) the
// label is whole. Just above the phone layout (761 px) main's title bar, which Q336 keeps, has no room for it (Desktop
// de leaves 25 px for the name and the status), so a rare state takes the simplest safe behaviour (Q337): the label may
// end in an ellipsis or go, while the icon and its button stay and the popover says it all. Geometry only, no
// baselines: each engine lays out its own fonts, as the real app does on WebKitGTK and WebView2.
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
        test(`R1 canopi-f47t.52.270: the read-only save status shows "${label}" ${width === 1280 ? 'whole' : 'or its icon'} with no inline Update, and its popover holds the sentence and Update (${locale}, 2.1-Q336)`, async ({ page }) => {
          await openGallery(page, { surface: 'workspace', session: 'read-only', locale, ...(edition === 'web' ? { edition } : {}) })
          const status = page.locator('[data-workspace-title-bar] [data-save-status="read-only"]')
          const trigger = status.getByRole('button', { name: label, exact: true })
          await expect(trigger).toBeVisible()
          await expect(status.getByRole('button'), 'the label is the status\'s only control in the bar').toHaveCount(1)

          await expect(trigger.locator('svg'), 'its icon shows').toBeVisible()
          const text = trigger.locator('span')
          const { clientWidth, scrollWidth, textOverflow } = await text.evaluate((element) => ({
            clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, textOverflow: getComputedStyle(element).textOverflow,
          }))
          if (width === 1280) {
            expect(clientWidth, 'the label has room').toBeGreaterThan(0)
            expect(scrollWidth, 'the label is not cut short').toBeLessThanOrEqual(clientWidth)
          } else if (scrollWidth > clientWidth) {
            expect(textOverflow, 'a cut label ends in an ellipsis, never half a glyph').toBe('ellipsis')
          }

          await trigger.click()
          const popover = status.getByRole('dialog')
          await expect(popover).toContainText(sentence)
          await expect(popover.getByRole('button', { name: update })).toBeVisible()
        })
      }
    })
  }
}
