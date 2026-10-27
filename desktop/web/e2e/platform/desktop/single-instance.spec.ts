// Single instance (canopi-f47t.52.228.14; 2.1-M60, M80, M85, M214, Q145, Q166, Q228; plan Phase 0 failure row
// 'Single instance'): a second launch of the e2e build hands its Design file to the running Canopi, which comes to
// the front and opens it through the replacement guard. CI covers X11 (Xvfb with openbox) and Windows. GNOME on
// Wayland refusing to raise the window is a known limitation, not a bug (2.1-Q229): the app still asks for attention.
//
// The specs share one app session and run in order. Each Design file lives in the session's profile; the names are
// what the title bar shows once a file opens.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { currentPlatform, currentProfile, launchSecondProcess, separateProfile } from '../support/app'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/canvas-base.canopi')
/** The e2e build's single-instance D-Bus name: its identifier plus the plugin's suffix. */
const DBUS_NAME = 'com.canopi.e2e.SingleInstance'
/** The plugin's wait on Windows for the first instance to take the arguments (2.5.4), plus the process start. */
const WINDOWS_FORWARD_LIMIT_MS = 10_000 + 5_000

/** Writes a Design called `name` into the session's profile; returns its absolute path. */
function designFile(name: string, fileName = `${name}.canopi`): string {
  const design = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
  const path = join(currentProfile(), 'designs', fileName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...design, name }, null, 2))
  return path
}

function savedName(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }).name
}

/** The title bar's name button once the Design called `name` is open. */
async function waitForOpenDesign(name: string): Promise<void> {
  await $(`button[aria-label="Rename Design: ${name}"]`).waitForDisplayed({ timeout: 30_000 })
}

async function documentHasFocus(): Promise<boolean> {
  return browser.execute(() => document.hasFocus())
}

/** Minimises the app's window from outside it, as a user switching away would. */
function minimiseAppWindow(): void {
  if (currentPlatform() === 'linux') {
    execFileSync('xdotool', ['search', '--sync', '--onlyvisible', '--name', '^Canopi$', 'windowminimize', '%@'])
    return
  }
  execFileSync('powershell', ['-NoProfile', '-Command', [
    "Add-Type -Namespace Canopi -Name Window -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int c);'",
    'Get-Process canopi-desktop | Where-Object MainWindowHandle -ne 0 | ForEach-Object { [void][Canopi.Window]::ShowWindow($_.MainWindowHandle, 6) }',
  ].join('; ')])
}

/** Suspends or resumes the running app's process on Windows (ntdll, as Process Explorer does). */
function setAppSuspended(suspended: boolean): void {
  const call = suspended ? 'NtSuspendProcess' : 'NtResumeProcess'
  execFileSync('powershell', ['-NoProfile', '-Command', [
    `Add-Type -Namespace Canopi -Name Process -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int ${call}(System.IntPtr h);'`,
    `Get-Process canopi-desktop | ForEach-Object { [void][Canopi.Process]::${call}($_.Handle) }`,
  ].join('; ')])
}

