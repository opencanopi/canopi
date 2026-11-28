/**
 * app/document-session/core/edits.ts: Document, reconcile, Scene, compound, place, and unified
 * Undo/Redo methods for the Session Core (ADR 0024, contracts §4, 2b-3).
 */
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { CanopiFile } from '../../../types/design'
import { diffDocumentPatch, mergeFrozenDocument } from './helpers'
import type { HistoryEntryId, SessionHistory, TransientHistoryPort, UndoOutcome } from './history'
import type { DeepReadonly } from './immutable'
import { isDesignDirty, type OpenDesignState } from './state'

export interface PlacementFragment<TScene = unknown> {
  readonly label: string
  readonly sceneObjects: readonly TScene[]
  readonly documentPatch?: Partial<DeepReadonly<CanopiFile>>
  /** Optional document merger for rich placements (e.g. v3 stamps adding care actions, consortiums, budget; 2.1-Q155, 2.1-M89). */
  readonly mergeDocument?: (current: DeepReadonly<CanopiFile>) => Partial<DeepReadonly<CanopiFile>> | null
}

export interface SessionEditsHost {
  readonly history: SessionHistory
  readonly getDesign: () => OpenDesignState | null
  readonly updateDesign: (updater: (design: OpenDesignState) => OpenDesignState) => void
  readonly bumpHistoryTick: () => void
  readonly notifyPendingWrite: (pending: boolean) => void
  readonly scheduleWrite: () => void
  readonly replayScene: (command: SceneCommand, direction: 'undo' | 'redo') => void
}

export interface SessionEditsApi {
  document(
    label: string,
    write: (current: DeepReadonly<CanopiFile>) => Partial<DeepReadonly<CanopiFile>> | null,
    options?: { readonly coalesce?: string; readonly isDelete?: boolean },
  ): HistoryEntryId | null
  reconcile(write: (current: DeepReadonly<CanopiFile>) => Partial<DeepReadonly<CanopiFile>> | null): void
  endCoalesce(key: string): void
  recordSceneEdit(
    label: string,
    command: SceneCommand,
    options?: { readonly remainingPlantSpecies?: ReadonlySet<string> },
  ): HistoryEntryId | null
  remapSceneCommands(map: (command: SceneCommand) => SceneCommand): void
  compound<TSceneResult>(
    label: string,
    sceneEdit: () => { readonly command: SceneCommand; readonly result: TSceneResult; readonly rollback: () => void },
    buildDocumentWrite: (sceneResult: TSceneResult, current: DeepReadonly<CanopiFile>) => Partial<DeepReadonly<CanopiFile>> | null,
  ): HistoryEntryId | null
  place<TScene>(
    fragment: PlacementFragment<TScene>,
    applySceneObjects: (objects: readonly TScene[]) => { readonly command: SceneCommand; readonly rollback: () => void },
  ): HistoryEntryId | null
  undo(options?: { readonly expect?: HistoryEntryId }): UndoOutcome
  redo(): UndoOutcome
  setTransientHistory(port: TransientHistoryPort | null): void
}

