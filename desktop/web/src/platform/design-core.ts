/**
 * platform/design-core.ts: the design-core port's Web adapter over the format worker (ADR 0025 Format core failures;
 * contracts §18 F28; Step 2.0.4, 2.1-M476, 2.1-M477). Owner of the format worker (worker-only-in-owner, ADR 0028; §18
 * F16). Invariant: every call settles exactly once, nothing is retried silently, and the worker
 * (platform/design-core.worker.ts) is started only here.
 *
 * In the reader release it is Web only and read only: Desktop reads `.canopi` natively (2.1-M476), and the Web asks
 * it only for the read view of a Design a newer Canopi saved (`readNewerDesign`, 2.1-M478).
 * - Lazy: the worker starts on the first call, so a session that never opens a newer Design never fetches the module.
 * - A failed load (the worker script or the `.wasm` gone after a deploy, a module the engine refuses) refuses only that
 *   call with `format_core_unavailable`; the next call, the user's Retry (opening the file again), loads once more.
 * - A trap settles its call and every call queued behind it `format_core_trapped`, never replayed, and the worker is
 *   terminated: the next call starts another, since a trapped instance stays dead.
 * - Hiding the page settles nothing early: a page going into the back-forward cache freezes its worker with it and the
 *   call settles once, when its answer comes; a page that unloads takes its calls with it. A reply settles its call
 *   once: an answer for a call already settled finds nothing.
 * A refusal of the Design itself rejects with its `DesignLoadFailure` (`newer_version`, `invalid_document`,
 * `invalid_json`) and its field, which `app/contracts/canopi-design-errors.ts` maps as it maps Desktop's.
 */
import type { DesignLoadFailure, Failure, FailureCode, ReadOnlyDesign, RedactedText } from '../generated/contracts'
import { redact } from '../failures/redact'

/** What the adapter needs of a worker: the dedicated `Worker` in a page, a fake in a test. */
interface DesignCoreWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  postMessage(message: DesignCoreRequest): void
  terminate(): void
}

/** A call the worker runs; ids are the adapter's, unique per adapter. */
interface DesignCoreRequest {
  readonly id: number
  readonly call: 'read'
  readonly text: string
}

interface DesignCoreOptions {
  readonly createWorker?: () => DesignCoreWorker
}

export interface DesignCore {
  /**
   * The read view of `text`, a `.canopi` Design of version 10 or later (2.1-M478). Rejects with the Design's
   * `DesignLoadFailure`, or a format core settlement (`format_core_unavailable`, `format_core_trapped`).
   */
  readNewerDesign(text: string): Promise<ReadOnlyDesign>
}

/** The op every settlement of the adapter carries, for the ring and the report. */
const DESIGN_CORE_READ_OP = 'format_core.read'

interface Waiting {
  resolve(design: ReadOnlyDesign): void
  reject(reason: unknown): void
}

/** The dedicated module worker the Web build emits beside the page. */
function startFormatWorker(): DesignCoreWorker {
  return new Worker(new URL('./design-core.worker.ts', import.meta.url), { type: 'module', name: 'canopi-format-core' }) as unknown as DesignCoreWorker
}

/** The adapter; its worker starts on its first call. */
export function createDesignCore({ createWorker = startFormatWorker }: DesignCoreOptions = {}): DesignCore {
  let worker: DesignCoreWorker | null = null
  // Whether the running worker has answered once: an error event before any answer is a load that failed.
  let answered = false
  let nextId = 1
  const waiting = new Map<number, Waiting>()

  /** Drops the worker and settles every waiting call with `reason`; a late answer finds nothing to settle. */
  function stopWorker(reason: () => unknown): void {
    worker?.terminate()
    worker = null
    answered = false
    const settled = [...waiting.values()]
    waiting.clear()
    for (const call of settled) call.reject(reason())
  }

  function started(): DesignCoreWorker {
    if (worker) return worker
    const next = createWorker()
    next.onmessage = (event) => {
      if (worker === next) receive(event.data)
    }
    next.onerror = (event) => {
      if (worker !== next) return
      event.preventDefault()
      // The script never ran (a 404 after a deploy, a refused module) or the worker died outside a call.
      const code = answered ? 'format_core_trapped' : 'format_core_unavailable'
      stopWorker(() => formatCoreFailure(code, answered ? 'trapped' : 'the format worker failed to start'))
    }
    worker = next
    return next
  }

  function receive(data: unknown): void {
    if (!isReply(data)) return
    answered = true
    const call = waiting.get(data.id)
    if (!call) return
    waiting.delete(data.id)
    if (data.ok) {
      settleAnswer(call, data.value)
      return
    }
    if (data.error === 'unavailable') {
      call.reject(formatCoreFailure('format_core_unavailable', data.detail))
      return
    }
    call.reject(formatCoreFailure('format_core_trapped', data.detail))
    stopWorker(() => formatCoreFailure('format_core_trapped', 'trapped'))
  }

  function readNewerDesign(text: string): Promise<ReadOnlyDesign> {
    return new Promise<ReadOnlyDesign>((resolve, reject) => {
      let running: DesignCoreWorker
      try {
        running = started()
      } catch (error) {
        reject(formatCoreFailure('format_core_unavailable', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'))
        return
      }
      const id = nextId++
      waiting.set(id, { resolve, reject })
      running.postMessage({ id, call: 'read', text })
    })
  }

  return { readNewerDesign }
}

type Reply =
  | { readonly id: number, readonly ok: true, readonly value: string }
  | { readonly id: number, readonly ok: false, readonly error: 'unavailable' | 'trapped', readonly detail: string }

function isReply(data: unknown): data is Reply {
  if (typeof data !== 'object' || data === null) return false
  const reply = data as Record<string, unknown>
  if (typeof reply.id !== 'number') return false
  return reply.ok === true
    ? typeof reply.value === 'string'
    : reply.ok === false && (reply.error === 'unavailable' || reply.error === 'trapped') && typeof reply.detail === 'string'
}

/** The module's JSON answer: the read view, or the Design's refusal; anything else is an internal fault. */
function settleAnswer(call: Waiting, value: string): void {
  let answer: unknown
  try {
    answer = JSON.parse(value)
  } catch {
    // Not JSON: the module gave no answer this build reads, settled below as an internal fault.
    answer = null
  }
  const record = typeof answer === 'object' && answer !== null ? answer as Record<string, unknown> : {}
  if (isReadOnlyDesign(record.read)) {
    call.resolve(record.read)
    return
  }
  if (isDesignLoadFailure(record.refused)) {
    call.reject(record.refused)
    return
  }
  call.reject({ kind: 'internal', message: 'the format core gave an answer the adapter cannot read' } satisfies DesignLoadFailure)
}

function isReadOnlyDesign(value: unknown): value is ReadOnlyDesign {
  if (typeof value !== 'object' || value === null) return false
  const design = value as Record<string, unknown>
  return typeof design.saved_by_version === 'number' && typeof design.view === 'object' && design.view !== null
}

function isDesignLoadFailure(value: unknown): value is DesignLoadFailure {
  if (typeof value !== 'object' || value === null) return false
  const failure = value as Record<string, unknown>
  return typeof failure.kind === 'string' && typeof failure.message === 'string'
}

/** A format core settlement as the wire carries one, so the ring, the notice and the report read its code. */
function formatCoreFailure(kind: 'format_core_unavailable' | 'format_core_trapped', detail: string): Failure {
  const code = { kind } as FailureCode
  return {
    code,
    user_may_retry: true,
    op: DESIGN_CORE_READ_OP,
    operation: null,
    detail: redact(detail) as RedactedText,
  }
}
