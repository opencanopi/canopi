import { describe, expect, it, vi } from 'vitest'
import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  createCanvasDocumentReplacementToken,
} from '../../canvas/runtime/runtime'
import { createTestCanvasDocumentSurface } from '../../__tests__/support/canvas-runtime-surfaces'
import type { WorkspaceActivationSnapshot } from './workspace-activation'
import { createWorkspaceDocumentSurface } from './workspace-document-surface'
import {
  WorkspaceGenerationReconciler,
  type WorkspaceGenerationLifecycle,
} from './workspace-generation-reconciler'

describe('WorkspaceGenerationReconciler', () => {
  it('returns no-design during initial reconciliation without lifecycle work', async () => {
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => null })

    await expect(reconciler.reconcileInitialGeneration()).resolves.toBe('no-design')
    expect(workspace.requestGenerationDisconnect).not.toHaveBeenCalled()
    expect(workspace.activate).not.toHaveBeenCalled()
  })

  it('activates one initial Design and publishes its non-cancelled outcome', async () => {
    const A = snapshot()
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({
      workspace, readSnapshot: () => A,
    })

    await expect(reconciler.reconcileInitialGeneration()).resolves.toBe('shared-ready')
    expect(workspace.activate).toHaveBeenCalledExactlyOnceWith(A)
    await expect(workspace.activate.mock.results[0]!.value).resolves.toBe('shared-ready')
  })

  it('observes one initial snapshot read failure without rejecting startup', async () => {
    const error = new Error('snapshot failed')
    const onFailure = vi.fn()
    const reconciler = new WorkspaceGenerationReconciler({
      workspace: lifecycle(), readSnapshot: () => { throw error }, onFailure,
    })

    await expect(reconciler.reconcileInitialGeneration()).resolves.toBe('cancelled')
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('invalidates a late initial activation when replacement starts', async () => {
    const initial = deferred<'shared-ready'>()
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const B = snapshot({ sessionIdentity: {}, latitude: 20 })
    let current = A
    const workspace = lifecycle({
      activate: vi.fn()
        .mockImplementationOnce(() => initial.promise)
        .mockResolvedValue('shared-ready'),
    })
    const reconciler = new WorkspaceGenerationReconciler({
      workspace, readSnapshot: () => current,
    })

    const startup = reconciler.reconcileInitialGeneration()
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledExactlyOnceWith(A))
    current = B
    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(2))
    initial.resolve('shared-ready')

    await expect(startup).resolves.toBe('cancelled')
    expect(workspace.activate).toHaveBeenLastCalledWith(B)
    await expect(workspace.activate.mock.results[1]!.value).resolves.toBe('shared-ready')
  })

  it('invalidates a late initial activation when disposed', async () => {
    const activation = deferred<'shared-ready'>()
    const workspace = lifecycle({ activate: () => activation.promise })
    const reconciler = new WorkspaceGenerationReconciler({
      workspace, readSnapshot: () => snapshot(),
    })

    const startup = reconciler.reconcileInitialGeneration()
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledOnce())
    await reconciler.dispose()
    activation.resolve('shared-ready')

    await expect(startup).resolves.toBe('cancelled')
  })

  it('contains a throwing failure observer during queued snapshot reconciliation', async () => {
    const readError = new Error('snapshot failed')
    const observerError = new Error('observer failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = new WorkspaceGenerationReconciler({
      workspace: lifecycle(),
      readSnapshot: () => { throw readError },
      onFailure: () => { throw observerError },
    })

    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      'Shared workspace failure observer failed:', observerError,
    ))
    consoleError.mockRestore()
  })

  it('keeps a null snapshot disconnected after typed pre-hydration rejection', async () => {
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => null })
    const error = new CanvasDocumentReplacementNotAdmittedError(new Error('not hydrated'))
    const documents = createTestCanvasDocumentSurface({
      replaceDocument: () => { throw error },
    })
    const surface = createWorkspaceDocumentSurface({ documents, reconciler })

    expect(() => surface.replaceDocument(
      {} as never,
      createCanvasDocumentReplacementToken(),
      () => {},
    )).toThrow(error)
    await Promise.resolve()

    expect(workspace.requestGenerationDisconnect).toHaveBeenCalledOnce()
    expect(workspace.activate).not.toHaveBeenCalled()
  })

  it('readmits the authoritative prior generation after typed pre-hydration rejection', async () => {
    const cleanup = deferred<void>()
    const events: string[] = []
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const workspace = lifecycle({
      requestGenerationDisconnect: () => {
        events.push('disconnect')
        return cleanup.promise
      },
      activate: async (candidate) => {
        events.push(`activate:${label(candidate)}`)
        await cleanup.promise
        events.push(`admit:${label(candidate)}`)
        return 'shared-ready'
      },
    })
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => A })
    const error = new CanvasDocumentReplacementNotAdmittedError(new Error('pre-hydration rejected'))
    const documents = createTestCanvasDocumentSurface({
      replaceDocument: () => {
        events.push('delegate')
        throw error
      },
    })
    const surface = createWorkspaceDocumentSurface({ documents, reconciler })

    expect(() => surface.replaceDocument({} as never, createCanvasDocumentReplacementToken(), () => {}))
      .toThrow(error)
    expect(events).toEqual(['disconnect', 'delegate'])
    await Promise.resolve()
    expect(workspace.activate).toHaveBeenCalledWith(A)
    cleanup.resolve()
    await vi.waitFor(() => expect(events).toContain('admit:A'))
  })

  it('activates the post-replacement snapshot only after delegated replacement and cleanup', async () => {
    const cleanup = deferred<void>()
    const events: string[] = []
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const B = snapshot({ sessionIdentity: {}, latitude: 20 })
    let current = A
    const workspace = lifecycle({
      requestGenerationDisconnect: () => {
        events.push('disconnect')
        return cleanup.promise
      },
      activate: async (candidate) => {
        events.push(`activate:${label(candidate)}`)
        await cleanup.promise
        events.push('old-map-released')
        events.push(`admit:${label(candidate)}`)
        return 'shared-ready'
      },
    })
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })
    const documents = createTestCanvasDocumentSurface({
      replaceDocument: (_file, _token, finalize) => {
        events.push('delegate')
        current = B
        finalize()
        return { callerFinalizerInvoked: true }
      },
    })
    const surface = createWorkspaceDocumentSurface({ documents, reconciler })

    surface.replaceDocument({} as never, createCanvasDocumentReplacementToken(), () => {
      events.push('finalize')
    })
    expect(events).toEqual(['disconnect', 'delegate', 'finalize'])
    await Promise.resolve()
    expect(events).toEqual(['disconnect', 'delegate', 'finalize', 'activate:B'])
    cleanup.resolve()
    await vi.waitFor(() => expect(events).toContain('admit:B'))
    expect(events.indexOf('old-map-released')).toBeLessThan(events.indexOf('admit:B'))
  })

  it('replaces equal map values for a new session identity and skips repeated publication', async () => {
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const B = snapshot({ sessionIdentity: {}, latitude: 10 })
    let current = A
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })

    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(1))
    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(2))
    expect(workspace.activate).toHaveBeenLastCalledWith(A)

    current = B
    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(3))
    expect(workspace.activate).toHaveBeenLastCalledWith(B)

    const ticket = reconciler.suspendForDocumentReplacement()
    reconciler.reconcileAfterDocumentReplacement(ticket)
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(4))
    reconciler.reconcileAfterDocumentReplacement(ticket)
    await Promise.resolve()
    expect(workspace.activate).toHaveBeenCalledTimes(4)
  })

  it('invalidates queued recovery when a successor replacement begins', async () => {
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const C = snapshot({ sessionIdentity: {}, latitude: 30 })
    let current = A
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })

    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    current = C
    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())

    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(1))
    expect(workspace.activate).toHaveBeenCalledWith(C)
  })

  it('keeps ambiguous replacement failure fenced until a later successful retry', async () => {
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const B = snapshot({ sessionIdentity: {}, latitude: 20 })
    let current = A
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })
    const documents = createTestCanvasDocumentSurface({
      replaceDocument: () => { throw new CanvasAuthorityBusyError('document-settlement') },
    })
    const surface = createWorkspaceDocumentSurface({ documents, reconciler })
    const token = createCanvasDocumentReplacementToken()

    expect(() => surface.replaceDocument({} as never, token, () => {})).toThrow(CanvasAuthorityBusyError)
    await Promise.resolve()
    expect(workspace.activate).not.toHaveBeenCalled()
    current = B
    documents.replaceDocument = vi.fn(() => ({ callerFinalizerInvoked: true }))
    surface.replaceDocument({} as never, token, () => {})
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(1))
    expect(workspace.activate).toHaveBeenCalledWith(B)
  })

  it('ignores predecessor completion after a nested ambiguous successor failure', async () => {
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const C = snapshot({ sessionIdentity: {}, latitude: 30 })
    let current = A
    const workspace = lifecycle()
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })
    const busy = new CanvasAuthorityBusyError('document-settlement')
    const outerToken = createCanvasDocumentReplacementToken()
    const successorToken = createCanvasDocumentReplacementToken()
    let nested = false
    const documents = createTestCanvasDocumentSurface({
      replaceDocument: () => {
        if (nested) throw busy
        nested = true
        try {
          surface.replaceDocument({} as never, successorToken, () => {})
        } catch (error) {
          expect(error).toBe(busy)
        }
        return { callerFinalizerInvoked: true }
      },
    })
    const surface: ReturnType<typeof createWorkspaceDocumentSurface> = createWorkspaceDocumentSurface({ documents, reconciler })

    surface.replaceDocument({} as never, outerToken, () => {})
    await Promise.resolve()
    expect(workspace.activate).not.toHaveBeenCalled()
    current = C
    documents.replaceDocument = vi.fn(() => ({ callerFinalizerInvoked: true }))
    surface.replaceDocument({} as never, successorToken, () => {})
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledTimes(1))
    expect(workspace.activate).toHaveBeenCalledWith(C)
  })

  it('observes synchronous activation failure without retrying', async () => {
    const activationError = new Error('activation rejected')
    const workspace = lifecycle({
      activate: () => { throw activationError },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => snapshot() })

    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Shared workspace activation failed:', activationError,
    ))
    expect(consoleError).toHaveBeenCalledWith('Shared workspace activation failed:', activationError)
    expect(workspace.requestGenerationDisconnect).toHaveBeenCalledOnce()
    expect(workspace.activate).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(workspace.activate).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('memoizes a synchronous terminal teardown throw as one observed rejection', async () => {
    const error = new Error('teardown threw')
    const workspace = lifecycle({ teardown: () => { throw error } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => snapshot() })

    const first = reconciler.dispose()
    const second = reconciler.dispose()
    expect(second).toBe(first)
    expect(workspace.teardown).toHaveBeenCalledOnce()
    await expect(first).rejects.toBe(error)
    await Promise.resolve()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('Shared workspace teardown failed:', error)
    consoleError.mockRestore()
  })

  it('observes one rejected terminal teardown promise', async () => {
    const error = new Error('teardown rejected')
    const workspace = lifecycle({ teardown: () => Promise.reject(error) })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => snapshot() })

    const first = reconciler.dispose()
    const second = reconciler.dispose()
    expect(second).toBe(first)
    expect(workspace.teardown).toHaveBeenCalledOnce()
    await expect(first).rejects.toBe(error)
    await Promise.resolve()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('Shared workspace teardown failed:', error)
    consoleError.mockRestore()
  })

  it('disposes terminally and invalidates queued or late activation work', async () => {
    const teardown = deferred<void>()
    const activation = deferred<'shared-ready'>()
    const workspace = lifecycle({ teardown: () => teardown.promise, activate: () => activation.promise })
    const readSnapshot = vi.fn(() => snapshot({ sessionIdentity: {}, latitude: 10 }))
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot })

    reconciler.reconcileAfterDocumentReplacement(reconciler.suspendForDocumentReplacement())
    const firstTeardown = reconciler.dispose()
    const secondTeardown = reconciler.dispose()
    expect(secondTeardown).toBe(firstTeardown)
    expect(workspace.teardown).toHaveBeenCalledOnce()
    teardown.resolve()
    await firstTeardown
    await Promise.resolve()
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(workspace.activate).not.toHaveBeenCalled()
    reconciler.reconcileAfterDocumentReplacement(null)
    activation.resolve('shared-ready')
    await Promise.resolve()
    expect(workspace.activate).not.toHaveBeenCalled()
  })

  it('activates the current Design again on a Retry the workspace accepts', async () => {
    const A = snapshot()
    const B = snapshot()
    let current = A
    const workspace = lifecycle({ activate: vi.fn().mockResolvedValueOnce('map-unavailable').mockResolvedValue('shared-ready') })
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })
    await expect(reconciler.reconcileInitialGeneration()).resolves.toBe('map-unavailable')
    current = B

    expect(reconciler.retry()).toBe(true)

    expect(workspace.retry).toHaveBeenCalledOnce()
    expect(workspace.activate).toHaveBeenLastCalledWith(B)
    // A second press while that activation runs is refused rather than queued.
    expect(reconciler.retry()).toBe(false)
    await vi.waitFor(() => expect(reconciler.retry()).toBe(true))
    expect(workspace.activate).toHaveBeenCalledTimes(3)
  })

  it('refuses Retry without a Design, when the workspace refuses, during a replacement and after disposal', async () => {
    let current: WorkspaceActivationSnapshot | null = null
    const workspace = lifecycle({ retry: () => false })
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => current })
    expect(reconciler.retry()).toBe(false)
    expect(workspace.retry).not.toHaveBeenCalled()

    current = snapshot()
    expect(reconciler.retry()).toBe(false)
    expect(workspace.retry).toHaveBeenCalledOnce()

    workspace.retry.mockImplementation(() => true)
    reconciler.suspendForDocumentReplacement()
    expect(reconciler.retry()).toBe(false)

    await reconciler.dispose()
    expect(reconciler.retry()).toBe(false)
    expect(workspace.activate).not.toHaveBeenCalled()
  })

  it('ignores a late activation settlement after disposal', async () => {
    const activation = deferred<'shared-ready'>()
    const A = snapshot({ sessionIdentity: {}, latitude: 10 })
    const workspace = lifecycle({ activate: () => activation.promise })
    const reconciler = new WorkspaceGenerationReconciler({ workspace, readSnapshot: () => A })
    const ticket = reconciler.suspendForDocumentReplacement()

    reconciler.reconcileAfterDocumentReplacement(ticket)
    await vi.waitFor(() => expect(workspace.activate).toHaveBeenCalledWith(A))
    await reconciler.dispose()
    activation.resolve('shared-ready')
    await Promise.resolve()

    reconciler.reconcileAfterDocumentReplacement(ticket)
    await Promise.resolve()
    expect(workspace.activate).toHaveBeenCalledOnce()
  })
})

function lifecycle(overrides: Partial<WorkspaceGenerationLifecycle> = {}) {
  const requestGenerationDisconnect = overrides.requestGenerationDisconnect ?? (async () => {})
  const activate = overrides.activate ?? (async () => 'shared-ready' as const)
  const teardown = overrides.teardown ?? (async () => {})
  const retry = overrides.retry ?? (() => true)
  return {
    requestGenerationDisconnect: vi.fn(requestGenerationDisconnect),
    activate: vi.fn(activate),
    teardown: vi.fn(teardown),
    retry: vi.fn(retry),
  }
}

function snapshot({
  sessionIdentity = {},
  latitude = 48.8566,
}: Partial<Pick<WorkspaceActivationSnapshot, 'sessionIdentity'>> & { latitude?: number } = {}): WorkspaceActivationSnapshot {
  return {
    sessionIdentity,
    map: {
      initialCenter: { lat: latitude, lon: 2.3522 },
      background: {
        basemap: { style: 'liberty', visible: true, opacity: 1 },
        satellite: { visible: false, opacity: 1 },
        locale: 'en',
      },
    },
  }
}

function label(candidate: WorkspaceActivationSnapshot): string {
  return candidate.map.initialCenter.lat === 10 ? 'A' : 'B'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
