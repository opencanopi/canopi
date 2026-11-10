/**
 * ipc/transport.ts: Owner of the native command call, the only module importing Tauri's `invoke` (invoke-only-in-ipc,
 * ADR 0022 and 0025, contracts §1 and §2, design check F15). Invariant: a rejected command settles as one `IpcFailure` (but for a typed
 * refusal not yet on the catalogue, passed on unchanged), recorded once in
 * the failure ring unless its catalogue row is silent; a later `reportFailure` of that same object marks the entry
 * surfaced, and so does the `unhandledrejection` hook find it, so a settlement never has two entries.
 *
 * A rejection that is a catalogue `Failure` keeps its code, op and native-redacted detail. Until R13 reaches 0, a
 * rejection that is not one (a String command's error, Tauri's own) is frontend-origin text: `untypedNativeFailure`
 * settles it `internal` under the command's op, its text redacted by failures/redact.ts, and the thrown object keeps
 * the text as `.message` byte for byte for 2.1-M41's busy and plant-DB matchers (2.1-M409). That branch is deleted
 * with the last String command. 2a's typed `invoke<K>` replaces `invokeCommand` and adds the OperationId (2.1-M411).
 */
import { Channel, invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { FAILURE_CATALOGUE, type Failure, type RedactedText } from '../generated/contracts'
import { IpcFailure, isWireFailure } from '../failures/ipc-failure'
import { redact } from '../failures/redact'
import { reportFailure } from '../failures/report'

/** A streaming command's progress channel (contracts §1 `stream`), re-exported so no other module imports Tauri core. */
export { Channel }

/** Calls native command `command`; a rejection throws its `IpcFailure`, already in the ring unless silent. */
export async function invokeCommand<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    // An argument-less command is called with none, as Tauri's own wrappers do.
    return await (args === undefined ? invoke<T>(command) : invoke<T>(command, args))
  } catch (rejection) {
    // A typed refusal not yet on the catalogue (`DesignLoadFailure`, `LidarImportRefusal`) is its caller's outcome,
    // worded by the surface that reads its shape; it joins the catalogue with its stream (design_load in 2b,
    // import_refused in N1), so it passes unchanged and unrecorded until then.
    if (isTypedRefusal(rejection)) throw rejection
    throw settle(command, rejection)
  }
}

function isTypedRefusal(rejection: unknown): boolean {
  return typeof rejection === 'object' && rejection !== null && !(rejection instanceof Error) && !isWireFailure(rejection)
}

function settle(command: string, rejection: unknown): IpcFailure {
  const settlement = isWireFailure(rejection) ? typedFailure(rejection) : untypedNativeFailure(command, rejection)
  // A silent row (a cancel, the refused second dialog) is the caller's outcome, not a failure to keep (2.1-M437).
  if (!FAILURE_CATALOGUE[settlement.failure.code.kind].silent) reportFailure(settlement, { shown: 'none' })
  return settlement
}

function typedFailure(failure: Failure): IpcFailure {
  return new IpcFailure(failure, failure.detail ?? failure.code.kind)
}

/**
 * The op a String command's settlement carries: its IPC name under `ipc.`, since such a command has no op constant
 * until its stream types it (`^[a-z_]+\.[a-z_]+$`, contracts §2).
 */
function untypedOp(command: string): string {
  return `ipc.${command}`
}

/**
 * A rejection that is not a `Failure`, settled `internal` with its text redacted here (2.1-M409; deleted at R13 0).
 * The host's refusal of a second dialog, still the bare string `dialog_already_open` on `pick_geojson_file`, settles
 * as its silent catalogue code so it is never recorded (2.1-M437, 2.1-Q284).
 */
function untypedNativeFailure(command: string, rejection: unknown): IpcFailure {
  const text = rejectionText(rejection)
  const failure: Failure = {
    code: text === 'dialog_already_open' ? { kind: 'dialog_already_open' } : { kind: 'internal' },
    user_may_retry: false,
    op: untypedOp(command),
    operation: null,
    detail: redactedDetail(text),
  }
  return new IpcFailure(failure, text)
}

/** The rejection's text as today's callers read it: the bare string, or an error's message. */
function rejectionText(rejection: unknown): string {
  if (typeof rejection === 'string') return rejection
  if (rejection instanceof Error) return rejection.message
  try {
    return String(rejection)
  } catch {
    // A value whose toString throws still settles; its text is what cannot be printed.
    return 'Unprintable rejection'
  }
}

function redactedDetail(text: string): RedactedText {
  try {
    return redact(text) as RedactedText
  } catch {
    // A redactor fault keeps the marker, never the text (contracts §13).
    return 'redaction_failed' as RedactedText
  }
}
