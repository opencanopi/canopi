/**
 * platform/design-core.ts: the design-core port's Web adapter over the format worker (ADR 0025 Format core failures;
 * contracts §10, §18 F28; 2b-5, 2.1-M156, 2.1-M476, 2.1-M539). Owner of the format worker (`worker-only-in-owner`,
 * ADR 0028; §18 F16). Invariant: every call settles exactly once, nothing is retried silently, and the worker
 * (`platform/design-core.worker.ts`) is started only here.
 *
 * - Lazy: the worker starts on the first call.
 * - Failed load -> `format_core_unavailable`; next call retries.
 * - Trap -> `format_core_trapped` for the active and queued calls; worker terminated and respawned on next call.
 * - Large open (> 4 MiB) -> worker recycled once idle (contracts §10).
 */
import type {
  CanopiFileV10,
  DesignLoadFailure,
  DraftSummaryOutcome,
  Failure,
  FailureCode,
  FormatDecodeAnswer,
  FormatRefusal,
  GeoPoint,
  NewDesignInputContract,
  ReadOnlyDesign,
  RedactedText,
  SavedObjectStampPayload,
} from '../generated/contracts'
import { redact } from '../failures/redact'
import type { FormatCoreRequest } from './design-core.worker'

/** What the adapter needs of a worker: the dedicated `Worker` in a page, a fake in a test. */
interface DesignCoreWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  postMessage(message: FormatCoreRequest): void
  terminate(): void
}

interface DesignCoreOptions {
  readonly createWorker?: () => DesignCoreWorker
}

type DesignCoreEncodeAnswer =
  | { readonly ok: Uint8Array }
  | { readonly err: FormatRefusal }

type DesignCoreDecodeStampAnswer =
  | { readonly ok: SavedObjectStampPayload }
  | { readonly err: unknown }

type DesignCoreEncodeStampAnswer =
  | { readonly ok: string }
  | { readonly err: unknown }

export interface DesignCore {
  /** Reports the `canopi-format` crate version (contracts §10 parity check). */
  version(): Promise<string>
  /** Decodes raw `.canopi` bytes (v9 or v10) through `canopi-format` (2.1-M539). */
  decode(bytes: Uint8Array): Promise<FormatDecodeAnswer>
  /** Validates and canonically encodes a v10 `.canopi` Design (2.1-M156, 2.1-M539). */
  encode(design: unknown): Promise<DesignCoreEncodeAnswer>
  /** Constructs a canonical v10 `.canopi` Design from `NewDesignInputContract`. */
  newDesign(input: NewDesignInputContract): Promise<CanopiFileV10>
  /** Derives a Draft summary from raw `.canopi` bytes through the one decode choke point. */
  draftSummary(bytes: Uint8Array, updatedAt: string): Promise<DraftSummaryOutcome>
  /** Decodes and migrates (v2 → v3) a saved-stamp JSON payload (2.1-Q155, 2.1-M88). */
  decodeStamp(payloadJson: string): Promise<DesignCoreDecodeStampAnswer>
  /** Validates and canonically encodes a v3 saved-stamp payload (2.1-Q155, 2.1-M88). */
  encodeStamp(payload: SavedObjectStampPayload): Promise<DesignCoreEncodeStampAnswer>
  /** Maps a v3 stamp payload to canonical v10 `.canopi` stamp file bytes (optional on Web until worker exposes it). */
  stampToCanopi?(payload: SavedObjectStampPayload, name: string, origin: GeoPoint): Promise<DesignCoreEncodeAnswer>
  /** Decodes a v9/v10 `.canopi` stamp file into a v3 stamp payload (optional on Web until worker exposes it). */
  canopiToStamp?(bytes: Uint8Array, origin: GeoPoint): Promise<DesignCoreDecodeStampAnswer>
  /**
   * Legacy Step 2.0.4 read view of `text` (2.1-M478). Rejects with `DesignLoadFailure` or a
   * format core settlement (`format_core_unavailable`, `format_core_trapped`).
   */
  readNewerDesign(text: string): Promise<ReadOnlyDesign>
}

const DESIGN_CORE_READ_OP = 'format_core.read'
const LARGE_OPEN_RECYCLE_BYTES = 4 * 1024 * 1024

interface Waiting {
  resolve(raw: string): void
  reject(reason: unknown): void
}

/** The dedicated module worker the Web build emits beside the page. */
function startFormatWorker(): DesignCoreWorker {
  return new Worker(new URL('./design-core.worker.ts', import.meta.url), {
    type: 'module',
    name: 'canopi-format-core',
  }) as unknown as DesignCoreWorker
}

