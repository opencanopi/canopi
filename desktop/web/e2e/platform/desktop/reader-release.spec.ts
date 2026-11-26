// The v10 cutover in the Desktop app (Step 2.0.4 R1, canopi-f47t.52.270; 2.1-Q347): Canopi 2.1 holds `.canopi` v10
// natively as an editable Design or Draft, and refuses newer-version (v11+) files unchanged instead of opening a
// read-only view (a v11 Draft is listed unreadable with no Delete and its bytes untouched; clicking a newer-version
// file shows the native error dialog).
//
// Each test starts from the start screen: the specs share one app session, a test that opens a Design leaves the
// workspace open, and a reload puts the start screen back (Desktop reopens no Design on launch). Drafts are written
// before the page reloads, so the start screen lists them. Text selectors are scoped from an element: WebKitGTK's
// driver refuses one combined with CSS (canopi-4ycm).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, appFolders, currentProfile, openDesignButton, waitForAnswerTaken, waitForOpenDesign } from '../support/app'

const DESIGN_FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')

/** A `.canopi` file at `version` with the v10 plant field `canopy_spread_m` (2.1-Q314). */
function designAtVersion(version: number, name: string): string {
  const design = JSON.parse(readFileSync(DESIGN_FIXTURE, 'utf8')) as Record<string, unknown>
  const plants = (design.plants as Record<string, unknown>[]).map(({ scale, ...plant }) => ({ ...plant, canopy_spread_m: scale }))
  return JSON.stringify({ ...design, version, name, plants }, null, 2)
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('the v10 cutover in the Desktop app', () => {
  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  beforeEach(async () => {
    if (await $('[data-start-screen]').isDisplayed()) return
    await browser.refresh()
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  it('R1 canopi-f47t.52.270: 2.1-Q347: a v11 Draft is listed unreadable with no Delete and bytes unchanged, while a v10 Draft opens natively (Desktop)', async () => {
    const v11Draft = write(join(appFolders(currentProfile()), 'drafts', 'orchard-2-2.canopi'), designAtVersion(11, 'Orchard 2.2'))
    const v11Bytes = readFileSync(v11Draft)
    write(join(appFolders(currentProfile()), 'drafts', 'orchard-2-1.canopi'), designAtVersion(10, 'Orchard 2.1'))
    await browser.refresh()
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })

    // A newer-version (v11) Draft is listed unreadable with no Delete action and its bytes untouched.
    const unreadableRow = $('[data-start-screen]').$('li[data-unreadable]')
    await unreadableRow.waitForDisplayed({ timeout: 30_000 })
    await expect(unreadableRow).not.toHaveAttribute('data-read-only')
    await expect(unreadableRow).toHaveText(expect.stringContaining('Saved by a newer Canopi; this version can’t read it'))
    await expect(unreadableRow.$('button[aria-label^="Actions for "]')).not.toBeExisting()

    // A v10 Draft is listed editable (with Actions) and opens natively in the workspace.
    const v10Row = $('[data-start-screen]').$('li*=Orchard 2.1')
    await v10Row.waitForDisplayed({ timeout: 30_000 })
    await expect(v10Row).not.toHaveAttribute('data-read-only')
    await expect(v10Row).not.toHaveAttribute('data-unreadable')
    await expect(v10Row.$('button[aria-label="Actions for Orchard 2.1"]')).toBeExisting()

    await v10Row.$('button*=Orchard 2.1').click()
    await waitForOpenDesign('Orchard 2.1')
    await $('[data-workspace-title-bar]').$('[data-save-status="draft"]').waitForDisplayed({ timeout: 30_000 })
    expect(readFileSync(v11Draft).equals(v11Bytes)).toBe(true)
  })

  it('R1 canopi-f47t.52.270: 2.1-Q347: a v10 Design opens natively editable and leaves its bytes unchanged until edited (Desktop)', async () => {
    const file = write(join(currentProfile(), 'designs', 'Orchard 2.1 file.canopi'), designAtVersion(10, 'Orchard 2.1 file'))
    const bytes = readFileSync(file)
    const answer = answerNextDialog(file)
    await openDesignButton().click()
    await waitForAnswerTaken(answer)

    await waitForOpenDesign('Orchard 2.1 file')
    await $('[data-workspace-title-bar]').$('[data-save-status="saved"]').waitForDisplayed({ timeout: 30_000 })
    await browser.pause(2_000)
    expect(readFileSync(file).equals(bytes)).toBe(true)
  })
})
