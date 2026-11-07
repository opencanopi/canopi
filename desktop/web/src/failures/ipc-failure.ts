/**
 * failures/ipc-failure.ts: the settlement object a rejected native command throws (contracts §2, design check F15).
 * Invariant: `.message` is the native rejection's text byte for byte (2.1-M41's matchers read it), and the object
 * itself is the settlement's identity: the ring matches reports by identity, so a copy (a new `IpcFailure` built from
 * another's fields) counts as a new report with its own entry. A cancel is read by its typed `cancelled` code, never by
 * its text (canopi-f47t.52.172).
 */
import type { Failure } from '../generated/contracts'

export class IpcFailure extends Error {
  override readonly name = 'IpcFailure'

  constructor(
    /** The settlement as it crossed the seam: its code, op and redacted detail. */
    readonly failure: Failure,
    /** The rejection's own text, unchanged; never shown and never stored unredacted. */
    message: string,
  ) {
    super(message)
  }
}

/** Whether `value` has a wire `Failure`'s shape (contracts §2): a code with its kind, an op and the retry flag. */
export function isWireFailure(value: unknown): value is Failure {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof Failure, unknown>>
  return typeof record.op === 'string' && typeof record.user_may_retry === 'boolean'
    && typeof record.code === 'object' && record.code !== null && typeof (record.code as { kind?: unknown }).kind === 'string'
}

/** The settlement an error carries: an `IpcFailure`'s, or a wire `Failure` itself; null for any other value. */
export function failureOf(error: unknown): Failure | null {
  if (error instanceof IpcFailure) return error.failure
  return isWireFailure(error) ? error : null
}

/** Whether `error` is a cancel: its settlement's code is `cancelled`, whatever any text says (canopi-f47t.52.172). */
export function isCancelledFailure(error: unknown): boolean {
  return failureOf(error)?.code.kind === 'cancelled'
}
