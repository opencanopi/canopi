// Accessibility per surface (ADR 0029 Accessibility, 2.1-M214, 2.1-Q84): each row of the surface table (support/a11y.ts)
// in Chromium, WebKit and Firefox. axe writes the surface's report for the axe family (policy/ratchets/axe.json), which
// gates the violations, so a violation never fails this spec; the ARIA snapshot fails on a changed accessibility tree
// (re-record in the pinned image with --update-snapshots); the keyboard-only flow fails on a key that does not act.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../support/offline'
import { A11Y_SURFACES, writeAxeReport, writeManifest, type A11yEngine } from '../support/a11y'

/**
 * The lane's planted broken page (plan:157; playwright.config.ts, web-edition-browsers.yml): the accessibility tree check
 * is marked to fail on it, so the inverted step's run passes only when the check ran and failed.
 */
const PLANTED = process.env.CANOPI_E2E_PLANTED_PAGE !== undefined

const engine = (name: string): A11yEngine => {
  if (name === 'chromium' || name === 'webkit' || name === 'firefox') return name
  throw new Error(`no a11y engine ${name}`)
}

test('the engine\'s a11y manifest names every surface row', async ({ browserName }) => {
  await writeManifest(engine(browserName))
})

/** The tracker's export (bd), where each known a11y bug's bead must be an open bug: never a closed one or a stream task. */
const BEADS = fileURLToPath(new URL('../../../../.beads/issues.jsonl', import.meta.url))
const AXE_RATCHET = fileURLToPath(new URL('../../../../policy/ratchets/axe.json', import.meta.url))

/** Each known a11y bug this suite carries, a marked keyboard flow or an axe ratchet entry, with the bead it cites. */
const knownBugs = (): ReadonlyArray<readonly [string, string | undefined]> => {
  const axe = JSON.parse(readFileSync(AXE_RATCHET, 'utf8')) as { entries: Record<string, { bead?: string }> }
  return [
    ...A11Y_SURFACES.flatMap((s) => (s.keyboardBug ? [[`the ${s.id} keyboard flow`, s.keyboardBug.bead] as const] : [])),
    ...Object.entries(axe.entries).map(([key, entry]) => [`the axe entry ${key}`, entry.bead] as const),
  ]
}

/** Known bugs whose own bead main files at F5's merge: each is marked to fail until it cites that bead. */
const AWAITING_BEAD = new Set([
  'the plant-catalog keyboard flow',
  'the axe entry keyboard-shortcuts: scrollable-region-focusable',
  'the axe entry plant-catalog: aria-valid-attr-value',
])

for (const [bug, bead] of knownBugs()) {
  const awaiting = AWAITING_BEAD.has(bug)
  test(`${bug} cites an open bug bead${awaiting ? ' (fails until main files it, canopi-f47t.52.228.14, owner main)' : ''}`, ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'reads files only: one engine checks it')
    test.fail(awaiting)
    const issue = readFileSync(BEADS, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string, status: string, issue_type: string })
      .find((i) => i.id === bead)
    expect({ bead, status: issue?.status, type: issue?.issue_type }).toEqual({ bead, status: expect.not.stringMatching(/^closed$/), type: 'bug' })
  })
}

for (const surface of A11Y_SURFACES) {
  test.describe(surface.id, () => {
    test(`axe reports ${surface.id} (${surface.paths.join('; ')})`, async ({ page, browserName }) => {
      await surface.open(page)
      await writeAxeReport(page, surface, engine(browserName))
    })

    test(`${surface.id} keeps its accessibility tree`, async ({ page, browserName }) => {
      test.fail(PLANTED, 'a planted page must fail this check')
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
