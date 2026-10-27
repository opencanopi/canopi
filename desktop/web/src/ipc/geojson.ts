// ipc/geojson.ts
// Owner of the desktop GeoJSON write outcome (no-cancelled-literal, ADR 0025; §18 R14). Invariant: 'cancelled'
// is a GeoJsonWriteOutcome value, returned only when the save dialog is dismissed; ast-grep skips this file, so a
// hand-written cancel guard added here goes uncounted and belongs to the catalogue's CancelToken instead.

import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import type {
  GeoJsonFileAdapter,
  GeoJsonSourceFile,
  GeoJsonWriteOutcome,
} from '../app/geojson/workflow'

const GEOJSON_FILTERS = [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }]

/** Desktop GeoJSON file I/O: Rust picks and reads imports; exports go through the save dialog. */
export const desktopGeoJsonFiles: GeoJsonFileAdapter = {
  // Rust shows the open dialog and reads the file itself, so no path the page
  // chooses ever reaches the native reader.
  async pickGeoJsonFile(): Promise<GeoJsonSourceFile | null> {
    return invoke<GeoJsonSourceFile | null>('pick_geojson_file')
  },

  async writeGeoJsonFile(text: string, fileName: string): Promise<GeoJsonWriteOutcome> {
    const path = await save({ defaultPath: fileName, filters: GEOJSON_FILTERS })
    if (!path) return 'cancelled'
    await invoke('export_file', {
      data: text,
      path: /\.(geo)?json$/i.test(path) ? path : `${path}.geojson`,
    })
    return 'written'
  },
}
