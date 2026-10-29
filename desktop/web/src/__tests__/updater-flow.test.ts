import { describe, expect, it } from 'vitest'
import type { SaveProblemChoice, SaveProblemRequest } from '../app/document-session/save-problem'
import { UPDATE_STATE_KINDS, canTransition } from '../app/updates/state'

// The Desktop updater's user paths (canopi-f47t.52.228.15), written before the modules they drive exist: each fails
// today because app/updates/controller.ts is missing. The chunk named in a title builds that path and drops its marker
// in the same commit. The states are the contract's UpdateState kinds (2.1-M208), the failures typed §2 Failure values
// (its updater codes) and the close dialog the close guard's (ADR 0024, 2.1-Q182).

/** Loaded by path so this file compiles before the controller exists (F6-c2a creates it). */
const CONTROLLER_MODULE = '../app/updates/controller'

type UpdateStateKind =
  | 'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'installing' | 'installed' | 'close_requested'
  | 'failed' | 'link_only'

/**
 * A typed Failure as contracts §2 carries it over `invoke`: the code is a tagged value, never a string error. The
 * tests only pass failures through, so a code's exact payload is spelled once, in the constants below, and follows
 * the catalogue's generated type when it lands.
 */
interface Failure {
  readonly code: { readonly kind: string, readonly [field: string]: unknown }
  readonly user_may_retry: boolean
  readonly op: string
}

/** A command's reply: contracts §1, `Promise<Result<Reply, Failure>>`. */
type Result<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly failure: Failure }

interface UpdateOffer { readonly version: string, readonly date: string, readonly notes_url: string }

interface UpdateStateView { readonly kind: UpdateStateKind, readonly failure?: Failure }

/** One step of the close guard as the fake saw it: the Design flush, or a save-problem question and its answer. */
type CloseEvent = 'design-flushed' | { readonly asked: SaveProblemRequest, readonly answer: SaveProblemChoice }

/**
 * What a test drives: the host's update commands, and the close guard's ports (ADR 0024) that
 * `flushBeforeExit('update')` runs over: the Design flush, the settings flush and the save-problem question, answered
 * from a script. `settlements` stands in for the executor's settlement log (`op settlement`), `staged` for the
 * verified payload, `closeLog` for what the close guard did and asked, and `installs` for the installs run.
 */
interface FakeUpdateHost {
  readonly staged: string[]
  readonly settlements: string[]
  readonly closeLog: CloseEvent[]
  readonly installs: string[]
  check(): Promise<Result<UpdateOffer | null>>
  download(): Promise<Result<null>>
  cancel(): void
  install(): Promise<Result<null>>
  flushDesign(): Promise<boolean>
  flushSettings(): Promise<void>
  askSaveProblem(request: SaveProblemRequest): Promise<SaveProblemChoice>
}

interface UpdateController {
  state(): UpdateStateView
  check(): Promise<void>
  download(): Promise<void>
  cancel(): void
  install(): Promise<void>
}

interface ControllerModule {
  createUpdateController(host: FakeUpdateHost, options: { readonly platform: 'windows' | 'linux' }): UpdateController
}

async function loadController(): Promise<ControllerModule> {
  return (await import(/* @vite-ignore */ CONTROLLER_MODULE)) as ControllerModule
}

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/canopi/canopi/releases/tag/v2.1.0' }
/** The executor's silent settlement for a cancelled op (contracts §2): never a user-facing failure. */
const CANCELLED: Failure = { code: { kind: 'cancelled' }, user_may_retry: false, op: 'updater.download' }
const OFFLINE: Failure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check' }
const ADMIN_PROMPT_DISMISSED: Failure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install' }

interface HostScript {
  readonly check?: Result<UpdateOffer | null>
  readonly install?: Result<null>
  readonly settingsSaveable?: boolean
  /** The user's answers to the close guard's questions, in order. */
  readonly answers?: readonly SaveProblemChoice[]
}

