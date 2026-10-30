// The updater end to end (plan Phase 0 F6, plan:186-196; 2.1-M55, M64, M82, Q234): an installed N-1 updater-e2e build,
// whose channel endpoint is compiled in as http://127.0.0.1:<UPDATER_E2E_PORT>/channel.json, checks, downloads and
// installs N from the channel files .github/workflows/updater-e2e.yml prepared in UPDATER_E2E_DIR, which this spec
// serves itself so each test chooses what the channel says and whether the host answers at all.
//
// UPDATER_E2E_DIR holds good.json (N, signed with the job's ephemeral key), tampered.json (N's entries pointing at a
// copy with flipped bytes), old.json (N-1's payload and signature announced as N+1), on NSIS failing.json (a signed
// installer that exits with an error, announced as 9.0.2) and the payloads. UPDATER_E2E_BUNDLE names the installer
// under test (appimage, deb or nsis); UPDATER_E2E_APPIMAGE is the AppImage's path on that lane. On NSIS,
// UPDATER_E2E_N1_SETUP is N-1's installer and UPDATER_E2E_STABLE_SETUP the published 2.0.3 installer.
//
// Not in the wdio config's specs: only the updater lane runs it, with --spec, against an installed bundle. The tests
// run in order, every check before the one update install, which ends the session. A test that leaves Canopi closed, or
// in a state a later test cannot start from, starts it again on the same profile in a new session (`relaunch`).
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { answerNextDialog, appFolders, currentPlatform, currentProfile, designFile, launchForAttach, openDesignButton, renameOpenDesign, savedName, waitForOpenDesign } from './support/app'
import { logOutput } from './support/process-log'

const PORT = Number(process.env.UPDATER_E2E_PORT ?? '47811')
const CHANNELS = process.env.UPDATER_E2E_DIR ?? ''
const BUNDLE = process.env.UPDATER_E2E_BUNDLE ?? ''
const N1_SETUP = process.env.UPDATER_E2E_N1_SETUP ?? ''
const STABLE_SETUP = process.env.UPDATER_E2E_STABLE_SETUP ?? ''

type Channel = 'good.json' | 'tampered.json' | 'old.json' | 'failing.json'

/**
 * The local channel host: `/channel.json` answers with the chosen channel file, anything else from UPDATER_E2E_DIR.
 * Each request is logged with the bytes sent to `channel-host.log` in the session profile, which the lane uploads
 * when it fails, so a run shows what the app asked for and got.
 */
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
        logRequest(`${String(request.url)} -> 404`)
        response.writeHead(404).end()
        return
      }
      const size = statSync(path).size
      response.writeHead(200, { 'content-length': size })
      let sent = 0
      response.on('close', () => logRequest(`${String(request.url)} -> ${name}: ${sent} of ${size} bytes${response.writableFinished ? '' : ' (closed early)'}`))
      const stream = createReadStream(path, this.throttle === undefined ? {} : { highWaterMark: 4096 })
      stream.on('data', (chunk) => { sent += chunk.length })
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

/** Appends one line to the session profile's `channel-host.log`. */
function logRequest(line: string): void {
  appendFileSync(join(currentProfile(), 'channel-host.log'), `${new Date().toISOString()} ${line}\n`)
}

const host = new ChannelHost()

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

/**
 * Presses About's Check for updates unless the launch check already found the update: a relaunch with the channel up
 * runs "Check for updates at launch" (on by default, 2.1-Q164), and About then offers Download and install at once, as
 * a user who saw the launch notice finds it.
 */
async function checkUnlessFound(timeout = 60_000): Promise<void> {
  const check = updates().$('button=Check for updates')
  const download = updates().$('button=Download and install')
  await browser.waitUntil(async () => await download.isDisplayed()
    || (await check.isDisplayed() && await check.getAttribute('aria-disabled') !== 'true'), {
    timeout, timeoutMsg: 'About offered neither Check for updates nor Download and install',
  })
  if (!(await download.isDisplayed())) await check.click()
}