/** The unique bus name owning the single-instance name, or null while no instance holds it (Linux). */
function singleInstanceOwner(): string | null {
  try {
    const reply = execFileSync('dbus-send', [
      '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.GetNameOwner', `string:${DBUS_NAME}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return /string "([^"]+)"/.exec(reply)?.[1] ?? null
  } catch {
    return null
  }
}

describe('a second launch while Canopi runs', () => {
  before(async () => {
    await $('[data-start-screen]').waitForDisplayed({ timeout: 90_000 })
  })

  it('focuses the existing window and opens the file, a relative path resolved against its folder (2.1-M60)', async () => {
    const garden = designFile('Launched garden')
    minimiseAppWindow()
    await browser.waitUntil(async () => !(await documentHasFocus()), {
      timeout: 10_000,
      timeoutMsg: 'the minimised window still has focus, so the focus check would prove nothing',
    })

    const second = await launchSecondProcess([basename(garden)], dirname(garden))

    expect(second.exit).toBe(0)
    await waitForOpenDesign('Launched garden')
    await browser.waitUntil(documentHasFocus, { timeout: 10_000, timeoutMsg: 'the window did not take focus' })
  })

  it('flushes an unsaved edit before the next file replaces the Design (2.1-Q166)', async () => {
    const garden = join(currentProfile(), 'designs', 'Launched garden.canopi')
    await $('button[aria-label="Rename Design: Launched garden"]').click()
    const nameInput = $('input[aria-label="Design name"]')
    await nameInput.waitForDisplayed()
    await nameInput.setValue('Renamed garden')
    await browser.keys('Enter')
    await waitForOpenDesign('Renamed garden')
    const orchard = designFile('Orchard')

    const second = await launchSecondProcess([orchard], currentProfile())

    expect(second.exit).toBe(0)
    await waitForOpenDesign('Orchard')
    expect(savedName(garden)).toBe('Renamed garden')
  })

  it('keeps a | inside an argument intact (2.1-M80)', async () => {
    // With the plugin's legacy `|` separator the flag would split and `south` would open as the first file.
    const meadow = designFile('Meadow')

    const second = await launchSecondProcess(['--pinned=north|south', meadow], currentProfile())

    expect(second.exit).toBe(0)
    await waitForOpenDesign('Meadow')
    await expect($('[data-multi-open-notice]')).not.toBeExisting()
  })

  it('with several files opens the first and says Canopi opens one Design at a time (2.1-Q228)', async () => {
    const first = designFile('First pick')
    const second = designFile('Second pick')

    const launch = await launchSecondProcess([first, second], currentProfile())

    expect(launch.exit).toBe(0)
    await waitForOpenDesign('First pick')
    const notice = $('[data-multi-open-notice]')
    await expect(notice).toBeDisplayed()
    await expect(notice).toHaveText(expect.stringContaining('Canopi opens one Design at a time'))
    const focusInNotice = await browser.execute(() => document.activeElement?.closest('[data-multi-open-notice]') !== null)
    expect(focusInNotice).toBe(false)
  })

  it('on Linux with no session bus starts a second instance (2.5 falls back with a warning; 2.1-M80)', async function () {
    if (currentPlatform() !== 'linux') this.skip()
    const elsewhere = separateProfile()

    const second = await launchSecondProcess([], currentProfile(), {
      profile: elsewhere,
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/canopi-e2e-bus' },
      timeoutMs: 8_000,
    })

    expect(second.exit).toBe('still running')
  })

  it('on Windows exits within the 10 s wait when the running Canopi does not answer (2.1-M80)', async function () {
    if (currentPlatform() !== 'windows') this.skip()
    const garden = designFile('Unanswered')
    setAppSuspended(true)
    let elapsed: number
    let second: Awaited<ReturnType<typeof launchSecondProcess>>
    try {
      const started = Date.now()
      second = await launchSecondProcess([garden], currentProfile(), { timeoutMs: 30_000 })
      elapsed = Date.now() - started
    } finally {
      setAppSuspended(false)
    }

    expect(second.exit).not.toBe('still running')
    expect(elapsed).toBeLessThan(WINDOWS_FORWARD_LIMIT_MS)
  })

  // Linux only: tauri-driver relaunches the app for a new session there; on Windows the harness launched the app the
  // session attaches to, so a new session does not boot it again.
  it('during boot leaves the file for the start screen to open (2.1-M214)', async function () {
    if (currentPlatform() !== 'linux') this.skip()
    const boot = designFile('Opened at boot')
    const previousOwner = singleInstanceOwner()

    const reloading = browser.reloadSession()
    let owner: string | null = null
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      owner = singleInstanceOwner()
      if (owner && owner !== previousOwner) break
      await new Promise((wake) => setTimeout(wake, 20))
    }
    expect(owner).not.toBe(previousOwner)
    const second = await launchSecondProcess([boot], currentProfile())
    await reloading

    expect(second.exit).toBe(0)
    await waitForOpenDesign('Opened at boot')
  })
})

