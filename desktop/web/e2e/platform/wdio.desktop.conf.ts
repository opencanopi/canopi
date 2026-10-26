// The Desktop real-app suite (2.1-M213; ADR 0029 Platform matrix): `npm run test:platform` after `npm run build:e2e`.
// One worker: the e2e build is single-instance, so a second app under the same identifier would hand its launch to
// the first and exit. tauri-driver starts before each session and stops after it, with that session's fresh profile;
// support/app.ts says how each platform reaches the app.
import type { ChildProcess } from 'node:child_process'
import {
  appBinary,
  currentPlatform,
  freshProfile,
  launchForAttach,
  startTauriDriver,
  stop,
} from './support/app'

const DRIVER_PORT = Number(process.env.CANOPI_E2E_DRIVER_PORT ?? 4444)
const NATIVE_DRIVER_PORT = DRIVER_PORT + 1

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

  async beforeSession(_config, capabilities) {
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
  },

  async afterSession() {
    await stop(attachedApp)
    attachedApp = undefined
    await stop(driver)
    driver = undefined
  },
}