/** The command lines of the running Canopi processes, to see what the update's relaunch was given. */
function canopiCommandLines(): string[] {
  if (currentPlatform() === 'windows') {
    // The installed exe's own name: Tauri names it after the cargo binary (canopi-desktop.exe), not the product.
    const name = basename(process.env.CANOPI_E2E_APP ?? '')
    const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $_.CommandLine }`
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/u).filter(Boolean)
  }
  // By the process name (14 characters, under pgrep's 15): a full command-line match would also find every runner
  // process under /home/runner/work/canopi. pgrep exits 1 when nothing matches.
  try {
    return execFileSync('pgrep', ['-a', 'canopi-desktop'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
}

/** What good.json announces: N's version and, per installer key, its payload's URL. */
function announcedN(): { version: string, platforms: Record<string, { url: string }> } {
  return JSON.parse(readFileSync(join(CHANNELS, 'good.json'), 'utf8')) as { version: string, platforms: Record<string, { url: string }> }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The version now installed, read from what the install left (dpkg's record, the executable's version resource, the
 * AppImage's bytes), never from the relaunch, which an unchanged N-1 would pass too.
 */
function installedVersion(): string {
  const app = process.env.CANOPI_E2E_APP ?? ''
  if (BUNDLE === 'deb') {
    const owner = execFileSync('dpkg', ['-S', app], { encoding: 'utf8' }).split(':')[0] ?? ''
    return execFileSync('dpkg-query', ['-W', '-f=${Version}', owner], { encoding: 'utf8' }).trim()
  }
  if (BUNDLE === 'nsis') {
    const script = `(Get-Item -LiteralPath '${app}').VersionInfo.ProductVersion`
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
      .trim().replace(/^(\d+\.\d+\.\d+)\.0$/u, '$1')
  }
  const n = announcedN()
  const payload = join(CHANNELS, (n.platforms['linux-x86_64-appimage']?.url ?? '').split('/').pop() ?? '')
  const appimage = process.env.UPDATER_E2E_APPIMAGE ?? ''
  return sha256(appimage) === sha256(payload) ? n.version : `not N's AppImage (${sha256(appimage)})`
}

async function windowGone(): Promise<boolean> {
  try {
    await browser.getTitle()
    return false
  } catch {
    return true
  }
}

/** Waits until Canopi's window is gone, after something other than the session closed it. */
async function waitForExit(what: string, timeout = 180_000): Promise<void> {
  await browser.waitUntil(windowGone, { timeout, timeoutMsg: `Canopi did not close: ${what}` })
}

/**
 * Starts the installed Canopi again on the session's profile in a new session, as a user starting it after it closed.
 * On Linux tauri-driver closes a running Canopi and launches it for the new session; on Windows the harness launches
 * it and the new session attaches (the harness's own launch is the first session's; this is every later one's).
 */
async function relaunch(): Promise<void> {
  if (currentPlatform() === 'linux') {
    await browser.reloadSession()
  } else {
    const app = await launchForAttach(currentProfile())
    await browser.reloadSession({ ...browser.requestedCapabilities, 'ms:edgeOptions': { debuggerAddress: app.debuggerAddress } })
  }
  await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
}

/** Runs a Windows installer silently, as a user running a download by hand; it closes a running Canopi first. */
function runInstaller(setup: string): void {
  console.log(`running ${setup} /S`)
  execFileSync(setup, ['/S'], { stdio: 'inherit', timeout: 300_000 })
}

/** The files of a SQLite store (the database, its WAL and shared memory) named `name` under `folder`, a few levels deep. */
function storeFiles(folder: string, name: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return storeFiles(path, name, depth - 1)
    return entry.name === name || entry.name.startsWith(`${name}-`) ? [path] : []
  })
}

/** Replaces the store files in `to` with those of `from` (a WAL left beside a replaced database would be replayed). */
function moveStore(from: readonly string[], to: string): void {
  mkdirSync(to, { recursive: true })
  for (const stale of readdirSync(to).filter((name) => name.startsWith('user.db'))) rmSync(join(to, stale))
  for (const file of from) copyFileSync(file, join(to, basename(file)))
}

/**
 * Runs the installed Canopi (2.0.3 by then) on its own folders long enough to start and read its settings, failing
 * when it exits first; then stops it, as the next installer would. An idle 2.0.3 never writes a valid settings record,
 * so a 2.0.3 whole-record write is checked in the desktop crate instead
 * (a_2_0_3_whole_settings_record_write_leaves_the_launch_check_row).
 */
async function runInstalledFor(ms: number): Promise<void> {
  const child = spawn(process.env.CANOPI_E2E_APP ?? '', [], { stdio: ['ignore', 'pipe', 'pipe'] })
  logOutput(child, join(currentProfile(), 'stable-2.0.3.log'))
  const exited = new Promise<number | string | null>((settle) => {
    child.once('exit', (code, signal) => settle(code ?? signal))
    child.once('error', (error) => settle(error.message))
  })
  const outcome = await Promise.race([exited, new Promise<'running'>((settle) => setTimeout(() => settle('running'), ms))])
  if (outcome !== 'running') throw new Error(`the installed Canopi exited (${String(outcome)}) before it settled`)
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  await exited
}

