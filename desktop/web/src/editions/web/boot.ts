/**
 * editions/web/boot.ts: L5 Web edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22, C4).
 */
import { installPlaceSearchSession } from "../../app/geocoding/place-search-session";
import { installToolRailLearning } from "../../app/tool-rail/learning";
import { installSettingsProjection, readSettingsReportSummary } from "../../app/settings/projection";
import { initTheme } from "../../app/settings/theme";
import { registerDesignOpenFailurePresenter } from "../../app/document-session/open-failure";
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from "../../app/document-session/live-core";
import { registerCloseGuard } from "../../app/shell/close-guard";
import { installConsortiumSync } from "../../app/consortium/workflow";
import { withNewDesignDisplay } from "../../app/settings/new-design-defaults";
import { normalizeLoadedDocument } from "../../app/contracts/document";
import { NEW_DESIGN_LAYER_DEFAULTS } from "../../generated/new-design-defaults";
import type { DraftId } from "../../platform/design-home";
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
import { installCanvasHostRuntime } from "../../app/canvas-map-surface/use-canvas-host";
import { createBrowserCanvasHostRuntime } from "./browser-workspace-runtime";
import {
  browserAppLifecyclePort,
  browserFileAccessPort,
  createBrowserSessionHomeStore,
} from "./session-ports";
import {
  currentWebDesignText,
  downloadWebCanopi,
  installWebNewerDrafts,
  isWebDraftEditable,
  isWebDraftListingComplete,
  listedNewerWebDrafts,
  listWebDrafts,
  relistNewerWebDrafts,
  setWebLaunching,
} from "./web-session";

let disposeWebRoot: (() => void) | null = null;

export function bootWebEdition(): () => void {
  disposeWebRoot?.();
  const stopConsortiumSync = installConsortiumSync();

  const disposeFailureHooks = installFailureHooks({ storage: "device" }, window);
  const problemReportWriter = createBrowserProblemReportWriter({
    build: () => ({ app: "Canopi", version: CANOPI_VERSION }),
    health: () => storeHealth.peek(),
    settings: () => readSettingsReportSummary(capabilitiesForEdition("web", "linux")),
    currentDesign: () => currentWebDesignText(),
  });
  const formatCore = createDesignCore();
  const browserHomeStore = createBrowserSessionHomeStore();
  const disposePorts = installEditionPorts({
    capabilities: capabilitiesForEdition("web", "linux"),
    manifest: WEB_EDITION_MANIFEST,
    settings: browserSettingsPlatformAdapter,
    problemReport: problemReportWriter,
    geocoding: browserGeocodingTransport,
    canvasPdfDelivery: createBrowserPdfDelivery,
    budgetExportDelivery: deliverBrowserBudgetCsv,
    designHome: browserHomeStore,
    fileAccess: browserFileAccessPort,
    appLifecycle: browserAppLifecyclePort,
    designCore: formatCore,
  });
  const webSessionCore = createSessionCore({
    designHome: browserHomeStore,
    fileAccess: browserFileAccessPort,
    lifecycle: browserAppLifecyclePort,
    codec: createJsonSessionCodec({
      designCore: formatCore,
    }),
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
      applyNewDesignDefaults: withNewDesignDisplay,
    },
    newDesignFactory: async () => {
      const now = new Date().toISOString();
      const created = await formatCore.newDesign({
        name: "Untitled",
        plant_display: null,
        created_at: now,
      });
      const normalized = normalizeLoadedDocument(created);
      if (normalized.layers.length === 0) {
        normalized.layers = NEW_DESIGN_LAYER_DEFAULTS.map((layer) => ({ ...layer }));
      }
      return normalized;
    },
  });
  const disposeSessionCore = installLiveSessionCore(webSessionCore);
  const closeGuardLifetime = registerCloseGuard({ downloadCopy: downloadWebCanopi });
  const disposeCatalog = installSpeciesCatalogWorkbench(browserSpeciesCatalogWorkbench);
  const disposeCanvasHost = installCanvasHostRuntime(() => createBrowserCanvasHostRuntime());

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    const open = webSessionCore.currentDesign.peek();
    const needsFlush = webSessionCore.pendingWrite.peek()
      || open?.save.kind === "failed"
      || open?.save.kind === "refused";
    if (!needsFlush || !open || open.readOnly) return;
    try {
      if (open.home.kind === "draft" && open.save.kind !== "refused") {
        const snap = webSessionCore.snapshot();
        if (snap && browserHomeStore.flushDraftSync(open.home.key, snap, open.home.version)) return;
      }
    } catch {
      // Snapshot/sync-flush failure (e.g. SceneEditBusyError or invalid Draft) falls through to browser unload prompt (B2).
    }
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const disposeTheme = initTheme();
  const settingsInstallation = installSettingsProjection(browserSettingsPlatformAdapter);
  let disposed = false;
  void settingsInstallation.ready.catch((error) => {
    if (!disposed) console.error("Failed to bootstrap settings:", error);
  });
  if (browserAppDataStore.takeEarlierDataNotice(new Date().toISOString())) raiseEarlierDataNotice();
  browserAppDataStore.openSpeciesLists(readSpeciesListRecord);
  const uninstallNewerDrafts = installWebNewerDrafts(createDraftRecordsReader({
    onVersionChange: () => browserReleaseWatch.storeChanged(),
    report: (error) => reportFailure(error, { shown: "none", source: "web-drafts.read" }),
  }));

  let disposeDraftPersistence = () => {};
  setWebLaunching(true);
  void (async () => {
    try {
      const listing = await relistNewerWebDrafts();
      if (!disposed && listing.complete && listing.drafts.length === 0 && !webSessionCore.currentDesign.peek()) {
        const reloadHome = browserAppDataStore.takeReloadHome();
        const targetDraftId = reloadHome !== null
          ? reloadHome.draft
          : (listWebDrafts()[0]?.id ?? null);
        if (targetDraftId && isWebDraftEditable(targetDraftId)) {
          await webSessionCore.openFrom({ kind: "draft", id: targetDraftId as DraftId });
        }
      }
    } catch (error) {
      if (!disposed) console.error("Failed to restore the latest Design Draft:", error);
    } finally {
      setWebLaunching(false);
      if (!disposed) {
        const hasDrafts = !isWebDraftListingComplete()
          || listWebDrafts().length + (listedNewerWebDrafts()?.length ?? 0) > 0;
        disposeDraftPersistence = browserDraftPersistence.start({ hasDrafts });
      }
    }
  })();

  const stopReleaseWatch = browserReleaseWatch.start();
  registerDesignOpenFailurePresenter(presentBrowserDesignOpenFailure);
  const disposePlaceSearchSession = installPlaceSearchSession();
  const disposeToolRailLearning = installToolRailLearning();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("beforeunload", onBeforeUnload);
    registerDesignOpenFailurePresenter(null);
    disposeToolRailLearning();
    disposePlaceSearchSession();
    stopReleaseWatch();
    disposeDraftPersistence();
    uninstallNewerDrafts();
    settingsInstallation.dispose();
    disposeTheme();
    disposeCatalog();
    disposeCanvasHost();
    closeGuardLifetime.dispose();
    disposeSessionCore();
    disposePorts();
    problemReportWriter.dispose();
    disposeFailureHooks();
    stopConsortiumSync();
    if (disposeWebRoot === dispose) disposeWebRoot = null;
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
