import { effect } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestSessionCore, makeTestDesign, type TestSessionCoreHandle } from './support/session-core-fixture'
import {
  answerSaveProblem,
  saveProblem,
  type SaveProblemChoice,
  type SaveProblemRequest,
} from '../app/document-session/save-problem'
import { flushBeforeExit, holdCloseUntilSettled, registerCloseGuard, type CloseGuardLifetime } from '../app/shell/close-guard'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../app/updates/controller'
import { checkForUpdate as checkForUpdateOverIpc } from '../ipc/update'
import { updateFailureMessage, type UpdateFailureMessage } from '../failures/messages'
import { t } from '../i18n'
import { createUuid } from '../utils/ids'
import type { UpdateDownload, UpdaterFailure, UpdateOffer, UpdateOp, UpdateOs, UpdateProgress } from '../generated/contracts'

// The Desktop updater's user paths (canopi-f47t.52.228.15) through the real state machine, controller,
// SessionCore and close guard.

type Result<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly failure: UpdaterFailure }
type CloseEvent = 'design-flushed' | { readonly asked: SaveProblemRequest, readonly answer: SaveProblemChoice }

const fail = (op: UpdateOp, code: UpdaterFailure['code'], user_may_retry = true): UpdaterFailure =>
  ({ code, op, user_may_retry, operation: null, detail: null })

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/canopi/canopi/releases/tag/v2.1.0' }
const CANCELLED = fail('updater.download', { kind: 'cancelled' }, false)
const OFFLINE = fail('updater.check', { kind: 'network', network: 'offline' })
const ADMIN_PROMPT_DISMISSED = fail('updater.install', { kind: 'update_admin_prompt_dismissed' })
const INSTALLER_FAILED = fail('updater.install', { kind: 'update_install_failed', bundle: 'nsis' })

interface HostScript {
  readonly check?: Result<UpdateOffer | null>
  readonly download?: UpdateDownload
  readonly install?: Result<null>
  readonly launchCheck?: boolean
  readonly progress?: readonly UpdateProgress[]
  readonly holdDownload?: boolean
  readonly settingsSaveable?: boolean
  readonly designOpen?: boolean
  readonly answers?: readonly SaveProblemChoice[]
}

const activeCleanups: Array<() => void> = []

afterEach(() => {
  while (activeCleanups.length > 0) activeCleanups.pop()?.()
  if (saveProblem.peek()) answerSaveProblem('cancel')
})

