// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The Desktop updater's UI (canopi-f47t.52.228.15) through the real controller and components; fakes stand only at
// the host's update commands (ipc/update.ts, the UpdaterPort). Copy is 2.1-Q237 and Q244; the download starts
// only from About (Q235); About shows the offer's version and What's new (Q236); the switch is its own key row (M206);
// the notice mounts only in the Desktop root (M211); Web shows no updater (Q201, ADR 0005).

import { aboutCanopiDialogOpen, closeAboutCanopiDialog } from '../app/about/state'
import { CANOPI_VERSION } from '../app/about/metadata'
import { locale } from '../app/settings/state'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../app/updates/controller'
import { AboutCanopiDialog, AboutUpdates, UpdateAvailableNotice } from '../components/shared/AboutCanopiDialog'
import type { UpdateDownload, UpdateFailure, UpdateOffer, UpdateOs, UpdateProgress } from '../generated/contracts'
import { unmount } from './support/unmount'

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/opencanopi/canopi/releases/tag/v2.1.0' }
const DOWNLOAD_PAGE = 'https://projectcanopi.com'
const OFFLINE: UpdateFailure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check', detail: 'offline' }
const NO_ENTRY: UpdateFailure = { code: { kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'appimage' }, user_may_retry: false, op: 'updater.check', detail: 'no entry' }
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

/** The host's update commands, each reply held until the test settles it; progress goes through `progress`. */
function fakePort() {
  const checks: Pending<UpdateOffer | null>[] = []
  const downloads: Pending<UpdateDownload>[] = []
  const installs: Pending<void>[] = []
  let progress: (value: UpdateProgress) => void = () => {}
  const port: UpdaterPort = {
    checkForUpdate: () => { const next = pending<UpdateOffer | null>(); checks.push(next); return next.promise },
    downloadUpdate: (_operation, onProgress) => {
      progress = onProgress
      const next = pending<UpdateDownload>()
      downloads.push(next)
      return next.promise
    },
    installUpdate: () => { const next = pending<void>(); installs.push(next); return next.promise },
    cancelUpdate: () => Promise.resolve(),
    restartAfterUpdate: () => Promise.resolve(),
    getLaunchCheck: () => Promise.resolve(true),
  }
  return { port, checks, downloads, installs, progress: (value: UpdateProgress) => progress(value) }
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
