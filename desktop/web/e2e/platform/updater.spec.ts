// The updater end to end (plan Phase 0 F6, plan:186-196; 2.1-M55, M64, M82, Q234): an installed N-1 updater-e2e build,
// whose channel endpoint is compiled in as http://127.0.0.1:<UPDATER_E2E_PORT>/channel.json, checks, downloads and
// installs N from the channel files .github/workflows/updater-e2e.yml prepared in UPDATER_E2E_DIR, which this spec
// serves itself so each test chooses what the channel says and whether the host answers at all.
//
// UPDATER_E2E_DIR holds good.json (N, signed with the job's ephemeral key), tampered.json (N's entries pointing at a
// copy with flipped bytes), old.json (N-1's payload and signature announced as N+1) and the payloads. UPDATER_E2E_BUNDLE
// names the installer under test (appimage, deb or nsis); UPDATER_E2E_APPIMAGE is the AppImage's path on that lane.
//
// Not in the wdio config's specs: only the updater lane runs it, with --spec, against an installed bundle. The tests
// run in order: every check before the one install, which ends the session.
import { execFileSync } from 'node:child_process'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { answerNextDialog, currentPlatform, currentProfile, openDesignButton, renameOpenDesign, waitForOpenDesign } from './support/app'

const FIXTURE = resolve(import.meta.dirname, '../fixtures/canvas-base.canopi')
const PORT = Number(process.env.UPDATER_E2E_PORT ?? '47811')
const CHANNELS = process.env.UPDATER_E2E_DIR ?? ''
const BUNDLE = process.env.UPDATER_E2E_BUNDLE ?? ''

type Channel = 'good.json' | 'tampered.json' | 'old.json'

/** The local channel host: `/channel.json` answers with the chosen channel file, anything else from UPDATER_E2E_DIR. */
class ChannelHost {
  private server: Server | undefined
  channel: Channel = 'good.json'
  /** Bytes per second for payloads; unlimited when undefined. */
  throttle: number | undefined

  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.server = createServer((request, response) => {
      const name = request.url === '/channel.json' ? this.channel : decodeURIComponent((request.url ?? '/').slice(1))
      const path = join(CHANNELS, name)
      if (name.includes('..') || !existsSync(path) || !statSync(path).isFile()) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-length': statSync(path).size })
      const stream = createReadStream(path, this.throttle === undefined ? {} : { highWaterMark: 4096 })
      if (this.throttle !== undefined) {
        const pause = Math.ceil(4096 / this.throttle * 1000)
        stream.on('data', () => { stream.pause(); setTimeout(() => stream.resume(), pause) })
      }
      stream.pipe(response)
      request.on('close', () => stream.destroy())
    })
    await new Promise<void>((started) => this.server?.listen(PORT, '127.0.0.1', started))
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server !== undefined) await new Promise<void>((stopped) => { server.closeAllConnections(); server.close(() => stopped()) })
  }
}

const host = new ChannelHost()

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

async function openDesign(path: string, name: string): Promise<void> {
  answerNextDialog(path)
  if (await openDesignButton().isDisplayed()) await openDesignButton().click()
  else await browser.keys(['Control', 'o'])
  await waitForOpenDesign(name)
}

/** About's updates block. */
function updates(): ReturnType<typeof $> {
  return $('[data-about-updates]')
}

/** Opens About from Settings, as a user does. */
async function openAbout(): Promise<void> {
  await browser.keys(['Control', ','])
  await $('[data-settings-section="about"]').click()
  await $('button=About Canopi…').click()
  await updates().waitForDisplayed()
}

async function closeAbout(): Promise<void> {
  await browser.keys('Escape')
  await updates().waitForDisplayed({ reverse: true })
}

async function waitForStatus(text: string | RegExp, timeout = 60_000): Promise<void> {
  await browser.waitUntil(async () => {
    const status = await updates().$('[role="status"]').getText()
    return typeof text === 'string' ? status.includes(text) : text.test(status)
  }, { timeout, timeoutMsg: `About never said ${String(text)}` })
}

async function press(label: string, timeout = 60_000): Promise<void> {
  const button = updates().$(`button=${label}`)
  await button.waitForDisplayed({ timeout })
  await browser.waitUntil(async () => await button.getAttribute('aria-disabled') !== 'true', { timeout })
  await button.click()
}

