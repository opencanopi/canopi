// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Desktop updater's UI (canopi-f47t.52.228.15) through the real controller and components; fakes stand only at
// the host's update commands (ipc/update.ts, the UpdaterPort). Copy is 2.1-Q237 and Q244; the download starts
// only from About (Q235); About shows the offer's version and What's new (Q236); the switch is its own key row (M206);
// the notice mounts only in the Desktop root (M211); Web shows no updater (Q201, ADR 0005).

const host = { launchCheck: true, launchNotice: false }

vi.mock('../components/shared/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../components/shared/DegradedBanner', () => ({ DegradedBanner: () => null }))
vi.mock('../components/shared/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../components/shared/ProblemReportDialog', () => ({ ProblemReportDialog: () => null }))
vi.mock('../components/workspace/DesktopWorkspace', () => ({ DesktopWorkspace: () => null }))
vi.mock('../components/panels/DesktopPanelRail', () => ({ DesktopPanelRail: () => null }))
const invoke = vi.hoisted(() => vi.fn((_command: string, _args?: unknown) => Promise.resolve(null)))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }))

import { App, type DesktopUpdatePorts } from '../app'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog } from '../app/about/state'
import { CANOPI_VERSION } from '../app/about/metadata'
import { locale } from '../app/settings/state'
import { closeWaitsFor } from '../app/shell/close-guard'
import { multiOpenNotice } from '../app/document-session/launch-file'
import { resetNoticesForTests } from '../failures/notices'
import { reportFailure, resetFailureNoticesForTests } from '../failures/report'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import { closeSettingsDialog, openSettingsDialog } from '../app/shell/dialogs'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../app/updates/controller'
import { AboutCanopiDialog, AboutUpdates } from '../components/shared/AboutCanopiDialog'
import { LaunchCheckSwitch, SettingsDialog } from '../components/shared/SettingsDialog'
import type { UpdateDownload, UpdaterFailure, UpdateOffer, UpdateOs, UpdateProgress } from '../generated/contracts'
import { WebApp } from '../web/WebApp'
import { unmount } from './support/unmount'

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/opencanopi/canopi/releases/tag/v2.1.0' }
const DOWNLOAD_PAGE = 'https://projectcanopi.com'
const OFFLINE: UpdaterFailure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check', operation: null, detail: null }
const NO_ENTRY: UpdaterFailure = { code: { kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'appimage' }, user_may_retry: false, op: 'updater.check', operation: null, detail: null }
const CANCELLED: UpdaterFailure = { code: { kind: 'cancelled' }, user_may_retry: false, op: 'updater.download', operation: null, detail: null }
const DOWNLOAD_FAILED: UpdaterFailure = { code: { kind: 'network', network: 'timeout' }, user_may_retry: true, op: 'updater.download', operation: null, detail: null }
const NOT_VERIFIED: UpdaterFailure = { code: { kind: 'update_signature_refused' }, user_may_retry: false, op: 'updater.download', operation: null, detail: null }
const PROMPT_CLOSED: UpdaterFailure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install', operation: null, detail: null }

/** One pending host reply the test settles by hand. */
interface Pending<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

/**
 * The host's update commands, each reply held until the test settles it; progress goes through `progress`. A cancel
 * is recorded in `cancels` and drops the running download, which settles cancelled as the host's does (contracts §3);
 * `staged` holds each payload a download verified.
 */
function fakePort() {
  const checks: Pending<UpdateOffer | null>[] = []
  const downloads: Pending<UpdateDownload>[] = []
  const installs: Pending<void>[] = []
  const cancels: string[] = []
  const staged: string[] = []
  let progress: (value: UpdateProgress) => void = () => {}
  const port: UpdaterPort = {
    checkForUpdate: () => { const next = pending<UpdateOffer | null>(); checks.push(next); return next.promise },
    downloadUpdate: (_operation, onProgress) => {
      progress = onProgress
      const next = pending<UpdateDownload>()
      downloads.push(next)
      return next.promise.then((reply) => {
        if (reply.kind === 'verified') staged.push(OFFER.version)
        return reply
      })
    },
    installUpdate: () => { const next = pending<void>(); installs.push(next); return next.promise },
    cancelUpdate: (operation) => {
      cancels.push(operation)
      downloads.at(-1)?.reject(CANCELLED)
      return Promise.resolve()
    },
    restartAfterUpdate: () => Promise.resolve(),
    getLaunchCheck: () => Promise.resolve(true),
  }
  return { port, checks, downloads, installs, cancels, staged, progress: (value: UpdateProgress) => progress(value) }
}

