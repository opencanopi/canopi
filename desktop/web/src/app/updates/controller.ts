import { computed, signal, type ReadonlySignal } from '@preact/signals'
import type { UpdateDownload, UpdateFailure, UpdateOffer, UpdateOp, UpdateOs, UpdateProgress } from '../../generated/contracts'
import { canTransition, offersRetry, updateFailureMessage, type UpdateFailureMessage, type UpdateState } from './state'

/**
 * The host's update commands as the controller uses them; the Desktop root passes ipc/update.ts, so this module
 * imports no ipc/ module. Each rejects with an `UpdateFailure` (contracts §2). Progress arrives only through
 * `downloadUpdate`'s callback, update_download's Channel (2.1-M208).
 */
export interface UpdaterPort {
  checkForUpdate(operation: string): Promise<UpdateOffer | null>
  downloadUpdate(operation: string, onProgress: (progress: UpdateProgress) => void): Promise<UpdateDownload>
  /** `designPath` is the Design the Windows installer relaunches with (null: a Draft or the start screen, plan:194). */
  installUpdate(designPath: string | null): Promise<void>
  cancelUpdate(operation: string): Promise<void>
  restartAfterUpdate(designPath: string | null): Promise<void>
  getLaunchCheck(): Promise<boolean>
}

interface UpdateControllerOptions {
  readonly updater: UpdaterPort
  /** Windows saves first, since its installer quits Canopi; Linux installs first, then saves and restarts (2.1-Q233). */
  readonly platform: UpdateOs
  /** The close guard's exit flush (app/shell/close-guard.ts, 2.1-M209): the update exits only on proceed. */
  readonly flushBeforeExit: (purpose: 'update') => Promise<'proceed' | 'cancel'>
  /**
   * The close guard's hold (app/shell/close-guard.ts, 2.1-Q254): a window close waits for the install to settle. The
   * answer, read once it has, is whether a close waited; that close then ends Canopi, and nothing restarts.
   */
  readonly holdCloseUntilSettled: (install: Promise<unknown>) => () => boolean
  /** A fresh operation id per check or download, the one its cancel names (utils/ids.ts createUuid, from the root). */
  readonly mintOperationId: () => string
  /** The open Design's path when the install or the restart runs; null for a Draft or the start screen. */
  readonly currentDesignPath: () => string | null
  /** The launch check found an update: the root shows the one notice that opens About (2.1-Q164, M211). */
  readonly onUpdateAvailable?: (offer: UpdateOffer) => void
}

export interface UpdateController {
  readonly state: ReadonlySignal<UpdateState>
  /** The offer being downloaded, installed or restarted into; null before a check finds one. */
  readonly offer: ReadonlySignal<UpdateOffer | null>
  /** The last check found no newer release: About says "Canopi is up to date" until the next check starts. */
  readonly upToDate: ReadonlySignal<boolean>
  /** About offers Retry in place of Check for updates: a failed download that allows it (offersRetry, 2.1-Q252). */
  readonly canRetry: ReadonlySignal<boolean>
  /** A failed state's message as locale keys for About (updateFailureMessage for this platform); null otherwise. */
  readonly failureMessage: ReadonlySignal<UpdateFailureMessage | null>
  /**
   * From the update's close request until Canopi exits or the exit is called off (close_requested): the Desktop root
   * blocks Design edits meanwhile (close-guard.ts blockEditsWhile), since the exit flush has already run.
   */
  readonly exiting: ReadonlySignal<boolean>
  /** The launch check: at most once per controller, and only when "Check for updates at launch" is on (2.1-Q164). */
  launchCheck(): Promise<void>
  /** About's "Check for updates", from idle or failed; a second call while checking joins the running check. */
  check(): Promise<void>
  /** About's "Download and install", the only start of a download (2.1-Q235); a second call joins the running one. */
  download(): Promise<void>
  /** About's "Retry" after a failed download that allows it: downloads the same offer again (2.1-Q252). */
  retry(): Promise<void>
  /** Cancels the running check or download; it settles cancelled, back to idle. */
  cancel(): void
  /** "Install and restart" from verified. */
  install(): Promise<void>
  /** "Restart to finish updating" from installed (Linux). */
  restart(): Promise<void>
}

/** A rejection that is not a typed failure is a fault in Canopi itself, settled `internal`. */
function asFailure(error: unknown, op: UpdateOp): UpdateFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && 'op' in error) return error as UpdateFailure
  return { code: { kind: 'internal' }, user_may_retry: false, op, detail: String(error) }
}

/**
 * The Desktop updater's controller (contracts §3, 2.1-M208): it writes UpdateState, its own signal, only through the
 * transition table, and guards by state alone; the host runs one op at a time, so there is no serial lane here.
 */
