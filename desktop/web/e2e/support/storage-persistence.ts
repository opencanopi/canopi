// How a browser check makes each engine grant or refuse `navigator.storage.persist()` (2.1-Q82, Step 2.0.3 persist).
// Measured in the pinned image (Playwright 1.64.1) by e2e/canvas/storage-persistence-probe.spec.ts, which keeps these
// methods honest: a Playwright or engine bump that breaks one fails the probe, not only the Q82 checks.
// - Chromium: a fresh context refuses (persist() false). Granted: CDP `Browser.grantPermissions(['durableStorage'])`
//   with the page's own `browserContextId` (without it the grant lands on the default context and changes nothing),
//   from a session kept attached (detaching drops it); persisted() then reads true at once, so it is armed late.
//   Playwright's `grantPermissions(['persistent-storage'])` throws "Unknown permission" here.
// - Firefox: a fresh profile leaves persist() pending (its prompt, unanswered). Playwright's `grantPermissions` accepts
//   'persistent-storage' but changes nothing. The test prefs `dom.storageManager.prompt.testing(.allow)` answer the
//   prompt through Firefox's own permission path; they are launch prefs, so Firefox gets a browser of its own here.
// - WebKit: persist() resolves false (refused, real). There is no grant API, so granted is an init-script stub.
import { firefox, type Browser, type Page, type TestInfo } from '@playwright/test'
import { WEB_PORT } from './ports'

export type PersistenceAnswer = 'granted' | 'refused'

/** The only origin a check may reach (support/offline.ts). */
export const APP_ORIGIN = `http://localhost:${WEB_PORT}`

/** Firefox prefs that answer the persistence prompt without showing it. */
function firefoxPersistencePrefs(answer: PersistenceAnswer): Record<string, boolean> {
  return { 'dom.storageManager.prompt.testing': true, 'dom.storageManager.prompt.testing.allow': answer === 'granted' }
}

export interface PersistencePage {
  readonly page: Page
  /**
   * Readies the engine's answer; call it after the launch read, just before the click that asks. Chromium's grant is a
   * permission, which persisted() reads at once, so granting before the launch would make the app see Drafts kept.
   */
  armAnswer(): Promise<void>
  /** Errors the page logged or threw; a Firefox page lives outside the offline fixture, which checks the others. */
  readonly errors: string[]
  close(): Promise<void>
}

/**
 * A page whose engine answers persist() with `answer`, plus a spy that counts persist() calls in `window.__persistCalls`
 * and records whether the reason line was on screen at each call (`window.__persistReasonShown`).
 */
export async function pageWithPersistence(
  { page, browserName, testInfo }: { page: Page, browserName: string, testInfo: TestInfo },
  answer: PersistenceAnswer,
): Promise<PersistencePage> {
  if (browserName === 'firefox') return await firefoxPage(answer, testInfo)
  if (browserName === 'webkit' && answer === 'granted') await page.addInitScript(webkitGrantedStub)
  await page.addInitScript(persistSpy)
  const armAnswer = browserName === 'chromium' && answer === 'granted' ? () => grantInChromium(page) : async () => undefined
  return { page, errors: [], armAnswer, close: async () => undefined }
}

/** A fresh page with no forcing at all, for the probe's default answers (Firefox: no prefs). */
export async function pageWithDefaultAnswer(
  { page, browserName, testInfo }: { page: Page, browserName: string, testInfo: TestInfo },
): Promise<PersistencePage> {
  if (browserName === 'firefox') return await firefoxPage(null, testInfo)
  return { page, errors: [], armAnswer: async () => undefined, close: async () => undefined }
}

async function grantInChromium(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  await cdp.send('Browser.grantPermissions', {
    permissions: ['durableStorage'],
    origin: APP_ORIGIN,
    ...(targetInfo.browserContextId === undefined ? {} : { browserContextId: targetInfo.browserContextId }),
  })
  // Kept attached: Chromium drops a session's permission overrides when the session detaches.
}

