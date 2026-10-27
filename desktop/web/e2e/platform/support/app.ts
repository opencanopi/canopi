// The Desktop real-app harness (2.1-M213; ADR 0029 Platform matrix): plain WebdriverIO over tauri-driver drives the
// e2e build (`npm run build:e2e`: `--features e2e`, identifier com.canopi.e2e) with command mocking off, so every
// command, plugin and the single-instance name are the real app's. Each session gets a fresh profile of absolute
// paths under the run's temp dir, and the app never reads or writes the user's Canopi data: the e2e build puts every
// folder Tauri resolves, the WebView's data included, in the profile's `app` folder (`CANOPI_E2E_PROFILE`,
// `host::in_e2e_profile`) and refuses to start without one. Windows resolves the default folders through the shell's
// known folders, which no environment variable moves, so the app takes the profile itself on every platform.
//
// Linux: tauri-driver starts WebKitWebDriver, which launches the app from `tauri:options`. The suite runs inside
// `dbus-run-session -- xvfb-run` with a window manager (the CI lane), so the single-instance name lives on a private
// session bus; HOME and the XDG folders also point into the profile, for what WebKitGTK and GTK write outside the
// app's folders.
//
// Windows: the harness launches the app itself and msedgedriver attaches to its WebView2 through
// `ms:edgeOptions.debuggerAddress`, still behind tauri-driver. The e2e build opens WebView2's DevTools port itself
// (`host::e2e_window`, port 0, so the browser picks a free one) and the harness reads the port from the
// DevToolsActivePort file in the WebView's data folder. In launch mode msedgedriver started the app and waited for a
// DevToolsActivePort file that never appeared (F5 probe, CI run 40405302908); the likely reason is that Tauri always
// gives WebView2 its own user data folder, not the one msedgedriver reads. The port set through
// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which WebView2 appends to the app's arguments, never answered either (CI
// run 40479601190), so the app passes the switch; when the port still does not answer, the harness prints the
// WebView2 processes' command lines, their listening ports and the DevToolsActivePort files it finds before failing.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { $, browser } from '@wdio/globals'

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
const PROFILE_ROOT_VARIABLE = 'CANOPI_E2E_PROFILE_ROOT'
const APP_PID_VARIABLE = 'CANOPI_E2E_APP_PID'
const READY_TIMEOUT_MS = 60_000

export type Platform = 'linux' | 'windows'

export function currentPlatform(): Platform {
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'win32') return 'windows'
  throw new Error(`the Desktop real-app suite runs on Linux and Windows only, not ${process.platform}`)
}

/** The e2e binary: `CANOPI_E2E_APP`, else the debug build under `CARGO_TARGET_DIR` or the repository's `target/`. */
export function appBinary(): string {
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'target')
  const name = currentPlatform() === 'windows' ? 'canopi-desktop.exe' : 'canopi-desktop'
  const app = resolve(process.env.CANOPI_E2E_APP ?? join(targetDir, 'debug', name))
  if (!existsSync(app)) throw new Error(`no e2e build at ${app}: run \`npm run build:e2e\` first`)
  return app
}

/** The folder of the profile at `root` that holds every folder Tauri resolves for the app (logs in `logs/`). */
export function appFolders(root: string): string {
  return join(root, 'app')
}

/**
 * The folder the e2e build's host dialogs read their answers from (`CANOPI_E2E_DIALOGS`, `host::dialogs`): each
 * Open or Save takes the first file by name and deletes it; its lines are the chosen paths, and an empty file, or no
 * file at all, is a cancel.
 */
export function dialogAnswers(root: string): string {
  return join(root, 'dialogs')
}

let answerSequence = 0

/**
 * Queues the answer to the next host file dialog of the session: the chosen `paths`, or a cancel when none. Returns
 * the answer file, which the app deletes once a dialog has taken it.
 */
export function answerNextDialog(...paths: readonly string[]): string {
  answerSequence += 1
  const file = join(dialogAnswers(currentProfile()), `${String(answerSequence).padStart(6, '0')}.answer`)
  writeFileSync(file, paths.map(path => `${path}\n`).join(''))
  return file
}

/** Waits until a dialog has taken the answer `file` (the app deletes it). */
export async function waitForAnswerTaken(file: string): Promise<void> {
  await browser.waitUntil(() => !existsSync(file), { timeout: 30_000, timeoutMsg: `no dialog took ${file}` })
}

/** The environment that points every Canopi data path into the profile at `root`. */
export function profileEnvironment(root: string): Record<string, string> {
  // The app refuses a relative profile, and a relative XDG path is ignored for the user's own folder.
  if (!isAbsolute(root)) throw new Error(`a profile needs an absolute path, not ${root}`)
  const dir = (path: string) => {
    mkdirSync(path, { recursive: true })
    return path
  }
  const app = { CANOPI_E2E_PROFILE: dir(appFolders(root)), CANOPI_E2E_DIALOGS: dir(dialogAnswers(root)) }
  if (currentPlatform() === 'windows') return app
  return {
    ...app,
    HOME: dir(join(root, 'home')),
    XDG_DATA_HOME: dir(join(root, 'data')),
    XDG_CONFIG_HOME: dir(join(root, 'config')),
    XDG_CACHE_HOME: dir(join(root, 'cache')),
    XDG_STATE_HOME: dir(join(root, 'state')),
  }
}