/** Settings › About's "Check for updates at launch" switch, opened as a user does. */
async function launchCheckSwitch(): Promise<ReturnType<typeof $>> {
  await browser.keys(['Control', ','])
  await $('[data-settings-section="about"]').click()
  const toggle = $('[data-launch-check] input[role="switch"]')
  await toggle.waitForExist({ timeout: 30_000 })
  return toggle
}

describe('the updater, from an installed N-1 to N', () => {
  let current = ''

  before(async () => {
    if (CHANNELS === '' || BUNDLE === '') throw new Error('UPDATER_E2E_DIR and UPDATER_E2E_BUNDLE name the lane\'s channel files and installer')
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  after(async () => { await host.stop() })

  // A failed test leaves what the window showed and About's updates text in the profile, then closes every open dialog,
  // so the next test starts from the main window instead of failing on the overlay the failed one left.
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed' || await windowGone()) return
    const name = (this.currentTest.title.replace(/[^a-z0-9]+/giu, '-').slice(0, 60))
    await browser.saveScreenshot(join(currentProfile(), `failed-${name}.png`))
    const about = await updates().isExisting() ? await updates().getText() : '(About was not open)'
    writeFileSync(join(currentProfile(), `failed-${name}.about.txt`), about)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const open = await $$('[role="dialog"]').filter((dialog) => dialog.isDisplayed())
      if (open.length === 0) return
      await browser.keys('Escape')
      await browser.pause(300)
    }
  })

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
    // Cancelled is no failure: About returns to Check for updates (2.1-Q251) and says nothing went wrong.
    await updates().$('button=Check for updates').waitForDisplayed()
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

  // Canopi probes whether it can replace itself when the download starts (2.1-M210), so the link follows Download and
  // install; the link-only state lasts until Canopi restarts, so the test ends in a fresh session for the next one
  // (canopi-f47t.52.228.15).
  it('offers the download link for an AppImage in a folder Canopi cannot change', async function () {
    const appimage = process.env.UPDATER_E2E_APPIMAGE ?? ''
    if (BUNDLE !== 'appimage') this.skip()
    host.channel = 'good.json'
    const folder = dirname(appimage)
    chmodSync(folder, 0o555)
    try {
      await openAbout()
      await press('Check for updates')
      await press('Download and install')
      await updates().$('a=Download the update from projectcanopi.com').waitForDisplayed({ timeout: 60_000 })
      await closeAbout()
    } finally {
      chmodSync(folder, 0o755)
    }
    await relaunch()
    current = ''
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

  // Q234: the marker is written and the installer launched, and Canopi exits; the installer then fails, so nothing
  // relaunches it. The user starts Canopi again: still N-1, it says the update did not install.
  it('a planted failing Windows installer shows Update not installed at the next launch (2.1-Q234)', async function () {
    if (BUNDLE !== 'nsis') this.skip()
    host.channel = 'failing.json'
    await openAbout()
    await press('Check for updates')
    await waitForStatus(/Canopi 9\.0\.2 is available/u)
    await press('Download and install')
    await press('Install and restart', 120_000)
    await waitForExit('the failing installer never took over')
    host.channel = 'good.json'
    await relaunch()
    const notice = $('[data-update-failed-notice]')
    await notice.waitForDisplayed({ timeout: 30_000 })
    await expect(notice).toHaveText(/Update not installed/u)
    expect(installedVersion()).toBe('9.0.0')
    await notice.$('button=Dismiss').click()
    await notice.waitForDisplayed({ reverse: true })
    current = ''
  })

  // An installer run by hand closes a running Canopi without asking it (2.1-M82). Continuous save writes an edit 1.5 s
  // after it (CONTINUOUS_SAVE_DELAY_MS); the test waits past that, so the write has landed before the installer runs
  // and this checks that the installer's close and reinstall keep it. A write still running at the close is held by
  // the native exit handler, whose wiring the desktop crate tests (the_exit_event_waits_for_a_running_write_to_land):
  // timing cannot land the close inside a write that lasts milliseconds. An edit inside the 1.5 s is the residual
  // accepted for Phase 0.
  it('an edit continuous save has written survives an installer run by hand closing Canopi (2.1-M82)', async function () {
    if (BUNDLE !== 'nsis') this.skip()
    const garden = designFile('Installer garden')
    await openDesign(garden, 'Installer garden')
    await renameOpenDesign('Installer garden', 'Reinstalled garden')
    await new Promise((settle) => setTimeout(settle, 2_000))
    runInstaller(N1_SETUP)
    await waitForExit('N-1\'s installer, run by hand, did not close it')
    await relaunch()
    await openDesign(garden, 'Reinstalled garden')
    current = garden
  })

  // A beta user going back to 2.0.3 (no updater; its own identity's folder) and later to 2.1 keeps the launch check
  // they chose (plan:192; the key row 2.0.3 never writes, 2.1-M206). The e2e build keeps its data in the session's
  // profile, so the store is handed to 2.0.3's folder and back around 2.0.3's start; 2.0.3's whole-record settings
  // write, which an idle start never makes, is the desktop crate's settings test.
  it('the launch setting survives a 2.0.3 reinstall', async function () {
    if (BUNDLE !== 'nsis') this.skip()
    const toggle = await launchCheckSwitch()
    if (await toggle.isSelected()) await $('[data-launch-check] label').click()
    await browser.waitUntil(async () => !(await toggle.isSelected()), { timeoutMsg: 'the launch check did not turn off' })
    await browser.keys('Escape')
    // The switch shows the new value at once; its row write follows.
    await new Promise((settle) => setTimeout(settle, 2_000))

    runInstaller(STABLE_SETUP)
    await waitForExit('2.0.3\'s installer did not close it')
    expect(installedVersion()).toBe('2.0.3')
    const store = storeFiles(appFolders(currentProfile()), 'user.db')
    if (store[0] === undefined) throw new Error(`no user.db under ${appFolders(currentProfile())}`)
    const profileFolder = dirname(store[0])
    const stableFolder = join(process.env.APPDATA ?? '', 'com.canopi.app')
    moveStore(store, stableFolder)
    try {
      await runInstalledFor(20_000)
    } finally {
      // Kept with the profile, which the lane uploads when it fails.
      cpSync(stableFolder, join(currentProfile(), 'stable-2.0.3-data'), { recursive: true })
    }
    moveStore(storeFiles(stableFolder, 'user.db', 0), profileFolder)

    runInstaller(N1_SETUP)
    expect(installedVersion()).toBe('9.0.0')
    await relaunch()
    const kept = await launchCheckSwitch()
    expect(await kept.isSelected()).toBe(false)
    await browser.keys('Escape')
    current = ''
  })

  it('update install during an unsaved edit keeps the edit', async () => {
    host.channel = 'good.json'
    // Launched with A, switched to B: the relaunch must reopen B (plan:194).
    const first = designFile('First garden')
    const second = designFile('Second garden')
    if (current === '') await openDesign(first, 'First garden')
    await openDesign(second, 'Second garden')
    await openAbout()
    await checkUnlessFound()
    await press('Download and install')
    await updates().$('button=Install and restart').waitForDisplayed({ timeout: 120_000 })
    await closeAbout()

    await renameOpenDesign('Second garden', 'Updated garden')
    await openAbout()
    await press('Install and restart')
    // Continuous save may write the edit 1.5 s after it; either way the file the relaunch opens must hold it: the
    // update path flushes before the installer starts. An installer run by hand has its own test above.
    await browser.waitUntil(windowGone, { timeout: 180_000, timeoutMsg: 'the app did not restart into the update' })
    expect(savedName(second)).toBe('Updated garden')
    current = second
  })

  it('restarts into N as the primary instance with the current Design', async () => {
    // Every command line includes '': without the update test's Design this check would pass on any process.
    if (current === '') throw new Error('no current Design: the update install test did not reach the restart')
    await browser.waitUntil(() => canopiCommandLines().some((line) => line.includes(current)), {
      timeout: 120_000,
      timeoutMsg: `no relaunched Canopi named ${current}`,
    })
    // A relaunch that only forwarded to a lingering instance would exit; the primary stays.
    await new Promise((settle) => setTimeout(settle, 5_000))
    expect(canopiCommandLines().filter((line) => line.includes(current))).toHaveLength(1)
    // And it is N: a relaunch of an N-1 the install left in place would pass every check above.
    expect(installedVersion()).toBe(announcedN().version)
  })
})
