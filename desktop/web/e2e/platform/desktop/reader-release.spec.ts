// The reader release in the Desktop app (Step 2.0.4 R1, canopi-f47t.52.270; plan "Tests by behaviour"). After a
// rollback from 2.1, a `.canopi` v10 Draft is listed read-only and can be neither deleted nor saved over, its bytes
// unchanged (2.1-Q316, design check F7), and a v10 Design file opens in the read-only Session kind: its save status
// says a newer Canopi saved it, with Update (2.1-Q317), Close is its only action (2.1-Q315), and the file is never
// written; Recent Designs then lists it labelled read-only.
//
// Written failing in commit 0 and marked expected-fail. R1-6 removed the open's marker; the Draft row's stays until the
// Draft list says which Draft a newer Canopi saved (a read-only flag on DesignDraftSummary, canopi-types/src/design.rs,
// R1 canopi-f47t.52.270): today the row is listed but not labelled, with Delete offered. Mocha has no expected-fail, so
// `it.fails` below runs its body and fails unless the body throws, as Vitest's does (a body that passes is a vacuous
// test). The specs share one app session and run in order; the Draft is written before the page reloads, so the
// start screen lists it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, appFolders, currentProfile, openDesignButton, waitForAnswerTaken } from '../support/app'

const DESIGN_FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')

/** Mocha's `it`, with an expected-fail: `it.fails` passes only when its body fails. */
const it = Object.assign((title: string, body: () => Promise<void>): void => { globalThis.it(title, body) }, {
  fails(title: string, body: () => Promise<void>): void {
    globalThis.it(title, async () => {
      try {
        await body()
      } catch (error) {
        console.log(`expected failure: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      throw new Error(`"${title}" passed but is marked expected-fail: remove its marker`)
    })
  },
})

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

  it.fails('R1 canopi-f47t.52.270: reader release: deleting or saving over a v10 Draft is refused and leaves its bytes', async () => {
    const draft = write(join(appFolders(currentProfile()), 'drafts', 'orchard-2-1.canopi'), v10Design('Orchard 2.1'))
    const bytes = readFileSync(draft)
    await browser.refresh()
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })

    // Today the v10 Draft is listed, but unlabelled and with Delete offered (the Draft list has no read-only flag yet).
    // A text selector scoped from the start screen: WebKitGTK's driver refuses one combined with CSS (canopi-4ycm).
    const row = $('[data-start-screen]').$('li*=Orchard 2.1')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row).toHaveAttribute('data-read-only')
    await expect(row).toHaveText(expect.stringContaining('Read-only: saved by a newer Canopi'))
    await expect(row.$('button[aria-label="Actions for Orchard 2.1"]')).not.toBeExisting()

    await row.$('button*=Orchard 2.1').click()
    await $('[data-save-status]').waitForDisplayed({ timeout: 30_000 })
    await expect($('[data-save-status]')).toHaveText(expect.stringContaining('newer Canopi'))
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

    const status = $('[data-workspace-title-bar] [data-save-status]')
    await status.waitForDisplayed({ timeout: 30_000 })
    await expect(status).toHaveText(expect.stringContaining('newer Canopi'))
    await expect(status.$('button=Update')).toBeDisplayed()
    await browser.pause(2_000)
    expect(readFileSync(file).equals(bytes)).toBe(true)
  })
})