export function createSessionEdits(host: SessionEditsHost): SessionEditsApi {
  const applyDocumentPatch = (patch: Partial<DeepReadonly<CanopiFile>>): void => {
    const design = host.getDesign()
    if (!design) return
    const wasDirty = isDesignDirty(design)
    const nextDoc = mergeFrozenDocument(design.document, patch)
    host.updateDesign((cur) => ({
      ...cur,
      document: nextDoc,
      rev: cur.rev + 1,
      save: cur.save.kind === 'idle' ? { kind: 'pending' } : cur.save,
    }))
    if (!wasDirty) host.notifyPendingWrite(true)
    host.scheduleWrite()
  }

  const documentEdit: SessionEditsApi['document'] = (label, write, options) => {
    const design = host.getDesign()
    if (!design || design.readOnly) return null
    const patch = write(design.document)
    if (!patch) return null
    const delta = diffDocumentPatch(design.document, patch)
    if (!delta) return null
    const id = host.history.recordDocument(label, delta, options)
    applyDocumentPatch(delta.after)
    host.bumpHistoryTick()
    return id
  }

  const reconcile: SessionEditsApi['reconcile'] = (write) => {
    const design = host.getDesign()
    if (!design || design.readOnly) return
    const patch = write(design.document)
    if (!patch) return
    const delta = diffDocumentPatch(design.document, patch)
    if (!delta) return
    const nextDoc = mergeFrozenDocument(design.document, delta.after)
    host.updateDesign((cur) => ({ ...cur, document: nextDoc }))
  }

  const recordSceneEdit: SessionEditsApi['recordSceneEdit'] = (label, command, options) => {
    const design = host.getDesign()
    if (!design || design.readOnly) return null
    const remaining = options?.remainingPlantSpecies
    if (remaining && design.document.consortiums.length > 0) {
      const nextConsortiums = design.document.consortiums.filter((entry) => {
        const name = entry.target.kind === 'species' ? entry.target.canonical_name : null
        return name !== null && remaining.has(name)
      })
      if (nextConsortiums.length < design.document.consortiums.length) {
        const delta = diffDocumentPatch(design.document, { consortiums: nextConsortiums }) ?? { before: {}, after: {} }
        const id = host.history.recordCompound(label, command, delta)
        applyDocumentPatch(delta.after)
        host.bumpHistoryTick()
        return id
      }
    }
    const wasDirty = isDesignDirty(design)
    const id = host.history.recordScene(label, command)
    host.updateDesign((cur) => ({
      ...cur,
      rev: cur.rev + 1,
      save: cur.save.kind === 'idle' ? { kind: 'pending' } : cur.save,
    }))
    if (!wasDirty) host.notifyPendingWrite(true)
    host.scheduleWrite()
    host.bumpHistoryTick()
    return id
  }

  const compound: SessionEditsApi['compound'] = (label, sceneEdit, buildDocumentWrite) => {
    const design = host.getDesign()
    if (!design || design.readOnly) return null
    const staged = sceneEdit()
    let docPatch: Partial<DeepReadonly<CanopiFile>> | null = null
    try {
      docPatch = buildDocumentWrite(staged.result, design.document)
    } catch {
      // Document half builder threw; roll back the staged Scene half so neither half commits alone.
      staged.rollback()
      return null
    }
    if (docPatch === null) {
      staged.rollback()
      return null
    }
    const delta = diffDocumentPatch(design.document, docPatch) ?? { before: {}, after: {} }
    try {
      const id = host.history.recordCompound(label, staged.command, delta)
      applyDocumentPatch(delta.after)
      host.bumpHistoryTick()
      return id
    } catch {
      // Recording or applying the compound entry failed; roll back the staged Scene edit to keep state consistent.
      staged.rollback()
      return null
    }
  }

  const place: SessionEditsApi['place'] = (fragment, applySceneObjects) =>
    compound(
      fragment.label,
      () => ({ ...applySceneObjects(fragment.sceneObjects), result: undefined }),
      (_res, current) => {
        if (fragment.mergeDocument) return fragment.mergeDocument(current)
        if (!fragment.documentPatch) return {}
        const fillOnly: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(fragment.documentPatch)) {
          const existing = (current as Record<string, unknown>)[key]
          if (existing === undefined || existing === null) fillOnly[key] = val
        }
        return fillOnly
      },
    )

  const bumpSceneRev = (): void => {
    const design = host.getDesign()
    if (!design) return
    const wasDirty = isDesignDirty(design)
    host.updateDesign((cur) => ({
      ...cur,
      rev: cur.rev + 1,
      save: cur.save.kind === 'idle' ? { kind: 'pending' } : cur.save,
    }))
    if (!wasDirty) host.notifyPendingWrite(true)
    host.scheduleWrite()
  }

  return {
    document: documentEdit,
    reconcile,
    endCoalesce: (key) => host.history.endCoalesce(key),
    recordSceneEdit,
    remapSceneCommands: (map) => host.history.remapSceneCommands(map),
    compound,
    place,
    undo(options) {
      let docApplied = false
      let sceneReplayed = false
      const outcome = host.history.undo(
        (patch) => {
          docApplied = true
          applyDocumentPatch(patch)
        },
        (cmd, dir) => {
          host.replayScene(cmd, dir)
          sceneReplayed = true
        },
        options,
      )
      if (sceneReplayed && !docApplied) bumpSceneRev()
      if (outcome.status === 'applied') host.bumpHistoryTick()
      return outcome
    },
    redo() {
      let docApplied = false
      let sceneReplayed = false
      const outcome = host.history.redo(
        (patch) => {
          docApplied = true
          applyDocumentPatch(patch)
        },
        (cmd, dir) => {
          host.replayScene(cmd, dir)
          sceneReplayed = true
        },
      )
      if (sceneReplayed && !docApplied) bumpSceneRev()
      if (outcome.status === 'applied') host.bumpHistoryTick()
      return outcome
    },
    setTransientHistory(port) {
      host.history.setTransient(port)
      host.bumpHistoryTick()
    },
  }
}
