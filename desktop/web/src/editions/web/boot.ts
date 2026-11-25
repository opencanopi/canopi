/**
 * editions/web/boot.ts: L5 Web edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22).
 */
import { installPlaceSearchSession } from "../../app/geocoding/place-search-session";
import { installToolRailLearning } from "../../app/tool-rail/learning";
import { installSettingsProjection, readSettingsReportSummary } from "../../app/settings/projection";
import { initTheme } from "../../app/settings/theme";
import { registerDesignOpenFailurePresenter } from "../../app/document-session/open-failure";
import { browserDesignSessionController } from "../../web/browser-design-session";
import { presentBrowserDesignOpenFailure, raiseEarlierDataNotice } from "../../web/browser-notices";
import { browserAppDataStore } from "../../web/browser-app-data";
import { browserDraftPersistence } from "../../web/browser-draft-persistence";
import { browserReleaseWatch } from "./browser-release-watch";
import { browserSettingsPlatformAdapter } from "./settings";
import { readSpeciesListRecord } from "../../platform/browser-record";
import { createDesignCore } from "../../platform/design-core";
import { createDraftRecordsReader } from "../../platform/draft-records.browser";
import { installFailureHooks, reportFailure } from "../../failures/report";
import { capabilitiesForEdition } from "../../generated/edition-capabilities";
import { installEditionPorts } from "../../platform/edition-ports";
import { WEB_EDITION_MANIFEST } from "./manifest";
import { geocodingTransport as browserGeocodingTransport } from "../../app/geocoding/transport.browser";
import { createPdfDelivery as createBrowserPdfDelivery } from "../../app/canvas-pdf/platform.browser";
import { deliverBudgetCsv as deliverBrowserBudgetCsv } from "../../app/budget/platform.browser";
import { installSpeciesCatalogWorkbench } from "../../app/plant-browser";
import { speciesCatalogWorkbench as browserSpeciesCatalogWorkbench } from "./species-catalog";
import { createBrowserProblemReportWriter } from "./problem-report";
import { CANOPI_VERSION } from "../../app/about/metadata";
import { storeHealth } from "../../failures/health";
import { isNewerReadView } from "../../app/document-session/store";
import { installCanvasHostRuntime } from "../../app/canvas-map-surface/use-canvas-host";
import { createBrowserCanvasHostRuntime } from "./browser-workspace-runtime";

let disposeWebRoot: (() => void) | null = null;

export function bootWebEdition(): () => void {
  disposeWebRoot?.();

  // Window error hooks first so a failure during bootstrap reaches the ring (ADR 0025).
  const disposeFailureHooks = installFailureHooks({ storage: "device" }, window);
  const problemReportWriter = createBrowserProblemReportWriter({
    build: () => ({ app: "Canopi", version: CANOPI_VERSION }),
    health: () => storeHealth.peek(),
    settings: () => readSettingsReportSummary(capabilitiesForEdition("web", "linux")),
    currentDesign: () => (isNewerReadView(browserDesignSessionController.readDesignIdentity()?.readOnlyOrigin) ? null : browserDesignSessionController.currentDesignText()),
  });
  const disposePorts = installEditionPorts({
    capabilities: capabilitiesForEdition("web", "linux"),
    manifest: WEB_EDITION_MANIFEST,
    settings: browserSettingsPlatformAdapter,
    problemReport: problemReportWriter,
    geocoding: browserGeocodingTransport,
    canvasPdfDelivery: createBrowserPdfDelivery,
    budgetExportDelivery: deliverBrowserBudgetCsv,
  });
  const disposeCatalog = installSpeciesCatalogWorkbench(browserSpeciesCatalogWorkbench);
  const disposeCanvasHost = installCanvasHostRuntime(() => createBrowserCanvasHostRuntime(browserDesignSessionController));

  const disposeTheme = initTheme();
  const settingsInstallation = installSettingsProjection(browserSettingsPlatformAdapter);
  let disposed = false;
  void settingsInstallation.ready.catch((error) => {
    if (!disposed) console.error("Failed to bootstrap settings:", error);
  });
  if (browserAppDataStore.takeEarlierDataNotice(new Date().toISOString())) raiseEarlierDataNotice();
  browserAppDataStore.openSpeciesLists(readSpeciesListRecord);
  const uninstallFormatCore = browserDesignSessionController.installFormatCore(createDesignCore());
  const uninstallNewerDrafts = browserDesignSessionController.installNewerDrafts(createDraftRecordsReader({
    onVersionChange: () => browserReleaseWatch.storeChanged(),
    report: (error) => reportFailure(error, { shown: "none", source: "web-drafts.read" }),
  }));
  let disposeDraftPersistence = () => {};
  void browserDesignSessionController.launch().catch((error: unknown) => {
    if (!disposed) console.error("Failed to restore the latest Design Draft:", error);
  }).finally(() => {
    if (disposed) return;
    const controller = browserDesignSessionController;
    const hasDrafts = !controller.draftListingComplete() || controller.listDrafts().length + (controller.listedNewerDrafts()?.length ?? 0) > 0;
    disposeDraftPersistence = browserDraftPersistence.start({ hasDrafts });
  });
  const uninstallContinuousSave = browserDesignSessionController.installContinuousSave();
  const stopReleaseWatch = browserReleaseWatch.start();
  registerDesignOpenFailurePresenter(presentBrowserDesignOpenFailure);
  const disposePlaceSearchSession = installPlaceSearchSession();
  const disposeToolRailLearning = installToolRailLearning();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    registerDesignOpenFailurePresenter(null);
    disposeToolRailLearning();
    disposePlaceSearchSession();
    stopReleaseWatch();
    uninstallContinuousSave();
    uninstallNewerDrafts();
    uninstallFormatCore();
    disposeDraftPersistence();
    settingsInstallation.dispose();
    disposeTheme();
    disposeCatalog();
    disposeCanvasHost();
    disposePorts();
    problemReportWriter.dispose();
    disposeFailureHooks();
  };
  disposeWebRoot = dispose;
  return dispose;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeWebRoot?.();
    disposeWebRoot = null;
  });
}
