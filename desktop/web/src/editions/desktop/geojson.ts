// editions/desktop/geojson.ts
//
// Desktop GeoJSON notices and workflow adapter over @tauri-apps/* (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and editions/desktop/.

import { message } from '@tauri-apps/plugin-dialog'
import { designName } from '../../app/document-session/store'
import { createGeoJsonWorkflow, geoJsonNoticeText, type GeoJsonNotice } from '../../app/geojson/workflow'
import { t } from '../../i18n'
import { desktopGeoJsonFiles } from '../../ipc/geojson'

/** Desktop presents GeoJSON import and export notices as native message dialogs. */
export async function presentDesktopGeoJsonNotice(notice: GeoJsonNotice): Promise<void> {
  await message(geoJsonNoticeText(notice), {
    title: t(notice.title),
    kind: notice.tone === 'error' ? 'error' : 'info',
  })
}

/** The Desktop GeoJSON workflow: native file transport plus native notices. */
export const desktopGeoJsonWorkflow = createGeoJsonWorkflow({
  files: desktopGeoJsonFiles,
  notify: presentDesktopGeoJsonNotice,
  designName: () => designName.value,
})
