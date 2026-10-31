// What the updater end to end (updater.spec.ts) needs to see the update's relaunch: the running Canopi processes with
// their argv as the process itself reads it, the session profile handed to a relaunch the installer starts outside the
// harness's environment, and what to report when no relaunch shows up (CI triage round 4, canopi-f47t.52.228.15).
//
// Windows: the elevated runner's NSIS installer relaunches through nsis_tauri_utils' RunAsUser, which takes the desktop
// user's token and an environment built fresh from the user's profile, so the e2e build would start without
// CANOPI_E2E_PROFILE and refuse to run. The harness writes the session's profile variables to HKCU\Environment, which
// that environment block reads, just before the install, and removes them when the spec ends. The argv of a process is
// its command line split by Windows' own CommandLineToArgvW, never a substring match: a split path still holds the
// whole path as a substring (canopi-f47t.52.228.53).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appFolders, currentPlatform, profileEnvironment } from './app'

/** A running process: its id, its executable's name and its argv, the program first. */
export interface RunningProcess {
  pid: number
  name: string
  argv: string[]
  /** Windows: the logon session it runs in; the desktop user's explorer.exe shows RunAsUser's token source. */
  session?: number
  parent?: number
}

const HANDED = ['CANOPI_E2E_PROFILE', 'CANOPI_E2E_DIALOGS'] as const
let handed = false

/** Runs a PowerShell script, encoded so no quote in it meets Windows command-line quoting. */
function powershell(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' })
}

/** The Win32 processes `filter` (a WQL condition) selects, each command line split by CommandLineToArgvW. */
function windowsProcesses(filter: string): RunningProcess[] {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace CanopiE2e -Name Argv -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string line, out int count); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);'
function Split-CommandLine([string] $line) {
  if (-not $line) { return ,@() }
  $count = 0
  $argv = [CanopiE2e.Argv]::CommandLineToArgvW($line, [ref] $count)
  if ($argv -eq [IntPtr]::Zero) { return ,@() }
  try {
    return ,@(0..($count - 1) | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($argv, $_ * [IntPtr]::Size)) })
  } finally { [void] [CanopiE2e.Argv]::LocalFree($argv) }
}
$rows = @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object {
  [pscustomobject] @{ pid = [int] $_.ProcessId; name = $_.Name; argv = (Split-CommandLine $_.CommandLine); session = [int] $_.SessionId; parent = [int] $_.ParentProcessId }
})
ConvertTo-Json -InputObject $rows -Depth 4 -Compress`
  const text = powershell(script).trim()
  if (text === '') return []
  const parsed = JSON.parse(text) as unknown
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { pid: number, name: string, argv: unknown, session: number, parent: number }[]
  return rows.map((row) => ({
    pid: row.pid,
    name: row.name,
    argv: Array.isArray(row.argv) ? row.argv.map(String) : row.argv == null ? [] : [String(row.argv)],
    session: row.session,
    parent: row.parent,
  }))
}

/** The Linux processes named `name` (pgrep's process name), each argv read from /proc/<pid>/cmdline. */
function linuxProcesses(name: string): RunningProcess[] {
  let pids: string[]
  try {
    pids = execFileSync('pgrep', [name], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
  return pids.flatMap((pid) => {
    const cmdline = join('/proc', pid, 'cmdline')
    let text: string
    try {
      text = readFileSync(cmdline, 'utf8')
    } catch {
      // The process exited between pgrep and the read: it is no longer running.
      return []
    }
    const argv = text.split('\0')
    if (argv.at(-1) === '') argv.pop()
    return [{ pid: Number(pid), name, argv }]
  })
}

/** The installed Canopi's name: Tauri names the exe after the cargo binary (canopi-desktop), not the product. */
function canopiName(): string {
  return currentPlatform() === 'windows' ? basename(process.env.CANOPI_E2E_APP ?? 'canopi-desktop.exe') : 'canopi-desktop'
}

/** The running Canopi processes, each with its argv. */
export function canopiProcesses(): RunningProcess[] {
  // pgrep by the process name (14 characters, under pgrep's 15): a full command-line match would also find every
  // runner process under /home/runner/work/canopi.
  return currentPlatform() === 'windows' ? windowsProcesses(`Name='${canopiName()}'`) : linuxProcesses(canopiName())
}

/**
 * Whether `running` (one of `canopiProcesses`, so its program is Canopi's exe) was started with exactly the Design
 * `path`: argv [exe, path], nothing split or added.
 */
export function relaunchedWith(running: RunningProcess, path: string): boolean {
  return running.argv.length === 2 && running.argv[1] === path
}

/** The pending-update markers left in the profile at `root`; Canopi takes its marker as it starts the update's N. */
export function pendingUpdateMarkers(root: string): string[] {
  const folder = appFolders(root)
  if (!existsSync(folder)) return []
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((path) => basename(path) === 'pending-update.json')
    .map((path) => join(folder, path))
}

/**
 * Windows: writes the profile variables of the session at `root` to HKCU\Environment, so a relaunch RunAsUser starts
 * with an environment built from the user's profile runs on the session's profile. Elsewhere the relaunch inherits
 * the app's environment, and this does nothing.
 */
export function handProfileToRelaunch(root: string): void {
  if (currentPlatform() !== 'windows') return
  const environment = profileEnvironment(root)
  handed = true
  for (const name of HANDED) {
    const value = environment[name]
    if (value === undefined) throw new Error(`the profile environment has no ${name}`)
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe' })
  }
}

/** Removes what `handProfileToRelaunch` wrote, so no later process on the machine starts on the spec's profile. */
export function withdrawProfileFromRelaunch(): void {
  if (!handed) return
  handed = false
  for (const name of HANDED) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { stdio: 'pipe' })
    } catch {
      // Not written (the add failed before it): nothing to remove.
    }
  }
}

/** One line of the report, or why it could not be read: the report must never hide the failure it explains. */
function reportLine(label: string, read: () => string): string {
  try {
    return `${label}: ${read()}`
  } catch (error) {
    return `${label}: unreadable (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * What the spec reports when no relaunched Canopi shows up: Canopi and installer processes with their argv (on
 * Windows the desktop user's explorer.exe too, with its session), the installed version, whether the profile's
 * pending-update marker is still there (N never started on this profile), and on Windows the runner's integrity level.
 */
export function relaunchReport(root: string, installedVersion: () => string): string {
  const windows = currentPlatform() === 'windows'
  const processes = () => JSON.stringify(windows
    ? windowsProcesses(`Name='${canopiName()}' OR Name LIKE '%setup%.exe' OR Name='explorer.exe'`)
    : linuxProcesses(canopiName()))
  const lines = [
    reportLine('processes', processes),
    reportLine('installed version', installedVersion),
    reportLine('pending-update.json in the profile', () => pendingUpdateMarkers(root).join(', ') || 'gone'),
  ]
  if (windows) {
    lines.push(reportLine('integrity level', () => execFileSync('whoami', ['/groups'], { encoding: 'utf8' })
      .split(/\r?\n/u).filter((line) => line.includes('Mandatory Label')).join(' | ').replace(/\s+/gu, ' ')))
  }
  return lines.join('\n')
}
