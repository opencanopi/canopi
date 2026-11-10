import { designName } from "../app/document-session/store";
import {
  createGeoJsonWorkflow,
  type GeoJsonFileAdapter,
  type GeoJsonWorkflow,
} from "../app/geojson/workflow";
import { presentBrowserGeoJsonNotice } from "./browser-notices";
import { downloadBrowserTextFile, pickBrowserTextFile } from "./browser-text-files";

/** Web GeoJSON file I/O: the browser picker reads, a download writes. */
export const browserGeoJsonFiles: GeoJsonFileAdapter = {
  async pickGeoJsonFile() {
    const file = await pickBrowserTextFile(".geojson,.json,application/geo+json,application/json");
    return file ? { name: file.fileName, text: file.text } : null;
  },
  async writeGeoJsonFile(text, fileName) {
    downloadBrowserTextFile(fileName, text, "application/geo+json");
    return "written";
  },
};

export function createBrowserGeoJsonWorkflow(): GeoJsonWorkflow {
  return createGeoJsonWorkflow({
    files: browserGeoJsonFiles,
    notify: presentBrowserGeoJsonNotice,
    designName: () => designName.value,
  });
}
