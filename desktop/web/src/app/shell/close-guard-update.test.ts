import { effect } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestSessionCore, makeTestDesign } from '../../__tests__/support/session-core-fixture'
import {
  answerSaveProblem,
  saveProblem,
  type SaveProblemChoice,
  type SaveProblemRequest,
} from '../document-session/save-problem'
import { createUpdateController, type UpdaterPort } from '../updates/controller'
import { createUuid } from '../../utils/ids'
import type { UpdateDownload, UpdaterFailure, UpdateOffer, UpdateOs } from '../../generated/contracts'
import { closeWaitsFor, flushBeforeExit, holdCloseUntilSettled, registerCloseGuard } from './close-guard'

// A window close during a Desktop update (canopi-f47t.52.228.15, canopi-f47t.52.228), through the real
// SessionCore, state machine, controller and close guard.

type Result<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly failure: UpdaterFailure }
const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/canopi/canopi/releases/tag/v2.1.0' }
const ADMIN_PROMPT_DISMISSED: UpdaterFailure = { code: { kind: 'update_admin_prompt_dismissed' }, user_may_retry: true, op: 'updater.install', operation: null, detail: null }
const INSTALLER_FAILED: UpdaterFailure = { code: { kind: 'update_install_failed', bundle: 'nsis' }, user_may_retry: true, op: 'updater.install', operation: null, detail: null }

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  if (saveProblem.peek()) answerSaveProblem('cancel')
})

function makeUpdateCloseHarness(options: {
  readonly platform: UpdateOs
  readonly holdInstall?: boolean
  readonly holdFlush?: boolean
  readonly install?: Result<null>
  readonly settingsSaveable?: boolean
  readonly answers?: readonly SaveProblemChoice[]
}) {
  const order: string[] = []
  const restarts: number[] = []
  const asked: SaveProblemRequest[] = []
  const answers = [...(options.answers ?? [])]
  let releaseInstall: (() => void) | null = null
  let releaseFlush: (() => void) | null = null
  let flushHeld = options.holdFlush ?? false

  const session = createTestSessionCore({
    file: makeTestDesign(),
    path: '/designs/orchard.canopi',
    flushSettings: async () => {
      if (!(options.settingsSaveable ?? true)) throw new Error('settings unwritable')
    },
  })
  const origWrite = session.home.write.bind(session.home)
  vi.spyOn(session.home, 'write').mockImplementation(async (...args) => {
    if (flushHeld) {
      flushHeld = false
      await new Promise<void>((resolve) => { releaseFlush = resolve })
    }
    const res = await origWrite(...args)
    order.push('design-flushed')
    return res
  })
  const origDestroy = session.lifecycle.destroyWindow!.bind(session.lifecycle)
  session.lifecycle.destroyWindow = async () => {
    order.push('destroyed')
    await origDestroy()
  }

  session.core.document('dirty', () => ({ description: 'pending-before-update' }))

  const guard = registerCloseGuard()
  const stopAutoAnswer = effect(() => {
    const req = saveProblem.value
    if (!req) return
    asked.push(req)
    const answer = answers.shift() ?? 'cancel'
    queueMicrotask(() => {
      if (saveProblem.peek() === req) answerSaveProblem(answer)
    })
  })
  cleanups.push(() => {
    stopAutoAnswer()
    guard.dispose()
    session.dispose()
  })

  const updaterPort: UpdaterPort = {
    checkForUpdate: async () => OFFER,
    downloadUpdate: async (): Promise<UpdateDownload> => ({ kind: 'verified' }),
    cancelUpdate: async () => {},
    installUpdate: () => {
      const result = options.install ?? { ok: true, value: null }
      order.push('install')
      if (!options.holdInstall) {
        return result.ok ? Promise.resolve() : Promise.reject(result.failure)
      }
      return new Promise<void>((resolve, reject) => {
        releaseInstall = () => {
          if (result.ok) resolve()
          else reject(result.failure)
        }
      })
    },
    restartAfterUpdate: async () => {
      restarts.push(restarts.length + 1)
      order.push('restart')
    },
    getLaunchCheck: async () => true,
  }

  const updater = createUpdateController({
    updater: updaterPort,
    platform: options.platform,
    flushBeforeExit,
    holdCloseUntilSettled,
    mintOperationId: createUuid,
  })

  return {
    session,
    updater,
    order,
    restarts,
    asked,
    requestClose: () => flushBeforeExit('close'),
    destroyed: () => session.lifecycle.destroyedCount() > 0,
    waitForInstallHeld: () => vi.waitFor(() => expect(releaseInstall).not.toBeNull()),
    waitForFlushHeld: () => vi.waitFor(() => expect(releaseFlush).not.toBeNull()),
    releaseInstall: () => { releaseInstall?.() },
    releaseFlush: () => { releaseFlush?.() },
    dispose: () => {
      stopAutoAnswer()
      guard.dispose()
      session.dispose()
    },
  }
}

