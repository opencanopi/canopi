/**
 * ipc/bytes.ts: Raw binary IPC body transport for FileDelivery (contracts §16, 2.1-M154, 2.1-M522).
 * Bytes cross the Tauri IPC boundary as a raw `Uint8Array` body with ASCII headers rather than a
 * JSON number array.
 */
import type { FileKind } from '../generated/contracts'
import { invokeBinaryCommand, mintOperationId } from './transport'

/** Deliver raw bytes to a native Save-dialog destination via the unified `deliver_file` command. */
export async function deliverFileBytes(kind: FileKind, path: string, bytes: Uint8Array): Promise<string> {
  return invokeBinaryCommand<string>(
    'deliver_file',
    bytes,
    {
      'x-canopi-delivery-kind': kind,
      'x-canopi-delivery-path': encodeURIComponent(path),
    },
    mintOperationId('u'),
  )
}
