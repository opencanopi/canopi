/**
 * app/document-session/core/session-ops.ts: Extracted Save As and settings-flush retry helpers
 * for `session-core.ts` (keeps `session-core.ts` concise and below complexity ceilings).
 */
import { EMPTY_SHA256, type DesignHome, type HomeVersion } from '../../../platform/design-home'
import type { composeForWrite } from './scene-half'
import {
  isDesignDirty,
  type DesignSessionState,
  type OpenDesignState,
  type QuestionChoice,
  type QuestionKind,
  type QuestionPurpose,
  type SaveState,
  type SessionQuestion,
} from './state'
import type { SessionCoreDeps } from './types'

export async function flushSettingsWithRetry(args: {
  readonly flushSettings: (() => Promise<void>) | undefined
  readonly purpose: QuestionPurpose
  readonly designSaved: boolean
  readonly getCurrentDesign: () => OpenDesignState | null
  readonly setState: (next: DesignSessionState) => void
  readonly askQuestion: (
    kind: QuestionKind,
    purpose: QuestionPurpose,
    publish: (question: SessionQuestion) => void,
  ) => Promise<QuestionChoice>
}): Promise<boolean> {
  if (!args.flushSettings) return true
  while (true) {
    try {
      await args.flushSettings()
      return true
    } catch {
      // Settings flush failed before close (with or without an open Design, N1): ask Retry/Discard/Cancel.
      const curAfter = args.getCurrentDesign()
      const choice = await args.askQuestion('settings-flush-failed-before-close', args.purpose, (question) => {
        args.setState({
          kind: 'closing',
          ...(curAfter ? { current: curAfter } : {}),
          question: { ...question, designSaved: args.designSaved },
        })
      })
      if (choice === 'cancel') {
        args.setState(curAfter ? { kind: 'open', design: curAfter } : { kind: 'idle' })
        return false
      }
      if (choice === 'discard') return true
    }
  }
}

async function applySaveAsWritten(args: {
  readonly deps: SessionCoreDeps
  readonly initialScope: OpenDesignState['scope']
  readonly targetHome: DesignHome
  readonly previousHome: DesignHome
  readonly version: HomeVersion
  readonly targetRev: number
  readonly updatedAt: string
  readonly updateCurrentDesign: (updater: (cur: OpenDesignState) => OpenDesignState) => void
  readonly notifyPendingWrite: (pending: boolean) => void
}): Promise<boolean> {
  const writtenHome: DesignHome = { ...args.targetHome, version: args.version }
  let applied = false
  let stillDirty = false
  args.updateCurrentDesign((cur) => {
    if (cur.scope !== args.initialScope) return cur
    applied = true
    const nextAckRev = Math.max(cur.ackRev, args.targetRev)
    stillDirty = cur.rev > nextAckRev
    return {
      ...cur,
      home: writtenHome,
      document: { ...cur.document, updated_at: args.updatedAt },
      ackRev: nextAckRev,
      migratedFrom: null,
      save: stillDirty ? { kind: 'pending' } : { kind: 'idle' },
    }
  })
  // If another Design opened before Save As settled, do not clobber last_open_home or delete the old Draft (M2/B5).
  if (!applied) return false
  args.notifyPendingWrite(stillDirty)
  await args.deps.settings.writeLastOpenHome(writtenHome)
  if (args.previousHome.kind === 'draft') {
    const del = await args.deps.designHome.deleteDraft(args.previousHome.key)
    if (!del.ok) args.deps.onNotice?.({ kind: 'draft-delete-failed', detail: args.previousHome.key })
  }
  return stillDirty
}

async function probeSaveAsTarget(
  deps: SessionCoreDeps,
  picked: { readonly grant: string; readonly displayName?: string; readonly recentId?: string },
): Promise<{ readonly targetHome: DesignHome; readonly expected: HomeVersion | null }> {
  const probe = await deps.designHome.read(picked.grant)
  const expected: HomeVersion | null = probe.kind === 'present'
    ? (probe.bytes.length === 0 ? EMPTY_SHA256 : probe.version)
    : null
  return {
    expected,
    targetHome: {
      kind: 'file',
      key: picked.grant,
      displayName: picked.displayName ?? picked.grant,
      ...(picked.recentId ? { recentId: picked.recentId } : {}),
      version: expected,
    },
  }
}

export async function runSaveAs(args: {
  readonly deps: SessionCoreDeps
  readonly getCurrentDesign: () => OpenDesignState | null
  readonly updateCurrentDesign: (updater: (cur: OpenDesignState) => OpenDesignState) => void
  readonly setSaveState: (save: SaveState) => void
  readonly composeForWrite: typeof composeForWrite
  readonly clearWriteTimer: () => void
  readonly runExclusive: <T>(fn: () => Promise<T>) => Promise<T>
  readonly notifyPendingWrite: (pending: boolean) => void
  readonly scheduleWrite: () => void
}): Promise<'saved' | 'aborted' | 'conflict' | 'failed'> {
  const initial = args.getCurrentDesign()
  if (!initial || initial.readOnly) return 'failed'
  const initialScope = initial.scope

  const picked = await args.deps.fileAccess.pickHomeTarget(initial.document.name || 'Untitled')
  if (picked.kind !== 'picked' || args.getCurrentDesign()?.scope !== initialScope) return 'aborted'

  args.clearWriteTimer()
  let shouldScheduleWrite = false
  const outcome = await args.runExclusive(async () => {
    const design = args.getCurrentDesign()
    if (!design || design.readOnly || design.scope !== initialScope) return 'aborted'

    try {
      const { targetHome, expected } = await probeSaveAsTarget(args.deps, picked)
      if (args.getCurrentDesign()?.scope !== initialScope) return 'aborted'

      const updatedAt = new Date().toISOString()
      const encoded = await args.deps.codec.encode({ ...args.composeForWrite(design), updated_at: updatedAt })
      if (args.getCurrentDesign()?.scope !== initialScope) return 'aborted'
      const result = await args.deps.designHome.write(targetHome.key, encoded.bytes, expected)
      if (args.getCurrentDesign()?.scope !== initialScope) return 'aborted'

      if (result.kind === 'written') {
        shouldScheduleWrite = await applySaveAsWritten({
          deps: args.deps,
          initialScope,
          targetHome,
          previousHome: design.home,
          version: result.version,
          targetRev: design.rev,
          updatedAt,
          updateCurrentDesign: args.updateCurrentDesign,
          notifyPendingWrite: args.notifyPendingWrite,
        })
        return 'saved'
      }

      if (result.kind === 'conflict') {
        args.updateCurrentDesign((cur) => (cur.scope === initialScope
          ? { ...cur, home: { ...targetHome, version: expected }, save: { kind: 'conflict', current: result.current } }
          : cur))
        return 'conflict'
      }

      args.setSaveState({ kind: 'failed', reason: result.kind })
      shouldScheduleWrite = isDesignDirty(args.getCurrentDesign())
      return 'failed'
    } catch (error) {
      // Save As transport/encode error: keep previous Draft home intact and reschedule autosave if dirty (M1).
      if (args.getCurrentDesign()?.scope === initialScope) {
        const reason = error instanceof Error && error.message ? error.message : 'write_failed'
        args.setSaveState({ kind: 'failed', reason })
        shouldScheduleWrite = isDesignDirty(args.getCurrentDesign())
      }
      return 'failed'
    }
  })
  // Schedule autosave AFTER runExclusive releases inFlight (M1/M2).
  if (shouldScheduleWrite && args.getCurrentDesign()?.scope === initialScope) args.scheduleWrite()
  return outcome
}