function makeHost(script: HostScript = {}) {
  const staged: string[] = []
  const settlements: string[] = []
  const closeLog: CloseEvent[] = []
  const installs: string[] = []
  const restarts: number[] = []
  const order: string[] = []
  const calls = { check: 0, download: 0 }
  const unsaved: string[] = []
  const written: string[] = []
  const writtenAt: { install?: string[], restart?: string[] } = {}
  const answers = [...(script.answers ?? [])]
  let cancelRequested = false
  let releaseDownload = () => {}

  const designOpen = script.designOpen ?? true
  const session: TestSessionCoreHandle = createTestSessionCore({
    ...(designOpen ? { file: makeTestDesign(), path: '/designs/orchard.canopi' } : {}),
    flushSettings: async () => { if (!(script.settingsSaveable ?? true)) throw new Error('settings store unwritable') },
  })
  const origWrite = session.home.write.bind(session.home)
  vi.spyOn(session.home, 'write').mockImplementation(async (...args) => {
    const res = await origWrite(...args)
    closeLog.push('design-flushed')
    order.push('design-flushed')
    written.push(...unsaved.splice(0))
    return res
  })

  // Ensure a dirty edit exists when testing closeLog / flush order with a Design open.
  if (designOpen) session.core.document('initial-dirty', () => ({ description: 'pending-before-update' }))

  const guard: CloseGuardLifetime = registerCloseGuard()
  const stopAutoAnswer = effect(() => {
    const req = saveProblem.value
    if (!req) return
    const answer = answers.shift() ?? 'cancel'
    closeLog.push({ asked: req, answer })
    queueMicrotask(() => { if (saveProblem.peek() === req) answerSaveProblem(answer) })
  })
  activeCleanups.push(() => { stopAutoAnswer(); guard.dispose(); session.dispose() })

  const settle = <T>(op: string, result: Result<T>): Promise<T> => {
    settlements.push(`${op} ${result.ok ? 'ok' : String(result.failure.code.kind)}`)
    return result.ok ? Promise.resolve(result.value) : Promise.reject(result.failure)
  }

  const updater: UpdaterPort = {
    checkForUpdate: () => { calls.check += 1; return settle('updater.check', script.check ?? { ok: true, value: OFFER }) },
    downloadUpdate: (_operation, onProgress) => {
      calls.download += 1
      return new Promise<UpdateDownload>((resolve, reject) => {
        const finish = () => {
          for (const progress of script.progress ?? []) onProgress(progress)
          if (cancelRequested) { settle('updater.download', { ok: false, failure: CANCELLED }).catch(reject); return }
          staged.push(OFFER.version)
          void settle<UpdateDownload>('updater.download', { ok: true, value: script.download ?? { kind: 'verified' } }).then(resolve)
        }
        if (script.holdDownload) releaseDownload = finish
        else setTimeout(finish, 0)
      })
    },
    cancelUpdate: () => { cancelRequested = true; return Promise.resolve() },
    installUpdate: () => {
      const result = script.install ?? { ok: true, value: null }
      if (result.ok) installs.push(OFFER.version)
      order.push('install')
      writtenAt.install = [...written]
      return settle('updater.install', result).then(() => undefined)
    },
    restartAfterUpdate: () => {
      restarts.push(restarts.length + 1)
      order.push('restart')
      writtenAt.restart = [...written]
      return Promise.resolve()
    },
    getLaunchCheck: () => Promise.resolve(script.launchCheck ?? true),
  }

  return {
    updater, staged, settlements, closeLog, installs, restarts, order, calls, writtenAt,
    edit: (change: string) => { unsaved.push(change); session.core.document(change, () => ({ description: change })) },
    releaseDownload: () => releaseDownload(),
  }
}

function startUpdater(
  host: { readonly updater: UpdaterPort },
  options: { readonly platform: UpdateOs, readonly onUpdateAvailable?: (offer: UpdateOffer) => void },
): UpdateController {
  return createUpdateController({
    updater: host.updater, platform: options.platform, flushBeforeExit, holdCloseUntilSettled, mintOperationId: createUuid,
    ...(options.onUpdateAvailable ? { onUpdateAvailable: options.onUpdateAvailable } : {}),
  })
}

async function runToInstall(updater: UpdateController): Promise<void> {
  await updater.check(); await updater.download(); await updater.install()
}

const settleTasks = (): Promise<void> => new Promise((settle) => setTimeout(settle, 0))
const translated = (m: UpdateFailureMessage | null): string | null =>
  m === null ? null : m.reason === undefined ? t(m.key) : t(m.key, { reason: t(m.reason) })
const shown = (failure: UpdaterFailure, platform: UpdateOs = 'linux'): string | null =>
  translated(updateFailureMessage(failure, platform))

// Tauri's invoke, for the one path through the real ipc/update.ts and transport.
const tauriInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke, Channel: class {} }))

