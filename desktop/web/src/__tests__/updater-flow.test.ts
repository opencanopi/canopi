import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveProblemChoice, SaveProblemRequest } from '../app/document-session/save-problem'
import { flushBeforeExit } from '../app/shell/close-guard'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../app/updates/controller'
import { UPDATE_STATE_KINDS, canTransition, updateFailureMessage, type UpdateFailureMessage, type UpdateStateKind } from '../app/updates/state'
import { t } from '../i18n'
import { createUuid } from '../utils/ids'
import type { UpdateDownload, UpdateFailure, UpdateFailureCode, UpdateOffer, UpdateOp, UpdateOs, UpdateProgress } from '../generated/contracts'

// The Desktop updater's user paths (canopi-f47t.52.228.15) through the real state machine, controller and close guard:
// fakes stand only at the ports, the host's update commands (UpdaterPort, what ipc/update.ts invokes) and the close
// guard's Design flush, settings flush and save-problem question, answered from a script. The states are the
// contract's UpdateState kinds (2.1-M208), the failures typed §2 Failure values (its updater codes) and the close
// dialog the close guard's (ADR 0024, 2.1-Q182).

/** The close guard's ports, which each test's fake host fills (vi.mock factories run before the imports above). */
/**
 * About's rendering of a failed state's message: app/updates names keys only, so it adds no cross-area edge to i18n
 * (2.1-M200), and the caller translates. F6-c3 replaces this with About itself.
 */
function shown(failure: UpdateFailure): string | null {
  const message: UpdateFailureMessage | null = updateFailureMessage(failure)
  if (message === null) return null
  return message.reason === undefined ? t(message.key) : t(message.key, { reason: t(message.reason) })
}

const closePorts = vi.hoisted(() => ({
  flushDesign: (): Promise<boolean> => Promise.resolve(true),
  flushSettings: (): Promise<void> => Promise.resolve(),
  ask: (_request: unknown): Promise<string> => Promise.resolve('cancel'),
  designOpen: true,
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../app/document-session/transition', () => ({
  designContinuousSave: { flush: () => closePorts.flushDesign(), conflict: { peek: () => null } },
}))
vi.mock('../app/document-session/store', () => ({
  currentDesign: { peek: () => (closePorts.designOpen ? {} : null) },
}))
vi.mock('../app/document-session/save-problem', () => ({
  requestSaveProblemDecision: (request: unknown) => closePorts.ask(request),
}))
vi.mock('../app/settings/projection', () => ({ flushSettingsProjection: () => closePorts.flushSettings() }))

/** A command's reply: contracts §1, `Promise<Result<Reply, Failure>>`. */
type Result<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly failure: UpdateFailure }

/** One step of the close guard as the fake saw it: the Design flush, or a save-problem question and its answer. */
type CloseEvent = 'design-flushed' | { readonly asked: SaveProblemRequest, readonly answer: SaveProblemChoice }

/**
 * What a test drives and reads. `settlements` stands in for the executor's settlement log (`op settlement`), `staged`
 * for the verified payload, `closeLog` for what the close guard did and asked, `installs` and `restarts` for the
 * installs and restarts run, `order` for the close guard's flush, installs and restarts in the order they ran, and
 * `calls` for how often each command was invoked.
 */
interface FakeUpdateHost {
  readonly updater: UpdaterPort
  readonly staged: string[]
  readonly settlements: string[]
  readonly closeLog: CloseEvent[]
  readonly installs: string[]
  readonly restarts: (string | null)[]
  readonly order: string[]
  readonly calls: { check: number, download: number }
  /** The open Design's path; the test switches it between Designs. */
  designPath: string | null
}

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/canopi/canopi/releases/tag/v2.1.0' }
/** The executor's silent settlement for a cancelled op (contracts §2): never a user-facing failure. */
const CANCELLED: UpdateFailure = { code: { kind: 'cancelled' }, user_may_retry: false, op: 'updater.download', detail: 'cancelled by the user' }
const OFFLINE: UpdateFailure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check', detail: 'offline' }
const ADMIN_PROMPT_DISMISSED: UpdateFailure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install', detail: 'pkexec exit 126' }
const INSTALLER_FAILED: UpdateFailure = { code: { kind: 'update_install_failed', bundle: 'nsis' }, user_may_retry: true, op: 'updater.install', detail: 'installer did not start' }