function controllerFor(port: UpdaterPort, platform: UpdateOs = 'linux', exit: 'proceed' | 'cancel' = 'cancel'): UpdateController {
  let id = 0
  return createUpdateController({
    updater: port,
    platform,
    flushBeforeExit: () => Promise.resolve(exit),
    holdCloseUntilSettled: () => () => false,
    mintOperationId: () => `op-${++id}`,
    currentDesignPath: () => null,
  })
}

/** The Desktop root's host ports (platform/updates.desktop.ts): a check that offers OFFER, a download that never ends. */
function rootPorts(): DesktopUpdatePorts {
  return {
    updater: {
      checkForUpdate: () => Promise.resolve(OFFER),
      downloadUpdate: () => new Promise(() => {}),
      installUpdate: () => Promise.resolve(),
      cancelUpdate: () => Promise.resolve(),
      restartAfterUpdate: () => Promise.resolve(),
      getLaunchCheck: () => Promise.resolve(host.launchCheck),
    },
    setLaunchCheck: () => Promise.resolve(),
    takeLaunchNotice: () => Promise.resolve(host.launchNotice),
    mintOperationId: () => 'op-root',
  }
}

describe('About › Updates', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    aboutCanopiDialogOpen.value = true
  })

  afterEach(() => {
    unmount(container)
    container.remove()
    closeAboutCanopiDialog()
  })

  async function showAbout(controller: UpdateController): Promise<void> {
    await act(async () => {
      render(<AboutCanopiDialog updates={<AboutUpdates controller={controller} downloadPage={DOWNLOAD_PAGE} />} />, container)
    })
  }

  const section = () => container.querySelector<HTMLElement>('[data-about-updates]')!
  const action = () => section().querySelector<HTMLButtonElement>('button')!
  const cancelButton = () => section().querySelector<HTMLButtonElement>('[data-update-cancel]')
  const status = () => section().querySelector<HTMLElement>('[role="status"]')!.textContent
  const press = async (button: HTMLButtonElement) => {
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }
  const settle = async (run: () => void) => { await act(async () => { run(); await Promise.resolve() }) }

  it('About shows the version, Check for updates, Checking… while it runs, then Canopi is up to date', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))

    expect(container.querySelector('[role="dialog"]')!.textContent).toContain(`Version ${CANOPI_VERSION}`)
    expect(action().textContent).toBe('Check for updates')
    await press(action())
    expect(action().textContent).toBe('Checking…')
    expect(action().getAttribute('aria-disabled')).toBe('true')
    await settle(() => fake.checks[0]!.resolve(null))

    expect({ action: action().textContent, status: status() }).toEqual({ action: 'Check for updates', status: 'Canopi is up to date' })
  })

  it('an available update shows its version and What\'s new, downloads only from Download and install, then installs and restarts', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))

    const notes = section().querySelector<HTMLAnchorElement>('a')!
    expect({ status: status(), link: notes.textContent, href: notes.href, target: notes.target, action: action().textContent, downloads: fake.downloads.length })
      .toEqual({ status: 'Canopi 2.1.0 is available What’s new', link: 'What’s new', href: OFFER.notes_url, target: '_blank', action: 'Download and install', downloads: 0 })
    await press(action())
    await settle(() => fake.progress({ received: 42, total: 100 }))
    expect(action().textContent).toBe('Downloading… 42%')
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    expect(action().textContent).toBe('Install and restart')
    await press(action())
    await act(async () => { fake.installs[0]!.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    // Linux: installed, and the close guard's Cancel kept the window, so the restart waits for the user (2.1-Q233).
    expect(action().textContent).toBe('Restart to finish updating')
  })

  // About stays open over the Desktop root while the Linux install runs, so its status, the topmost surface, says it.
  it('while the install runs About says Installing update…, above the root notice About\'s scrim covers (canopi-f47t.52.228)', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    await press(action())

    expect({ status: status(), installs: fake.installs.length }).toEqual({ status: 'Installing update…', installs: 1 })
  })

  // The same holds for the update's own exit: its flush, then the Windows installer start or the Linux restart.
  it('while the update\'s exit runs About says Finishing update…, above the root notice About\'s scrim covers (canopi-f47t.52.228)', async () => {
    const fake = fakePort()
    const flush = pending<'proceed' | 'cancel'>()
    const controller = createUpdateController({
      updater: fake.port,
      platform: 'windows',
      flushBeforeExit: () => flush.promise,
      holdCloseUntilSettled: () => () => false,
      mintOperationId: () => 'op-exit',
      currentDesignPath: () => null,
    })
    await showAbout(controller)
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    await press(action())

    expect({ state: controller.state.value.kind, status: status(), installs: fake.installs.length })
      .toEqual({ state: 'close_requested', status: 'Finishing update…', installs: 0 })
    await settle(() => flush.resolve('cancel'))
  })

  it('offline: About says Can\'t check for updates while offline and offers the check again', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.reject(OFFLINE))

    expect({ status: status(), action: action().textContent }).toEqual({ status: 'Can’t check for updates while offline', action: 'Check for updates' })
  })

  it('update_no_channel_entry and a link_only download show Download the update from projectcanopi.com as an external link', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.reject(NO_ENTRY))
    const fromCheck = section().querySelector<HTMLAnchorElement>('a')!
    expect({ text: fromCheck.textContent, href: fromCheck.href, target: fromCheck.target })
      .toEqual({ text: 'Download the update from projectcanopi.com', href: `${DOWNLOAD_PAGE}/`, target: '_blank' })

    await press(action())
    await settle(() => fake.checks[1]!.resolve(OFFER))
    await press(action())
    await settle(() => fake.downloads[0]!.resolve({ kind: 'link_only', url: 'https://projectcanopi.com/download' }))
    const fromDownload = [...section().querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.href !== OFFER.notes_url)!
    expect({ text: fromDownload.textContent, href: fromDownload.href, target: fromDownload.target })
      .toEqual({ text: 'Download the update from projectcanopi.com', href: 'https://projectcanopi.com/download', target: '_blank' })
  })

  it('a failed Linux install shows Update not installed with its reason; Windows shows it plain', async () => {
    const shownFor = async (platform: UpdateOs): Promise<string | null> => {
      const fake = fakePort()
      await showAbout(controllerFor(fake.port, platform, 'proceed'))
      await press(action())
      await settle(() => fake.checks[0]!.resolve(OFFER))
      await press(action())
      await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
      await press(action())
      await settle(() => fake.installs[0]!.reject(PROMPT_CLOSED))
      return status()
    }

    expect(await shownFor('linux')).toBe('Update not installed: the password prompt was closed')
    unmount(container)
    expect(await shownFor('windows')).toBe('Update not installed')
  })

  // 2.1-Q251: Cancel sits beside the running download; the cancel settles silently, back to idle, with nothing staged.
  it('cancelled update download leaves nothing staged and settles cancelled: About\'s Cancel stops it and offers Check for updates', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    expect(cancelButton()).toBeNull()
    await press(action())
    await settle(() => fake.progress({ received: 10, total: 100 }))
    expect({ action: action().textContent, cancel: cancelButton()?.textContent }).toEqual({ action: 'Downloading… 10%', cancel: 'Cancel' })
    cancelButton()!.focus()
    await settle(() => fake.progress({ received: 20, total: 100 }))
    const keptFocus = document.activeElement === cancelButton()
    await press(cancelButton()!)
    await settle(() => {})

    expect({
      cancels: fake.cancels,
      staged: fake.staged,
      action: action().textContent,
      disabled: action().getAttribute('aria-disabled'),
      status: status(),
      cancelDisabled: cancelButton()?.getAttribute('aria-disabled'),
      keptFocus,
      focused: document.activeElement === cancelButton(),
    }).toEqual({ cancels: ['op-2'], staged: [], action: 'Check for updates', disabled: null, status: '', cancelDisabled: 'true', keptFocus: true, focused: true })
  })

  it('closing About during a download lets it finish; About reopens on Install and restart (2.1-Q251)', async () => {
    const fake = fakePort()
    const controller = controllerFor(fake.port)
    await showAbout(controller)
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    await act(async () => { closeAboutCanopiDialog() })
    expect(container.querySelector('[data-about-updates]')).toBeNull()
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    await act(async () => { aboutCanopiDialogOpen.value = true })

    expect({ cancels: fake.cancels, staged: fake.staged, state: controller.state.value.kind, action: action().textContent })
      .toEqual({ cancels: [], staged: [OFFER.version], state: 'verified', action: 'Install and restart' })
  })

  // Lens 7: no focus moves on an async result. A download that settles while Cancel has focus leaves focus on Cancel,
  // now unavailable, so a key press meant for Cancel never lands on Install and restart (or Retry); Cancel leaves once
  // the user moves focus away.
  it('a download settling while Cancel has focus keeps focus on Cancel, unavailable, so the press installs nothing', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    cancelButton()!.focus()
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    const settled = { focused: document.activeElement === cancelButton(), cancelDisabled: cancelButton()?.getAttribute('aria-disabled') }
    await press(cancelButton()!)
    await act(async () => { action().focus() })

    expect({ settled, action: action().textContent, installs: fake.installs.length, cancels: fake.cancels, cancel: cancelButton() })
      .toEqual({ settled: { focused: true, cancelDisabled: 'true' }, action: 'Install and restart', installs: 0, cancels: [], cancel: null })
  })

  // canopi-f47t.52.228.15: switching to another app fires focusout with no related target while the window has no
  // focus; Cancel must stay focused through a download settling meanwhile, or focus drops to the page on return.
  it('canopi-f47t.52.228.15: a download settling while the window is away keeps About\'s focused Cancel', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    cancelButton()!.focus()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    try {
      await act(async () => { cancelButton()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })) })
      await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    } finally {
      hasFocus.mockRestore()
    }

    expect({ focused: document.activeElement === cancelButton(), cancelDisabled: cancelButton()?.getAttribute('aria-disabled') })
      .toEqual({ focused: true, cancelDisabled: 'true' })
  })

  // 2.1-Q252: Windows shows Linux's two download reasons; Retry, offered when the failure allows it, downloads again.
  it('on Windows a failed or unverifiable download shows Update not installed with its reason, and Retry downloads again', async () => {
    const failedWith = async (failure: UpdaterFailure) => {
      const fake = fakePort()
      await showAbout(controllerFor(fake.port, 'windows'))
      await press(action())
      await settle(() => fake.checks[0]!.resolve(OFFER))
      await press(action())
      await settle(() => fake.downloads[0]!.reject(failure))
      return { fake, status: status(), action: action().textContent }
    }

    const notVerified = await failedWith(NOT_VERIFIED)
    unmount(container)
    const failed = await failedWith(DOWNLOAD_FAILED)
    await press(action())
    await settle(() => failed.fake.downloads[1]!.resolve({ kind: 'verified' }))

    expect({
      notVerified: { status: notVerified.status, action: notVerified.action },
      failed: { status: failed.status, action: failed.action },
      retried: { checks: failed.fake.checks.length, downloads: failed.fake.downloads.length, action: action().textContent },
    }).toEqual({
      notVerified: { status: 'Update not installed: the download could not be verified', action: 'Check for updates' },
      failed: { status: 'Update not installed: the download failed', action: 'Retry' },
      retried: { checks: 1, downloads: 2, action: 'Install and restart' },
    })
  })

  it('no focus moves when a check, download or install settles', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    const button = action()
    button.focus()
    await press(button)
    await settle(() => fake.checks[0]!.resolve(OFFER))
    expect(document.activeElement).toBe(button)
    await press(button)
    await settle(() => fake.progress({ received: 1, total: 2 }))
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))
    expect(document.activeElement).toBe(button)
    await press(button)
    await settle(() => fake.installs[0]!.reject(PROMPT_CLOSED))
    expect({ focused: document.activeElement === button, same: action() === button }).toEqual({ focused: true, same: true })
  })
})

