// The asset protocol serves only its configured files (canopi-f47t.52.228.14; 2.1-M81; contracts §7): a Design the
// user opened through the host's Open dialog stays unreadable to the page over asset://. The dialog plugin's JS
// commands added every picked file to the scope for the session; the host dialogs never do. The Rust contract test
// (`commands::host` tests) proves the same on a mock app, with a configured file served as the control; this spec
// proves it on the real app, through the real protocol handler.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentProfile } from '../support/app'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')

describe('the asset protocol', () => {
  it('refuses a Design picked through the host Open dialog', async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
    const folder = join(currentProfile(), 'designs')
    mkdirSync(folder, { recursive: true })
    const picked = join(folder, 'Picked garden.canopi')
    const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
    writeFileSync(picked, JSON.stringify({ ...design, name: 'Picked garden' }, null, 2))
    answerNextDialog(picked)

    await $('button=Open Design…').click()
    await $('button[aria-label="Rename Design: Picked garden"]').waitForDisplayed({ timeout: 30_000 })

    const answer = await browser.execute(async (path: string) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc(path: string, protocol: string): string } }).__TAURI_INTERNALS__
      try {
        const response = await fetch(internals.convertFileSrc(path, 'asset'))
        return { status: response.status }
      } catch (error) {
        return { error: String(error) }
      }
    }, picked)

    // Out of scope is a 403 from the protocol handler, not a network failure, which a missing protocol would give.
    expect(answer).toEqual({ status: 403 })
  })
})