describe('Desktop updater window close', () => {
  it('a window close during a Linux update install waits for it, then closes without restarting (canopi-f47t.52.228.15)', async () => {
    const closedAfter = async (install: Result<null>) => {
      const h = makeUpdateCloseHarness({ platform: 'linux', holdInstall: true, install })
      await h.updater.check().then(() => h.updater.download())
      const installing = h.updater.install()
      await h.waitForInstallHeld()
      const closing = h.requestClose()
      await vi.waitFor(() => expect(closeWaitsFor.value).toBe('install'))
      const whileInstalling = { destroyed: h.destroyed(), waiting: closeWaitsFor.value }
      h.releaseInstall()
      await Promise.all([installing, closing])
      const result = {
        whileInstalling,
        destroyed: h.destroyed(),
        waiting: closeWaitsFor.value,
        restarts: h.restarts,
        state: h.updater.state.value.kind,
      }
      h.dispose()
      return result
    }

    expect({
      installed: await closedAfter({ ok: true, value: null }),
      failed: await closedAfter({ ok: false, failure: ADMIN_PROMPT_DISMISSED }),
    }).toEqual({
      installed: { whileInstalling: { destroyed: false, waiting: 'install' }, destroyed: true, waiting: null, restarts: [], state: 'installed' },
      failed: { whileInstalling: { destroyed: false, waiting: 'install' }, destroyed: true, waiting: null, restarts: [], state: 'failed' },
    })
  })

  it('a window close during the update\'s exit flush waits for the installer or the restart (canopi-f47t.52.228)', async () => {
    const windows = async () => {
      const h = makeUpdateCloseHarness({
        platform: 'windows',
        holdFlush: true,
        holdInstall: true,
        install: { ok: false, failure: INSTALLER_FAILED },
      })
      await h.updater.check().then(() => h.updater.download())
      const installing = h.updater.install()
      await h.waitForFlushHeld()
      const closing = h.requestClose()
      await vi.waitFor(() => expect(closeWaitsFor.value).toBe('exit'))
      const duringFlush = { order: [...h.order], waiting: closeWaitsFor.value }
      h.releaseFlush()
      await h.waitForInstallHeld()
      const duringInstall = { order: [...h.order], waiting: closeWaitsFor.value }
      h.releaseInstall()
      await Promise.all([installing, closing])
      const res = { duringFlush, duringInstall, order: h.order, state: h.updater.state.value.kind }
      h.dispose()
      return res
    }
    const linux = async () => {
      const h = makeUpdateCloseHarness({ platform: 'linux', holdFlush: true })
      await h.updater.check().then(() => h.updater.download())
      const installing = h.updater.install()
      await h.waitForFlushHeld()
      const closing = h.requestClose()
      await vi.waitFor(() => expect(closeWaitsFor.value).toBe('exit'))
      const duringFlush = { order: [...h.order], waiting: closeWaitsFor.value }
      h.releaseFlush()
      await Promise.all([installing, closing])
      const res = { duringFlush, order: h.order }
      h.dispose()
      return res
    }

    expect({ windows: await windows(), linux: await linux() }).toEqual({
      windows: {
        duringFlush: { order: [], waiting: 'exit' },
        duringInstall: { order: ['design-flushed', 'install'], waiting: 'exit' },
        order: ['design-flushed', 'install', 'destroyed'],
        state: 'failed',
      },
      linux: {
        duringFlush: { order: ['install'], waiting: 'exit' },
        order: ['install', 'design-flushed', 'restart', 'destroyed'],
      },
    })
  })

  it('after an update\'s exit flush answered cancel, a later window close flushes and closes the window', async () => {
    const h = makeUpdateCloseHarness({
      platform: 'windows',
      settingsSaveable: false,
      answers: ['cancel', 'discard'],
    })
    await h.updater.check().then(() => h.updater.download())
    await h.updater.install()
    const afterCancel = { order: [...h.order], state: h.updater.state.value.kind }
    await h.requestClose()

    expect({ afterCancel, order: h.order, asked: h.asked.length }).toEqual({
      afterCancel: { order: ['design-flushed'], state: 'verified' },
      order: ['design-flushed', 'destroyed'],
      asked: 2,
    })
    h.dispose()
  })

  it('a window close waiting on an update exit the user cancelled keeps Canopi open', async () => {
    const h = makeUpdateCloseHarness({
      platform: 'windows',
      holdFlush: true,
      settingsSaveable: false,
      answers: ['cancel', 'discard'],
    })
    await h.updater.check().then(() => h.updater.download())
    const installing = h.updater.install()
    await h.waitForFlushHeld()
    const closing = h.requestClose()
    await vi.waitFor(() => expect(closeWaitsFor.value).toBe('exit'))
    h.releaseFlush()
    await Promise.all([installing, closing])

    expect({
      destroyed: h.destroyed(),
      order: h.order,
      asked: h.asked.length,
      waiting: closeWaitsFor.value,
      state: h.updater.state.value.kind,
    }).toEqual({
      destroyed: false,
      order: ['design-flushed'],
      asked: 1,
      waiting: null,
      state: 'verified',
    })
    h.dispose()
  })
})
