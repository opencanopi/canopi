// The Desktop real-app harness (2.1-M213; ADR 0029 Platform matrix): plain WebdriverIO over tauri-driver drives the
// e2e build (`npm run build:e2e`: `--features e2e`, identifier com.canopi.e2e) with command mocking off, so every
// command, plugin and the single-instance name are the real app's. Each session gets a fresh profile of absolute
// paths under the run's temp dir, and the app never reads or writes the user's Canopi data.
//
// Linux: tauri-driver starts WebKitWebDriver, which launches the app from `tauri:options`. The suite runs inside
// `dbus-run-session -- xvfb-run` with a window manager (the CI lane), so the single-instance name lives on a private
// session bus.
//
// Windows: the harness launches the app itself with WebView2's DevTools port open
// (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which overrides the app's own arguments) and msedgedriver attaches to it
// through `ms:edgeOptions.debuggerAddress`, still behind tauri-driver. In launch mode msedgedriver started the app and
// waited for a DevToolsActivePort file that never appeared (F5 probe, CI run 40405302908); the likely reason is that
// Tauri always gives WebView2 its own user data folder (`%LOCALAPPDATA%\com.canopi.e2e`), not the one msedgedriver
// reads. Attaching needs no such file, and the harness owns the app process, so an app that exits says how.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { browser } from '@wdio/globals'

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
const PROFILE_ROOT_VARIABLE = 'CANOPI_E2E_PROFILE_ROOT'
/** WebView2's own switches that wry passes when no environment value replaces them (wry `create_environment`). */
const WRY_WEBVIEW2_ARGUMENTS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
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

/** The environment that points every Canopi data path into the profile at `root`. */
export function profileEnvironment(root: string): Record<string, string> {
  // A relative XDG path is ignored for the user's own folder, so only absolute paths isolate the app.
  if (!isAbsolute(root)) throw new Error(`a profile needs an absolute path, not ${root}`)
  const dir = (name: string) => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  if (currentPlatform() === 'windows') return { APPDATA: dir('Roaming'), LOCALAPPDATA: dir('Local') }
  return {
    HOME: dir('home'),
    XDG_DATA_HOME: dir('data'),
    XDG_CONFIG_HOME: dir('config'),
    XDG_CACHE_HOME: dir('cache'),
    XDG_STATE_HOME: dir('state'),
  }
}

/** A new profile under the run's temp dir (`RUNNER_TEMP` in CI), recorded for this worker's helpers. */
export function freshProfile(): string {
  const root = mkdtempSync(join(resolve(process.env.RUNNER_TEMP ?? tmpdir()), 'canopi-e2e-'))
  profileEnvironment(root)
  process.env[PROFILE_ROOT_VARIABLE] = root
  return root
}

/** The profile of the session this worker runs. */
export function currentProfile(): string {
  const root = process.env[PROFILE_ROOT_VARIABLE]
  if (!root) throw new Error('no session profile: the wdio config creates one before each session')
  return root
}

/** A free local TCP port. */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))))
    })
  })
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

/** Launches the e2e app with WebView2's DevTools port open and waits until the port answers. */
export async function launchForAttach(profileRoot: string): Promise<AttachedApp> {
  const port = await freePort()
  const child = spawn(appBinary(), [], {
    env: {
      ...process.env,
      ...profileEnvironment(profileRoot),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${WRY_WEBVIEW2_ARGUMENTS} --remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, child, 'the e2e app')
  return { process: child, debuggerAddress: `127.0.0.1:${port}` }
}

/** What a second process of the app did: its exit code or signal, or still running when the wait ended. */
export interface SecondLaunch {
  readonly exit: number | NodeJS.Signals | 'still running'
  readonly output: string
}

/**
 * Launches another process of the e2e binary with `args` from `cwd`, in the current session's profile, as a user
 * opening a file while Canopi runs; resolves when it exits, or kills it after `timeoutMs`.
 */
export async function launchSecondProcess(args: readonly string[], cwd: string, timeoutMs = 20_000): Promise<SecondLaunch> {
  const child = spawn(appBinary(), [...args], {
    cwd,
    env: { ...process.env, ...profileEnvironment(currentProfile()) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exit = await new Promise<SecondLaunch['exit']>((settle) => {
    const timer = setTimeout(() => settle('still running'), timeoutMs)
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
  if (exit === 'still running') child.kill()
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
