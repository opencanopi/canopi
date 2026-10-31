import { vi } from 'vitest'
import type { SaveProblemChoice, SaveProblemRequest } from '../../app/document-session/save-problem'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { flushBeforeExit, holdCloseUntilSettled } from '../../app/shell/close-guard'
import { createUpdateController, type UpdateController, type UpdaterPort } from '../../app/updates/controller'
import { createUuid } from '../../utils/ids'
import type { UpdateDownload, UpdateFailure, UpdateOffer, UpdateOs, UpdateProgress } from '../../generated/contracts'

// The fake host behind the Desktop updater suites (updater-flow.test.ts, app/shell/close-guard-update.test.ts): fakes
// stand only at the ports, the host's update commands (UpdaterPort, what ipc/update.ts invokes) and the close guard's
// Design flush, settings flush and save-problem question, answered from a script. Importing this module mocks the close
// guard's modules onto those ports, so a suite imports it before anything that loads the close guard.

/** The close guard's ports, which each test's fake host fills (vi.mock factories run before the imports above). */
const closePorts = vi.hoisted(() => ({
  flushDesign: (): Promise<boolean> => Promise.resolve(true),
  flushSettings: (): Promise<void> => Promise.resolve(),
  ask: (_request: unknown): Promise<string> => Promise.resolve('cancel'),
  designOpen: true,
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../../app/document-session/transition', () => ({
  designContinuousSave: { flush: () => closePorts.flushDesign(), conflict: { peek: () => null } },
}))
vi.mock('../../app/document-session/store', () => ({
  currentDesign: { peek: () => (closePorts.designOpen ? {} : null) },
}))
vi.mock('../../app/document-session/save-problem', () => ({
  requestSaveProblemDecision: (request: unknown) => closePorts.ask(request),
}))
vi.mock('../../app/settings/projection', () => ({ flushSettingsProjection: () => closePorts.flushSettings() }))

/** A command's reply: contracts §1, `Promise<Result<Reply, Failure>>`. */
export type Result<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly failure: UpdateFailure }

/** One step of the close guard as the fake saw it: the Design flush, or a save-problem question and its answer. */
export type CloseEvent = 'design-flushed' | { readonly asked: SaveProblemRequest, readonly answer: SaveProblemChoice }

/**
 * What a test drives and reads. `settlements` stands in for the executor's settlement log (`op settlement`), `staged`
 * for the verified payload, `closeLog` for what the close guard did and asked, `installs` and `restarts` for the
 * installs and restarts run, `order` for the close guard's flush, installs and restarts in the order they ran, and
 * `calls` for how often each command was invoked. `edit` makes an unsaved edit, one the continuous save has not
 * written yet; the Design flush writes the edits made so far, and `writtenAt` holds what was written when the install
 * and the restart ran.
 */
export interface FakeUpdateHost {
  readonly updater: UpdaterPort
  readonly staged: string[]
  readonly settlements: string[]
  readonly closeLog: CloseEvent[]
  readonly installs: string[]
  /** The Design path each install was given, the one the Windows installer relaunches with. */
  readonly installedWith: (string | null)[]
  readonly restarts: (string | null)[]
  readonly order: string[]
  readonly calls: { check: number, download: number }
  readonly writtenAt: { install?: string[], restart?: string[] }
  edit(change: string): void
  /** The open Design's path; the test switches it between Designs. */
  designPath: string | null
}

export const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/canopi/canopi/releases/tag/v2.1.0' }
/** The executor's silent settlement for a cancelled op (contracts §2): never a user-facing failure. */
export const CANCELLED: UpdateFailure = { code: { kind: 'cancelled' }, user_may_retry: false, op: 'updater.download', detail: 'cancelled by the user' }
export const OFFLINE: UpdateFailure = { code: { kind: 'network', network: 'offline' }, user_may_retry: true, op: 'updater.check', detail: 'offline' }
export const ADMIN_PROMPT_DISMISSED: UpdateFailure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install', detail: 'pkexec exit 126' }
export const INSTALLER_FAILED: UpdateFailure = { code: { kind: 'update_install_failed', bundle: 'nsis' }, user_may_retry: true, op: 'updater.install', detail: 'installer did not start' }

export interface HostScript {
  readonly check?: Result<UpdateOffer | null>
  readonly download?: UpdateDownload
  readonly install?: Result<null>
  readonly launchCheck?: boolean
  /** Progress the download reports over its channel before it settles. */
  readonly progress?: readonly UpdateProgress[]
  /** A download that settles only when the test calls the returned function. */
  readonly holdDownload?: boolean
  /** An install that settles only when the test calls `releaseInstall`. */
  readonly holdInstall?: boolean
  /** The first Design flush settles only when the test calls `releaseFlush`; later ones settle at once. */
  readonly holdFlush?: boolean
  readonly settingsSaveable?: boolean
  readonly designOpen?: boolean
  readonly designPath?: string | null
  /** The user's answers to the close guard's questions, in order. */
  readonly answers?: readonly SaveProblemChoice[]
}

