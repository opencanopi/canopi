import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_PROMPT_DISMISSED, fakeHost, INSTALLER_FAILED, OFFER, OFFLINE, startUpdater, type FakeUpdateHost,
} from './support/fake-update-host'
import type { SaveProblemRequest } from '../app/document-session/save-problem'
import { updateFailureMessage, type UpdateFailureMessage } from '../app/updates/state'
import { t } from '../i18n'
import type { UpdateFailure, UpdateFailureCode, UpdateOffer, UpdateOp, UpdateOs } from '../generated/contracts'

// The Desktop updater's user paths (canopi-f47t.52.228.15) through the real state machine, controller and close guard:
// fakes stand only at the ports, the host's update commands (UpdaterPort, what ipc/update.ts invokes) and the close
// guard's Design flush, settings flush and save-problem question, answered from a script. The states are the
// contract's UpdateState kinds (2.1-M208), the failures typed §2 Failure values (its updater codes) and the close
// dialog the close guard's (ADR 0024, 2.1-Q182).

/**
 * A failure message's text as About renders it: app/updates names keys only, so it adds no cross-area edge to i18n
 * (2.1-M200), and About translates (about-updates.test.tsx renders About itself).
 */
function translated(message: UpdateFailureMessage | null): string | null {
  if (message === null) return null
  return message.reason === undefined ? t(message.key) : t(message.key, { reason: t(message.reason) })
}

function shown(failure: UpdateFailure, platform: UpdateOs = 'linux'): string | null {
  return translated(updateFailureMessage(failure, platform))
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

  // plan Phase 0 F6 and 2.1-M82: an edit the continuous save has not written yet is written before anything ends
  // Canopi. On Windows the installer quits Canopi, so the close guard writes it before the installer runs; on Linux
  // Canopi stays open while it installs, so an edit made during the install is written too, before the restart. The
  // Windows installer's Restart Manager close (RmShutdown, which reaches only RunEvent::Exit and skips the close
  // guard) is not driven here: an update Canopi starts writes the edit here first and then the updater plugin exits
  // Canopi itself as it launches the installer. For an installer run by hand, the native exit handler holds the exit
  // until a write already sent lands (desktop/src/lib.rs, the_exit_event_waits_for_a_running_write_to_land); the
  // updater lane's NSIS run checks that an edit continuous save has written survives the installer's close.
  it('update install during an unsaved edit keeps the edit', async () => {
    const writtenOn = async (platform: UpdateOs): Promise<FakeUpdateHost['writtenAt']> => {
      const host = fakeHost()
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


  // About shows the controller's failureMessage, the line about-updates.test.tsx renders in About.
  it('offline update check settles network.offline and About shows it', async () => {
    const updater = startUpdater(fakeHost({ check: { ok: false, failure: OFFLINE } }), { platform: 'linux' })

    await updater.check()

    expect(updater.state.value).toEqual({ kind: 'failed', failure: OFFLINE })
    expect(translated(updater.failureMessage.value)).toBe('Can’t check for updates while offline')
  })

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
    expect(translated(updater.failureMessage.value)).toBe('Update not installed: the password prompt was closed')
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

  // plan:194: launched with A and switched to B, the relaunch reopens B. The Windows installer relaunches Canopi, so
  // the install is given the Design open when it starts, as the Linux restart is; a Draft gives none.
  it('on Windows the installer is given the Design open at that moment, none for a Draft (canopi-f47t.52.228.15)', async () => {
    const installedWith = async (designPath: string | null): Promise<(string | null)[]> => {
      const host = fakeHost({ designPath: '/designs/a.canopi' })
      const updater = startUpdater(host, { platform: 'windows' })
      await updater.check().then(() => updater.download())
      host.designPath = designPath
      await updater.install()
      return host.installedWith
    }

    expect({ design: await installedWith('/designs/b.canopi'), draft: await installedWith(null) })
      .toEqual({ design: ['/designs/b.canopi'], draft: [null] })
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
  // Windows install failures show plain "Update not installed" (2.1-Q234, 2.1-Q244): the six reasons are Linux only.
  it('on Windows an install failure is plain Update not installed, without a Linux reason (canopi-f47t.52.228.15)', () => {
    const windowsText: readonly (readonly [UpdateOp, UpdateFailureCode, string | null])[] = [
      ['updater.install', { kind: 'update_install_failed', bundle: 'nsis' }, 'Update not installed'],
      ['updater.install', { kind: 'io', io: 'other' }, 'Update not installed'],
      ['updater.install', { kind: 'internal' }, 'Update not installed'],
      ['updater.install', { kind: 'update_signature_refused' }, 'Update not installed'],
      ['updater.install', { kind: 'update_location_not_writable' }, 'Update not installed'],
      ['updater.install', { kind: 'cancelled' }, null],
      ['updater.download', { kind: 'update_signature_refused' }, 'Update not installed: the download could not be verified'],
    ]
    const messages = windowsText.map(([op, code]) => shown({ code, op, user_may_retry: true, detail: '' }, 'windows'))
    expect(messages).toEqual(windowsText.map(([, , text]) => text))
  })
})
