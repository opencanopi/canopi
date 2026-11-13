// The reader release in the Desktop app (Step 2.0.4 R1, canopi-f47t.52.270; plan "Tests by behaviour"). After a
// rollback from 2.1, a `.canopi` v10 Draft is listed read-only and can be neither deleted nor saved over, its bytes
// unchanged (2.1-Q316, design check F7), and a v10 Design file opens in the read-only Session kind: its save status
// says "Read-only" and its popover that a newer Canopi saved it, with Update (2.1-Q317, Q336), Close is its only action
// (2.1-Q315), and the file is never written; Recent Designs then lists it labelled read-only.
//
// Written failing in commit 0 and marked expected-fail; both pass now, so neither carries the marker. Each test starts
// from the start screen: the specs share one app session, a test that opens a Design leaves the workspace open, and a
// reload puts the start screen back (Desktop reopens no Design on launch). The Draft is written before the page
// reloads, so the start screen lists it. Text selectors are scoped from an element: WebKitGTK's driver refuses one
// combined with CSS (canopi-4ycm).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, appFolders, currentProfile, openDesignButton, waitForAnswerTaken } from '../support/app'

const DESIGN_FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')

/** A Design as 2.1 writes it: `.canopi` v10, with the plant `scale` renamed `canopy_spread_m` (2.1-Q314). */
function v10Design(name: string): string {
  const design = JSON.parse(readFileSync(DESIGN_FIXTURE, 'utf8')) as Record<string, unknown>
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return JSON.stringify({ ...design, version: 10, name, plants }, null, 2)
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('the reader release in the Desktop app', () => {
  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  beforeEach(async () => {
    if (await $('[data-start-screen]').isDisplayed()) return
    await browser.refresh()
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  it('R1 canopi-f47t.52.270: reader release: deleting or saving over a v10 Draft is refused and leaves its bytes', async () => {
    const draft = write(join(appFolders(currentProfile()), 'drafts', 'orchard-2-1.canopi'), v10Design('Orchard 2.1'))
    const bytes = readFileSync(draft)
    await browser.refresh()
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })

    // The v10 Draft is listed labelled read-only, with no Delete.
    const row = $('[data-start-screen]').$('li*=Orchard 2.1')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row).toHaveAttribute('data-read-only')
    await expect(row).toHaveText(expect.stringContaining('Read-only: saved by a newer Canopi'))
    await expect(row.$('button[aria-label="Actions for Orchard 2.1"]')).not.toBeExisting()

    await row.$('button*=Orchard 2.1').click()
    // The status says "Read-only"; its popover says why (2.1-Q336).
    const status = $('[data-workspace-title-bar]').$('[data-save-status="read-only"]')
    await status.waitForDisplayed({ timeout: 30_000 })
    await status.$('button=Read-only').click()
    await expect(status.$('[role="dialog"]')).toHaveText(expect.stringContaining('Read-only: saved by a newer Canopi'))
    await browser.keys(['Escape'])
    // Save is refused over an existing newer Draft.
    await browser.keys(['Control', 's'])
    await browser.pause(2_000)
    expect(readFileSync(draft).equals(bytes)).toBe(true)
  })

  it('R1 canopi-f47t.52.270: reader release: a v10 Design opens read-only and says a newer Canopi saved it (Desktop)', async () => {
    const file = write(join(currentProfile(), 'designs', 'Orchard newer.canopi'), v10Design('Orchard newer'))
    const bytes = readFileSync(file)
    const answer = answerNextDialog(file)
    await openDesignButton().click()
    await waitForAnswerTaken(answer)

    // The status says "Read-only"; its popover says why and offers Update (2.1-Q336).
    const status = $('[data-workspace-title-bar]').$('[data-save-status="read-only"]')
    await status.waitForDisplayed({ timeout: 30_000 })
    await status.$('button=Read-only').click()
    const details = status.$('[role="dialog"]')
    await expect(details).toHaveText(expect.stringContaining('Read-only: saved by a newer Canopi'))
    await expect(details.$('button=Update')).toBeDisplayed()
    await browser.pause(2_000)
    expect(readFileSync(file).equals(bytes)).toBe(true)
  })
})
