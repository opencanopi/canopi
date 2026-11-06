// The iOS smoke (ADR 0029 Platform matrix, 2.1-Q84): Safari in an iOS simulator, driven through Appium's XCUITest
// driver by plain WebdriverIO (2.1-Q247: safaridriver's fixed ~34 s connect wait failed session creation on hosted
// runners), reads the built Web Edition (`npm run build:web`, served by `vite preview` on 4174). `npm run test:ios` with
// Appium listening on CANOPI_E2E_DRIVER_PORT (4723) and CANOPI_IOS_DEVICE, CANOPI_IOS_VERSION and CANOPI_IOS_UDID naming
// a booted simulator (the CI job exports them); an iPhone is the phone layout, an iPad the tablet layout (ADR 0029:26).
// With CANOPI_E2E_PLANTED_PAGE the spec opens that page instead, so the lane's inverted step fails unless the smoke
// fails (plan:157).
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The booted simulator, named exactly: the smoke never runs on whatever device the driver would pick. */
function simulator(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: the iOS smoke runs only on the booted simulator it names`)
  return value
}
const device = simulator('CANOPI_IOS_DEVICE')

/**
 * The WebDriverAgent build the CI job made or restored from its cache (CANOPI_WDA_DERIVED_DATA, its derived data): the
 * session runs it as is (`test-without-building`). Without it the driver builds WebDriverAgent itself.
 */
const prebuilt = process.env.CANOPI_WDA_DERIVED_DATA
  ? { 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': process.env.CANOPI_WDA_DERIVED_DATA }
  : {}

/** Mobile Safari in the simulator through the XCUITest driver (appium-xcuitest-driver's capability list). */
const safari: WebdriverIO.Capabilities = {
  platformName: 'iOS',
  browserName: 'Safari',
  'appium:automationName': 'XCUITest',
  'appium:deviceName': device,
  'appium:platformVersion': simulator('CANOPI_IOS_VERSION'),
  // The UDID picks the booted device even when another of the same name exists.
  'appium:udid': simulator('CANOPI_IOS_UDID'),
  // Safari opens on a blank page, not on Appium's welcome page nor on the app: the spec loads the page it tests, once.
  // With the app here every run loaded it twice, and on the planted-page run the app's start-up load crashed Safari's
  // web content process under the spec's about:blank (canopi-f47t.52.261, runs 41753452998 and 42046262923).
  'appium:safariInitialUrl': 'about:blank',
  // The waits are the hosted runner's, not a laptop's: WebDriverAgent is built by the job before the session, but its
  // first launch in a cold simulator, Safari's first web inspector connection and a simulator boot all take minutes there.
  'appium:simulatorStartupTimeout': 300_000,
  'appium:wdaLaunchTimeout': 300_000,
  'appium:wdaConnectionTimeout': 300_000,
  'appium:webviewConnectTimeout': 120_000,
  // A script the page does not answer fails in 30 s instead of the driver's 120 s, so a dead page (F5 probe 7: Safari's
  // web content process crashed after New Design) fails the smoke inside its budget, with the spec's crash check, and
  // a busy one still has room (probe 7's slowest answered script took 12 s).
  'appium:webviewAtomWaitTimeout': 30_000,
  'appium:newCommandTimeout': 600,
  'appium:showXcodeLog': true,
  ...prebuilt,
}

/** Where a failed test leaves its screenshot: the run's temp dir, which the CI job uploads on failure. */
const ARTIFACTS = resolve(process.env.RUNNER_TEMP ?? tmpdir())

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./smoke.spec.ts'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: Number(process.env.CANOPI_E2E_DRIVER_PORT ?? 4723),
  capabilities: [safari],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 20_000,
  // Session creation launches WebDriverAgent and Safari in the simulator, which takes minutes on the hosted runner.
  // The client waits longer than the driver's launch waits together (12 min), so a launch that fails is reported by
  // Appium, with its cause. No retry: a simulator or driver that fails once fails the job (plan:181), and a retried
  // command would hide an intermittent failure in the smoke itself.
  connectionRetryTimeout: 900_000,
  connectionRetryCount: 0,
  framework: 'mocha',
  reporters: ['spec'],
  // The smoke's own waits end first: 90 s for the start screen, 90 s for the tap to land and 90 s for the Design (each
  // past its deadline by at most one busy script, about 45 s), and on a context loss 30 s for the map notice and up to
  // 120 s for the simulator log (smoke.spec.ts).
  mochaOpts: { ui: 'bdd', timeout: 600_000 },

  async afterTest(test, _context, { passed }) {
    if (passed) return
    const name = `${device}-${test.title}`.replace(/[^A-Za-z0-9-]+/g, '-')
    await browser.saveScreenshot(join(ARTIFACTS, `ios-failure-${name}.png`))
  },
}
