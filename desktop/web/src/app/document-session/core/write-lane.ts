/**
 * app/document-session/core/write-lane.ts: Single-writer serial write lane for the Session Core
 * (ADR 0024, contracts §4, #341/#400 FAT 0-byte handling, 2.1-Q35r pre-upgrade copy, case 16 lost-ack).
 */
import type {
  DesignHomeStore,
  DesignHomeWriteResult,
  HomeVersion,
} from '../../../platform/design-home'
import type { CanopiFile } from '../../../types/design'
import type { DesignScope } from '../../../types/design-scope'
import type { DeepReadonly } from './immutable'
import { isDesignDirty, type OpenDesignState, type SaveState } from './state'

export interface EncodedDesignPayload {
  readonly bytes: Uint8Array
  readonly version: HomeVersion
}

interface WriteLaneCodec {
  encode(file: DeepReadonly<CanopiFile>): Promise<EncodedDesignPayload>
  admitWrite?(file: DeepReadonly<CanopiFile>): string | null
}

export interface WriteLaneHost {
  readonly designHome: DesignHomeStore
  readonly codec: WriteLaneCodec
  readonly isDisposed: () => boolean
  readonly getDesign: () => OpenDesignState | null
  readonly composeForWrite: (design: OpenDesignState) => DeepReadonly<CanopiFile>
  readonly updateDesign: (updater: (design: OpenDesignState) => OpenDesignState) => void
  readonly scheduleRetry: () => void
  readonly onPendingWriteChange?: (pending: boolean) => void
}

