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
import { closeSettingsDialog, openSettingsDialog } from '../app/shell/dialogs'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../app/updates/controller'
import { AboutCanopiDialog, AboutUpdates, UpdateAvailableNotice } from '../components/shared/AboutCanopiDialog'
import { LaunchCheckSwitch, SettingsDialog } from '../components/shared/SettingsDialog'
import type { UpdateDownload, UpdateFailure, UpdateOffer, UpdateOs, UpdateProgress } from '../generated/contracts'
import { WebApp } from '../web/WebApp'
import { unmount } from './support/unmount'

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/opencanopi/canopi/releases/tag/v2.1.0' }
const DOWNLOAD_PAGE = 'https://projectcanopi.com'
const OFFLINE: UpdateFailure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check', detail: 'offline' }
const NO_ENTRY: UpdateFailure = { code: { kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'appimage' }, user_may_retry: false, op: 'updater.check', detail: 'no entry' }
const CANCELLED: UpdateFailure = { code: { kind: 'cancelled' }, user_may_retry: false, op: 'updater.download', detail: 'cancelled by the user' }
const PROMPT_CLOSED: UpdateFailure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install', detail: 'pkexec exit 126' }

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
    await settle(() => fake.installs[0]!.resolve())
    // Linux: installed, and the close guard's Cancel kept the window, so the restart waits for the user (2.1-Q233).
    expect(action().textContent).toBe('Restart to finish updating')
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
      cancel: cancelButton(),
      keptFocus,
      focused: document.activeElement === action(),
    }).toEqual({ cancels: ['op-2'], staged: [], action: 'Check for updates', disabled: null, status: '', cancel: null, keptFocus: true, focused: true })
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

  it('a download settling while Cancel has focus leaves focus on About\'s update button', async () => {
    const fake = fakePort()
    await showAbout(controllerFor(fake.port))
    await press(action())
    await settle(() => fake.checks[0]!.resolve(OFFER))
    await press(action())
    cancelButton()!.focus()
    await settle(() => fake.downloads[0]!.resolve({ kind: 'verified' }))

    expect({ action: action().textContent, cancel: cancelButton(), focused: document.activeElement === action() })
      .toEqual({ action: 'Install and restart', cancel: null, focused: true })
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

describe('Available-update notice', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    closeAboutCanopiDialog()
  })

  afterEach(() => {
    unmount(container)
    container.remove()
    closeAboutCanopiDialog()
  })

  it('the notice is non-modal, takes no focus and opens About', async () => {
    const before = document.createElement('button')
    document.body.appendChild(before)
    before.focus()
    await act(async () => { render(<UpdateAvailableNotice version="2.1.0" onDismiss={() => {}} />, container) })

    const notice = container.querySelector<HTMLElement>('[role="status"]')!
    expect({ text: notice.textContent, modal: container.querySelector('[aria-modal]'), focused: document.activeElement === before })
      .toEqual({ text: 'Canopi 2.1.0 is availableAbout Canopi', modal: null, focused: true })
    await act(async () => { notice.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(aboutCanopiDialogOpen.value).toBe(true)
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
      notice: container.querySelector('[data-update-notice]'),
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
  })

  it('the Desktop root shows the launch check\'s notice once, takes no focus, and its About offers Download and install', async () => {
    const before = document.activeElement
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await vi.waitFor(() => expect(container.querySelector('[data-update-notice]')).not.toBeNull())

    expect({ notices: container.querySelectorAll('[data-update-notice]').length, focused: document.activeElement === before })
      .toEqual({ notices: 1, focused: true })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-update-notice] button')!.click() })
    expect(container.querySelector('[data-about-updates] button')!.textContent).toBe('Download and install')
    expect(container.querySelector('[data-update-notice]')).toBeNull()
  })

  it('the Desktop root runs no launch check when Check for updates at launch is off', async () => {
    host.launchCheck = false
    await act(async () => { render(<App updates={rootPorts()} />, container) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(container.querySelector('[data-update-notice]')).toBeNull()
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
      await vi.waitFor(() => expect(container.querySelector('[data-update-failed-notice]')).not.toBeNull())
      await act(async () => { vi.advanceTimersByTime(60_000) })
    } finally {
      vi.useRealTimers()
    }
    const notice = container.querySelector<HTMLElement>('[data-update-failed-notice]')
    expect({ text: notice?.textContent, focused: document.activeElement === before })
      .toEqual({ text: 'Update not installedDismiss', focused: true })
    await act(async () => { notice!.querySelector<HTMLButtonElement>('button')!.click() })
    expect(container.querySelector('[data-update-failed-notice]')).toBeNull()
  })
})
