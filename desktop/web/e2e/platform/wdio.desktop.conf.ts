// The Desktop real-app suite (2.1-M213; ADR 0029 Platform matrix): `npm run test:platform` after `npm run build:e2e`.
// One worker: the e2e build is single-instance, so a second app under the same identifier would hand its launch to
// the first and exit. tauri-driver starts before each session and stops after it, with that session's fresh profile,
// on Linux with the app it reached (its process group), so the next session's app never meets the previous one;
// support/app.ts says how each platform reaches and stops the app.
import type { ChildProcess } from 'node:child_process'
import {
  appBinary,
  currentPlatform,
  freshProfile,
  launchForAttach,
  startTauriDriver,
  stop,
  stopDriver,
} from './support/app'

const DRIVER_PORT = Number(process.env.CANOPI_E2E_DRIVER_PORT ?? 4444)
const NATIVE_DRIVER_PORT = DRIVER_PORT + 1
/** Where a session goes when its app or driver did not start: a name that never resolves. */
const LAUNCH_FAILED_HOST = 'canopi-launch-failed.invalid'

let driver: ChildProcess | undefined
let attachedApp: ChildProcess | undefined

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./desktop/**/*.spec.ts'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: DRIVER_PORT,
  // Filled per session in beforeSession: the app path (Linux) or the attach address (Windows).
  capabilities: [{ 'wdio:enforceWebDriverClassic': true }],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 0,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 180_000 },

  async beforeSession(config, capabilities) {
    try {
      const profile = freshProfile()
      driver = await startTauriDriver(DRIVER_PORT, NATIVE_DRIVER_PORT, profile)
      const requested = capabilities as WebdriverIO.Capabilities & Record<string, unknown>
      if (currentPlatform() === 'linux') {
        requested['tauri:options'] = { application: appBinary(), args: [] }
        return
      }
      const app = await launchForAttach(profile)
      attachedApp = app.process
      requested.browserName = 'webview2'
      requested['ms:edgeOptions'] = { debuggerAddress: app.debuggerAddress }
    } catch (error) {
      // WebdriverIO logs a beforeSession error and still creates the session, which then drives whatever the
      // driver started (Windows probe run 40479601190: 90 s per spec on a session that was not Canopi). The session
      // goes to a host that never resolves instead (.invalid, RFC 2606), so its creation fails at once, after the
      // real reason is logged; the config is this worker's own, so the next spec file starts clean.
      console.error(`the Desktop real-app session cannot start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      await stop(attachedApp)
      attachedApp = undefined
      await stopDriver(driver)
      driver = undefined
      config.hostname = LAUNCH_FAILED_HOST
    }
  },

  async afterSession() {
    await stop(attachedApp)
    attachedApp = undefined
    await stopDriver(driver)
    driver = undefined
  },
}