/** A new profile under the run's temp dir (`RUNNER_TEMP` in CI), for a process that must not share the session's. */
export function separateProfile(): string {
  const root = mkdtempSync(join(resolve(process.env.RUNNER_TEMP ?? tmpdir()), 'canopi-e2e-'))
  profileEnvironment(root)
  return root
}

/** A new profile, recorded as the session's for this worker's helpers. */
export function freshProfile(): string {
  const root = separateProfile()
  process.env[PROFILE_ROOT_VARIABLE] = root
  return root
}

/** The profile of the session this worker runs. */
export function currentProfile(): string {
  const root = process.env[PROFILE_ROOT_VARIABLE]
  if (!root) throw new Error('no session profile: the wdio config creates one before each session')
  return root
}

/** Resolves once `url` answers 200; rejects when `child` exits first or the time runs out. */
async function waitForHttp(url: string, child: ChildProcess, what: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${what} exited (${child.exitCode ?? child.signalCode}) before ${url} answered`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((wake) => setTimeout(wake, 250))
  }
  throw new Error(`${what} did not answer ${url} within ${READY_TIMEOUT_MS / 1000} s`)
}

/**
 * Starts tauri-driver (`TAURI_DRIVER`, else on PATH) on `port`, with the native driver from `CANOPI_E2E_NATIVE_DRIVER`
 * when set (msedgedriver matched to WebView2 on Windows), and waits until it answers. A missing driver fails here.
 */
export async function startTauriDriver(port: number, nativePort: number, profileRoot: string): Promise<ChildProcess> {
  const args = ['--port', String(port), '--native-port', String(nativePort)]
  const native = process.env.CANOPI_E2E_NATIVE_DRIVER
  if (native) args.push('--native-driver', native)
  const driver = spawn(process.env.TAURI_DRIVER ?? 'tauri-driver', args, {
    env: { ...process.env, ...profileEnvironment(profileRoot) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const spawnFailure = new Promise<never>((_, reject) => driver.once('error', (error) => reject(new Error(`tauri-driver did not start: ${error.message}`))))
  await Promise.race([waitForHttp(`http://127.0.0.1:${port}/status`, driver, 'tauri-driver'), spawnFailure])
  return driver
}

/** The app launched by the harness (Windows) with its DevTools port, ready to attach to. */
export interface AttachedApp {
  readonly process: ChildProcess
  readonly debuggerAddress: string
}

/** Every DevToolsActivePort file under `folder`, a few levels deep (WebView2 writes it in its `EBWebView` folder). */
function devToolsPortFiles(folder: string, depth = 3): string[] {
  if (depth < 0 || !existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return devToolsPortFiles(path, depth - 1)
    return entry.name === 'DevToolsActivePort' ? [path] : []
  })
}

/** The DevTools port the WebView wrote under the profile's app folders, once it has. */
function writtenDevToolsPort(profileRoot: string): number | undefined {
  for (const file of devToolsPortFiles(appFolders(profileRoot))) {
    const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0])
    if (Number.isInteger(port) && port > 0) return port
  }
  return undefined
}

/** What the harness can see of WebView2 when its DevTools port does not answer, for the CI log. */
function webViewDiagnostics(profileRoot: string): string {
  const script = [
    "$views = @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\")",
    "\"msedgewebview2 processes: $($views.Count)\"",
    "foreach ($view in $views) { \"[$($view.ProcessId) parent $($view.ParentProcessId)] $($view.CommandLine)\" }",
    "$ids = $views | ForEach-Object { $_.ProcessId }",
    "$listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess })",
    "\"listening ports of those processes: $(($listening | ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort) (pid $($_.OwningProcess))\" }) -join ', ')\"",
    "\"a --remote-debugging-port switch on a command line: $([bool]($views | Where-Object { $_.CommandLine -match '--remote-debugging-port' }))\"",
  ].join('; ')
  let processes: string
  try {
    // Encoded, so no quote in the script meets Windows command-line quoting.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    processes = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 60_000 })
  } catch (error) {
    processes = `the process listing failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const files = devToolsPortFiles(appFolders(profileRoot))
  const written = files.length > 0
    ? files.map((file) => `${file}: ${JSON.stringify(readFileSync(file, 'utf8'))}`).join('\n')
    : `none under ${appFolders(profileRoot)}`
  return `${processes.trim()}\nDevToolsActivePort files: ${written}`
}

/**
 * Launches the e2e app, which opens WebView2's DevTools port (`host::e2e_window`), reads the port from the WebView's
 * DevToolsActivePort file and waits until it answers. On a timeout it prints what it saw of WebView2 and stops the app.
 */
export async function launchForAttach(profileRoot: string): Promise<AttachedApp> {
  const child = spawn(appBinary(), [], {
    env: { ...process.env, ...profileEnvironment(profileRoot) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  try {
    const port = await waitForDevToolsPort(profileRoot, child)
    await waitForHttp(`http://127.0.0.1:${port}/json/version`, child, 'the e2e app')
    if (child.pid === undefined) throw new Error('the e2e app has no process id')
    process.env[APP_PID_VARIABLE] = String(child.pid)
    return { process: child, debuggerAddress: `127.0.0.1:${port}` }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      console.error(`WebView2 as the harness sees it:\n${webViewDiagnostics(profileRoot)}`)
    }
    await stop(child)
    throw error
  }
}