describe('Settings › Check for updates at launch', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    invoke.mockClear()
  })

  afterEach(() => {
    unmount(container)
    container.remove()
    closeSettingsDialog()
  })

  it('Settings shows Check for updates at launch, on when the key row is missing, and writes only that row', async () => {
    const writes: boolean[] = []
    const port = { get: () => Promise.resolve(true), set: (on: boolean) => { writes.push(on); return Promise.resolve() } }
    openSettingsDialog()
    await act(async () => { render(<SettingsDialog updates={<LaunchCheckSwitch port={port} />} />, container) })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-section="about"]')!.click() })
    await act(async () => { await Promise.resolve() })
    const toggle = () => container.querySelector<HTMLInputElement>('[data-launch-check] input[role="switch"]')!

    expect({ label: container.querySelector('[data-launch-check]')!.textContent, on: toggle().checked })
      .toEqual({ label: 'Check for updates at launch', on: true })
    await act(async () => { toggle().click() })
    expect({ on: toggle().checked, writes, invokes: invoke.mock.calls }).toEqual({ on: false, writes: [false], invokes: [] })
  })
})

describe('Web root', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
  })

  afterEach(() => {
    unmount(container)
    container.remove()
    closeAboutCanopiDialog()
    closeSettingsDialog()
  })

  it('the Web root renders About and Settings with no updater control and mounts no notice', async () => {
    await act(async () => { render(<WebApp workspace={<div />} />, container) })
    await act(async () => { aboutCanopiDialogOpen.value = true })
    const about = container.querySelector('[role="dialog"]')!.textContent
    await act(async () => { closeAboutCanopiDialog(); openSettingsDialog() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-section="about"]')!.click() })

    expect({
      about: about?.includes('Check for updates'),
      section: container.querySelector('[data-about-updates]'),
      launchCheck: container.querySelector('[data-launch-check]'),
      notice: container.querySelector('[data-notice-key="update.available"]'),
    }).toEqual({ about: false, section: null, launchCheck: null, notice: null })
  })
})

