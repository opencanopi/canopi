/**
 * platform/design-core.ts: the design-core port's Web adapter over the format worker (ADR 0025 Format core failures;
 * contracts §10, §18 F28; 2b-5, 2.1-M156, 2.1-M476, 2.1-M539, 2.1-Q347). Owner of the format worker
 * (`worker-only-in-owner`, ADR 0028; §18 F16) and the CanopiFile format-core boundary (`no-canopifile-literal`,
 * ADR 0026; §18 F28). Invariant: every call settles exactly once, nothing is retried silently, and the worker
 * (`platform/design-core.worker.ts`) is started only here.
 *
 * - Lazy: the worker starts on the first call.
 * - Failed load -> `format_core_unavailable`; next call retries.
 * - Trap -> `format_core_trapped` for the active and queued calls; worker terminated and respawned on next call.
 * - Large open (> 4 MiB) -> worker recycled once idle (contracts §10).
 */
import type { CanopiFileV10, DraftSummaryOutcome, Failure, FailureCode, FormatDecodeAnswer, FormatRefusal, NewDesignInputContract, RedactedText, SavedObjectStampPayload } from '../generated/contracts'
import type { GeoPoint } from '../types/design'
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
  /** Per-call timeout in ms before rejecting `format_core_unavailable` and recycling the worker. */
  readonly callTimeoutMs?: number
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
  /** Maps a v3 stamp payload to canonical v10 `.canopi` stamp file bytes (Desktop IPC). */
  stampToCanopi?(payload: SavedObjectStampPayload, name: string, origin: GeoPoint): Promise<DesignCoreEncodeAnswer>
  /** Decodes a v9/v10 `.canopi` stamp file into a v3 stamp payload (Desktop IPC). */
  canopiToStamp?(bytes: Uint8Array, origin: GeoPoint): Promise<DesignCoreDecodeStampAnswer>
}

const DESIGN_CORE_OP = 'format_core'
const LARGE_OPEN_RECYCLE_BYTES = 4 * 1024 * 1024
const DEFAULT_CALL_TIMEOUT_MS = 30_000

interface Waiting {
  resolve(raw: string): void
  reject(reason: unknown): void
  timer: ReturnType<typeof setTimeout>
}

/** The dedicated module worker the Web build emits beside the page. */
function startFormatWorker(): DesignCoreWorker {
  return new Worker(new URL('./design-core.worker.ts', import.meta.url), {
    type: 'module',
    name: 'canopi-format-core',
  }) as unknown as DesignCoreWorker
}

/** The adapter; its worker starts on its first call. */
export function createDesignCore({
  createWorker = startFormatWorker,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}: DesignCoreOptions = {}): DesignCore {
  // Fatal UTF-8 decoding matches Desktop's `serde_json::from_slice` refusal of invalid UTF-8.
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
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
    const settled = [...waiting.values()]
    waiting.clear()
    for (const call of settled) {
      clearTimeout(call.timer)
      if (reason) call.reject(reason())
    }
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
    const call = waiting.get(data.id)
    if (!call) return
    clearTimeout(call.timer)
    waiting.delete(data.id)
    if (data.ok) {
      answered = true
      call.resolve(data.value)
      if (recycleWhenIdle && waiting.size === 0) stopWorker()
      return
    }
    if (data.error === 'unavailable') {
      // Do not mark `answered`: a subsequent worker error is still an unavailable start failure.
      call.reject(formatCoreFailure('format_core_unavailable', data.detail))
      return
    }
    answered = true
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
      const timer = setTimeout(() => {
        if (!waiting.has(id)) return
        stopWorker(() => formatCoreFailure('format_core_unavailable', 'the format worker timed out'))
      }, callTimeoutMs)
      waiting.set(id, { resolve, reject, timer })
      running.postMessage(build(id))
    })
  }

  function decodeUtf8Strict(bytes: Uint8Array): string | null {
    try {
      return utf8Decoder.decode(bytes)
    } catch {
      // Invalid UTF-8 bytes are refused as invalid_json for Desktop edition parity.
      return null
    }
  }

  return {
    async version(): Promise<string> {
      return send((id) => ({ id, call: 'version' }))
    },
    async decode(bytes: Uint8Array): Promise<FormatDecodeAnswer> {
      const text = decodeUtf8Strict(bytes)
      if (text === null) {
        return {
          err: {
            kind: 'invalid_json',
            message: 'the Design is not valid UTF-8',
            field_path: null,
          },
        }
      }
      if (bytes.byteLength > LARGE_OPEN_RECYCLE_BYTES) recycleWhenIdle = true
      const raw = await send((id) => ({ id, call: 'decode', text }))
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
          field_path: null,
        },
      }
    },
    async newDesign(input: NewDesignInputContract): Promise<CanopiFileV10> {
      const raw = await send((id) => ({ id, call: 'new_design', inputJson: JSON.stringify(input) }))
      return JSON.parse(raw) as CanopiFileV10
    },
    async draftSummary(bytes: Uint8Array, updatedAt: string): Promise<DraftSummaryOutcome> {
      const text = decodeUtf8Strict(bytes)
      if (text === null) {
        return {
          name: '',
          updated_at: updatedAt,
          readable: false,
          refusal_kind: { kind: 'invalid_json' },
        }
      }
      const raw = await send((id) => ({
        id,
        call: 'draft_summary',
        text,
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

type FormatCoreCode = Extract<FailureCode, { readonly kind: 'format_core_unavailable' | 'format_core_trapped' }>['kind']

function formatCoreFailure(kind: FormatCoreCode, detail: string): Failure {
  return {
    code: { kind },
    user_may_retry: true,
    op: DESIGN_CORE_OP,
    operation: null,
    detail: detail.length > 0 ? redact(detail) as RedactedText : null,
  }
}
