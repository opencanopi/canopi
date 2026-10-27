// Quit with an unsaved edit (canopi-f47t.52.228.14; 2.1-M7, M81; contracts §4 step 4): closing the window from the
// title bar runs the close guard, which writes the edit to the Design's file before the window goes. The Design opens
// through the host's Open dialog, so the close path runs after the dialog move, on the real shell.
//
// Its own spec file: the window closes and the app exits, which ends the session.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentProfile, openDesignButton, renameOpenDesign, waitForOpenDesign } from '../support/app'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')

/** Writes a Design called `name` into the session's profile; returns its absolute path. */
function designFile(name: string): string {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const path = join(currentProfile(), 'designs', `${name}.canopi`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...design, name }, null, 2))
  return path
}

function savedName(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }).name
}

/** True once the app's window is gone and the driver can no longer reach its page. */
async function windowGone(): Promise<boolean> {
  try {
    await browser.getTitle()
    return false
  } catch {
    return true
  }
}

describe('closing the window', () => {
  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  it('with an unsaved edit keeps the edit through the close guard (2.1-M7)', async () => {
    const garden = designFile('Closing garden')
    answerNextDialog(garden)
    await openDesignButton().click()
    await waitForOpenDesign('Closing garden')

    await renameOpenDesign('Closing garden', 'Kept garden')
    // Continuous save waits 1.5 s after an edit, so the file still has the old name: only the close guard writes it.
    expect(savedName(garden)).toBe('Closing garden')

    await $('[data-workspace-title-bar] button[aria-label="Close"]').click()

    // The window goes once the guard is done; a window still open would let continuous save write the edit instead.
    await browser.waitUntil(windowGone, { timeout: 30_000, timeoutMsg: 'the window did not close' })
    expect(savedName(garden)).toBe('Kept garden')
  })
})
