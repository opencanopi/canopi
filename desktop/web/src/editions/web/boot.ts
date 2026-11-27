/**
 * editions/web/boot.ts: L5 Web edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22, C4).
 *
 * Unload residual risk (2b-6, 2.1-M526): IndexedDB writes are asynchronous, so `beforeunload`
 * starts a best-effort `flushNow({ force: true })` and triggers the browser unload prompt while
 * unsaved edits remain. If the browser kills the tab before the transaction commits, the per-tab
 * pending-write marker survives in localStorage and surfaces the "closed before saving" notice
 * on the next launch. `pagehide` closes the IndexedDB connection and refuses reopens while hidden
 * so bfcache stays intact; `pageshow` (`event.persisted`) reopens it.
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
import { openProblemReportDialog } from "../../app/problem-report/submission";
import { t } from "../../i18n";
import {
  presentBrowserDesignOpenFailure,
  raiseDraftStoreBlockedNotice,
  raiseEarlierDataNotice,
  raiseOlderTabCopyNotice,
  raisePendingWriteNotice,
  registerBrowserProblemReportOpener,
  withdrawDraftStoreBlockedNotice,
} from "../../web/browser-notices";
import { browserAppDataStore, DRAFTS_STORAGE_KEY } from "../../web/browser-app-data";
import { browserDraftPersistence } from "../../web/browser-draft-persistence";
import { browserReleaseWatch } from "./browser-release-watch";
import { browserSettingsPlatformAdapter } from "./settings";
import { readSpeciesListRecord, type BrowserStorage } from "../../platform/browser-record";
import { createDesignCore } from "../../platform/design-core";
import { createBrowserDesignHomeStore, type BrowserDesignHomeStore } from "../../platform/design-home.browser";
import { draftNameFromBytes } from "../../platform/draft-records-move";
import { installFailureHooks, reportFailure } from "../../failures/report";
import { capabilitiesForEdition } from "../../generated/edition-capabilities";
import { installEditionPorts } from "../../platform/edition-ports";
import { createUuid } from "../../utils/ids";
import { WEB_EDITION_MANIFEST } from "./manifest";
import { geocodingTransport as browserGeocodingTransport } from "../../app/geocoding/transport.browser";
import { createBrowserFileDelivery } from "../../platform/file-delivery";
import { createUnsupportedDataLibraryPort } from "../../platform/library";
import { installSpeciesCatalogWorkbench } from "../../app/plant-browser";
import { speciesCatalogWorkbench as browserSpeciesCatalogWorkbench } from "./species-catalog";
import { createBrowserProblemReportWriter } from "./problem-report";
import { CANOPI_VERSION } from "../../app/about/metadata";
import { storeHealth } from "../../failures/health";
import { installCanvasHostRuntime } from "../../app/canvas-map-surface/use-canvas-host";
import { createBrowserCanvasHostRuntime } from "./browser-workspace-runtime";
import { browserAppLifecyclePort, browserFileAccessPort } from "./session-ports";
import {
  currentWebDesignText,
  downloadWebCanopi,
  setWebLaunching,
  setWebStorageUnchecked,
} from "./web-session";

let disposeWebRoot: (() => void) | null = null;

export function bootWebEdition(): () => void {
  disposeWebRoot?.();
  const stopConsortiumSync = installConsortiumSync();

  const disposeFailureHooks = installFailureHooks({ storage: "device" }, window);
  registerBrowserProblemReportOpener(openProblemReportDialog);
  const browserFileDelivery = createBrowserFileDelivery({ untitled: () => t("titleBar.untitledDesign") });
  const problemReportWriter = createBrowserProblemReportWriter({
    build: () => ({ app: "Canopi", version: CANOPI_VERSION }),
    health: () => storeHealth.peek(),
    settings: () => readSettingsReportSummary(capabilitiesForEdition("web", "linux")),
    currentDesign: () => currentWebDesignText(),
    fileDelivery: browserFileDelivery,
  });
  const formatCore = createDesignCore();
  const legacyStorageBridge: BrowserStorage = {
    getItem: (key) => browserAppDataStore.readRecord((s) => s.getItem(key)),
    setItem: (key, value) => { browserAppDataStore.writeRecord((s) => s.setItem(key, value)); },
    removeItem: (key) => { browserAppDataStore.writeRecord((s) => s.removeItem(key)); },
  };
  const liveTabId = createUuid();
  const reloadTabId = browserAppDataStore.takeReloadTabId();
  const idbHomeStore: BrowserDesignHomeStore = createBrowserDesignHomeStore({
    legacyStorage: legacyStorageBridge,
    designCore: formatCore,
    appVersion: CANOPI_VERSION,
    tabId: liveTabId,
    onVersionChange: () => {
      browserReleaseWatch.storeChanged();
    },
    onBlocked: () => {
      raiseDraftStoreBlockedNotice();
    },
    onNewerStore: () => {
      browserReleaseWatch.storeChanged();
    },
    onOlderTabCopy: ({ name }) => {
      raiseOlderTabCopyNotice(name);
    },
    onMigrationFailed: (error) => {
      reportFailure(error, { shown: "none", source: "web-drafts.move" });
    },
  });
  const disposePorts = installEditionPorts({
    capabilities: capabilitiesForEdition("web", "linux"),
    manifest: WEB_EDITION_MANIFEST,
    settings: browserSettingsPlatformAdapter,
    problemReport: problemReportWriter,
    geocoding: browserGeocodingTransport,
    fileDelivery: browserFileDelivery,
    dataLibrary: createUnsupportedDataLibraryPort(),
    designHome: idbHomeStore,
    fileAccess: browserFileAccessPort,
    appLifecycle: browserAppLifecyclePort,
    designCore: formatCore,
  });
  let lastMarkedDraftId: string | null = null;
  const webSessionCore = createSessionCore({
    designHome: idbHomeStore,
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
    onPendingWriteChange: (pending) => {
      const open = webSessionCore.currentDesign.peek();
      if (pending && open && !open.readOnly && open.home.kind === "draft") {
        lastMarkedDraftId = open.home.key;
        idbHomeStore.markPending(open.home.key);
      } else if (!pending && lastMarkedDraftId) {
        idbHomeStore.clearPending(lastMarkedDraftId);
        lastMarkedDraftId = null;
      }
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
      || open?.save.kind === "refused"
      || open?.save.kind === "quota";
    if (!needsFlush || !open || open.readOnly) return;
    if (open.home.kind === "draft" && open.save.kind !== "refused") {
      // Best-effort async flush; IndexedDB cannot block unload, so the prompt still guards unsaved work.
      void webSessionCore.flushNow({ force: true }).catch(() => {
        // Unload flush is best-effort; the per-tab pending-write marker covers crash or immediate kill.
      });
    }
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const onPageHide = () => {
    browserAppDataStore.noteReloadTabId(liveTabId);
    idbHomeStore.closeForPageHide();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    browserAppDataStore.takeReloadTabId();
    void idbHomeStore.reopenAfterPageShow().then(() => {
      if (disposed) return;
      const open = webSessionCore.currentDesign.peek();
      if (open && !open.readOnly && open.home.kind === "draft" && (webSessionCore.pendingWrite.peek() || open.save.kind === "failed")) {
        void webSessionCore.flushNow({ force: true }).catch(() => {
          // Best-effort retry after bfcache restore; save notice remains if it still fails.
        });
      }
    });
  };
  const onLegacyStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DRAFTS_STORAGE_KEY) {
      void idbHomeStore.syncLegacyStorage();
    }
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("storage", onLegacyStorage);

  const disposeTheme = initTheme();
  const settingsInstallation = installSettingsProjection(browserSettingsPlatformAdapter);
  let disposed = false;
  void settingsInstallation.ready.catch((error) => {
    if (!disposed) console.error("Failed to bootstrap settings:", error);
  });
  if (browserAppDataStore.takeEarlierDataNotice(new Date().toISOString())) raiseEarlierDataNotice();
  browserAppDataStore.openSpeciesLists(readSpeciesListRecord);

  const restoreIdbDrafts = async (): Promise<number> => {
    const openOutcome = await idbHomeStore.open();
    withdrawDraftStoreBlockedNotice();
    if (disposed) return 0;
    if (openOutcome.kind === "unavailable") {
      // 2.1-Q334 (canopi-2b6q): IndexedDB could not be checked; list 2.0-key Drafts read-only with Download a copy.
      // Notice ("Opened read-only...") is raised when a Draft is actually opened, never on an empty launch.
      setWebStorageUnchecked(true);
      return browserAppDataStore.listDrafts().length;
    }
    setWebStorageUnchecked(false);
    if (openOutcome.kind !== "ready") return 0;
    const drafts = await idbHomeStore.listDrafts();
    for (const pendingId of idbHomeStore.takePendingMarkers(reloadTabId)) {
      const match = drafts.find((d) => d.id === pendingId);
      raisePendingWriteNotice(draftNameFromBytes(match?.bytes ?? null));
      reportFailure(new Error(`Pending write marker found for Draft ${pendingId}`), {
        shown: "notice",
        source: "web-drafts.pending-marker",
      });
    }
    if (!webSessionCore.currentDesign.peek()) {
      const reloadHome = browserAppDataStore.takeReloadHome();
      const targetDraftId = reloadHome !== null ? reloadHome.draft : (drafts[0]?.id ?? null);
      if (targetDraftId) {
        await webSessionCore.openFrom({ kind: "draft", id: targetDraftId as DraftId });
      }
    }
    return drafts.length;
  };

  let disposeDraftPersistence = () => {};
  setWebLaunching(true);
  void (async () => {
    let draftCount = 0;
    try {
      draftCount = await restoreIdbDrafts();
    } catch (error) {
      if (!disposed) console.error("Failed to restore the latest Design Draft:", error);
    } finally {
      setWebLaunching(false);
      if (!disposed) {
        disposeDraftPersistence = browserDraftPersistence.start({ hasDrafts: draftCount > 0 });
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
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("storage", onLegacyStorage);
    withdrawDraftStoreBlockedNotice();
    setWebStorageUnchecked(false);
    idbHomeStore.dispose();
    registerDesignOpenFailurePresenter(null);
    disposeToolRailLearning();
    disposePlaceSearchSession();
    stopReleaseWatch();
    disposeDraftPersistence();
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
