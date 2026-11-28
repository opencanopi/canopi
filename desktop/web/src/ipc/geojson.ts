// ipc/geojson.ts
// Owner of the Desktop GeoJSON import IPC pick (no-cancelled-literal, ADR 0022 and 0025, contracts §16).
// Invariant: extensions come solely from the generated FILE_KINDS table; returns null only when the user
// cancels or a second dialog is refused with dialog_already_open. Exports go through `editions/desktop/file-delivery.ts`.

import { invokeTyped, mintOperationId } from './transport'
import { failureOf } from '../failures/ipc-failure'
import type { GeoJsonSourceFile } from '../app/geojson/workflow'
import { FILE_KINDS } from '../generated/file-kinds'

/** Show the host GeoJSON Open dialog and read the chosen file; returns null when cancelled. */
export async function pickDesktopGeoJsonFile(): Promise<GeoJsonSourceFile | null> {
  return invokeTyped(
    'pick_geojson_file',
    { extensions: FILE_KINDS.geojson.extensions },
    mintOperationId('u'),
  ).catch((error: unknown) => {
    if (failureOf(error)?.code.kind === 'dialog_already_open') return null
    throw error
  })
}
