import { batch, signal, type ReadonlySignal } from '@preact/signals'
import type { SceneCommand } from '../scene-commands'

interface DetachedSceneSessionAdapter {
  readonly canUndo: ReadonlySignal<boolean>
  readonly canRedo: ReadonlySignal<boolean>
  recordSceneEdit(label: string, command: SceneCommand): void
  undo(): void
  redo(): void
  remapSceneCommands?(map: (command: SceneCommand) => SceneCommand): void
}

/**
 * Local in-memory Scene session adapter used only when `SceneRuntimeEditCoordinator` runs
 * detached from a live `SessionCore` (e.g. unit tests of transactions/mutations/reorigin).
 */
export function createDetachedSceneSessionAdapter(): DetachedSceneSessionAdapter & {
  bindReplay(fn: (command: SceneCommand, direction: 'undo' | 'redo', onApplied?: () => void) => boolean): void
} {
  const canUndo = signal(false)
  const canRedo = signal(false)
  let past: SceneCommand[] = []
  let future: SceneCommand[] = []
  let replayer: ((command: SceneCommand, direction: 'undo' | 'redo', onApplied?: () => void) => boolean) | null = null
  const sync = () => {
    batch(() => {
      canUndo.value = past.length > 0
      canRedo.value = future.length > 0
    })
  }
  return {
    canUndo,
    canRedo,
    bindReplay(fn) {
      replayer = fn
    },
    recordSceneEdit(_label, command) {
      past.push(command)
      future = []
      if (past.length > 500) past.shift()
      sync()
    },
    undo() {
      const cmd = past.pop()
      if (!cmd) return
      let applied = false
      const commit = () => {
        if (applied) return
        applied = true
        future.push(cmd)
        sync()
      }
      try {
        const ok = replayer?.(cmd, 'undo', commit) ?? true
        if (ok) commit()
        else if (!applied) past.push(cmd)
      } catch (error) {
        if (!applied) past.push(cmd)
        throw error
      }
    },
    redo() {
      const cmd = future.pop()
      if (!cmd) return
      let applied = false
      const commit = () => {
        if (applied) return
        applied = true
        past.push(cmd)
        sync()
      }
      try {
        const ok = replayer?.(cmd, 'redo', commit) ?? true
        if (ok) commit()
        else if (!applied) future.push(cmd)
      } catch (error) {
        if (!applied) future.push(cmd)
        throw error
      }
    },
    remapSceneCommands(map) {
      past = past.map(map)
      future = future.map(map)
    },
  }
}