describe('Desktop updater user paths', () => {
  it('cancelled update download leaves nothing staged and settles cancelled', async () => {
    const host = makeHost()
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

  it('update install with an unsaveable settings store flushes the Design first, then offers Retry, Close anyway and Cancel', async () => {
    const host = makeHost({ settingsSaveable: false, answers: ['retry', 'discard'] })
    await runToInstall(startUpdater(host, { platform: 'windows' }))

    const settingsFailed: SaveProblemRequest = { kind: 'settings-failed', designSaved: true }
    expect({ closeLog: host.closeLog, installs: host.installs }).toEqual({
      closeLog: ['design-flushed', { asked: settingsFailed, answer: 'retry' }, { asked: settingsFailed, answer: 'discard' }],
      installs: [OFFER.version],
    })
  })

  it('on Windows an update install cancelled at the close dialog installs nothing', async () => {
    const host = makeHost({ settingsSaveable: false, answers: ['cancel'] })
    const updater = startUpdater(host, { platform: 'windows' })
    await runToInstall(updater)

    expect({ state: updater.state.value, installs: host.installs, closeLog: host.closeLog }).toEqual({
      state: { kind: 'verified' },
      installs: [],
      closeLog: ['design-flushed', { asked: { kind: 'settings-failed', designSaved: true }, answer: 'cancel' }],
    })
  })

  it('update install during an unsaved edit keeps the edit', async () => {
    const writtenOn = async (platform: UpdateOs): Promise<{ install?: string[], restart?: string[] }> => {
      const host = makeHost()
      const updater = startUpdater(host, { platform })
      await updater.check()
      await updater.download()
      host.edit('plant moved')
      const install = updater.install()
      if (platform === 'linux') host.edit('label renamed')
      await install
      return host.writtenAt
    }

    expect({ windows: await writtenOn('windows'), linux: await writtenOn('linux') }).toEqual({
      windows: { install: ['plant moved'] },
      linux: { install: [], restart: ['plant moved', 'label renamed'] },
    })
  })

  it('offline update check settles network.offline and About shows it', async () => {
    const updater = startUpdater(makeHost({ check: { ok: false, failure: OFFLINE } }), { platform: 'linux' })
    await updater.check()

    expect(updater.state.value).toEqual({ kind: 'failed', failure: OFFLINE })
    expect(translated(updater.failureMessage.value)).toBe('Can’t check for updates while offline')
  })

  it('a dismissed .deb admin prompt keeps the Design open with Update not installed', async () => {
    const host = makeHost({ install: { ok: false, failure: ADMIN_PROMPT_DISMISSED } })
    const updater = startUpdater(host, { platform: 'linux' })
    await runToInstall(updater)

    expect({ state: updater.state.value, closeLog: host.closeLog, installs: host.installs }).toEqual({
      state: { kind: 'failed', failure: ADMIN_PROMPT_DISMISSED },
      closeLog: [],
      installs: [],
    })
    expect(translated(updater.failureMessage.value)).toBe('Update not installed: the password prompt was closed')
  })
})

describe('Desktop updater controller', () => {
  it('with the launch check off, launch makes no update check', async () => {
    const host = makeHost({ launchCheck: false })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.launchCheck()

    expect({ checks: host.calls.check, state: updater.state.value }).toEqual({ checks: 0, state: { kind: 'idle' } })
  })

  it('the launch check runs once when called twice', async () => {
    const host = makeHost({ check: { ok: true, value: null } })
    const updater = startUpdater(host, { platform: 'linux' })

    await updater.launchCheck()
    await updater.launchCheck()

    expect({ checks: host.calls.check, upToDate: updater.upToDate.value }).toEqual({ checks: 1, upToDate: true })
  })

  it('a new controller is idle and not up to date', () => {
    const updater = startUpdater(makeHost(), { platform: 'linux' })

    expect({ state: updater.state.value, upToDate: updater.upToDate.value, canRetry: updater.canRetry.value })
      .toEqual({ state: { kind: 'idle' }, upToDate: false, canRetry: false })
  })

  it('an update the launch check finds raises one notice and downloads nothing; About\'s check raises none', async () => {
    const notices: UpdateOffer[] = []
    const host = makeHost()
    const updater = startUpdater(host, { platform: 'linux', onUpdateAvailable: (offer) => notices.push(offer) })

    await updater.launchCheck()
    const afterLaunch = updater.state.value
    const about = startUpdater(makeHost(), { platform: 'linux', onUpdateAvailable: (offer) => notices.push(offer) })
    await about.check()

    expect({ notices, afterLaunch, downloads: host.calls.download }).toEqual({
      notices: [OFFER],
      afterLaunch: { kind: 'available', offer: OFFER },
      downloads: 0,
    })
  })

  it('a second check or download while one runs resolves when the first settles, with one host call', async () => {
    const host = makeHost({ holdDownload: true })
    let releaseCheck = () => {}
    const held = new Promise<void>((release) => { releaseCheck = release })
    const updater = startUpdater({ ...host, updater: { ...host.updater, checkForUpdate: (id) => held.then(() => host.updater.checkForUpdate(id)) } }, { platform: 'linux' })
    const settledIn: string[] = []
    const settled = (press: Promise<void>) => press.then(() => { settledIn.push(updater.state.value.kind) })

    const checks = [settled(updater.check()), settled(updater.check())]
    await settleTasks()
    const whileChecking = [...settledIn]
    releaseCheck()
    await Promise.all(checks)
    const downloads = [settled(updater.download()), settled(updater.download())]
    await settleTasks()
    const whileDownloading = [...settledIn]
    host.releaseDownload()
    await Promise.all(downloads)

    expect({ whileChecking, whileDownloading, settledIn, calls: host.calls }).toEqual({
      whileChecking: [],
      whileDownloading: ['available', 'available'],
      settledIn: ['available', 'available', 'verified', 'verified'],
      calls: { check: 1, download: 1 },
    })
  })

  it('a download pressed while a check runs returns at once and calls no host (canopi-f47t.52.228)', async () => {
    const host = makeHost()
    let releaseCheck = () => {}
    const held = new Promise<void>((release) => { releaseCheck = release })
    const updater = startUpdater({ ...host, updater: { ...host.updater, checkForUpdate: (id) => held.then(() => host.updater.checkForUpdate(id)) } }, { platform: 'linux' })
    const pressed: string[] = []

    const checking = updater.check()
    void updater.download().then(() => { pressed.push(updater.state.value.kind) })
    await settleTasks()
    const whileChecking = [...pressed]
    releaseCheck()
    await checking

    expect({ whileChecking, calls: host.calls }).toEqual({ whileChecking: ['checking'], calls: { check: 1, download: 0 } })
  })

  it('About\'s Check pressed during a download keeps its progress, its cancel and its join (canopi-f47t.52.228.15)', async () => {
    const host = makeHost({ holdDownload: true, progress: [{ received: 5, total: 10 }] })
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
    const host = makeHost({ holdDownload: true, progress: [{ received: 512, total: 2048 }] })
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

  it('a check rejected with a plain Error settles failed internal and offers no Retry', async () => {
    const host = makeHost()
    const updater = startUpdater({ ...host, updater: { ...host.updater, checkForUpdate: () => Promise.reject(new Error('lost')) } }, { platform: 'linux' })

    await updater.check()

    expect({ state: updater.state.value, canRetry: updater.canRetry.value }).toEqual({
      state: { kind: 'failed', failure: { code: { kind: 'internal' }, user_may_retry: false, op: 'updater.check', operation: null, detail: null } },
      canRetry: false,
    })
  })

  it('a check rejected with untyped text settles failed internal under updater.check, its detail redacted', async () => {
    const host = makeHost()
    tauriInvoke.mockRejectedValueOnce('channel file unreadable at /home/ana/.cache/canopi/latest.json')
    const updater = startUpdater({ ...host, updater: { ...host.updater, checkForUpdate: checkForUpdateOverIpc } }, { platform: 'linux' })

    await updater.check()

    const state = updater.state.value
    expect(state).toMatchObject({ kind: 'failed', failure: { code: { kind: 'internal' }, op: 'updater.check', user_may_retry: false } })
    expect(JSON.stringify(state)).not.toContain('/home/ana')
    expect(state.kind === 'failed' && state.failure.detail).toContain('channel file unreadable')
  })

  it('progress arriving after a failed download leaves About on the failure', async () => {
    const host = makeHost()
    const failure = fail('updater.download', { kind: 'network', network: 'timeout' })
    let lateProgress = () => {}
    const updater = startUpdater({
      ...host,
      updater: {
        ...host.updater,
        downloadUpdate: (_id, onProgress) => { lateProgress = () => onProgress({ received: 5, total: 10 }); return Promise.reject(failure) },
      },
    }, { platform: 'linux' })

    await updater.check()
    await updater.download()
    lateProgress()
    expect({ state: updater.state.value, canRetry: updater.canRetry.value }).toEqual({ state: { kind: 'failed', failure }, canRetry: true })
  })

  it('download, retry and install call the host only from available, a retryable failed download and verified', async () => {
    const retryable = fail('updater.download', { kind: 'network', network: 'timeout' })
    const final: UpdaterFailure = { ...retryable, code: { kind: 'update_signature_refused' }, user_may_retry: false }
    const run = async (failDownload: UpdaterFailure | null) => {
      const host = makeHost()
      let failNext = failDownload
      const updater = startUpdater({
        ...host,
        updater: {
          ...host.updater,
          downloadUpdate: (id, onProgress) => {
            const failure = failNext
            failNext = null
            if (failure === null) return host.updater.downloadUpdate(id, onProgress)
            host.calls.download += 1
            return Promise.reject(failure)
          },
        },
      }, { platform: 'linux' })
      const seen: string[] = []
      const press = async (name: 'download' | 'retry' | 'install') => {
        const from = updater.state.value.kind
        const before = host.calls.download + host.installs.length
        await updater[name]()
        if (host.calls.download + host.installs.length > before) seen.push(`${name} from ${from}`)
      }
      for (const name of ['download', 'retry', 'install'] as const) await press(name)
      await updater.check()
      for (const name of ['retry', 'install', 'download'] as const) await press(name)
      for (const name of ['download', 'retry', 'install'] as const) await press(name)
      return seen
    }

    expect({ retryable: await run(retryable), final: await run(final), clean: await run(null) }).toEqual({
      retryable: ['download from available', 'retry from failed', 'install from verified'],
      final: ['download from available'],
      clean: ['download from available', 'install from verified'],
    })
  })

  it('an installer that cannot be replaced by Canopi settles link_only with its download page', async () => {
    const url = 'https://projectcanopi.com/download'
    const updater = startUpdater(makeHost({ download: { kind: 'link_only', url } }), { platform: 'linux' })
    await updater.check()
    await updater.download()
    expect(updater.state.value).toEqual({ kind: 'link_only', url })
  })

  it('on Linux the update installs, then the close request flushes and restarts without a Design path (2.1-M523)', async () => {
    const host = makeHost()
    const updater = startUpdater(host, { platform: 'linux' })
    await runToInstall(updater)

    expect({ order: host.order, restarts: host.restarts, state: updater.state.value.kind }).toEqual({
      order: ['install', 'design-flushed', 'restart'],
      restarts: [1],
      state: 'close_requested',
    })
  })

  it('on Linux a Draft restarts with no Design path', async () => {
    const host = makeHost({ designOpen: false })
    await runToInstall(startUpdater(host, { platform: 'linux' }))
    expect(host.restarts).toEqual([1])
  })

  it('on Linux a close cancelled after the install shows Restart to finish updating and the update stays installed', async () => {
    const host = makeHost({ settingsSaveable: false, answers: ['cancel', 'discard'] })
    const updater = startUpdater(host, { platform: 'linux' })
    await runToInstall(updater)
    const afterCancel = { state: updater.state.value, installs: [...host.installs], restarts: [...host.restarts] }
    await updater.restart()

    expect({ afterCancel, restarts: host.restarts }).toEqual({
      afterCancel: { state: { kind: 'installed' }, installs: [OFFER.version], restarts: [] },
      restarts: [1],
    })
  })

  it('on Windows the close request runs before the installer, which runs only on proceed', async () => {
    const host = makeHost()
    const updater = startUpdater(host, { platform: 'windows' })
    await runToInstall(updater)

    expect({ order: host.order, state: updater.state.value.kind }).toEqual({
      order: ['design-flushed', 'install'],
      state: 'close_requested',
    })
  })

  it('on Windows the installer runs without a Design path argument (2.1-M523)', async () => {
    const host = makeHost()
    await runToInstall(startUpdater(host, { platform: 'windows' }))
    expect(host.installs).toEqual([OFFER.version])
  })

  it('on Windows an installer that cannot launch after the close dialog settles failed with the Design open', async () => {
    const host = makeHost({ install: { ok: false, failure: INSTALLER_FAILED } })
    const updater = startUpdater(host, { platform: 'windows' })
    await runToInstall(updater)

    expect({ state: updater.state.value, restarts: host.restarts }).toEqual({
      state: { kind: 'failed', failure: INSTALLER_FAILED },
      restarts: [],
    })
  })
})

const FAILURE_TEXT: readonly (readonly [UpdateOp, UpdaterFailure['code'], string | null])[] = [
  ['updater.check', { kind: 'network', network: 'offline' }, 'Can’t check for updates while offline'],
  ['updater.check', { kind: 'network', network: 'timeout' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'io', io: 'other' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'invalid' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'busy', lane: 'network' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'unavailable' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'panicked' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'join_failed' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'internal' }, 'Couldn’t check for updates'],
  ['updater.check', { kind: 'cancelled' }, null],
  ['updater.check', { kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'deb' }, 'Download the update from projectcanopi.com'],
  ['updater.download', { kind: 'update_admin_prompt_unavailable' }, 'Download the update from projectcanopi.com'],
  ['updater.download', { kind: 'update_signature_refused' }, 'Update not installed: the download could not be verified'],
  ['updater.download', { kind: 'network', network: 'too_large' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'io', io: 'no_space' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'busy', lane: 'local' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'panicked' }, 'Update not installed: the download failed'],
  ['updater.download', { kind: 'cancelled' }, null],
  ['updater.install', { kind: 'update_admin_prompt_dismissed' }, 'Update not installed: the password prompt was closed'],
  ['updater.install', { kind: 'update_admin_prompt_refused' }, 'Update not installed: permission was refused'],
  ['updater.install', { kind: 'update_location_not_writable' }, 'Update not installed: Canopi’s folder can’t be changed'],
  ['updater.install', { kind: 'update_install_failed', bundle: 'appimage' }, 'Update not installed: the installer reported an error'],
  ['updater.install', { kind: 'io', io: 'permission_denied' }, 'Update not installed: the installer reported an error'],
  ['updater.install', { kind: 'internal' }, 'Update not installed: the installer reported an error'],
  ['updater.install', { kind: 'join_failed' }, 'Update not installed: the installer reported an error'],
]

describe('updater failure messages (2.1-Q237, 2.1-Q244)', () => {
  it('maps every updater failure code to its one message, and a cancel to none', () => {
    const messages = FAILURE_TEXT.map(([op, code]) => shown({ code, op, user_may_retry: true, operation: null, detail: null }))
    expect(messages).toEqual(FAILURE_TEXT.map(([, , text]) => text))
  })

  it('on Windows an install failure is plain Update not installed, without a Linux reason (canopi-f47t.52.228.15)', () => {
    const windowsText: readonly (readonly [UpdateOp, UpdaterFailure['code'], string | null])[] = [
      ['updater.install', { kind: 'update_install_failed', bundle: 'nsis' }, 'Update not installed'],
      ['updater.install', { kind: 'io', io: 'other' }, 'Update not installed'],
      ['updater.install', { kind: 'internal' }, 'Update not installed'],
      ['updater.install', { kind: 'update_signature_refused' }, 'Update not installed'],
      ['updater.install', { kind: 'update_location_not_writable' }, 'Update not installed'],
      ['updater.install', { kind: 'cancelled' }, null],
      ['updater.download', { kind: 'update_signature_refused' }, 'Update not installed: the download could not be verified'],
    ]
    const messages = windowsText.map(([op, code]) => shown({ code, op, user_may_retry: true, operation: null, detail: null }, 'windows'))
    expect(messages).toEqual(windowsText.map(([, , text]) => text))
  })
})