/** The adapter; its worker starts on its first call. */
export function createDesignCore({ createWorker = startFormatWorker }: DesignCoreOptions = {}): DesignCore {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Encoder = new TextEncoder()
  let worker: DesignCoreWorker | null = null
  let answered = false
  let recycleWhenIdle = false
  let nextId = 1
  const waiting = new Map<number, Waiting>()

  function stopWorker(reason?: () => unknown): void {
    worker?.terminate()
    worker = null
    answered = false
    recycleWhenIdle = false
    if (!reason) return
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
      call.resolve(data.value)
      if (recycleWhenIdle && waiting.size === 0) stopWorker()
      return
    }
    if (data.error === 'unavailable') {
      call.reject(formatCoreFailure('format_core_unavailable', data.detail))
      return
    }
    call.reject(formatCoreFailure('format_core_trapped', data.detail))
    stopWorker(() => formatCoreFailure('format_core_trapped', 'trapped'))
  }

  function send(build: (id: number) => FormatCoreRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let running: DesignCoreWorker
      try {
        running = started()
      } catch (error) {
        reject(
          formatCoreFailure(
            'format_core_unavailable',
            error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
          ),
        )
        return
      }
      const id = nextId++
      waiting.set(id, { resolve, reject })
      running.postMessage(build(id))
    })
  }

  return {
    async version(): Promise<string> {
      return send((id) => ({ id, call: 'version' }))
    },
    async decode(bytes: Uint8Array): Promise<FormatDecodeAnswer> {
      if (bytes.byteLength > LARGE_OPEN_RECYCLE_BYTES) recycleWhenIdle = true
      const raw = await send((id) => ({ id, call: 'decode', text: utf8Decoder.decode(bytes) }))
      return JSON.parse(raw) as FormatDecodeAnswer
    },
    async encode(design: unknown): Promise<DesignCoreEncodeAnswer> {
      const raw = await send((id) => ({ id, call: 'encode', designJson: JSON.stringify(design) }))
      const parsed = JSON.parse(raw) as { readonly ok?: string; readonly err?: FormatRefusal }
      if (typeof parsed.ok === 'string') return { ok: utf8Encoder.encode(parsed.ok) }
      if (parsed.err) return { err: parsed.err }
      return {
        err: {
          kind: 'invalid_document',
          message: 'the format core gave an answer the adapter cannot read',
        },
      }
    },
    async newDesign(input: NewDesignInputContract): Promise<CanopiFileV10> {
      const raw = await send((id) => ({ id, call: 'new_design', inputJson: JSON.stringify(input) }))
      return JSON.parse(raw) as CanopiFileV10
    },
    async draftSummary(bytes: Uint8Array, updatedAt: string): Promise<DraftSummaryOutcome> {
      const raw = await send((id) => ({
        id,
        call: 'draft_summary',
        text: utf8Decoder.decode(bytes),
        updatedAt,
      }))
      return JSON.parse(raw) as DraftSummaryOutcome
    },
    async decodeStamp(payloadJson: string): Promise<DesignCoreDecodeStampAnswer> {
      const raw = await send((id) => ({ id, call: 'decode_stamp', text: payloadJson }))
      return JSON.parse(raw) as DesignCoreDecodeStampAnswer
    },
    async encodeStamp(payload: SavedObjectStampPayload): Promise<DesignCoreEncodeStampAnswer> {
      const raw = await send((id) => ({
        id,
        call: 'encode_stamp',
        payloadJson: JSON.stringify(payload),
      }))
      return JSON.parse(raw) as DesignCoreEncodeStampAnswer
    },
    async readNewerDesign(text: string): Promise<ReadOnlyDesign> {
      const raw = await send((id) => ({ id, call: 'read', text }))
      const settled = parseReadNewerAnswer(raw)
      return settled.ok ? settled.value : Promise.reject(settled.failure)
    },
  }
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

type ReadNewerSettled =
  | { readonly ok: true; readonly value: ReadOnlyDesign }
  | { readonly ok: false; readonly failure: DesignLoadFailure }

function parseReadNewerAnswer(value: string): ReadNewerSettled {
  let answer: unknown
  try {
    answer = JSON.parse(value)
  } catch {
    // Not JSON: the module gave no answer this build reads, settled below as an internal fault.
    answer = null
  }
  const record = typeof answer === 'object' && answer !== null ? answer as Record<string, unknown> : {}
  if (isReadOnlyDesign(record.read)) return { ok: true, value: record.read }
  if (isDesignLoadFailure(record.refused)) return { ok: false, failure: record.refused }
  return {
    ok: false,
    failure: { kind: 'internal', message: 'the format core gave an answer the adapter cannot read' },
  }
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
