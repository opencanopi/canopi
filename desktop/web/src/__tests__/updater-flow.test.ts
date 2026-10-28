import { describe, expect, it } from 'vitest'

// The Desktop updater's user paths (canopi-f47t.52.228.15), written before the modules they drive exist: each fails
// today because app/updates/controller.ts is missing. The chunk named in a title builds that path and drops its marker
// in the same commit. The states are the contract's UpdateState kinds (2.1-M208) and the failures its updater codes.

/** Loaded by path so this file compiles before the controller exists (F6-c2a creates it). */
const CONTROLLER_MODULE = '../app/updates/controller'

type UpdateStateKind =
  | 'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'installing' | 'installed' | 'close_requested'
  | 'failed' | 'link_only'

interface UpdateStateView { readonly kind: UpdateStateKind, readonly failure?: { readonly code: string } }

/** What a test drives: the host's update commands, faked, and the close guard's flush (ADR 0024). */
interface FakeUpdateHost {
  readonly staged: string[]
  readonly closeAnswers: string[]
  check(): Promise<void>
  download(): Promise<void>
  cancel(): void
  install(): Promise<void>
}

interface UpdateController {
  state(): UpdateStateView
  check(): Promise<void>
  download(): Promise<void>
  cancel(): void
  install(): Promise<void>
}

interface ControllerModule {
  createUpdateController(host: FakeUpdateHost, options: { readonly settingsSaveable: boolean, readonly offline: boolean }): UpdateController
}

async function loadController(): Promise<ControllerModule> {
  return (await import(/* @vite-ignore */ CONTROLLER_MODULE)) as ControllerModule
}

function fakeHost(): FakeUpdateHost {
  const staged: string[] = []
  const closeAnswers: string[] = []
  return {
    staged,
    closeAnswers,
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    cancel: () => undefined,
    install: () => Promise.resolve(),
  }
}

describe('Desktop updater user paths', () => {
  it.fails('[expected-fail F6-c2b, canopi-f47t.52.228.15] cancelled update download leaves nothing staged and settles cancelled', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost()
    const updater = createUpdateController(host, { settingsSaveable: true, offline: false })

    await updater.check()
    const download = updater.download()
    updater.cancel()
    await download

    expect({ state: updater.state(), staged: host.staged }).toEqual({ state: { kind: 'failed', failure: { code: 'cancelled' } }, staged: [] })
  })

  it.fails('[expected-fail F6-c2b, canopi-f47t.52.228.15] update install with an unsaveable settings store flushes the Design first, then offers Retry and Close anyway', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost()
    const updater = createUpdateController(host, { settingsSaveable: false, offline: false })

    await updater.check()
    await updater.download()
    await updater.install()

    expect(host.closeAnswers).toEqual(['design-flushed', 'retry', 'close-anyway'])
  })

  it.fails('[expected-fail F6-c3, canopi-f47t.52.228.15] offline update check settles network.offline and About shows it', async () => {
    const { createUpdateController } = await loadController()
    const updater = createUpdateController(fakeHost(), { settingsSaveable: true, offline: true })

    await updater.check()

    expect(updater.state()).toEqual({ kind: 'failed', failure: { code: 'network.offline' } })
  })

  it.fails('[expected-fail F6-c3, canopi-f47t.52.228.15] a dismissed .deb admin prompt keeps the Design open with Update not installed', async () => {
    const { createUpdateController } = await loadController()
    const host = fakeHost()
    const updater = createUpdateController({ ...host, install: () => Promise.reject(new Error('update_admin_prompt_dismissed')) }, { settingsSaveable: true, offline: false })

    await updater.check()
    await updater.download()
    await updater.install()

    expect({ state: updater.state(), closeAnswers: host.closeAnswers }).toEqual({ state: { kind: 'failed', failure: { code: 'update_admin_prompt_dismissed' } }, closeAnswers: [] })
  })
})