function fakeHost(script: HostScript = {}): FakeUpdateHost {
  const staged: string[] = []
  const settlements: string[] = []
  const closeLog: CloseEvent[] = []
  const installs: string[] = []
  const answers = [...(script.answers ?? [])]
  let cancelRequested = false
  const settle = <T>(op: string, result: Result<T>): Result<T> => {
    settlements.push(`${op} ${result.ok ? 'ok' : String(result.failure.code.kind)}`)
    return result
  }
  return {
    staged,
    settlements,
    closeLog,
    installs,
    check: () => Promise.resolve(settle('updater.check', script.check ?? { ok: true, value: OFFER })),
    // The transfer finishes a task later, so a cancel issued meanwhile drops it and nothing is staged. The flag is
    // never reset: each test runs one download, and a cancel the controller forwards before host.download starts
    // (after an await of its own) must still count.
    download: () => new Promise((resolve) => {
      setTimeout(() => {
        if (cancelRequested) {
          resolve(settle('updater.download', { ok: false, failure: CANCELLED }))
          return
        }
        staged.push(OFFER.version)
        resolve(settle('updater.download', { ok: true, value: null }))
      }, 0)
    }),
    cancel: () => { cancelRequested = true },
    install: () => {
      const result = script.install ?? { ok: true, value: null }
      if (result.ok) installs.push(OFFER.version)
      return Promise.resolve(settle('updater.install', result))
    },
    flushDesign: () => {
      closeLog.push('design-flushed')
      return Promise.resolve(true)
    },
    flushSettings: () => (script.settingsSaveable ?? true) ? Promise.resolve() : Promise.reject(new Error('settings store unwritable')),
    askSaveProblem: (request) => {
      const answer = answers.shift() ?? 'cancel'
      closeLog.push({ asked: request, answer })
      return Promise.resolve(answer)
    },
  }
}

describe('Desktop updater user paths', () => {
  // A cancel goes downloading to idle (states.md Updater, 2.1-M208); "settles cancelled" is the executor's silent
  // settlement in its log, never a failed state.
  it.fails('[expected-fail F6-c2b, canopi-f47t.52.228.15] cancelled update download leaves nothing staged and settles cancelled', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost()
    const updater = createUpdateController(host, { platform: 'linux' })

    await updater.check()
    const download = updater.download()
    updater.cancel()
    await download

    expect({ state: updater.state(), staged: host.staged, settlements: host.settlements }).toEqual({
      state: { kind: 'idle' },
      staged: [],
      settlements: ['updater.check ok', 'updater.download cancelled'],
    })
  })

  // The settings question is the close guard's 'settings-failed' dialog: Retry, Close anyway ('discard') and Cancel
  // (2.1-Q182). On Windows the flush runs before the installer (2.1-Q234).
  it.fails('[expected-fail F6-c2b, canopi-f47t.52.228.15] update install with an unsaveable settings store flushes the Design first, then offers Retry, Close anyway and Cancel', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost({ settingsSaveable: false, answers: ['retry', 'discard'] })
    const updater = createUpdateController(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    const settingsFailed: SaveProblemRequest = { kind: 'settings-failed', designSaved: true }
    expect({ closeLog: host.closeLog, installs: host.installs }).toEqual({
      closeLog: ['design-flushed', { asked: settingsFailed, answer: 'retry' }, { asked: settingsFailed, answer: 'discard' }],
      installs: [OFFER.version],
    })
  })

  it.fails('[expected-fail F6-c2b, canopi-f47t.52.228.15] on Windows an update install cancelled at the close dialog installs nothing', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost({ settingsSaveable: false, answers: ['cancel'] })
    const updater = createUpdateController(host, { platform: 'windows' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state(), installs: host.installs, closeLog: host.closeLog }).toEqual({
      state: { kind: 'verified' },
      installs: [],
      closeLog: ['design-flushed', { asked: { kind: 'settings-failed', designSaved: true }, answer: 'cancel' }],
    })
  })

  it.fails('[expected-fail F6-c3, canopi-f47t.52.228.15] offline update check settles network.offline and About shows it', async () => {
    const { createUpdateController } = await loadController()
    const updater = createUpdateController(fakeHost({ check: { ok: false, failure: OFFLINE } }), { platform: 'linux' })

    await updater.check()

    expect(updater.state()).toEqual({ kind: 'failed', failure: OFFLINE })
  })

  it.fails('[expected-fail F6-c3, canopi-f47t.52.228.15] a dismissed .deb admin prompt keeps the Design open with Update not installed', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost({ install: { ok: false, failure: ADMIN_PROMPT_DISMISSED } })
    const updater = createUpdateController(host, { platform: 'linux' })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state(), closeLog: host.closeLog, installs: host.installs }).toEqual({
      state: { kind: 'failed', failure: ADMIN_PROMPT_DISMISSED },
      closeLog: [],
      installs: [],
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
