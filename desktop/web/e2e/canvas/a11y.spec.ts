// Accessibility per surface (ADR 0029 Accessibility, 2.1-M214, 2.1-Q84): each row of the surface table (support/a11y.ts)
// in Chromium, WebKit and Firefox. axe writes the surface's report for the axe family (policy/ratchets/axe.json), which
// gates the violations, so a violation never fails this spec; the ARIA snapshot fails on a changed accessibility tree
// (re-record in the pinned image with --update-snapshots); the keyboard-only flow fails on a key that does not act.
import { test, expect } from '../support/offline'
import { A11Y_SURFACES, writeAxeReport, writeManifest, type A11yEngine } from '../support/a11y'

const engine = (name: string): A11yEngine => {
  if (name === 'chromium' || name === 'webkit' || name === 'firefox') return name
  throw new Error(`no a11y engine ${name}`)
}

test('the engine\'s a11y manifest names every surface row', async ({ browserName }) => {
  await writeManifest(engine(browserName))
})

for (const surface of A11Y_SURFACES) {
  test.describe(surface.id, () => {
    test(`axe reports ${surface.id} (${surface.paths.join('; ')})`, async ({ page, browserName }) => {
      await surface.open(page)
      await writeAxeReport(page, surface, engine(browserName))
    })

    test(`${surface.id} keeps its accessibility tree`, async ({ page, browserName }) => {
      await surface.open(page)
      await expect(surface.root(page)).toMatchAriaSnapshot({ name: `${surface.id}-${browserName}.aria.yml` })
    })

    const bug = surface.keyboardBug
    test(`${surface.id} works from the keyboard alone${bug ? ` (fails in ${bug.engines.join(' and ')} until ${bug.bead}, owner ${bug.owner})` : ''}`, async ({ page, browserName }) => {
      test.fail(bug?.engines.includes(engine(browserName)) ?? false)
      await surface.open(page)
      await surface.keyboard(page)
    })
  })
}
