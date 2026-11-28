// Single instance (canopi-f47t.52.228.14; 2.1-M60, M80, M85, M214, Q145, Q166, Q228; plan Phase 0 failure row
// 'Single instance'): a second launch of the e2e build hands its Design file to the running Canopi, which comes to
// the front and opens it through the replacement guard. CI covers X11 (Xvfb with openbox) and Windows. GNOME on
// Wayland refusing to raise the window is a known limitation, not a bug (2.1-Q229): the app still asks for attention.
//
// The specs share one app session and run in order. Each Design file lives in the session's profile; the names are
// what the title bar shows once a file opens.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { currentAppPid, currentPlatform, currentProfile, designFile, launchSecondProcess, renameOpenDesign, savedName, separateProfile, waitForOpenDesign } from '../support/app'

/** The e2e build's single-instance D-Bus name: its identifier plus the plugin's suffix. */
const DBUS_NAME = 'com.canopi.e2e.SingleInstance'
/** The plugin's wait on Windows for the first instance to take the arguments (2.5.4), plus the process start. */
const WINDOWS_FORWARD_LIMIT_MS = 10_000 + 5_000

async function documentHasFocus(): Promise<boolean> {
  return browser.execute(() => document.hasFocus())
}

/** The attached app's top-level window on Windows, as user32 reports it. */
interface NativeWindow {
  readonly handle: number
  readonly iconic: boolean
  readonly foreground: boolean
}

/**
 * Runs `body` in PowerShell with user32's window calls loaded and `$h` bound to `handle`, or to the attached app's
 * main window (found by its process id) when none is given; the script answers that window's state as JSON. Encoded,
 * so no quote meets Windows command-line quoting.
 */
function nativeWindow(body: string, handle?: number): NativeWindow {
  const script = [
    "Add-Type -Namespace Canopi -Name Window -MemberDefinition '"
      + '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); '
      + '[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); '
      + '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); '
      + '[DllImport("user32.dll")] public static extern System.IntPtr GetShellWindow(); '
      + '[DllImport("user32.dll")] public static extern System.IntPtr GetDesktopWindow(); '
      + "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);'",
    handle === undefined
      ? `$h = (Get-Process -Id ${currentAppPid()} -ErrorAction Stop).MainWindowHandle`
      : `$h = [System.IntPtr]::new(${handle})`,
    `if ($h -eq [System.IntPtr]::Zero) { throw 'the attached app (pid ${currentAppPid()}) has no main window' }`,
    body,
    '@{ handle = $h.ToInt64(); iconic = [Canopi.Window]::IsIconic($h); foreground = ([Canopi.Window]::GetForegroundWindow() -eq $h) } | ConvertTo-Json -Compress',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const reply = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 60_000 })
  return JSON.parse(reply.trim()) as NativeWindow
}

/**
 * Spawns a real top-level Win32 window on headless Windows runners (where no shell window can take foreground)
 * and uses AttachThreadInput + SetForegroundWindow so the minimised Canopi window genuinely loses foreground
 * until the second launch reclaims it. The caller must kill the returned process in a finally block.
 */
function spawnWindowsFocusHolder(): ChildProcess {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -Namespace Canopi -Name Focus -MemberDefinition '"
      + '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); '
      + '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr pid); '
      + '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); '
      + '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach); '
      + '[DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h); '
      + '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); '
      + "[DllImport(\"user32.dll\")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);'",
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = 'CanopiFocusHolder'; $f.Width = 200; $f.Height = 100; $f.TopMost = $false",
    "$f.StartPosition = 'Manual'; $f.Left = 0; $f.Top = 0",
    '$f.Show()',
    '$fg = [Canopi.Focus]::GetForegroundWindow()',
    '$fgTid = [Canopi.Focus]::GetWindowThreadProcessId($fg, [System.IntPtr]::Zero)',
    '$myTid = [Canopi.Focus]::GetCurrentThreadId()',
    'if ($fgTid -ne 0 -and $fgTid -ne $myTid) { [void][Canopi.Focus]::AttachThreadInput($myTid, $fgTid, $true) }',
    '[void][Canopi.Focus]::BringWindowToTop($f.Handle)',
    '[void][Canopi.Focus]::SetForegroundWindow($f.Handle)',
    'if ($fgTid -ne 0 -and $fgTid -ne $myTid) { [void][Canopi.Focus]::AttachThreadInput($myTid, $fgTid, $false) }',
    '[void][Canopi.Focus]::AllowSetForegroundWindow([uint32]::MaxValue)',
    '[System.Windows.Forms.Application]::Run($f)',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
    stdio: 'ignore',
    windowsHide: false,
  })
}

/**
 * Minimises the app's window from outside it, as a user switching away would, and fails unless it really is
 * minimised. Returns the window's handle and optional focus-holder cleanup on Windows, for the native focus checks.
 */