interface HostScript {
  readonly check?: Result<UpdateOffer | null>
  readonly download?: UpdateDownload
  readonly install?: Result<null>
  readonly launchCheck?: boolean
  /** Progress the download reports over its channel before it settles. */
  readonly progress?: readonly UpdateProgress[]
  /** A download that settles only when the test calls the returned function. */
  readonly holdDownload?: boolean
  readonly settingsSaveable?: boolean
  readonly designOpen?: boolean
  readonly designPath?: string | null
  /** The user's answers to the close guard's questions, in order. */
  readonly answers?: readonly SaveProblemChoice[]
}

function fakeHost(script: HostScript = {}): FakeUpdateHost & { releaseDownload: () => void } {
  const staged: string[] = []
  const settlements: string[] = []
  const closeLog: CloseEvent[] = []
  const installs: string[] = []
  const restarts: (string | null)[] = []
  const order: string[] = []
  const calls = { check: 0, download: 0 }
  const answers = [...(script.answers ?? [])]
  let cancelRequested = false
  let releaseDownload = () => {}
  const settle = <T>(op: string, result: Result<T>): Promise<T> => {
    settlements.push(`${op} ${result.ok ? 'ok' : String(result.failure.code.kind)}`)
    return result.ok ? Promise.resolve(result.value) : Promise.reject(result.failure)
  }
  closePorts.designOpen = script.designOpen ?? true
  closePorts.flushDesign = () => {
    closeLog.push('design-flushed')
    order.push('design-flushed')
    return Promise.resolve(true)
  }
  closePorts.flushSettings = () => (script.settingsSaveable ?? true) ? Promise.resolve() : Promise.reject(new Error('settings store unwritable'))
  closePorts.ask = (request) => {
    const answer = answers.shift() ?? 'cancel'
    closeLog.push({ asked: request as SaveProblemRequest, answer })
    return Promise.resolve(answer)
  }
  const updater: UpdaterPort = {
    checkForUpdate: () => {
      calls.check += 1
      return settle('updater.check', script.check ?? { ok: true, value: OFFER })
    },
    // The transfer finishes a task later (or when released), so a cancel issued meanwhile drops it and nothing is
    // staged. The flag is never reset: each test runs one download, and a cancel the controller forwards before the
    // transfer starts must still count.
    downloadUpdate: (_operation, onProgress) => {
      calls.download += 1
      return new Promise<UpdateDownload>((resolve, reject) => {
        const finish = () => {
          for (const progress of script.progress ?? []) onProgress(progress)
          if (cancelRequested) {
            settle('updater.download', { ok: false, failure: CANCELLED }).catch(reject)
            return
          }
          staged.push(OFFER.version)
          const reply: UpdateDownload = script.download ?? { kind: 'verified' }
          void settle('updater.download', { ok: true, value: reply }).then(resolve)
        }
        if (script.holdDownload) releaseDownload = finish
        else setTimeout(finish, 0)
      })
    },
    cancelUpdate: () => {
      cancelRequested = true
      return Promise.resolve()
    },
    installUpdate: () => {
      const result = script.install ?? { ok: true, value: null }
      if (result.ok) installs.push(OFFER.version)
      order.push('install')
      return settle('updater.install', result).then(() => undefined)
    },
    restartAfterUpdate: (designPath) => {
      restarts.push(designPath)
      order.push('restart')
      return Promise.resolve()
    },
    getLaunchCheck: () => Promise.resolve(script.launchCheck ?? true),
  }
  const host = {
    updater, staged, settlements, closeLog, installs, restarts, order, calls,
    designPath: script.designPath === undefined ? '/designs/a.canopi' : script.designPath,
    releaseDownload: () => releaseDownload(),
  }
  return host
}

function startUpdater(
  host: FakeUpdateHost,
  options: { readonly platform: UpdateOs, readonly onUpdateAvailable?: (offer: UpdateOffer) => void },
): UpdateController {
  return createUpdateController({
    updater: host.updater,
    platform: options.platform,
    flushBeforeExit,
    mintOperationId: createUuid,
    currentDesignPath: () => host.designPath,
    ...(options.onUpdateAvailable ? { onUpdateAvailable: options.onUpdateAvailable } : {}),
  })
}

beforeEach(() => {
  fakeHost()
})

