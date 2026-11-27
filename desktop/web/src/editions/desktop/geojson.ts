// editions/desktop/geojson.ts
//
// Desktop GeoJSON notices on the shared NoticeRow (2.1-M20) and workflow wired to host pick + FileDelivery.

import { designName } from '../../app/document-session/store'
import { createGeoJsonWorkflow, type GeoJsonNotice } from '../../app/geojson/workflow'
import { raiseNotice, withdrawNotice } from '../../failures/notices'
import { pickDesktopGeoJsonFile } from '../../ipc/geojson'

const DESKTOP_GEOJSON_NOTICE_KEY = 'desktop.geojson'

/** Desktop presents GeoJSON import and export outcomes in the shared notice row. */
export function presentDesktopGeoJsonNotice(notice: GeoJsonNotice): void {
  withdrawNotice(DESKTOP_GEOJSON_NOTICE_KEY)
  raiseNotice({
    key: DESKTOP_GEOJSON_NOTICE_KEY,
    kind: 'outcome',
    ...notice,
  })
}

/** The Desktop GeoJSON workflow: native host pick, FileDelivery export, and NoticeRow outcomes. */
export const desktopGeoJsonWorkflow = createGeoJsonWorkflow({
  pickGeoJsonFile: pickDesktopGeoJsonFile,
  notify: presentDesktopGeoJsonNotice,
  designName: () => designName.value,
})