async function minimiseAppWindow(): Promise<{ readonly handle?: number; readonly release: () => void }> {
  if (currentPlatform() === 'linux') {
    execFileSync('xdotool', ['search', '--sync', '--onlyvisible', '--name', '^Canopi$', 'windowminimize', '%@'])
    return { release: () => {} }
  }
  const window = nativeWindow(
    '[void][Canopi.Window]::ShowWindow($h, 6); '
    + 'if ([Canopi.Window]::GetForegroundWindow() -eq $h) { '
    + '$other = [Canopi.Window]::GetShellWindow(); '
    + 'if ($other -eq [System.IntPtr]::Zero) { $other = [Canopi.Window]::GetDesktopWindow() }; '
    + 'if ($other -ne [System.IntPtr]::Zero) { [void][Canopi.Window]::SetForegroundWindow($other) } '
    + '}; Start-Sleep -Milliseconds 250',
  )
  if (!window.iconic) throw new Error(`the app's window ${window.handle} is not minimised after SW_MINIMIZE`)
  if (!window.foreground) return { handle: window.handle, release: () => {} }
  const holder = spawnWindowsFocusHolder()
  const release = () => {
    try {
      holder.kill()
    } catch {
      // reason: focus holder already exited.
    }
  }
  await browser.waitUntil(() => !nativeWindow('', window.handle).foreground, { timeout: 10_000 }).catch(() => {
    // reason: line 114 reports the exact foreground failure if the holder could not take focus.
  })
  return { handle: window.handle, release }
}

/** Suspends or resumes the attached app's process on Windows (ntdll, as Process Explorer does). */
function setAppSuspended(suspended: boolean): void {
  const call = suspended ? 'NtSuspendProcess' : 'NtResumeProcess'
  execFileSync('powershell', ['-NoProfile', '-Command', [
    `Add-Type -Namespace Canopi -Name Process -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int ${call}(System.IntPtr h);'`,
    `[void][Canopi.Process]::${call}((Get-Process -Id ${currentAppPid()} -ErrorAction Stop).Handle)`,
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
    const { handle, release } = await minimiseAppWindow()
    try {
      // The page's focus is what the user sees on X11. WebView2 may keep reporting focus for a window minimised from
      // outside (it follows its controller, F5 probe 3), so on Windows the check falls back to the native foreground
      // window: the minimised window must not be in front, and must come back to the front.
      const pageBlurred = await browser.waitUntil(async () => !(await documentHasFocus()), { timeout: 10_000 }).catch(() => false)
      const nativeTookFocus = (winHandle: number): boolean => {
        const window = nativeWindow('', winHandle)
        return window.foreground && !window.iconic
      }
      let tookFocus: () => Promise<boolean> = handle === undefined
        ? documentHasFocus
        : async () => (await documentHasFocus()) || nativeTookFocus(handle)
      if (!pageBlurred) {
        if (handle === undefined) throw new Error('the minimised window still has focus, so the focus check would prove nothing')
        if (nativeWindow('', handle).foreground) {
          throw new Error('the minimised window is still the foreground window, so the focus check would prove nothing')
        }
        tookFocus = async () => nativeTookFocus(handle)
      }

      const second = await launchSecondProcess([basename(garden)], dirname(garden))

      expect(second.exit).toBe(0)
      await waitForOpenDesign('Launched garden')
      await browser.waitUntil(tookFocus, {
        timeout: 10_000,
        timeoutMsg: `the window did not take focus${pageBlurred ? '' : ' (native foreground window, Windows)'}`,
      })
    } finally {
      release()
    }
  })

  // Runs on the Design the previous spec opened: when that one fails, this one fails to find 'Launched garden'.
  it('flushes an unsaved edit before the next file replaces the Design (2.1-Q166)', async () => {
    const garden = join(currentProfile(), 'designs', 'Launched garden.canopi')
    await renameOpenDesign('Launched garden', 'Renamed garden')
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
    await expect($('[data-notice-key="launch.multi-open"]')).not.toBeExisting()
  })

  it('with several files opens the first and says Canopi opens one Design at a time (2.1-Q228)', async () => {
    const first = designFile('First pick')
    const second = designFile('Second pick')

    const launch = await launchSecondProcess([first, second], currentProfile())

    expect(launch.exit).toBe(0)
    await waitForOpenDesign('First pick')
    const notice = $('[data-notice-key="launch.multi-open"]')
    await expect(notice).toBeDisplayed()
    await expect(notice).toHaveText(expect.stringContaining('Canopi opens one Design at a time'))
    const focusInNotice = await browser.execute(() => document.activeElement?.closest('[data-notice-key="launch.multi-open"]') !== null)
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