describe('Desktop updater user paths', () => {
  // A cancel goes downloading to idle (states.md Updater, 2.1-M208); "settles cancelled" is the executor's silent
  // settlement in its log, never a failed state.
  it('cancelled update download leaves nothing staged and settles cancelled', async () => {
    const host = fakeHost()
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.check()
    const download = updater.download()
    updater.cancel()
    await download

    expect({ state: updater.state.value, staged: host.staged, settlements: host.settlements }).toEqual({
      state: { kind: 'idle' },
      staged: [],
      settlements: ['updater.check ok', 'updater.download cancelled'],
    })
  })

  // The settings question is the close guard's 'settings-failed' dialog: Retry, Close anyway ('discard') and Cancel
  // (2.1-Q182). On Windows the flush runs before the installer (2.1-Q234).
  it('update install with an unsaveable settings store flushes the Design first, then offers Retry, Close anyway and Cancel', async () => {
    const host = fakeHost({ settingsSaveable: false, answers: ['retry', 'discard'] })
    const updater = startUpdater(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    const settingsFailed: SaveProblemRequest = { kind: 'settings-failed', designSaved: true }
    expect({ closeLog: host.closeLog, installs: host.installs }).toEqual({
      closeLog: ['design-flushed', { asked: settingsFailed, answer: 'retry' }, { asked: settingsFailed, answer: 'discard' }],
      installs: [OFFER.version],
    })
  })

  it('on Windows an update install cancelled at the close dialog installs nothing', async () => {
    const host = fakeHost({ settingsSaveable: false, answers: ['cancel'] })
    const updater = startUpdater(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state.value, installs: host.installs, closeLog: host.closeLog }).toEqual({
      state: { kind: 'verified' },
      installs: [],
      closeLog: ['design-flushed', { asked: { kind: 'settings-failed', designSaved: true }, answer: 'cancel' }],
    })
  })

  // About renders the failed state's updateFailureMessage; F6-c3 extends this test to render About itself.
  it('offline update check settles network.offline and About shows it', async () => {
    const updater = startUpdater(fakeHost({ check: { ok: false, failure: OFFLINE } }), { platform: 'linux' })

    await updater.check()

    expect(updater.state.value).toEqual({ kind: 'failed', failure: OFFLINE })
    expect(shown(OFFLINE)).toBe('Can’t check for updates while offline')
  })

  // F6-c3 extends this test to render About with the failed state's updateFailureMessage.
  it('a dismissed .deb admin prompt keeps the Design open with Update not installed', async () => {
    const host = fakeHost({ install: { ok: false, failure: ADMIN_PROMPT_DISMISSED } })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state.value, closeLog: host.closeLog, installs: host.installs }).toEqual({
      state: { kind: 'failed', failure: ADMIN_PROMPT_DISMISSED },
      closeLog: [],
      installs: [],
    })
    expect(shown(ADMIN_PROMPT_DISMISSED)).toBe('Update not installed: the password prompt was closed')
  })
})

