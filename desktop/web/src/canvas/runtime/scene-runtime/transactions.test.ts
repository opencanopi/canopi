import { effect, signal } from '@preact/signals'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { designSessionFixture } from '../../../__tests__/support/design-session-state'
import type { CanopiFile } from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { geoAt, hydratedScene } from '../../../__tests__/support/geo-design'
import { currentCanvasSelection } from '../../session-state'
import {
  CanvasDocumentReplacementNotAdmittedError,
  createCanvasDocumentReplacementToken,
} from '../runtime'
import { SceneHistory } from '../scene-history'
import { SceneStore, type SceneDesignObjectTarget } from '../scene'
import {
  SceneEditBusyError,
  SceneRuntimeEditCoordinator,
  type SceneEditTransaction,
} from './transactions'

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Transaction demo',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
    ],
    plants: [
      {
        id: 'plant-1',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(10, 10),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
      {
        id: 'plant-2',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(30, 30),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
    ],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

// Hydration centres the session plane on the Design's objects, so compare
// against the metres the runtime hydrates rather than the authored ones.
function plantStart(index: number) {
  return hydratedScene(makeFile()).plants[index]!.position
}

function movedFirstPlant(x: number, y: number) {
  const file = makeFile()
  file.plants[0]!.position = geoAt(x, y)
  return hydratedScene(file).plants[0]!.position
}

function createHarness() {
  const sceneStore = new SceneStore().hydrate(makeFile())
  const history = new SceneHistory()
  const invalidations: string[] = []
  let sceneRevision = 0
  const setSelection = (targets: Iterable<SceneDesignObjectTarget>) => {
    const next = [...targets]
    sceneStore.setSelection(next)
    currentCanvasSelection.value = new Set(next.map((target) => target.id))
  }
  const sceneEdits = new SceneRuntimeEditCoordinator({
    sceneStore,
    history,
    setSelection,
    incrementSceneRevision: () => {
      sceneRevision += 1
    },
    syncCanvasSignalsFromScene: () => {},
    invalidate: () => {
      invalidations.push('scene')
    },
  })

  return {
    sceneStore,
    history,
    sceneEdits,
    invalidations,
    setSelection,
    readSceneRevision: () => sceneRevision,
  }
}

describe('scene edit transactions', () => {
  beforeEach(() => {
    designSessionFixture.canvasClean = true
    currentCanvasSelection.value = new Set()
  })

  it('commits a command edit as one history entry and one scene revision', () => {
    const { sceneStore, history, sceneEdits, invalidations, readSceneRevision } = createHarness()

    const committed = sceneEdits.run('command-move-plant', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 42, y: 10 }
      })
    })

    expect(committed).toBe(true)
    expect(sceneStore.persisted.plants[0]?.position).toEqual({ x: 42, y: 10 })
    expect(readSceneRevision()).toBe(1)
    expect(history.canUndo.value).toBe(true)
    expect(invalidations).toEqual(['scene'])

    sceneEdits.undo()

    expect(sceneStore.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(history.canUndo.value).toBe(false)
    expect(history.canRedo.value).toBe(true)

    sceneEdits.redo()

    expect(sceneStore.persisted.plants[0]?.position).toEqual({ x: 42, y: 10 })
    expect(history.canUndo.value).toBe(true)
    expect(history.canRedo.value).toBe(false)
  })

  it('does not dirty history, bump revision, or invalidate rendering for no-op edits', () => {
    const { sceneStore, history, sceneEdits, invalidations, readSceneRevision } = createHarness()

    const committed = sceneEdits.run('noop', (tx) => {
      tx.mutate((draft) => {
        draft.plants = draft.plants.map((plant) => ({ ...plant }))
      })
      tx.setSelection(sceneStore.session.selectedTargets)
    })

    expect(committed).toBe(false)
    expect(history.canUndo.value).toBe(false)
    expect(readSceneRevision()).toBe(0)
    expect(invalidations).toEqual([])
  })

  it('aborts and restores persisted scene, selection, and embedded locks', () => {
    const { sceneStore, history, sceneEdits, invalidations, setSelection, readSceneRevision } = createHarness()
    setSelection([{ kind: 'plant', id: 'plant-1' }])
    sceneStore.updatePersisted((draft) => {
      draft.plants[0]!.locked = true
    })

    const tx = sceneEdits.begin('interaction-drag')
    tx.mutate((draft) => {
      draft.plants[0]!.position = { x: 99, y: 99 }
      draft.plants[0]!.locked = false
      draft.plants = draft.plants.slice(0, 1)
    })
    tx.setSelection([{ kind: 'plant', id: 'plant-2' }])

    expect(tx.changed).toBe(true)

    tx.abort()

    expect(sceneStore.persisted.plants).toHaveLength(2)
    expect(sceneStore.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(sceneStore.persisted.plants[0]?.locked).toBe(true)
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'plant', id: 'plant-1' }])
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(history.canUndo.value).toBe(false)
    expect(readSceneRevision()).toBe(0)
    expect(invalidations).toEqual([])
  })

  it('commits long-lived interaction edits through the same lifecycle', () => {
    const { sceneStore, history, sceneEdits, invalidations, readSceneRevision } = createHarness()
    const tx = sceneEdits.begin('interaction-drag')

    tx.mutate((draft) => {
      draft.plants[1]!.position = { x: 35, y: 35 }
    })

    expect(tx.commit()).toBe(true)
    expect(sceneStore.persisted.plants[1]?.position).toEqual({ x: 35, y: 35 })
    expect(readSceneRevision()).toBe(1)
    expect(history.canUndo.value).toBe(true)
    expect(invalidations).toEqual(['scene'])
  })
})