/**
 * The process id of the app this worker's session attached to (Windows), so native checks touch that window and no
 * other process of the binary, a second launch included.
 */
export function currentAppPid(): number {
  const pid = Number(process.env[APP_PID_VARIABLE])
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('no attached app: the harness launches it before each Windows session')
  return pid
}

/** The DevTools port once the WebView has written it; rejects when the app exits first or the time runs out. */
async function waitForDevToolsPort(profileRoot: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the e2e app exited (${child.exitCode ?? child.signalCode}) before its WebView wrote DevToolsActivePort`)
    }
    const port = writtenDevToolsPort(profileRoot)
    if (port !== undefined) return port
    await new Promise((wake) => setTimeout(wake, 250))
  }
  throw new Error(`the e2e app's WebView wrote no DevToolsActivePort under ${appFolders(profileRoot)} within ${READY_TIMEOUT_MS / 1000} s`)
}

/** What a second process of the app did: its exit code or signal, or still running when the wait ended. */
export interface SecondLaunch {
  readonly exit: number | NodeJS.Signals | 'still running'
  readonly output: string
}

/** How a second process starts: its own profile instead of the session's, and environment values over the run's. */
export interface SecondLaunchOptions {
  readonly timeoutMs?: number
  readonly profile?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Launches another process of the e2e binary with `args` from `cwd`, in the current session's profile unless another
 * is given, as a user opening a file while Canopi runs; resolves when it exits, or kills it after `timeoutMs`.
 */
export async function launchSecondProcess(args: readonly string[], cwd: string, options: SecondLaunchOptions = {}): Promise<SecondLaunch> {
  const child = spawn(appBinary(), [...args], {
    cwd,
    env: { ...process.env, ...profileEnvironment(options.profile ?? currentProfile()), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exit = await new Promise<SecondLaunch['exit']>((settle) => {
    const timer = setTimeout(() => settle('still running'), options.timeoutMs ?? 20_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      settle(code ?? signal ?? 'still running')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      output += `spawn error: ${error.message}`
      settle('still running')
    })
  })
  if (exit === 'still running') await stop(child)
  return { exit, output }
}

/** Stops a process the harness started and waits for it to exit. */
export async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill()
  await exited
}

/**
 * The lane's planted broken page (plan Phase 0: each platform job fails on one): with `CANOPI_E2E_PLANTED_PAGE`
 * set to `about:blank`, the spec replaces the loaded page with an empty document before it asserts. The document is
 * replaced in place because the app's navigation guard refuses to load `about:blank` (`services/external_links.rs`).
 */
export async function plantBrokenPageWhenAsked(): Promise<void> {
  const planted = process.env.CANOPI_E2E_PLANTED_PAGE
  if (!planted) return
  if (planted !== 'about:blank') throw new Error(`CANOPI_E2E_PLANTED_PAGE supports about:blank only, not ${planted}`)
  await browser.execute(() => {
    document.open()
    document.close()
  })
}

/**
 * The start screen's Open Design button. Its text holds the shortcut too ("Open Design… Ctrl+O"), and WebdriverIO's
 * `button=` matches the whole text, so the label is matched as a part (`button*=`), in this one place.
 */
export function openDesignButton(): ReturnType<typeof $> {
  return $('button*=Open Design…')
}

/** Waits until the title bar's name button shows the open Design called `name`. */
export async function waitForOpenDesign(name: string): Promise<void> {
  await $(`button[aria-label="Rename Design: ${name}"]`).waitForDisplayed({ timeout: 30_000 })
}

/**
 * Renames the open Design from the title bar, as a user does: click the name, type, Enter. The field opens focused
 * with its text selected, so typing replaces the name. Never `setValue`: it sends WebDriver's Element Clear first,
 * which blurs the field (WebKitGTK and WebView2 alike), so the rename ends and the input is gone before the typing
 * reaches it (a stale element, F5 probes 2 and 3).
 */
export async function renameOpenDesign(from: string, to: string): Promise<void> {
  await $(`button[aria-label="Rename Design: ${from}"]`).click()
  await $('input[aria-label="Design name"]').waitForDisplayed()
  await browser.keys(to)
  await browser.keys('Enter')
  await waitForOpenDesign(to)
}
