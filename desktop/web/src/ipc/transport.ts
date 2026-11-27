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
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core'
import { FAILURE_CATALOGUE, type Failure, type OperationId, type RedactedText } from '../generated/contracts'
import { createTypedInvoke, type CommandName } from '../generated/command-map'
import { activeCommandTransport, installAssetUrlResolver } from '../types/command-transport'
import { mintOperationId } from '../utils/ids'
import { IpcFailure, isWireFailure } from '../failures/ipc-failure'
import { redact } from '../failures/redact'
import { reportFailure } from '../failures/report'

/** A streaming command's progress channel (contracts §1 `stream`), re-exported so no other module imports Tauri core. */
export { Channel, convertFileSrc as nativeAssetUrl, mintOperationId }

/** Installs Tauri's `convertFileSrc` as the Desktop asset URL resolver (called by editions/desktop/boot.ts). */
export function installNativeAssetUrlResolver(): () => void {
  return installAssetUrlResolver(convertFileSrc)
}

/**
 * Generated typed native command call requiring a branded `OperationId` (2.1-M411, contracts §1).
 * Carries the same `OperationId` across the transport and into any settled `IpcFailure`.
 */
export const invokeTyped = createTypedInvoke((command, args, operation) => invokeCommand(command, args, operation))

/**
 * Raw binary IPC invocation for commands taking `tauri::ipc::Request<'_>` (2.1-M154, contracts §16).
 * Sends `bytes` as an unencoded binary body with ASCII headers so large exports never round-trip through JSON.
 */
export async function invokeBinaryCommand<T>(
  command: CommandName,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
  operation: OperationId,
): Promise<T> {
  try {
    const custom = activeCommandTransport()
    if (custom) {
      return await custom(command, { bytes, headers }, operation) as T
    }
    return await invoke<T>(command, bytes, { headers: { ...headers, 'x-canopi-operation': operation } })
  } catch (rejection) {
    if (isTypedRefusal(rejection)) throw rejection
    throw settle(command, rejection, operation)
  }
}

/** Private transport behind `invokeTyped`; a rejection throws its `IpcFailure`, already in the ring unless silent. */
async function invokeCommand<T>(
  command: CommandName,
  args: Record<string, unknown> | undefined,
  operation: OperationId,
): Promise<T> {
  try {
    const custom = activeCommandTransport()
    if (custom) {
      return await custom(command, args, operation) as T
    }
    // Preserve an explicit caller `operation` arg (e.g. updater cancel pairing) while always sending one on the wire.
    const wireArgs = { operation, ...args }
    return await invoke<T>(command, wireArgs)
  } catch (rejection) {
    // A typed refusal not yet on the catalogue (`DesignLoadFailure`, `LidarImportRefusal`) is its caller's outcome,
    // worded by the surface that reads its shape; it joins the catalogue with its stream (design_load in 2b,
    // import_refused in N1), so it passes unchanged and unrecorded until then.
    if (isTypedRefusal(rejection)) throw rejection
    throw settle(command, rejection, operation)
  }
}

function isTypedRefusal(rejection: unknown): boolean {
  return typeof rejection === 'object' && rejection !== null && !(rejection instanceof Error) && !isWireFailure(rejection)
}

function settle(command: string, rejection: unknown, operation: OperationId | null): IpcFailure {
  const settlement = isWireFailure(rejection)
    ? typedFailure(rejection.operation || operation === null ? rejection : { ...rejection, operation })
    : untypedNativeFailure(command, rejection, operation)
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
 * A write refused on a newer-read-only store: native rejects with this bare text (`write_refusal`,
 * desktop/src/db/user_db.rs; desktop/src/services/settings.rs; the Data library's `ensure_writable`,
 * desktop/src/services/lidar/recovery.rs), and the store's one notice says it (2.1-M487, 2.1-Q319).
 */
type SilentRow = readonly [text: string, code: Failure['code']]
const USER_DB_REFUSED: SilentRow = ['store_read_only', { kind: 'store_read_only', store: 'user_db' }]
const LIBRARY_REFUSED: SilentRow = ['store_read_only', { kind: 'store_read_only', store: 'library_catalogue' }]

/**
 * Each String command's silent refusal text and its catalogue code, bound to its command so no other command's text is
 * silenced; a row goes when its command is typed. `pick_geojson_file` refuses a second dialog with the bare kind,
 * `search_species` a query a newer one superseded (desktop/src/services/plant_browser.rs), and each user DB or
 * Data library write a newer-read-only store.
 */
const SILENT_UNTYPED: ReadonlyMap<string, SilentRow> = new Map<string, SilentRow>([
  ['pick_geojson_file', ['dialog_already_open', { kind: 'dialog_already_open' }]],
  ['search_species', ['Species search cancelled because a newer query superseded it', { kind: 'cancelled' }]],
  ['create_notebook_section', USER_DB_REFUSED],
  ['add_design_reference_to_notebook', USER_DB_REFUSED],
  ['rename_notebook_section', USER_DB_REFUSED],
  ['delete_notebook_section', USER_DB_REFUSED],
  ['move_design_reference_to_section', USER_DB_REFUSED],
  ['relocate_design_reference', USER_DB_REFUSED],
  ['remove_design_reference', USER_DB_REFUSED],
  ['reorder_notebook_sections', USER_DB_REFUSED],
  ['reorder_design_references', USER_DB_REFUSED],
  ['create_saved_object_stamp', USER_DB_REFUSED],
  ['rename_saved_object_stamp', USER_DB_REFUSED],
  ['delete_saved_object_stamp', USER_DB_REFUSED],
  ['restore_saved_object_stamp', USER_DB_REFUSED],
  ['reorder_saved_object_stamps', USER_DB_REFUSED],
  ['remove_recent_design', USER_DB_REFUSED],
  ['toggle_favorite', USER_DB_REFUSED],
  ['lidar_rename_item', LIBRARY_REFUSED],
  ['lidar_delete_item', LIBRARY_REFUSED],
  ['lidar_dismiss_import', LIBRARY_REFUSED],
  ['lidar_create_analysis', LIBRARY_REFUSED],
  ['lidar_rerun_analysis', LIBRARY_REFUSED],
])

/**
 * A rejection that is not a `Failure`, settled `internal` with its text redacted here (2.1-M409; deleted at R13 0),
 * but for the String commands' silent outcomes in `SILENT_UNTYPED`, settled as their silent catalogue code so they are
 * never recorded (2.1-M437, 2.1-Q284).
 */
function untypedNativeFailure(command: string, rejection: unknown, operation: OperationId | null): IpcFailure {
  const text = rejectionText(rejection)
  const failure: Failure = {
    code: untypedCode(command, text),
    user_may_retry: false,
    op: untypedOp(command),
    operation,
    detail: redactedDetail(text),
  }
  return new IpcFailure(failure, text)
}

function untypedCode(command: string, text: string): Failure['code'] {
  const silent = SILENT_UNTYPED.get(command)
  return silent?.[0] === text ? silent[1] : { kind: 'internal' }
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
