/**
 * failures/ipc-failure.ts: the settlement object a rejected native command throws (contracts §2, design check F15).
 * Invariant: `.message` is the native rejection's text byte for byte (2.1-M41's matchers read it), and the object
 * itself is the settlement's identity: the ring matches reports by identity, so a copy counts as a new report.
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