export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { updater } = options
  const state = signal<UpdateState>({ kind: 'idle' })
  const offer = signal<UpdateOffer | null>(null)
  const upToDate = signal(false)
  const failureMessage = computed(() => {
    const current = state.value
    return current.kind === 'failed' ? updateFailureMessage(current.failure, options.platform) : null
  })
  const canRetry = computed(() => offersRetry(state.value))
  const exiting = computed(() => state.value.kind === 'close_requested')
  let operation: string | null = null
  let running: Promise<unknown> | null = null
  let launchChecked = false

  const move = (next: UpdateState): boolean => {
    if (!canTransition(state.value.kind, next.kind)) return false
    state.value = next
    return true
  }

  const settleFailure = (error: unknown, op: UpdateOp) => {
    const failure = asFailure(error, op)
    move(failure.code.kind === 'cancelled' ? { kind: 'idle' } : { kind: 'failed', failure })
  }

  /** Runs an op that has already moved into its state; ops are one at a time, so the op it ends is its own. */
  const join = <T>(run: () => Promise<T>): Promise<T> => {
    const current = run().finally(() => {
      running = null
      operation = null
    })
    running = current
    return current
  }

  /** Runs a check from the state it has just moved into; resolves with the offer it found, null otherwise. */
  const runCheck = async (): Promise<UpdateOffer | null> => {
    const id = options.mintOperationId()
    operation = id
    try {
      const found = await updater.checkForUpdate(id)
      if (found === null) {
        upToDate.value = true
        move({ kind: 'idle' })
        return null
      }
      offer.value = found
      move({ kind: 'available', offer: found })
      return found
    } catch (error) {
      settleFailure(error, 'updater.check')
      return null
    }
  }

  /** Starts a check only from idle or failed: in any other state an op or an offer holds, and the check does nothing. */
  const startCheck = async (): Promise<UpdateOffer | null> => {
    if (state.value.kind === 'failed') move({ kind: 'idle' })
    if (!move({ kind: 'checking' })) return null
    upToDate.value = false
    return join(runCheck)
  }

  const check = async (): Promise<void> => {
    if (state.value.kind === 'checking' && running) {
      await running
      return
    }
    await startCheck()
  }

  const launchCheck = async (): Promise<void> => {
    if (launchChecked) return
    launchChecked = true
    let on: boolean
    try {
      on = await updater.getLaunchCheck()
    } catch {
      // The key row could not be read: the quiet launch check is skipped; About's check still works (2.1-Q164).
      return
    }
    if (!on || state.value.kind !== 'idle') return
    const found = await startCheck()
    if (found !== null) options.onUpdateAvailable?.(found)
  }

  /** Downloads the offer from available, or again from a failed download (Retry). */
  const runDownload = async (): Promise<void> => {
    move({ kind: 'downloading', progress: { received: 0, total: null } })
    await join(async () => {
      const id = options.mintOperationId()
      operation = id
      try {
        const result = await updater.downloadUpdate(id, (progress) => {
          if (operation === id && state.value.kind === 'downloading') move({ kind: 'downloading', progress })
        })
        move(result.kind === 'verified' ? { kind: 'verified' } : { kind: 'link_only', url: result.url })
      } catch (error) {
        settleFailure(error, 'updater.download')
      }
    })
  }

  const download = async (): Promise<void> => {
    if (state.value.kind === 'downloading' && running) {
      await running
      return
    }
    if (state.value.kind !== 'available') return
    await runDownload()
  }

  const retry = async (): Promise<void> => {
    if (!canRetry.value || offer.value === null) return
    await runDownload()
  }

  const cancel = (): void => {
    const id = operation
    if (id === null) return
    void updater.cancelUpdate(id).catch(() => {
      // The op settled before the cancel reached the host: its own result stands.
    })
  }

  /** The one close request, then the restart into the Design open at that moment (Linux, 2.1-M209). */
  const restart = async (): Promise<void> => {
    if (!move({ kind: 'close_requested' })) return
    if ((await options.flushBeforeExit('update')) === 'cancel') {
      move({ kind: 'installed' })
      return
    }
    try {
      await updater.restartAfterUpdate(options.currentDesignPath())
    } catch {
      // The restart did not run: the update stays installed and About offers "Restart to finish updating" again.
      move({ kind: 'installed' })
    }
  }

  /** Runs the host's install with every window close held until it settles; answers whether a close waited. */
  const runInstall = async (): Promise<{ readonly installed: boolean, readonly closeWaited: boolean }> => {
    const installing = updater.installUpdate(options.currentDesignPath())
    const closeWaited = options.holdCloseUntilSettled(installing)
    try {
      await installing
      return { installed: true, closeWaited: closeWaited() }
    } catch (error) {
      settleFailure(error, 'updater.install')
      return { installed: false, closeWaited: closeWaited() }
    }
  }

  const install = async (): Promise<void> => {
    if (state.value.kind !== 'verified') return
    if (options.platform === 'windows') {
      // The installer quits Canopi, so the close request comes first; Cancel installs nothing (2.1-Q234, M209).
      move({ kind: 'close_requested' })
      if ((await options.flushBeforeExit('update')) === 'cancel') {
        move({ kind: 'verified' })
        return
      }
      await runInstall()
      return
    }
    move({ kind: 'installing' })
    const { installed, closeWaited } = await runInstall()
    if (!installed) return
    move({ kind: 'installed' })
    // A window close waited for the install: it ends Canopi now, without restarting (2.1-Q254).
    if (closeWaited) return
    await restart()
  }

  return { state, offer, upToDate, canRetry, failureMessage, exiting, launchCheck, check, download, retry, cancel, install, restart }
}