/** Chromium only: the permission reads denied, as after a user's Block. */
export async function denyInChromium(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  await cdp.send('Browser.setPermission', {
    permission: { name: 'persistent-storage' },
    setting: 'denied',
    origin: APP_ORIGIN,
    ...(targetInfo.browserContextId === undefined ? {} : { browserContextId: targetInfo.browserContextId }),
  })
  // Kept attached: Chromium drops a session's permission overrides when the session detaches.
}

async function firefoxPage(answer: PersistenceAnswer | null, testInfo: TestInfo): Promise<PersistencePage> {
  const browser: Browser = await firefox.launch(answer ? { firefoxUserPrefs: firefoxPersistencePrefs(answer) } : {})
  const { baseURL, viewport, deviceScaleFactor, hasTouch, locale, timezoneId, colorScheme } = testInfo.project.use
  // The project's options that are set: an option the project leaves out stays out (exactOptionalPropertyTypes).
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
    acceptDownloads: true,
  })
  // The offline rule of support/offline.ts: only the preview server answers; the catalog is missing.
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(`${APP_ORIGIN}/assets/catalog/`)) return route.fulfill({ status: 404, body: 'Not Found' })
    if (new URL(url).origin === APP_ORIGIN) return route.continue()
    return route.abort('internetdisconnected')
  })
  const errors: string[] = []
  context.on('weberror', (error) => errors.push(`uncaught: ${error.error().message}`))
  await context.addInitScript(persistSpy)
  const page = await context.newPage()
  return { page, errors, armAnswer: async () => undefined, close: async () => { await browser.close() } }
}

/** Counts persist() calls and notes whether a reason line (the welcome screen's, or the save-status warning's popover) was on screen at each one. */
function persistSpy(): void {
  const target = window as unknown as { __persistCalls: number, __persistReasonShown: boolean[] }
  target.__persistCalls = 0
  target.__persistReasonShown = []
  const proto = (globalThis as unknown as { StorageManager?: { prototype: StorageManager } }).StorageManager?.prototype
  if (!proto) return
  const persist = proto.persist
  proto.persist = function spiedPersist(this: StorageManager) {
    target.__persistCalls += 1
    // Any on-screen reason line: the welcome screen's line, or the save-status warning's popover.
    const reasons = Array.from(document.querySelectorAll<HTMLElement>('[data-notice="draft-persistence-reason"]'))
    target.__persistReasonShown.push(reasons.some((reason) => reason.checkVisibility() && (reason.textContent ?? '').trim().length > 0))
    return persist.call(this)
  }
}

/** WebKit has no grant API: persist() grants and persisted() then reads true, as a granting engine answers. */
function webkitGrantedStub(): void {
  const proto = (globalThis as unknown as { StorageManager?: { prototype: StorageManager } }).StorageManager?.prototype
  if (!proto) return
  let kept = false
  proto.persisted = async () => kept
  proto.persist = async () => {
    kept = true
    return true
  }
}

/**
 * Drafts kept from launch, for a check whose subject is not persistence (offline.ts `draftsKept`): persisted() and
 * persist() resolve true in every engine, so the save status reads "Saved in this browser" and no reason or warning
 * line shows. Only draft-persistence.spec.ts and the probe drive the engines' own answers.
 */
export function draftsKeptStub(): void {
  const proto = (globalThis as unknown as { StorageManager?: { prototype: StorageManager } }).StorageManager?.prototype
  if (!proto) return
  proto.persisted = async () => true
  proto.persist = async () => true
}

/** What the page's engine answers, without the app: persist() settled within `ms` or still pending. */
export async function racePersist(page: Page, ms = 3000): Promise<string> {
  return await page.evaluate((wait) => Promise.race([
    navigator.storage.persist().then((value) => `settled:${value}`, (error: Error) => `rejected:${error.name}`),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), wait)),
  ]), ms)
}