describe('Desktop updater controller', () => {
  it('the launch check runs once per launch, only when Check for updates at launch is on', async () => {
    const on = fakeHost({ launchCheck: true })
    const onUpdater = startUpdater(on, { platform: 'linux' })
    await onUpdater.launchCheck()
    await onUpdater.launchCheck()
    const off = fakeHost({ launchCheck: false })
    await startUpdater(off, { platform: 'linux' }).launchCheck()

    expect({ on: on.calls.check, off: off.calls.check }).toEqual({ on: 1, off: 0 })
  })

  it('an update the launch check finds raises one notice and downloads nothing; About\'s check raises none', async () => {
    const notices: UpdateOffer[] = []
    const host = fakeHost()
    const updater = startUpdater(host, { platform: 'linux', onUpdateAvailable: (offer) => notices.push(offer) })

    await updater.launchCheck()
    const afterLaunch = updater.state.value
    const about = startUpdater(fakeHost(), { platform: 'linux', onUpdateAvailable: (offer) => notices.push(offer) })
    await about.check()

    expect({ notices, afterLaunch, downloads: host.calls.download }).toEqual({
      notices: [OFFER],
      afterLaunch: { kind: 'available', offer: OFFER },
      downloads: 0,
    })
  })

  it('a second Check while checking or a second Download while downloading starts nothing new', async () => {
    const host = fakeHost({ holdDownload: true })
    const updater = startUpdater(host, { platform: 'linux' })

    await Promise.all([updater.check(), updater.check()])
    const first = updater.download()
    const second = updater.download()
    host.releaseDownload()
    await Promise.all([first, second])

    expect({ calls: host.calls, state: updater.state.value }).toEqual({
      calls: { check: 1, download: 1 },
      state: { kind: 'verified' },
    })
  })

  it('About\'s Check pressed during a download keeps its progress, its cancel and its join (canopi-f47t.52.228.15)', async () => {
    const host = fakeHost({ holdDownload: true, progress: [{ received: 5, total: 10 }] })
    const updater = startUpdater(host, { platform: 'linux' })
    const seen: unknown[] = []

    await updater.check()
    const download = updater.download()
    await updater.check()
    const joined = updater.download()
    const stop = updater.state.subscribe((state) => {
      if (state.kind === 'downloading') seen.push(state.progress)
    })
    updater.cancel()
    host.releaseDownload()
    await Promise.all([download, joined])
    stop()

    expect({ seen, calls: host.calls, state: updater.state.value, settlements: host.settlements }).toEqual({
      seen: [{ received: 0, total: null }, { received: 5, total: 10 }],
      calls: { check: 1, download: 1 },
      state: { kind: 'idle' },
      settlements: ['updater.check ok', 'updater.download cancelled'],
    })
  })

  it('download progress arrives over update_download\'s channel and shows while downloading', async () => {
    const host = fakeHost({ holdDownload: true, progress: [{ received: 512, total: 2048 }] })
    const updater = startUpdater(host, { platform: 'linux' })
    const seen: unknown[] = []

    await updater.check()
    const download = updater.download()
    seen.push(updater.state.value)
    const stop = updater.state.subscribe((state) => {
      if (state.kind === 'downloading') seen.push(state)
    })
    host.releaseDownload()
    await download
    stop()

    expect(seen).toEqual([
      { kind: 'downloading', progress: { received: 0, total: null } },
      { kind: 'downloading', progress: { received: 0, total: null } },
      { kind: 'downloading', progress: { received: 512, total: 2048 } },
    ])
  })

  it('an installer that cannot be replaced by Canopi settles link_only with its download page', async () => {
    const url = 'https://projectcanopi.com/download'
    const updater = startUpdater(fakeHost({ download: { kind: 'link_only', url } }), { platform: 'linux' })

    await updater.check()
    await updater.download()

    expect(updater.state.value).toEqual({ kind: 'link_only', url })
  })

  it('on Linux the update installs, then the close request flushes and restarts into the Design open at that moment', async () => {
    const host = fakeHost({ designPath: '/designs/a.canopi' })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.check()
    await updater.download()
    host.designPath = '/designs/b.canopi'
    await updater.install()

    expect({ order: host.order, restarts: host.restarts, state: updater.state.value.kind }).toEqual({
      order: ['install', 'design-flushed', 'restart'],
      restarts: ['/designs/b.canopi'],
      state: 'close_requested',
    })
  })

  it('on Linux a Draft restarts with no Design path', async () => {
    const host = fakeHost({ designPath: null, designOpen: false })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect(host.restarts).toEqual([null])
  })

  it('on Linux a close cancelled after the install shows Restart to finish updating and the update stays installed', async () => {
    const host = fakeHost({ settingsSaveable: false, answers: ['cancel', 'discard'] })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.check()
    await updater.download()
    await updater.install()
    const afterCancel = { state: updater.state.value, installs: [...host.installs], restarts: [...host.restarts] }
    await updater.restart()

    expect({ afterCancel, restarts: host.restarts }).toEqual({
      afterCancel: { state: { kind: 'installed' }, installs: [OFFER.version], restarts: [] },
      restarts: ['/designs/a.canopi'],
    })
  })

  it('on Windows the close request runs before the installer, which runs only on proceed', async () => {
    const host = fakeHost()
    const updater = startUpdater(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ order: host.order, state: updater.state.value.kind }).toEqual({
      order: ['design-flushed', 'install'],
      state: 'close_requested',
    })
  })

  it('on Windows an installer that cannot launch after the close dialog settles failed with the Design open', async () => {
    const host = fakeHost({ install: { ok: false, failure: INSTALLER_FAILED } })
    const updater = startUpdater(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state.value, restarts: host.restarts }).toEqual({
      state: { kind: 'failed', failure: INSTALLER_FAILED },
      restarts: [],
    })
  })
})