describe('Desktop root', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    closeAboutCanopiDialog()
    host.launchCheck = true
    host.launchNotice = false
  })

  afterEach(() => {
    unmount(container)
    container.remove()
    closeAboutCanopiDialog()
    closeWaitsFor.value = null
    multiOpenNotice.value = null
    resetNoticesForTests()
    resetFailureNoticesForTests()
    resetFrontendDiagnosticsForTests()
  })

  /** The notice row while it shows the notice raised under `key`; null otherwise. */
  function rowNotice(key: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-notice-row][data-notice-key="${key}"]`)
  }

  /** The closing notice while a window close waits for `waitsFor`, and the row once the wait settles. */
  async function closingNotice(waitsFor: 'install' | 'exit') {
    host.launchCheck = false
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await act(async () => { closeWaitsFor.value = waitsFor })
    const notice = rowNotice('update.closing')
    const shown = { text: notice?.textContent, role: notice?.getAttribute('role') }
    await act(async () => { closeWaitsFor.value = null })
    return { shown, after: rowNotice('update.closing') }
  }

  function dismissShown(): Promise<void> {
    return act(async () => { container.querySelector<HTMLButtonElement>('[data-notice-row] button[aria-label="Dismiss"]')!.click() })
  }

  it('the Desktop root shows the launch check\'s notice on the notice row once, takes no focus, and its About offers Download and install (2.1-Q293)', async () => {
    const before = document.activeElement
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await vi.waitFor(() => expect(rowNotice('update.available')).not.toBeNull())

    const rows = container.querySelectorAll('[data-notice-row]').length
    expect({ rows, text: rowNotice('update.available')!.textContent, modal: container.querySelector('[aria-modal]'), focused: document.activeElement === before })
      .toEqual({ rows: 1, text: 'Canopi 2.1.0 is availableAbout Canopi', modal: null, focused: true })
    await act(async () => { [...rowNotice('update.available')!.querySelectorAll('button')].find((button) => button.textContent === 'About Canopi')!.click() })
    expect(container.querySelector('[data-about-updates] button')!.textContent).toBe('Download and install')
    // Opening About is no dismissal: the notice stays until dismissed or installed this session (2.1-Q293).
    expect(rowNotice('update.available')).not.toBeNull()
  })

  it('[canopi-f47t.52.36] a dismissed update notice stays hidden for the session and shows again at the next launch, with nothing stored (2.1-Q293)', async () => {
    const stored = { local: localStorage.length, session: sessionStorage.length }
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await vi.waitFor(() => expect(rowNotice('update.available')).not.toBeNull())
    await dismissShown()
    expect(rowNotice('update.available')).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(rowNotice('update.available')).toBeNull()
    // The next launch: a fresh root over the same host.
    unmount(container)
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await vi.waitFor(() => expect(rowNotice('update.available')).not.toBeNull())
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(stored)
  })

  it('[canopi-f47t.52.36] a launch notice and a failure notice share the one notice row, the oldest first with "1 of 2" (2.1-Q290)', async () => {
    host.launchCheck = false
    multiOpenNotice.value = 7
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await act(async () => { reportFailure(new Error('disk full'), { shown: 'notice', source: 'export', code: { kind: 'io', io: 'no_space' } }) })
    const rows = container.querySelectorAll('[data-notice-row]').length
    const shown = rowNotice('launch.multi-open')?.textContent?.includes('Canopi opens one Design at a time')
    expect({ rows, shown, count: container.querySelector('[data-notice-count]')?.textContent }).toEqual({ rows: 1, shown: true, count: '1 of 2' })
    await dismissShown()
    expect({ multiOpen: multiOpenNotice.value, rows: container.querySelectorAll('[data-notice-row]').length }).toEqual({ multiOpen: null, rows: 1 })
  })

  it('the Desktop root runs no launch check when Check for updates at launch is off', async () => {
    host.launchCheck = false
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(rowNotice('update.available')).toBeNull()
  })

  it('after a Windows update that did not install, the Desktop root says Update not installed once', async () => {
    host.launchCheck = false
    host.launchNotice = true
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await vi.waitFor(() => expect(container.textContent).toContain('Update not installed'))
  })

  it('Update not installed stays past the toast timeout, takes no focus, and goes only when the user dismisses it (Q234)', async () => {
    host.launchCheck = false
    host.launchNotice = true
    const before = document.activeElement
    vi.useFakeTimers()
    try {
      await act(async () => { render(<App updates={rootPorts()} />, container) })
      await vi.waitFor(() => expect(rowNotice('update.not-installed')).not.toBeNull())
      await act(async () => { vi.advanceTimersByTime(60_000) })
    } finally {
      vi.useRealTimers()
    }
    const notice = rowNotice('update.not-installed')
    expect({ text: notice?.textContent, focused: document.activeElement === before })
      .toEqual({ text: 'Update not installed', focused: true })
    await dismissShown()
    expect(rowNotice('update.not-installed')).toBeNull()
  })

  it('while a window close waits for an update install the Desktop root says Installing update… (canopi-f47t.52.228.15)', async () => {
    expect(await closingNotice('install')).toEqual({ shown: { text: 'Installing update…', role: 'status' }, after: null })
  })

  it('while a window close waits for an update\'s exit flush, installer start or restart the Desktop root says Finishing update… (canopi-f47t.52.228)', async () => {
    expect(await closingNotice('exit')).toEqual({ shown: { text: 'Finishing update…', role: 'status' }, after: null })
  })
})
