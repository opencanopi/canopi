import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_PROMPT_DISMISSED, closingWindow, fakeHost, INSTALLER_FAILED, settleTasks, startUpdater, type Result,
} from '../../__tests__/support/fake-update-host'
import { closeWaitsFor, registerCloseGuard } from './close-guard'

// A window close during a Desktop update (canopi-f47t.52.228.15, canopi-f47t.52.228), through the real state machine,
// controller and close guard: the fake host (__tests__/support/fake-update-host.ts) stands at the update commands and
// the close guard's flushes and question, and the window is the only other fake.

beforeEach(() => {
  fakeHost()
})

describe('Desktop updater window close', () => {
  // 2.1-Q254: the window's close never ends Canopi mid-install (a truncated AppImage, an orphaned pkexec prompt). The
  // close waits, the window showing "Installing update…", until the install settles; then Canopi closes without
  // restarting. Driven through the real close guard's close request, the window the only fake.
  it('a window close during a Linux update install waits for it, then closes without restarting (canopi-f47t.52.228.15)', async () => {
    const closedAfter = async (install: Result<null>) => {
      const host = fakeHost({ holdInstall: true, install })
      const window = closingWindow()
      const guard = registerCloseGuard()
      const updater = startUpdater(host, { platform: 'linux' })
      await updater.check().then(() => updater.download())
      const installing = updater.install()
      await settleTasks()
      const closing = window.requestClose()
      await settleTasks()
      const whileInstalling = { destroyed: window.destroyed(), waiting: closeWaitsFor.value }
      host.releaseInstall()
      await Promise.all([installing, closing]).finally(() => guard.dispose())
      return { whileInstalling, destroyed: window.destroyed(), waiting: closeWaitsFor.value, restarts: host.restarts, state: updater.state.value.kind }
    }

    expect({ installed: await closedAfter({ ok: true, value: null }), failed: await closedAfter({ ok: false, failure: ADMIN_PROMPT_DISMISSED }) }).toEqual({
      installed: { whileInstalling: { destroyed: false, waiting: 'install' }, destroyed: true, waiting: null, restarts: [], state: 'installed' },
      failed: { whileInstalling: { destroyed: false, waiting: 'install' }, destroyed: true, waiting: null, restarts: [], state: 'failed' },
    })
  })

  // A close during the update's own exit flush waits for the update's exit instead of running a second flush: the
  // window is never destroyed before the installer or the restart runs, and a failed install still ends in the close.
  // The wait is the exit's, not an install's, so the root says "Finishing update…" (canopi-f47t.52.228).
  it('a window close during the update\'s exit flush waits for the installer or the restart (canopi-f47t.52.228)', async () => {
    const windows = async () => {
      const host = fakeHost({ holdFlush: true, holdInstall: true, install: { ok: false, failure: INSTALLER_FAILED } })
      const window = closingWindow(host.order)
      const guard = registerCloseGuard()
      const updater = startUpdater(host, { platform: 'windows' })
      await updater.check().then(() => updater.download())
      const installing = updater.install()
      await settleTasks()
      const closing = window.requestClose()
      await settleTasks()
      const duringFlush = { order: [...host.order], waiting: closeWaitsFor.value }
      host.releaseFlush()
      await settleTasks()
      const duringInstall = { order: [...host.order], waiting: closeWaitsFor.value }
      host.releaseInstall()
      await Promise.all([installing, closing]).finally(() => guard.dispose())
      return { duringFlush, duringInstall, order: host.order, state: updater.state.value.kind }
    }
    const linux = async () => {
      const host = fakeHost({ holdFlush: true })
      const window = closingWindow(host.order)
      const guard = registerCloseGuard()
      const updater = startUpdater(host, { platform: 'linux' })
      await updater.check().then(() => updater.download())
      const installing = updater.install()
      await settleTasks()
      const closing = window.requestClose()
      await settleTasks()
      const duringFlush = { order: [...host.order], waiting: closeWaitsFor.value }
      host.releaseFlush()
      await Promise.all([installing, closing]).finally(() => guard.dispose())
      return { duringFlush, order: host.order }
    }

    expect({ windows: await windows(), linux: await linux() }).toEqual({
      windows: {
        duringFlush: { order: [], waiting: 'exit' },
        duringInstall: { order: ['design-flushed', 'install'], waiting: 'exit' },
        order: ['design-flushed', 'install', 'design-flushed', 'destroyed'],
        state: 'failed',
      },
      linux: { duringFlush: { order: ['install'], waiting: 'exit' }, order: ['install', 'design-flushed', 'restart', 'design-flushed', 'destroyed'] },
    })
  })
})
