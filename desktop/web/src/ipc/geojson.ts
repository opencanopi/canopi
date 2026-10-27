import { invoke } from '@tauri-apps/api/core'
import type {
  GeoJsonFileAdapter,
  GeoJsonSourceFile,
  GeoJsonWriteOutcome,
} from '../app/geojson/workflow'
import { pickSave } from './dialogs'

/** Desktop GeoJSON file I/O: Rust picks and reads imports; exports go through the host's Save dialog. */
export const desktopGeoJsonFiles: GeoJsonFileAdapter = {
  // Rust shows the open dialog and reads the file itself, so no path the page
  // chooses ever reaches the native reader.
  async pickGeoJsonFile(): Promise<GeoJsonSourceFile | null> {
    return invoke<GeoJsonSourceFile | null>('pick_geojson_file')
  },

  async writeGeoJsonFile(text: string, fileName: string): Promise<GeoJsonWriteOutcome> {
    const outcome = await pickSave('geojson-export', fileName)
    if (outcome.kind === 'cancelled') return 'cancelled'
    await invoke('export_file', { data: text, path: outcome.path })
    return 'written'
  },
}
