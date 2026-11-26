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
import {
  presentBrowserDesignOpenFailure,
  raiseDraftStoreBlockedNotice,
  raiseEarlierDataNotice,
  raiseOlderTabCopyNotice,
  raisePendingWriteNotice,
  withdrawDraftStoreBlockedNotice,
} from "../../web/browser-notices";
import { browserAppDataStore, DRAFTS_STORAGE_KEY } from "../../web/browser-app-data";
import { browserDraftPersistence } from "../../web/browser-draft-persistence";
import { browserReleaseWatch } from "./browser-release-watch";
import { browserSettingsPlatformAdapter } from "./settings";
import { readSpeciesListRecord, type BrowserStorage } from "../../platform/browser-record";
import { createDesignCore } from "../../platform/design-core";
import { createBrowserDesignHomeStore, isIndexedDbAvailable, type BrowserDesignHomeStore } from "../../platform/design-home.browser";
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
  const hasIndexedDb = isIndexedDbAvailable();
  const legacyStorageBridge: BrowserStorage = {
    getItem: (key) => browserAppDataStore.readRecord((s) => s.getItem(key)),
    setItem: (key, value) => { browserAppDataStore.writeRecord((s) => s.setItem(key, value)); },
    removeItem: (key) => { browserAppDataStore.writeRecord((s) => s.removeItem(key)); },
  };
  let idbHomeStore: BrowserDesignHomeStore | null = null;
  let fallbackHomeStore: ReturnType<typeof createBrowserSessionHomeStore> | null = null;
  if (hasIndexedDb) {
    idbHomeStore = createBrowserDesignHomeStore({
      legacyStorage: legacyStorageBridge,
      designCore: formatCore,
      appVersion: CANOPI_VERSION,
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
  } else {
    fallbackHomeStore = createBrowserSessionHomeStore();
  }
  const activeHomeStore = idbHomeStore ?? fallbackHomeStore!;
  const disposePorts = installEditionPorts({
    capabilities: capabilitiesForEdition("web", "linux"),
    manifest: WEB_EDITION_MANIFEST,
    settings: browserSettingsPlatformAdapter,
    problemReport: problemReportWriter,
    geocoding: browserGeocodingTransport,
    canvasPdfDelivery: createBrowserPdfDelivery,
    budgetExportDelivery: deliverBrowserBudgetCsv,
    designHome: activeHomeStore,
    fileAccess: browserFileAccessPort,
    appLifecycle: browserAppLifecyclePort,
    designCore: formatCore,
  });
  let lastMarkedDraftId: string | null = null;
  const webSessionCore = createSessionCore({
    designHome: activeHomeStore,
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
      if (!idbHomeStore) return;
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
    if (fallbackHomeStore) {
      try {
        if (open.home.kind === "draft" && open.save.kind !== "refused") {
          const snap = webSessionCore.snapshot();
          if (snap && fallbackHomeStore.flushDraftSync(open.home.key, snap, open.home.version)) return;
        }
      } catch {
        // Snapshot/sync-flush failure (e.g. SceneEditBusyError or invalid Draft) falls through to browser unload prompt (B2).
      }
    }
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const onPageHide = () => {
    idbHomeStore?.closeForPageHide();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void idbHomeStore?.reopenAfterPageShow();
  };
  const onLegacyStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DRAFTS_STORAGE_KEY) {
      void idbHomeStore?.syncLegacyStorage();
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
  const uninstallNewerDrafts = idbHomeStore
    ? () => {}
    : installWebNewerDrafts(createDraftRecordsReader({
        onVersionChange: () => browserReleaseWatch.storeChanged(),
        report: (error) => reportFailure(error, { shown: "none", source: "web-drafts.read" }),
      }));

  const restoreIdbDrafts = async (store: BrowserDesignHomeStore): Promise<number> => {
    const openOutcome = await store.open();
    withdrawDraftStoreBlockedNotice();
    if (disposed || openOutcome.kind !== "ready") return 0;
    const drafts = await store.listDrafts();
    for (const pendingId of store.takePendingMarkers()) {
      const match = drafts.find((d) => d.id === pendingId);
      raisePendingWriteNotice(draftNameFromBytes(match?.bytes ?? null) ?? "Untitled");
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

  const restoreFallbackDrafts = async (): Promise<void> => {
    const listing = await relistNewerWebDrafts();
    if (disposed || !listing.complete || listing.drafts.length > 0 || webSessionCore.currentDesign.peek()) return;
    const reloadHome = browserAppDataStore.takeReloadHome();
    const targetDraftId = reloadHome !== null ? reloadHome.draft : (listWebDrafts()[0]?.id ?? null);
    if (targetDraftId && isWebDraftEditable(targetDraftId)) {
      await webSessionCore.openFrom({ kind: "draft", id: targetDraftId as DraftId });
    }
  };

  let disposeDraftPersistence = () => {};
  setWebLaunching(true);
  void (async () => {
    let idbDraftCount = 0;
    try {
      if (idbHomeStore) {
        idbDraftCount = await restoreIdbDrafts(idbHomeStore);
      } else {
        await restoreFallbackDrafts();
      }
    } catch (error) {
      if (!disposed) console.error("Failed to restore the latest Design Draft:", error);
    } finally {
      setWebLaunching(false);
      if (!disposed) {
        const hasDrafts = idbHomeStore
          ? idbDraftCount > 0
          : (!isWebDraftListingComplete() || listWebDrafts().length + (listedNewerWebDrafts()?.length ?? 0) > 0);
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
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("storage", onLegacyStorage);
    withdrawDraftStoreBlockedNotice();
    idbHomeStore?.dispose();
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

function draftNameFromBytes(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { readonly name?: unknown };
    return typeof parsed?.name === "string" && parsed.name.trim().length > 0 ? parsed.name : null;
  } catch {
    // Unreadable Draft bytes fall back to Untitled in the pending-write notice.
    return null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeWebRoot?.();
    disposeWebRoot = null;
  });
}
