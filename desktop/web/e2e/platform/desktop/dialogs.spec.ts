// Host file dialogs (canopi-f47t.52.228.14; 2.1-M81, Q240, Q241): Open, Save and Save As go through the host's
// pick_open and pick_save, which the e2e build answers from the session's answer folder (`answerNextDialog`), so the
// whole path past the native dialog runs for real: the commands, the host's extension rule, the write and the
// title bar. The native dialog itself is a live check (it cannot be driven over WebDriver).
//
// The specs share one app session and run in order.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentProfile, designFile, openDesignButton, savedName, waitForAnswerTaken } from '../support/app'


function designsFolder(): string {
  return join(currentProfile(), 'designs')
}

function designFiles(): string[] {
  return readdirSync(designsFolder()).sort()
}

async function waitForOpenDesign(name: string): Promise<void> {
  await $(`button[aria-label="Rename Design: ${name}"]`).waitForDisplayed({ timeout: 30_000 })
}

/** Runs a File command by its shortcut, as the menus and the palette run the same command. */
async function pressShortcut(...keys: string[]): Promise<void> {
  await browser.keys(['Control', ...keys])
}

describe('host file dialogs', () => {
  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
    mkdirSync(designsFolder(), { recursive: true })
  })

  it('Open cancelled leaves the start screen as it was', async () => {
    const answer = answerNextDialog()

    await openDesignButton().click()
    await waitForAnswerTaken(answer)

    await expect($('[data-start-screen]')).toBeDisplayed()
    await expect($('button[aria-label^="Rename Design: "]')).not.toBeExisting()
  })

  it('Open opens the Design the dialog chose', async () => {
    const garden = designFile('Chosen garden')
    answerNextDialog(garden)

    await openDesignButton().click()

    await waitForOpenDesign('Chosen garden')
  })

  it('Save As writes the Design where the dialog chose, adding the .canopi extension', async () => {
    const before = designFiles()
    // The dialog answers a name without an extension; the host adds the kind's own.
    const answer = answerNextDialog(join(designsFolder(), 'Garden copy'))

    await pressShortcut('Shift', 's')
    await waitForAnswerTaken(answer)

    const copy = join(designsFolder(), 'Garden copy.canopi')
    await browser.waitUntil(() => existsSync(copy), { timeout: 30_000, timeoutMsg: 'Save As wrote no file' })
    expect(savedName(copy)).toBe('Chosen garden')
    expect(designFiles()).toEqual([...before, 'Garden copy.canopi'].sort())
    await expect($('[data-save-status="saved"]')).toBeDisplayed()
  })

  it('Save As cancelled writes nothing', async () => {
    const before = designFiles()
    const answer = answerNextDialog()

    await pressShortcut('Shift', 's')
    await waitForAnswerTaken(answer)

    expect(designFiles()).toEqual(before)
    await waitForOpenDesign('Chosen garden')
  })

  it('Save As to a place that cannot be written keeps the Design open and writes nothing', async () => {
    const before = designFiles()
    const copy = join(designsFolder(), 'Garden copy.canopi')
    const copyBefore = readFileSync(copy, 'utf8')
    // A path under a file is unwritable on every platform.
    const answer = answerNextDialog(join(copy, 'Nested.canopi'))

    await pressShortcut('Shift', 's')
    await waitForAnswerTaken(answer)

    await waitForOpenDesign('Chosen garden')
    expect(designFiles()).toEqual(before)
    expect(readFileSync(copy, 'utf8')).toBe(copyBefore)
  })

  it('Save on a new Draft asks where to save, then writes there', async () => {
    await pressShortcut('n')
    await expect($('[data-save-status="draft"]')).toBeDisplayed({ wait: 30_000 })
    const answer = answerNextDialog(join(designsFolder(), 'Fresh draft.canopi'))

    await pressShortcut('s')
    await waitForAnswerTaken(answer)

    const fresh = join(designsFolder(), 'Fresh draft.canopi')
    await browser.waitUntil(() => existsSync(fresh), { timeout: 30_000, timeoutMsg: 'Save wrote no file' })
    await expect($('[data-save-status="saved"]')).toBeDisplayed({ wait: 30_000 })
  })
})