/** The command lines of the running Canopi processes, to see what the update's relaunch was given. */
function canopiCommandLines(): string[] {
  if (currentPlatform() === 'windows') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='Canopi.exe'\" | ForEach-Object { $_.CommandLine }"
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/u).filter(Boolean)
  }
  return execFileSync('pgrep', ['-a', '-f', 'canopi'], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

async function windowGone(): Promise<boolean> {
  try {
    await browser.getTitle()
    return false
  } catch {
    return true
  }
}

describe('the updater, from an installed N-1 to N', () => {
  let current = ''

  before(async () => {
    if (CHANNELS === '' || BUNDLE === '') throw new Error('UPDATER_E2E_DIR and UPDATER_E2E_BUNDLE name the lane\'s channel files and installer')
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  after(async () => { await host.stop() })

  it('offline update check settles network.offline and About shows it', async () => {
    await host.stop()
    await openAbout()
    await press('Check for updates')
    await waitForStatus('Can’t check for updates while offline')
    await closeAbout()
  })

  it('cancelled update download leaves nothing staged and settles cancelled', async () => {
    host.channel = 'good.json'
    host.throttle = 64 * 1024
    await host.start()
    await openAbout()
    await press('Check for updates')
    await waitForStatus(/Canopi \S+ is available/u)
    await press('Download and install')
    await press('Cancel')
    // Cancelled is no failure: About offers the same download again and says nothing went wrong.
    await updates().$('button=Download and install').waitForDisplayed()
    await expect(updates().$('[role="status"]')).not.toHaveText(/Update not installed/u)
    await expect(updates().$('button=Install and restart')).not.toBeExisting()
    host.throttle = undefined
    await closeAbout()
  })

  it('refuses a tampered payload (2.1-M55)', async () => {
    host.channel = 'tampered.json'
    await openAbout()
    await press('Check for updates')
    await press('Download and install')
    await waitForStatus('Update not installed: the download could not be verified')
    await closeAbout()
  })

  it('refuses an old validly signed payload announced as newer (2.1-M64)', async () => {
    host.channel = 'old.json'
    await openAbout()
    await press('Check for updates')
    await press('Download and install')
    await waitForStatus('Update not installed: the download could not be verified')
    await closeAbout()
  })

  it('offers the download link for an AppImage in a folder Canopi cannot change', async function () {
    const appimage = process.env.UPDATER_E2E_APPIMAGE ?? ''
    if (BUNDLE !== 'appimage') this.skip()
    host.channel = 'good.json'
    const folder = dirname(appimage)
    chmodSync(folder, 0o555)
    try {
      await openAbout()
      await press('Check for updates')
      await updates().$('a=Download the update from projectcanopi.com').waitForDisplayed({ timeout: 60_000 })
      await closeAbout()
    } finally {
      chmodSync(folder, 0o755)
    }
  })

  // A polkit rule can only refuse (pkexec exit 127); a dismissed prompt (exit 126) needs an authentication agent's
  // dialog, so the dismissed reason is held by host/updater/install/tests.rs (126 and 127) and updater-flow.test.ts.
  it('keeps the Design open when permission for the .deb install is refused', async function () {
    if (BUNDLE !== 'deb') this.skip()
    host.channel = 'good.json'
    const garden = designFile('Prompt garden')
    await openDesign(garden, 'Prompt garden')
    // The lane's polkit rule answers no while this file exists.
    execFileSync('sudo', ['touch', '/run/canopi-updater-e2e-deny'])
    try {
      await openAbout()
      await press('Check for updates')
      await press('Download and install')
      await press('Install and restart')
      await waitForStatus('Update not installed: permission was refused')
      await closeAbout()
      await waitForOpenDesign('Prompt garden')
    } finally {
      execFileSync('sudo', ['rm', '-f', '/run/canopi-updater-e2e-deny'])
    }
    current = garden
  })

  it('update install during an unsaved edit keeps the edit', async () => {
    host.channel = 'good.json'
    // Launched with A, switched to B: the relaunch must reopen B (plan:194).
    const first = designFile('First garden')
    const second = designFile('Second garden')
    if (current === '') await openDesign(first, 'First garden')
    await openDesign(second, 'Second garden')
    await openAbout()
    await press('Check for updates')
    await press('Download and install')
    await updates().$('button=Install and restart').waitForDisplayed({ timeout: 120_000 })
    await closeAbout()

    await renameOpenDesign('Second garden', 'Updated garden')
    await openAbout()
    await press('Install and restart')
    // Continuous save may write the edit 1.5 s after it; either way the file the relaunch opens must hold it. The
    // installer's own close is the Restart Manager test in the workflow (WM_ENDSESSION, 2.1-M82).
    await browser.waitUntil(windowGone, { timeout: 180_000, timeoutMsg: 'the app did not restart into the update' })
    expect(savedName(second)).toBe('Updated garden')
    current = second
  })

  it('restarts into N as the primary instance with the current Design', async () => {
    await browser.waitUntil(() => canopiCommandLines().some((line) => line.includes(current)), {
      timeout: 120_000,
      timeoutMsg: `no relaunched Canopi named ${current}`,
    })
    // A relaunch that only forwarded to a lingering instance would exit; the primary stays.
    await new Promise((settle) => setTimeout(settle, 5_000))
    expect(canopiCommandLines().filter((line) => line.includes(current))).toHaveLength(1)
  })
})