/** The contract's UpdateState kinds (contracts §3, 2.1-M208), spelled here so the table below is exhaustive over them. */
const CONTRACT_KINDS: readonly UpdateStateKind[] = [
  'idle', 'checking', 'available', 'downloading', 'verified', 'installing', 'installed', 'close_requested', 'failed',
  'link_only',
]

/**
 * states.md's Updater diagram, edge for edge, where it agrees with contracts §3; where they differ §3 wins: the
 * link_only probe runs in update_download (its reply is `verified` or `link_only`), so link_only follows downloading,
 * not checking; progress is downloading to downloading; and a Windows installer that fails to launch after the close
 * dialog's proceed settles failed with the Design open (close_requested to failed).
 */
const EDGES: readonly (readonly [UpdateStateKind, UpdateStateKind])[] = [
  ['idle', 'checking'],
  ['checking', 'idle'],
  ['checking', 'failed'],
  ['checking', 'available'],
  ['available', 'downloading'],
  ['downloading', 'downloading'],
  ['downloading', 'idle'],
  ['downloading', 'failed'],
  ['downloading', 'verified'],
  ['downloading', 'link_only'],
  ['failed', 'idle'],
  ['verified', 'installing'],
  ['verified', 'close_requested'],
  ['installing', 'installed'],
  ['installing', 'failed'],
  ['installed', 'close_requested'],
  ['close_requested', 'installed'],
  ['close_requested', 'verified'],
  ['close_requested', 'failed'],
]

describe('UpdateState transition table (2.1-M208, ADR 0028)', () => {
  it('names exactly the contract\'s UpdateState kinds', () => {
    expect([...UPDATE_STATE_KINDS].sort()).toEqual([...CONTRACT_KINDS].sort())
  })

  it('allows every diagram edge and refuses every other pair of kinds', () => {
    const allowed = CONTRACT_KINDS.flatMap((from) => CONTRACT_KINDS.filter((to) => canTransition(from, to)).map((to) => `${from} -> ${to}`))
    expect(allowed.sort()).toEqual(EDGES.map(([from, to]) => `${from} -> ${to}`).sort())
  })
})

/** Every updater failure code (contracts §2 updater row and the codes it reuses), with the op it settles on. */
const FAILURE_TEXT: readonly (readonly [UpdateOp, UpdateFailureCode, string | null])[] = [
  ['updater.check', { kind: 'network', network: 'offline' }, 'Can’t check for updates while offline'],
  ['updater.check', { kind: 'network', network: 'timeout' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'io', io: 'other' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'invalid' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'busy', lane: 'network' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'internal' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'cancelled' }, null],
  ['updater.check', { kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'deb' }, 'Download the update from projectcanopi.com'],
  ['updater.download', { kind: 'update_admin_prompt_unavailable' }, 'Download the update from projectcanopi.com'],
  ['updater.download', { kind: 'update_signature_refused' }, 'Update not installed: the download could not be verified'],
  ['updater.download', { kind: 'network', network: 'too_large' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'io', io: 'no_space' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'cancelled' }, null],
  ['updater.install', { kind: 'update_admin_prompt_dismissed' }, 'Update not installed: the password prompt was closed'],
  ['updater.install', { kind: 'update_admin_prompt_refused' }, 'Update not installed: permission was refused'],
  ['updater.install', { kind: 'update_location_not_writable' }, 'Update not installed: Canopi’s folder can’t be changed'],
  ['updater.install', { kind: 'update_install_failed', bundle: 'appimage' }, 'Update not installed: the installer reported an error'],
  ['updater.install', { kind: 'io', io: 'permission_denied' }, 'Update not installed: the installer reported an error'],
  ['updater.install', { kind: 'internal' }, 'Update not installed: the installer reported an error'],
]

describe('updater failure messages (2.1-Q237, 2.1-Q244)', () => {
  it('maps every updater failure code to its one message, and a cancel to none', () => {
    const messages = FAILURE_TEXT.map(([op, code]) => shown({ code, op, user_may_retry: true, detail: '' }))
    expect(messages).toEqual(FAILURE_TEXT.map(([, , text]) => text))
  })
})