export function fakeHost(script: HostScript = {}): FakeUpdateHost & { releaseDownload: () => void, releaseInstall: () => void, releaseFlush: () => void } {
  const staged: string[] = []
  const settlements: string[] = []
  const closeLog: CloseEvent[] = []
  const installs: string[] = []
  const installedWith: (string | null)[] = []
  const restarts: (string | null)[] = []
  const order: string[] = []
  const calls = { check: 0, download: 0 }
  const unsaved: string[] = []
  const written: string[] = []
  const writtenAt: { install?: string[], restart?: string[] } = {}
  const answers = [...(script.answers ?? [])]
  let cancelRequested = false
  let releaseDownload = () => {}
  let releaseInstall = () => {}
  let releaseFlush = () => {}
  let flushHeld = script.holdFlush ?? false
  const settle = <T>(op: string, result: Result<T>): Promise<T> => {
    settlements.push(`${op} ${result.ok ? 'ok' : String(result.failure.code.kind)}`)
    return result.ok ? Promise.resolve(result.value) : Promise.reject(result.failure)
  }
  closePorts.designOpen = script.designOpen ?? true
  closePorts.flushDesign = () => {
    const flushed = () => {
      closeLog.push('design-flushed')
      order.push('design-flushed')
      written.push(...unsaved.splice(0))
      return true
    }
    if (!flushHeld) return Promise.resolve(flushed())
    flushHeld = false
    return new Promise<boolean>((resolve) => { releaseFlush = () => resolve(flushed()) })
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
    installUpdate: (designPath) => {
      const result = script.install ?? { ok: true, value: null }
      installedWith.push(designPath)
      if (result.ok) installs.push(OFFER.version)
      order.push('install')
      writtenAt.install = [...written]
      if (!script.holdInstall) return settle('updater.install', result).then(() => undefined)
      return new Promise<void>((resolve, reject) => {
        releaseInstall = () => { settle('updater.install', result).then(() => resolve(), reject) }
      })
    },
    restartAfterUpdate: (designPath) => {
      restarts.push(designPath)
      order.push('restart')
      writtenAt.restart = [...written]
      return Promise.resolve()
    },
    getLaunchCheck: () => Promise.resolve(script.launchCheck ?? true),
  }
  const host = {
    updater, staged, settlements, closeLog, installs, installedWith, restarts, order, calls, writtenAt,
    edit: (change: string) => { unsaved.push(change) },
    designPath: script.designPath === undefined ? '/designs/a.canopi' : script.designPath,
    releaseDownload: () => releaseDownload(),
    releaseInstall: () => releaseInstall(),
    releaseFlush: () => releaseFlush(),
  }
  return host
}

export function startUpdater(
  host: FakeUpdateHost,
  options: { readonly platform: UpdateOs, readonly onUpdateAvailable?: (offer: UpdateOffer) => void },
): UpdateController {
  return createUpdateController({
    updater: host.updater,
    platform: options.platform,
    flushBeforeExit,
    holdCloseUntilSettled,
    mintOperationId: createUuid,
    currentDesignPath: () => host.designPath,
    ...(options.onUpdateAvailable ? { onUpdateAvailable: options.onUpdateAvailable } : {}),
  })
}

/** Lets every queued promise reaction and timer of the fakes run. */
export async function settleTasks(): Promise<void> {
  await new Promise((settle) => setTimeout(settle, 0))
}

/** The main window as the close guard sees it: the test requests its close, and reads whether it was destroyed. */
export function closingWindow(order?: string[]): { requestClose(): Promise<void>, destroyed(): boolean } {
  let onClose: ((event: { preventDefault(): void }) => Promise<void> | undefined) | null = null
  let destroyed = false
  vi.mocked(getCurrentWindow).mockReturnValue({
    onCloseRequested: (handler: typeof onClose) => { onClose = handler; return Promise.resolve(() => {}) },
    onFocusChanged: () => Promise.resolve(() => {}),
    destroy: () => { destroyed = true; order?.push('destroyed'); return Promise.resolve() },
  } as unknown as ReturnType<typeof getCurrentWindow>)
  return {
    requestClose: async () => { await onClose?.({ preventDefault: () => {} }) },
    destroyed: () => destroyed,
  }
}
