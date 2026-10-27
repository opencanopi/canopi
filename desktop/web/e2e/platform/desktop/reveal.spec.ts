// Show in folder on a Recent Design (canopi-zhv0; 2.1-Q227, M79): the host reveals the Design file through the
// opener's D-Bus FileManager1 call. The CI lane's private session bus has no file manager, and the opener's portal
// fallback cannot reach the portal (tauri-plugin-opener 2.7.2), so the reveal fails for real: the Start screen says
// so in a toast and the page names no path. That a desktop with a file manager opens the folder with the Design
// selected is a live check.
//
// Its own spec file: it needs a Recent Design and the Start screen, so it opens a Design and closes it again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentProfile } from '../support/app'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')
const NAME = 'Revealed garden'

/** Writes a Design called `name` into the session's profile; returns its absolute path. */
function designFile(name: string): string {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const path = join(currentProfile(), 'designs', `${name}.canopi`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...design, name }, null, 2))
  return path
}

describe('Show in folder', () => {
  let garden = ''

  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
    garden = designFile(NAME)
    answerNextDialog(garden)
    await $('button=Open Design…').click()
    await $(`button[aria-label="Rename Design: ${NAME}"]`).waitForDisplayed({ timeout: 30_000 })
    await browser.keys(['Control', 'w'])
    await $('[data-start-screen]').waitForDisplayed({ timeout: 30_000 })
  })

  it('with no file manager shows the failure toast and names no path', async () => {
    await $(`button[aria-label="More actions for ${NAME}"]`).click()
    await $('[role="menuitem"][aria-label="Show in folder"]').click()

    const toast = $('[role="status"]*=in its folder')
    await toast.waitForDisplayed({ timeout: 10_000 })
    const page = await $('body').getText()
    expect(page).not.toContain(garden)
    expect(page).not.toContain(dirname(garden))
  })
})