function createAdmissionHarness(options: {
  readonly file?: CanopiFile
  readonly history?: SceneHistory
  readonly setSelection?: (targets: Iterable<SceneDesignObjectTarget>) => void
  readonly incrementSceneRevision?: () => void
  readonly syncCanvasSignalsFromScene?: () => void
  readonly invalidate?: () => void
} = {}): {
  readonly coordinator: SceneRuntimeEditCoordinator
  readonly store: SceneStore
  readonly history: SceneHistory
} {
  const store = new SceneStore().hydrate(options.file ?? makeFile())
  const history = options.history ?? new SceneHistory()
  const coordinator = new SceneRuntimeEditCoordinator({
    sceneStore: store,
    history,
    setSelection: options.setSelection ?? ((targets) => store.setSelection(targets)),
    incrementSceneRevision: options.incrementSceneRevision ?? (() => {}),
    syncCanvasSignalsFromScene: options.syncCanvasSignalsFromScene ?? (() => {}),
    invalidate: options.invalidate ?? vi.fn(),
  })
  return { coordinator, store, history }
}

describe('Scene Edit single-writer admission', () => {
  it('replays the exact typed selection when raw ids collide', () => {
    const file = makeFile()
    file.plants[0]!.id = 'shared-id'
    file.zones = [{
      id: 'shared-id', name: 'shared-id',
      zone_type: 'rect',
      rotation: 0,
      points: [geoAt(0, 0), geoAt(5, 0), geoAt(5, 5), geoAt(0, 5)],
      fill_color: null,
      notes: null,
      locked: false,
    }]
    const { coordinator, store } = createAdmissionHarness({ file })
    store.setSelection([{ kind: 'plant', id: 'shared-id' }])

    const preview = coordinator.begin('preview-colliding-zone')
    preview.setSelection([{ kind: 'zone', id: 'shared-id' }])
    expect(store.session.selectedTargets).toEqual([{ kind: 'zone', id: 'shared-id' }])
    preview.abort()
    expect(store.session.selectedTargets).toEqual([{ kind: 'plant', id: 'shared-id' }])

    expect(coordinator.run('select-colliding-zone', (tx) => {
      tx.setSelection([{ kind: 'zone', id: 'shared-id' }])
    })).toBe(true)
    expect(store.session.selectedTargets).toEqual([{ kind: 'zone', id: 'shared-id' }])

    expect(coordinator.undo()).toBe(true)
    expect(store.session.selectedTargets).toEqual([{ kind: 'plant', id: 'shared-id' }])

    expect(coordinator.redo()).toBe(true)
    expect(store.session.selectedTargets).toEqual([{ kind: 'zone', id: 'shared-id' }])
  })

  it('does not strand authority when admission observers throw during acquire or release', () => {
    const { coordinator } = createAdmissionHarness()
    let publicationFailure: string | null = null
    const dispose = effect(() => {
      void coordinator.revision.value
      if (!publicationFailure) return
      const message = publicationFailure
      publicationFailure = null
      throw new Error(message)
    })

    publicationFailure = 'acquire observer failed'
    const active = coordinator.begin('interaction-drag')
    publicationFailure = 'release observer failed'
    active.abort()

    const next = coordinator.begin('interaction-rotation')
    next.abort()
    dispose()
  })

  it('rejects a second long-lived edit with a typed busy error', () => {
    const { coordinator } = createAdmissionHarness()
    const active = coordinator.begin('interaction-drag')
    let busyError: unknown

    try {
      coordinator.begin('interaction-rotation')
    } catch (error) {
      busyError = error
    }

    expect(busyError).toBeInstanceOf(SceneEditBusyError)
    expect((busyError as SceneEditBusyError).activeType).toBe('interaction-drag')

    active.abort()
  })

  it('does not invoke an immediate edit while a long-lived edit owns the Scene', () => {
    const { coordinator } = createAdmissionHarness()
    const active = coordinator.begin('interaction-drag')
    const edit = vi.fn()

    expect(coordinator.run('delete-selected', edit)).toBe(false)
    expect(edit).not.toHaveBeenCalled()

    active.abort()
    expect(coordinator.run('move-after-settlement', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 11, y: 12 }
      })
    })).toBe(true)
  })

  it('preserves hover Session state when a Scene Edit aborts', () => {
    const { coordinator, store } = createAdmissionHarness()
    const active = coordinator.begin('interaction-drag')
    active.mutate((draft) => {
      draft.plants[0]!.position = { x: 99, y: 99 }
    })
    store.updateSession((session) => {
      session.hoveredTarget = { kind: 'plant', id: 'plant-2' }
    })

    active.abort()

    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(store.session.hoveredTarget).toEqual({ kind: 'plant', id: 'plant-2' })
  })

  it('aborts an immediate edit when history rejects it before acceptance', () => {
    const history = new SceneHistory()
    const record = history.record.bind(history)
    vi.spyOn(history, 'record').mockImplementationOnce(() => {
      throw new Error('history rejected before acceptance')
    }).mockImplementation(record)
    const { coordinator, store } = createAdmissionHarness({ history })

    expect(() => coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toThrow('history rejected before acceptance')

    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(history.canUndo.value).toBe(false)
  })

  it('keeps an accepted immediate edit when history throws after acceptance, and rethrows', () => {
    const history = new SceneHistory()
    const record = history.record.bind(history)
    vi.spyOn(history, 'record').mockImplementationOnce((command, accepted) => {
      record(command, accepted)
      throw new Error('history publication failed after acceptance')
    }).mockImplementation(record)
    const { coordinator, store } = createAdmissionHarness({ history })

    expect(() => coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toThrow('history publication failed after acceptance')

    expect(store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
    expect(coordinator.undo()).toBe(true)
    expect(coordinator.undo()).toBe(false)
  })

  it('records an edit once when its clean-state publication throws', () => {
    let cleanStateFailures = 1
    let publishedClean = true
    let cleanStatePublications = 0
    const history = new SceneHistory({
      reportCleanState: (clean) => {
        cleanStatePublications += 1
        if (cleanStateFailures > 0) {
          cleanStateFailures -= 1
          throw new Error('history clean-state publication failed')
        }
        publishedClean = clean
      },
    })
    const { coordinator, store } = createAdmissionHarness({ history })

    expect(() => coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toThrow('history clean-state publication failed')

    expect(store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
    expect(cleanStatePublications).toBe(1)
    expect(coordinator.undo()).toBe(true)
    expect(publishedClean).toBe(true)
    expect(coordinator.undo()).toBe(false)
  })

  it('keeps divergent history dirty after replacing the redo lineage', () => {
    const { coordinator, history } = createAdmissionHarness()
    expect(coordinator.run('move-a', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toBe(true)
    expect(coordinator.capturePersistence().acknowledgeSaved()).toBe('applied')
    expect(history.isClean).toBe(true)

    expect(coordinator.undo()).toBe(true)
    expect(coordinator.run('move-b', (tx) => {
      tx.mutate((draft) => {
        draft.plants[1]!.position = { x: 77, y: 88 }
      })
    })).toBe(true)

    expect(history.isClean).toBe(false)
    expect(coordinator.canRedo.value).toBe(false)
  })

  it('runs the committed continuation once, before release, when publication throws', () => {
    let invalidationFailures = 1
    const continuationReentry = vi.fn()
    const onCommitted = vi.fn(() => {
      continuationReentry(coordinator.run('continuation-reentry', vi.fn()))
    })
    const harness = createAdmissionHarness({
      invalidate: () => {
        if (invalidationFailures > 0) {
          invalidationFailures -= 1
          throw new Error('invalidation failed')
        }
      },
    })
    const coordinator: SceneRuntimeEditCoordinator = harness.coordinator

    expect(() => coordinator.run('retained-command', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    }, { onCommitted })).toThrow('invalidation failed')

    expect(onCommitted).toHaveBeenCalledOnce()
    expect(continuationReentry).toHaveBeenCalledWith(false)
    expect(harness.store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
    const distinctEdit = vi.fn()
    expect(coordinator.run('distinct-command', distinctEdit)).toBe(false)
    expect(distinctEdit).toHaveBeenCalledOnce()
  })

  it('forgets an immediate failure whose callback already aborted its transaction', () => {
    const { coordinator } = createAdmissionHarness()

    expect(() => coordinator.run('self-aborted-command', (tx) => {
      tx.abort()
      throw new Error('command failed after abort')
    })).toThrow('command failed after abort')

    const active = coordinator.begin('interaction-drag')
    const blocked = vi.fn()
    expect(coordinator.runWhenSettled(blocked, 'busy')).toBe('busy')
    expect(blocked).not.toHaveBeenCalled()
    active.abort()
  })

  it('does not reenter the same history settlement from a revision observer', () => {
    let revisionCount = 0
    let reenterUndo = false
    let reenteredResult: boolean | null = null
    const harness = createAdmissionHarness({
      incrementSceneRevision: () => {
        revisionCount += 1
        if (!reenterUndo) return
        reenterUndo = false
        reenteredResult = coordinator.undo()
      },
    })
    const coordinator: SceneRuntimeEditCoordinator = harness.coordinator
    expect(coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toBe(true)

    reenterUndo = true
    expect(coordinator.undo()).toBe(true)

    expect(reenteredResult).toBe(false)
    expect(revisionCount).toBe(2)
    expect(harness.store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(coordinator.undo()).toBe(false)
  })

  it('publishes one Scene revision when an observer throws after the signal changes', () => {
    const revision = signal(0)
    let throwFromObserver = false
    const dispose = effect(() => {
      void revision.value
      if (!throwFromObserver) return
      throwFromObserver = false
      throw new Error('revision observer failed')
    })
    const { coordinator } = createAdmissionHarness({
      incrementSceneRevision: () => {
        revision.value += 1
      },
    })
    throwFromObserver = true

    expect(() => coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toThrow('revision observer failed')

    expect(revision.value).toBe(1)
    expect(coordinator.undo()).toBe(true)
    dispose()
  })

  it('publishes one history revision when an observer throws after the signal changes', () => {
    const revision = signal(0)
    let throwFromObserver = false
    const dispose = effect(() => {
      void revision.value
      if (!throwFromObserver) return
      throwFromObserver = false
      throw new Error('history revision observer failed')
    })
    const { coordinator } = createAdmissionHarness({
      incrementSceneRevision: () => {
        revision.value += 1
      },
    })
    expect(coordinator.run('move', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toBe(true)
    throwFromObserver = true

    expect(() => coordinator.undo()).toThrow('history revision observer failed')
    expect(coordinator.undo()).toBe(false)

    expect(revision.value).toBe(2)
    dispose()
  })
})

describe('Scene document hydration and replacement', () => {
  it('hydrates Scene content without introducing camera state into the Scene Session', () => {
    const { coordinator, store } = createAdmissionHarness()
    store.setSelection([{ kind: 'zone', id: 'shared-id' }])
    store.setHoveredTarget({ kind: 'annotation', id: 'shared-id' })

    coordinator.hydrate(makeFile())

    expect(store.session).not.toHaveProperty('viewport')
    expect(store.session.selectedTargets).toEqual([])
    expect(store.session.hoveredTarget).toBeNull()
  })

  it('does not let reentrant prepare replace an already reserved document successor', () => {
    const { coordinator, store } = createAdmissionHarness()
    const active = coordinator.begin('interaction-drag')
    active.mutate((draft) => {
      draft.plants[0]!.position = { x: 44, y: 55 }
    })
    const first = makeFile()
    first.name = 'First reserved replacement'
    first.plants[0]!.position = geoAt(66, 77)
    const competing = makeFile()
    competing.name = 'Competing replacement'
    competing.plants[0]!.position = geoAt(88, 99)
    const firstToken = createCanvasDocumentReplacementToken()
    const competingToken = createCanvasDocumentReplacementToken()
    const competingPrepare = vi.fn(() => active.abort())
    const firstPrepare = vi.fn(() => {
      expect(() => coordinator.replaceDocument(competing, {
        token: competingToken,
        prepare: competingPrepare,
      })).toThrowError(SceneEditBusyError)
      active.abort()
    })

    coordinator.replaceDocument(first, { token: firstToken, prepare: firstPrepare })

    expect(firstPrepare).toHaveBeenCalledOnce()
    expect(competingPrepare).not.toHaveBeenCalled()
    expect(store.persisted.plants[0]?.position).toEqual(movedFirstPlant(66, 77))
    expect(coordinator.run('after-reserved-replacement', (tx) => {
      tx.mutate((draft) => {
        draft.plants[1]!.position = { x: 31, y: 32 }
      })
    })).toBe(true)
  })

  it('reports a preparation rejection as not admitted and releases the old Scene', () => {
    const { coordinator, store } = createAdmissionHarness()
    const next = makeFile()
    next.name = 'Rejected before hydration'
    next.plants[0]!.position = geoAt(77, 88)
    const preparationError = new Error('replacement preparation failed')
    let rejection: unknown

    try {
      coordinator.replaceDocument(next, {
        token: createCanvasDocumentReplacementToken(),
        prepare: () => {
          throw preparationError
        },
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(CanvasDocumentReplacementNotAdmittedError)
    expect(rejection).toMatchObject({ reason: preparationError })
    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(coordinator.run('edit-after-rejection', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position = { x: 44, y: 55 }
      })
    })).toBe(true)
    expect(store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
  })

  it('publishes one hydration revision when a revision observer throws', () => {
    const revision = signal(0)
    let throwFromObserver = false
    const dispose = effect(() => {
      void revision.value
      if (!throwFromObserver) return
      throwFromObserver = false
      throw new Error('hydration revision observer failed')
    })
    const { coordinator } = createAdmissionHarness({
      incrementSceneRevision: () => {
        revision.value += 1
      },
    })
    const next = makeFile()
    next.name = 'Revision-safe hydration'
    throwFromObserver = true

    expect(() => coordinator.hydrate(next)).toThrow('hydration revision observer failed')

    expect(revision.value).toBe(1)
    dispose()
  })
})

describe('A Scene operation runs its steps once', () => {
  const moveFirstPlant = (tx: SceneEditTransaction) => {
    tx.mutate((draft) => {
      draft.plants[0]!.position = { x: 44, y: 55 }
    })
  }
  const expectNextCommandRuns = (coordinator: SceneRuntimeEditCoordinator, store: SceneStore) => {
    expect(coordinator.run('next-command', (tx) => {
      tx.mutate((draft) => {
        draft.plants[1]!.position = { x: 31, y: 32 }
      })
    })).toBe(true)
    expect(store.persisted.plants[1]?.position).toEqual({ x: 31, y: 32 })
  }

  it('an edit that throws before history accepts restores the scene, rethrows, releases, and the next command runs', () => {
    const { coordinator, store, history } = createAdmissionHarness()

    expect(() => coordinator.run('move', (tx) => {
      moveFirstPlant(tx)
      throw new Error('edit failed')
    })).toThrow('edit failed')

    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(history.canUndo.value).toBe(false)
    expectNextCommandRuns(coordinator, store)
  })

  it('an edit whose publication throws after history accepts keeps the edit, rethrows, releases, and the next command runs', () => {
    const invalidate = vi.fn<() => void>()
      .mockImplementationOnce(() => { throw new Error('invalidation failed') })
    const revisions = vi.fn()
    const { coordinator, store } = createAdmissionHarness({ invalidate, incrementSceneRevision: revisions })

    expect(() => coordinator.run('move', moveFirstPlant)).toThrow('invalidation failed')

    expect(store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
    expect(revisions).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledOnce()
    expectNextCommandRuns(coordinator, store)
    expect(coordinator.undo()).toBe(true)
    expect(coordinator.undo()).toBe(true)
    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(coordinator.undo()).toBe(false)
  })

  it('an undo whose publication throws keeps the step, rethrows, releases, and the next command runs', () => {
    const invalidate = vi.fn<() => void>()
    const { coordinator, store } = createAdmissionHarness({ invalidate })
    expect(coordinator.run('move', moveFirstPlant)).toBe(true)
    invalidate.mockImplementationOnce(() => { throw new Error('undo invalidation failed') })

    expect(() => coordinator.undo()).toThrow('undo invalidation failed')

    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(coordinator.canUndo.value).toBe(false)
    expect(coordinator.canRedo.value).toBe(true)
    expectNextCommandRuns(coordinator, store)
  })

  it('an undo whose store update throws leaves the scene and cursor as before', () => {
    const { coordinator, store } = createAdmissionHarness()
    expect(coordinator.run('move', moveFirstPlant)).toBe(true)
    const update = store.updatePersisted.bind(store)
    vi.spyOn(store, 'updatePersisted')
      .mockImplementationOnce(() => { throw new Error('store update failed') })
      .mockImplementation(update)

    expect(() => coordinator.undo()).toThrow('store update failed')

    expect(store.persisted.plants[0]?.position).toEqual({ x: 44, y: 55 })
    expect(coordinator.canUndo.value).toBe(true)
    expect(coordinator.canRedo.value).toBe(false)
    expect(coordinator.undo()).toBe(true)
    expect(store.persisted.plants[0]?.position).toEqual(plantStart(0))
    expect(coordinator.undo()).toBe(false)
  })

  const expectSceneClosed = (coordinator: SceneRuntimeEditCoordinator, store: SceneStore) => {
    const before = store.persisted
    expect(coordinator.runWhenSettled(() => 'pressed', 'refused')).toBe('refused')
    expect(coordinator.run('next-command', moveFirstPlant)).toBe(false)
    expect(coordinator.undo()).toBe(false)
    expect(coordinator.canUndo.value).toBe(false)
    expect(store.persisted).toEqual(before)
  }

  it('after an open whose replace throws, a press, an edit and undo are refused until the next successful open, which takes over', () => {
    const { coordinator, store } = createAdmissionHarness()
    expect(coordinator.run('move', moveFirstPlant)).toBe(true)
    vi.spyOn(store, 'hydrate').mockImplementationOnce(() => { throw new Error('replacement hydrate failed') })

    expect(() => coordinator.replaceDocument(makeFile(), {
      token: createCanvasDocumentReplacementToken(),
      prepare: () => {},
    })).toThrow('replacement hydrate failed')

    expectSceneClosed(coordinator, store)
    const next = makeFile()
    next.plants[0]!.position = geoAt(55, 66)
    coordinator.hydrate(next)
    expect(store.persisted.plants[0]?.position).toEqual(movedFirstPlant(55, 66))
    expectNextCommandRuns(coordinator, store)
  })

  it('a hydration that throws keeps the Scene closed until a replace takes over', () => {
    const invalidate = vi.fn<() => void>()
      .mockImplementationOnce(() => { throw new Error('hydration invalidation failed') })
    const { coordinator, store } = createAdmissionHarness({ invalidate })

    expect(() => coordinator.hydrate(makeFile())).toThrow('hydration invalidation failed')

    expect(invalidate).toHaveBeenCalledOnce()
    expectSceneClosed(coordinator, store)
    expect(coordinator.replaceDocument(makeFile(), {
      token: createCanvasDocumentReplacementToken(),
      prepare: () => {},
    })).toBe(false)
    expectNextCommandRuns(coordinator, store)
  })
})
