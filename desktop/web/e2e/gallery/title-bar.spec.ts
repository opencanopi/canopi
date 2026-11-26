// The read-only save status in the title bar (R1 canopi-f47t.52.270, 2.1-Q336, Q337, Q347): a storage-unchecked
// read-only session shows its icon and the short label "Read-only", on both editions, in the locales with the longest
// labels; no inline action sits in the bar, and the label's popover holds the explanation and keep-a-copy button. At
// the Desktop default window (1280 px) the label is whole. Just above the phone layout (761 px) main's title bar, which
// Q336 keeps, has no room for it (Desktop de leaves 25 px for the name and the status), so a rare state takes the
// simplest safe behaviour (Q337): the label may end in an ellipsis or go, while the icon and its button stay and the
// popover says it all. Geometry only, no baselines: each engine lays out its own fonts, as the real app does on
// WebKitGTK and WebView2.
import { expect, openGallery, test } from '../support/gallery'

const LOCALES = [
  {
    locale: 'en',
    label: 'Read-only',
    sentence: 'Opened read-only: Canopi couldn’t check this browser’s storage, so this Draft may be out of date. Download a copy to keep it.',
    action: { desktop: 'Save as…', web: 'Download a copy' },
  },
  {
    locale: 'fr',
    label: 'Lecture seule',
    sentence: 'Ouvert en lecture seule : Canopi n’a pas pu vérifier le stockage de ce navigateur, ce brouillon n’est peut-être pas à jour. Téléchargez une copie pour le conserver.',
    action: { desktop: 'Enregistrer sous…', web: 'Télécharger une copie' },
  },
  {
    locale: 'de',
    label: 'Schreibgeschützt',
    sentence: 'Schreibgeschützt geöffnet: Canopi konnte den Speicher dieses Browsers nicht prüfen, daher ist diese Skizze möglicherweise veraltet. Wählen Sie „Kopie herunterladen“, um sie zu behalten.',
    action: { desktop: 'Speichern unter…', web: 'Kopie herunterladen' },
  },
] as const

for (const width of [1280, 761]) {
  for (const edition of ['desktop', 'web'] as const) {
    test.describe(`${edition} at ${width} px`, () => {
      test.use({ viewport: { width, height: 800 } })

      for (const { locale, label, sentence, action } of LOCALES) {
        test(`R1 canopi-f47t.52.270: the read-only save status shows "${label}" ${width === 1280 ? 'whole' : 'or its icon'} with no inline action, and its popover holds the storage-unchecked sentence and copy action (${locale}, 2.1-Q336, 2.1-Q347)`, async ({ page }) => {
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
          await expect(popover.getByRole('button', { name: action[edition] })).toBeVisible()
        })
      }
    })
  }
}