interface WriteLaneRunOptions {
  readonly overrideExpected?: HomeVersion | null
  readonly useOverrideExpected?: boolean
  readonly omitKeepPrevious?: boolean
  readonly forceWrite?: boolean
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export interface SessionWriteLane {
  readonly inFlight: Promise<boolean> | null
  run(options?: WriteLaneRunOptions): Promise<boolean>
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
}

interface UnackedAttempt {
  readonly scope: DesignScope
  readonly key: string
  readonly rev: number
  readonly bytes: Uint8Array
  readonly version: HomeVersion
}

const MAX_UNACKED_ATTEMPTS = 8

export function createSessionWriteLane(host: WriteLaneHost): SessionWriteLane {
  let inFlight: Promise<boolean> | null = null
  let unackedAttempts: UnackedAttempt[] = []
  let retryAfterFinish = false

  const updateDesignIfScope = (
    scope: DesignScope,
    updater: (cur: OpenDesignState) => OpenDesignState,
  ): boolean => {
    const live = host.getDesign()
    if (!live || live.scope !== scope) return false
    host.updateDesign((cur) => (cur.scope === scope ? updater(cur) : cur))
    return true
  }

  const setSave = (scope: DesignScope, save: SaveState): void => {
    updateDesignIfScope(scope, (cur) => ({ ...cur, save }))
  }

  const adoptWritten = (scope: DesignScope, targetRev: number, version: HomeVersion | null): boolean => {
    if (
      !updateDesignIfScope(scope, (cur) => {
        const ackRev = Math.max(cur.ackRev, targetRev)
        return {
          ...cur,
          home: { ...cur.home, version },
          ackRev,
          migratedFrom: null,
          save: cur.rev > ackRev ? { kind: 'pending' } : { kind: 'idle' },
        }
      })
    ) {
      return false
    }
    const latest = host.getDesign()
    return Boolean(latest && latest.scope === scope && isDesignDirty(latest))
  }

  const adoptOrContinue = (scope: DesignScope, targetRev: number, version: HomeVersion | null): 'continue' | 'done' => {
    if (adoptWritten(scope, targetRev, version)) return 'continue'
    if (host.getDesign()?.scope === scope) host.onPendingWriteChange?.(false)
    return 'done'
  }

  const recordUnacked = (attempt: UnackedAttempt): void => {
    if (
      unackedAttempts.length > 0
      && (unackedAttempts[0]!.scope !== attempt.scope || unackedAttempts[0]!.key !== attempt.key)
    ) {
      unackedAttempts = []
    }
    unackedAttempts.push(attempt)
    if (unackedAttempts.length > MAX_UNACKED_ATTEMPTS) {
      unackedAttempts = unackedAttempts.slice(-MAX_UNACKED_ATTEMPTS)
    }
  }

  const resolveConflictOutcome = async (
    scope: DesignScope,
    key: string,
    current: HomeVersion | null,
  ): Promise<'continue' | 'done' | 'conflict'> => {
    // Lost-ack adoption (contracts §4 case 16, M2): compare against ALL unacknowledged attempts for
    // this scope/home so a later retry with fresh updated_at still recognizes our own landed write.
    const candidates = unackedAttempts.filter((a) => a.scope === scope && a.key === key)
    if (current !== null && candidates.length > 0) {
      const byVersion = candidates.find((a) => a.version === current)
      if (byVersion) {
        unackedAttempts = unackedAttempts.filter((a) => a.rev > byVersion.rev)
        return adoptOrContinue(scope, byVersion.rev, current)
      }
      const reread = await host.designHome.read(key)
      if (reread.kind === 'present') {
        const storedBytes = new Uint8Array(reread.bytes)
        const byBytes = candidates.find((a) => bytesEqual(storedBytes, a.bytes))
        if (byBytes) {
          unackedAttempts = unackedAttempts.filter((a) => a.rev > byBytes.rev)
          return adoptOrContinue(scope, byBytes.rev, reread.version)
        }
      }
    }
    setSave(scope, { kind: 'conflict', current })
    return 'conflict'
  }

  const handleNonWritten = (
    scope: DesignScope,
    result: Exclude<DesignHomeWriteResult, { kind: 'written' | 'conflict' }>,
  ): void => {
    if (result.kind === 'copy_blocked') {
      setSave(scope, { kind: 'copy_blocked', folder: result.folder })
      return
    }
    if (result.kind === 'quota_refused') {
      setSave(scope, { kind: 'quota' })
      return
    }
    const failureKind = typeof result.failure?.code === 'object' && result.failure.code !== null
      ? (result.failure.code as { kind?: string }).kind
      : undefined
    if (failureKind === 'busy') {
      setSave(scope, { kind: 'busy' })
      retryAfterFinish = true
      return
    }
    setSave(scope, { kind: 'failed', reason: failureKind ?? 'write_failed' })
  }

  const writeOnce = async (
    design: OpenDesignState,
    composed: DeepReadonly<CanopiFile>,
    options: WriteLaneRunOptions | undefined,
  ): Promise<{ readonly encodedVersion: HomeVersion; readonly updatedAt: string; readonly result: DesignHomeWriteResult } | null> => {
    const scope = design.scope
    const targetRev = design.rev
    setSave(scope, { kind: 'writing', rev: targetRev })
    const updatedAt = new Date().toISOString()
    const stamped = { ...composed, updated_at: updatedAt } as DeepReadonly<CanopiFile>
    const encoded = await host.codec.encode(stamped)
    recordUnacked({ scope, key: design.home.key, rev: targetRev, bytes: encoded.bytes, version: encoded.version })
    if (host.isDisposed() || host.getDesign()?.scope !== scope) return null

    const expected = options?.useOverrideExpected ? (options.overrideExpected ?? null) : design.home.version
    const keepPrevious = !options?.omitKeepPrevious && design.migratedFrom !== null && design.home.kind === 'file'
    const result = await host.designHome.write(
      design.home.key,
      encoded.bytes,
      expected,
      keepPrevious ? { keepPrevious: true } : undefined,
    )
    if (host.isDisposed() || host.getDesign()?.scope !== scope) return null
    return { encodedVersion: encoded.version, updatedAt, result }
  }

  const preflightWrite = (
    design: OpenDesignState | null,
    options?: WriteLaneRunOptions,
  ): 'done' | 'blocked' | 'proceed' => {
    if (!design || design.readOnly) return 'done'
    if (design.save.kind === 'conflict' && !options?.useOverrideExpected) return 'blocked'
    if (!isDesignDirty(design) && !options?.useOverrideExpected && !options?.forceWrite) {
      setSave(design.scope, { kind: 'idle' })
      host.onPendingWriteChange?.(false)
      return 'done'
    }
    return 'proceed'
  }

  const failFromThrown = (scope: DesignScope, error: unknown): void => {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    const failureKind = typeof code === 'object' && code !== null
      ? (code as { kind?: string }).kind
      : undefined
    if (failureKind === 'busy') {
      setSave(scope, { kind: 'busy' })
      retryAfterFinish = true
      return
    }
    const reason = failureKind ?? (error instanceof Error && error.message ? error.message : 'write_failed')
    setSave(scope, { kind: 'failed', reason })
  }

  const execute = async (initialOptions?: WriteLaneRunOptions): Promise<boolean> => {
    let options = initialOptions
    while (true) {
      if (host.isDisposed()) return false
      const design = host.getDesign()
      const gate = preflightWrite(design, options)
      if (gate !== 'proceed' || !design) return gate === 'done'

      const scope = design.scope
      const targetRev = design.rev
      try {
        const composed = host.composeForWrite(design)
        const admissionRefusal = host.codec.admitWrite?.(composed) ?? null
        if (admissionRefusal) {
          setSave(scope, { kind: 'refused', reason: admissionRefusal })
          return false
        }
        const attempt = await writeOnce(design, composed, options)
        if (!attempt) return false
        const { updatedAt, result } = attempt

        if (result.kind === 'written') {
          unackedAttempts = []
          updateDesignIfScope(scope, (cur) => ({ ...cur, document: { ...cur.document, updated_at: updatedAt } }))
          if (adoptOrContinue(scope, targetRev, result.version) === 'continue') {
            options = undefined
            continue
          }
          return true
        }

        if (result.kind === 'conflict') {
          const outcome = await resolveConflictOutcome(scope, design.home.key, result.current)
          if (outcome === 'continue') {
            options = undefined
            continue
          }
          return outcome === 'done'
        }

        handleNonWritten(scope, result)
        return false
      } catch (error) {
        // Transport rejection on write or conflict re-read (B1/B4/M1): clear 'writing' and let close/UI ask or retry.
        if (!host.isDisposed()) failFromThrown(scope, error)
        return false
      }
    }
  }

  return {
    get inFlight() {
      return inFlight
    },
    async run(options?: WriteLaneRunOptions): Promise<boolean> {
      const initialScope = host.getDesign()?.scope
      while (inFlight) {
        const prevOk = await inFlight
        const after = host.getDesign()
        if (!after || (initialScope !== undefined && after.scope !== initialScope)) {
          return prevOk
        }
        if (!isDesignDirty(after) && !options?.useOverrideExpected && !options?.forceWrite) {
          return prevOk
        }
      }
      retryAfterFinish = false
      inFlight = execute(options).finally(() => {
        inFlight = null
        if (retryAfterFinish && !host.isDisposed()) {
          retryAfterFinish = false
          host.scheduleRetry()
        }
      })
      return inFlight
    },
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      while (inFlight) await inFlight
      let release!: () => void
      const lock = new Promise<boolean>((resolve) => {
        release = () => resolve(true)
      })
      inFlight = lock
      try {
        return await fn()
      } finally {
        if (inFlight === lock) inFlight = null
        release()
      }
    },
  }
}
