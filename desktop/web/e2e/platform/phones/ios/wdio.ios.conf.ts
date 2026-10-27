// The iOS smoke (ADR 0029 Platform matrix, 2.1-Q84): Safari in an iOS simulator, driven through safaridriver by plain
// WebdriverIO, reads the built Web Edition (`npm run build:web`, served by `vite preview` on 4174). `npm run test:ios`
// with safaridriver listening on CANOPI_E2E_DRIVER_PORT (4445) and CANOPI_IOS_DEVICE naming a booted simulator; an
// iPhone is the phone layout, an iPad the tablet layout (ADR 0029:26). With CANOPI_E2E_PLANTED_PAGE the spec opens
// that page instead, so the lane's inverted step fails unless the smoke fails (plan:157).
// Probed 2026-10-26 (macos-latest, Xcode 26.6, iPhone 17 Pro, iOS 26.5): these capabilities reach Safari.
const device = process.env.CANOPI_IOS_DEVICE
if (!device) throw new Error('CANOPI_IOS_DEVICE names no simulator: the iOS smoke never runs on whatever device Safari picks')
// The booted simulator's UDID picks that device even when another of the same name exists (the CI job exports it).
const udid = process.env.CANOPI_IOS_UDID
/** safaridriver's own capabilities, which WebdriverIO's types do not list. */
const safari: WebdriverIO.Capabilities & Record<`safari:${string}`, unknown> = {
  browserName: 'Safari',
  platformName: 'iOS',
  'safari:useSimulator': true,
  'safari:deviceName': device,
  ...(udid ? { 'safari:deviceUDID': udid } : {}),
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./smoke.spec.ts'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: Number(process.env.CANOPI_E2E_DRIVER_PORT ?? 4445),
  capabilities: [safari],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 20_000,
  // The first session boots Safari's automation in the simulator: measured over two minutes on the hosted runner.
  // safaridriver gives up on a cold Safari before that (iPad, probe run 40479601028), so the CI job warms Safari
  // first and a session gets two more tries; three failed attempts still fail the job.
  connectionRetryTimeout: 300_000,
  connectionRetryCount: 2,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 300_000 },
}
