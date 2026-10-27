// Show in folder on a Recent Design (canopi-zhv0; 2.1-Q227, M79): the host reveals the Design file through the
// opener's D-Bus FileManager1 call. The CI lane's private session bus has no file manager, and the opener's portal
// fallback cannot reach the portal (tauri-plugin-opener 2.7.2), so the reveal fails for real and the host opens the
// Design's folder instead, through xdg-open as 2.0 did. The profile's XDG config makes a recorder the folder handler,
// so the spec reads which folder was opened. That a desktop with a file manager opens the folder with the Design
// selected, and Explorer on Windows, are live checks.
//
// Its own spec file: it needs a Recent Design and the Start screen, so it opens a Design and closes it again.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentPlatform, currentProfile, profileEnvironment } from '../support/app'

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

/**
 * Makes a recorder the profile's handler for folders (xdg-mime reads `XDG_CONFIG_HOME` and `XDG_DATA_HOME` when the
 * app calls xdg-open); returns the file the recorder writes the opened folder's path into.
 */
function recordOpenedFolders(): string {
  const { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data } = profileEnvironment(currentProfile())
  if (!config || !data) throw new Error('a Linux profile has XDG folders')
  const record = join(currentProfile(), 'opened-folder')
  const recorder = join(currentProfile(), 'record-opened-folder')
  // Written aside and renamed into place, so the record never exists empty while the spec polls for it.
  writeFileSync(recorder, `#!/bin/sh\nprintf %s "$1" > '${record}.tmp' && mv '${record}.tmp' '${record}'\n`)
  chmodSync(recorder, 0o755)
  mkdirSync(join(data, 'applications'), { recursive: true })
  writeFileSync(
    join(data, 'applications', 'canopi-e2e-folder-recorder.desktop'),
    `[Desktop Entry]\nType=Application\nName=Folder recorder\nExec=${recorder} %f\nMimeType=inode/directory;\nNoDisplay=true\n`,
  )
  writeFileSync(join(config, 'mimeapps.list'), '[Default Applications]\ninode/directory=canopi-e2e-folder-recorder.desktop\n')
  return record
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

  it('with no file manager opens the Design\'s folder and names no path', async function () {
    if (currentPlatform() !== 'linux') this.skip()
    const record = recordOpenedFolders()

    await $(`button[aria-label="More actions for ${NAME}"]`).click()
    await $('[role="menuitem"][aria-label="Show in folder"]').click()

    await browser.waitUntil(() => existsSync(record), { timeout: 10_000, timeoutMsg: 'no folder was opened' })
    expect(readFileSync(record, 'utf8')).toBe(dirname(garden))
    expect(await $('[role="status"]*=in its folder').isDisplayed()).toBe(false)
    const page = await $('body').getText()
    expect(page).not.toContain(garden)
    expect(page).not.toContain(dirname(garden))
  })
})
