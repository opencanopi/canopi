import { describe, expect, it, vi } from 'vitest'

import { SceneStore } from '../canvas/runtime/scene'
import { CanvasAuthorityBusyError } from '../canvas/runtime/runtime'
import {
  createDetachedSceneSessionAdapter,
  SceneRuntimeEditCoordinator,
} from '../canvas/runtime/scene-runtime/transactions'

function createAuthority() {
  const store = new SceneStore()
  const history = createDetachedSceneSessionAdapter()
  const authority = new SceneRuntimeEditCoordinator({
    sceneStore: store,
    sceneSession: history,
    setSelection: (ids) => store.setSelection(ids),
    incrementSceneRevision: vi.fn(),
    syncCanvasSignalsFromScene: vi.fn(),
    invalidate: vi.fn(),
  })
  history.bindReplay((command, direction) => authority.replayCommand(command, direction))
  return { authority, history, store }
}

describe('Settled Scene persistence authority', () => {
  it('captures the committed before-state while a live preview remains visible', () => {
    const { authority, history, store } = createAuthority()
    const edit = authority.begin('drag')
    edit.mutate((draft) => {
      draft.plantSpeciesColors['Malus domestica'] = '#aa0000'
    })

    const capture = authority.capturePersistence()

    expect(store.persisted.plantSpeciesColors['Malus domestica']).toBe('#aa0000')
    expect(capture.scene.plantSpeciesColors['Malus domestica']).toBeUndefined()

    edit.abort()
    expect(capture.acknowledgeSaved()).toBe('applied')
    expect(history.canUndo.value).toBe(false)
  })

  it('leaves a committed edit dirty when acknowledging its older capture', () => {
    const { authority, history } = createAuthority()
    const edit = authority.begin('drag')
    edit.mutate((draft) => {
      draft.plantSpeciesColors['Malus domestica'] = '#aa0000'
    })
    const capture = authority.capturePersistence()

    edit.commit()

    expect(capture.acknowledgeSaved()).toBe('applied')
    expect(history.canUndo.value).toBe(true)
  })

  it('makes checkpoints stale when another document is hydrated', () => {
    const { authority } = createAuthority()
    const capture = authority.capturePersistence()

    authority.hydrate(new SceneStore().toCanopiFile())

    expect(capture.acknowledgeSaved()).toBe('stale')
  })

  it('captures the after-state once history has accepted a committing edit', () => {
    const store = new SceneStore()
    const reentrantCaptures: Array<
      ReturnType<SceneRuntimeEditCoordinator['capturePersistence']>
    > = []
    const authority: SceneRuntimeEditCoordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      setSelection: (ids) => store.setSelection(ids),
      incrementSceneRevision: vi.fn(),
      syncCanvasSignalsFromScene: () => {
        if (reentrantCaptures.length === 0) {
          reentrantCaptures.push(authority.capturePersistence())
        }
      },
      invalidate: vi.fn(),
    })
    const edit = authority.begin('command')
    edit.mutate((draft) => {
      draft.plantSpeciesColors['Malus domestica'] = '#aa0000'
    })

    edit.commit()

    const reentrantCapture = reentrantCaptures[0]
    expect(reentrantCapture?.scene.plantSpeciesColors['Malus domestica']).toBe('#aa0000')
    expect(reentrantCapture?.acknowledgeSaved()).toBe('applied')
  })

  it('rejects mixed capture while document hydration is settling', () => {
    const store = new SceneStore()
    let captureError: unknown = null
    const authority: SceneRuntimeEditCoordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      setSelection: (ids) => store.setSelection(ids),
      incrementSceneRevision: vi.fn(),
      syncCanvasSignalsFromScene: () => {
        try {
          authority.capturePersistence()
        } catch (error) {
          captureError = error
        }
      },
      invalidate: vi.fn(),
    })

    authority.hydrate(new SceneStore().toCanopiFile())

    expect(captureError).toMatchObject({ name: 'SceneEditBusyError' })
    expect(captureError).toBeInstanceOf(CanvasAuthorityBusyError)
    expect(() => authority.capturePersistence()).not.toThrow()
  })

  it('invalidates a capture when its runtime lifetime ends', () => {
    const { authority, history } = createAuthority()
    const capture = authority.capturePersistence()
    authority.run('later-edit', (edit) => {
      edit.mutate((draft) => {
        draft.plantSpeciesColors['Malus domestica'] = '#aa0000'
      })
    })

    authority.disposePersistence()

    expect(capture.acknowledgeSaved()).toBe('stale')
    expect(history.canUndo.value).toBe(true)
  })

  it('captures the undone state at once after an undo whose selection replay throws', () => {
    const store = new SceneStore()
    let selectionFailures = 0
    const authority = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      setSelection: (ids) => {
        if (selectionFailures > 0) {
          selectionFailures -= 1
          throw new Error('selection replay failed')
        }
        store.setSelection(ids)
      },
      incrementSceneRevision: vi.fn(),
      syncCanvasSignalsFromScene: vi.fn(),
      invalidate: vi.fn(),
    })
    authority.run('edit-and-select', (edit) => {
      edit.mutate((draft) => {
        draft.plantSpeciesColors['Malus domestica'] = '#aa0000'
      })
      edit.setSelection([{ kind: 'plant', id: 'plant-1' }])
    })

    selectionFailures = 1
    expect(() => authority.undo()).toThrow('selection replay failed')
    expect(store.persisted.plantSpeciesColors['Malus domestica']).toBeUndefined()

    // The undo kept its step and released the Scene: nothing waits to be resumed.
    const capture = authority.capturePersistence()
    expect(capture.scene.plantSpeciesColors['Malus domestica']).toBeUndefined()
    expect(capture.acknowledgeSaved()).toBe('applied')
  })

  it('returns stale when document replacement reenters clean-state publication', () => {
    const { authority } = createAuthority()
    const capture = authority.capturePersistence()

    authority.hydrate(new SceneStore().toCanopiFile())

    expect(capture.acknowledgeSaved()).toBe('stale')
  })

  it('rejects new persistence captures after the runtime lifetime ends', () => {
    const { authority } = createAuthority()

    authority.disposePersistence()

    expect(() => authority.capturePersistence()).toThrow('runtime-disposed')
  })
})
