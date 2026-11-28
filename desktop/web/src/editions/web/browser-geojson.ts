import { designName } from "../../app/document-session/store";
import {
  createGeoJsonWorkflow,
  type GeoJsonSourceFile,
  type GeoJsonWorkflow,
} from "../../app/geojson/workflow";
import { FILE_KINDS } from "../../platform/file-delivery";
import { presentBrowserGeoJsonNotice } from "../../web/browser-notices";
import { pickBrowserTextFile } from "../../web/browser-text-files";

/** Web GeoJSON file picker using the FileDelivery file-kind accept string. */
async function pickBrowserGeoJsonFile(): Promise<GeoJsonSourceFile | null> {
  const file = await pickBrowserTextFile(FILE_KINDS.geojson.accept);
  return file ? { name: file.fileName, text: file.text } : null;
}

export function createBrowserGeoJsonWorkflow(): GeoJsonWorkflow {
  return createGeoJsonWorkflow({
    pickGeoJsonFile: pickBrowserGeoJsonFile,
    notify: presentBrowserGeoJsonNotice,
    designName: () => designName.value,
  });
}
