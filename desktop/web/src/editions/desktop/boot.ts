/**
 * editions/desktop/boot.ts: L5 Desktop edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22).
 */
import { bootstrapShell, type ShellBootstrap } from "../../app/shell/bootstrap";
import { registerCloseGuard, type CloseGuardLifetime } from "../../app/shell/close-guard";
import { disposeLidarWorkflow, installLidarWorkflow } from "../../app/data-library/workflow";
import { disposeLidarDisplayDescriptors, installLidarDisplayDescriptors } from "../../app/data-library/display";
import { installDesignContinuousSave } from "../../app/document-session/transition";
import { installLaunchFile } from "../../app/document-session/launch-file";
import { subscribePendingOpen, takePendingOpen } from "../../ipc/launch";
import { installPlaceSearchSession } from "../../app/geocoding/place-search-session";
import { installToolRailLearning } from "../../app/tool-rail/learning";
import { focusOwner } from "../../app/keyboard/focus-owner";
import { installKeyRouter } from "../../app/keyboard/key-router";
import { singleKeyShortcuts } from "../../app/settings/state";
import { currentCanvasKeyboardPort } from "../../canvas/session";
import { detectPlatform } from "../../canvas/runtime/input/platform";
import { setShortcutPlatform } from "../../app/shell-commands/shortcut-text";
import { installDesktopKeyRouter } from "../../commands/registry";
import { registerDesignOpenFailurePresenter } from "../../app/document-session/open-failure";
import { presentDesktopDesignOpenFailure } from "./open-failure";
import { desktopSettingsPlatformAdapter, loadDesktopHealth } from "./settings";
import { installProblemReportPort } from "../../components/shared/ProblemReportDialog";
import { desktopProblemReport } from "./problem-report";
import { installFailureHooks } from "../../failures/report";
import { capabilitiesForEdition, type RuntimeOs } from "../../generated/edition-capabilities";
import { installEditionPorts } from "../../platform/edition-ports";
import { DESKTOP_EDITION_MANIFEST } from "./manifest";
import { geocodingTransport as desktopGeocodingTransport } from "../../app/geocoding/transport.desktop";
import { createPdfDelivery as createDesktopPdfDelivery } from "../../app/canvas-pdf/platform.desktop";
import { deliverBudgetCsv as deliverDesktopBudgetCsv } from "../../app/budget/platform.desktop";
import { installSpeciesCatalogWorkbench } from "../../app/plant-browser";
import { speciesCatalogWorkbench as desktopSpeciesCatalogWorkbench } from "./species-catalog";
import { installSpeciesCacheLoader } from "../../app/canvas-runtime/species-cache";
import { installGeoJsonWorkflow } from "../../app/geojson/workflow";
import { desktopGeoJsonWorkflow } from "./geojson";
import { getFlowerColorBatch, getSpeciesBatch } from "../../ipc/species";
import { installNativeAssetUrlResolver } from "../../ipc/transport";
import { isPlantDbUnavailableError } from "../../ipc/plant-db-errors";
import { createDesktopCanvasHostRuntime } from "../../app/canvas-map-surface/desktop-workspace-runtime";
import { installCanvasHostRuntime } from "../../app/canvas-map-surface/use-canvas-host";

function runtimeOsFromPlatform(platform: ReturnType<typeof detectPlatform>): RuntimeOs {
  if (platform.os === "mac") return "macos";
  if (platform.os === "windows") return "windows";
  return "linux";
}

let disposeDesktopRoot: (() => void) | null = null;

export function bootDesktopEdition(): () => void {
  disposeDesktopRoot?.();

  // Window error hooks first so a failure during bootstrap reaches the ring (ADR 0025).
  const disposeFailureHooks = installFailureHooks({ storage: "disk" }, window);
  const disposeAssetUrlResolver = installNativeAssetUrlResolver();
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  const disposePorts = installEditionPorts({
    capabilities: capabilitiesForEdition("desktop", runtimeOsFromPlatform(platform)),
    manifest: DESKTOP_EDITION_MANIFEST,
    settings: desktopSettingsPlatformAdapter,
    problemReport: desktopProblemReport,
    geocoding: desktopGeocodingTransport,
    canvasPdfDelivery: createDesktopPdfDelivery,
    budgetExportDelivery: deliverDesktopBudgetCsv,
  });
  const disposeCatalog = installSpeciesCatalogWorkbench(desktopSpeciesCatalogWorkbench);
  const disposeSpeciesCacheLoader = installSpeciesCacheLoader({
    getSpeciesBatch,
    getFlowerColorBatch,
    isPlantDbUnavailableError,
  });
  const disposeGeoJsonWorkflow = installGeoJsonWorkflow(desktopGeoJsonWorkflow);
  const disposeCanvasHost = installCanvasHostRuntime(createDesktopCanvasHostRuntime);
  installProblemReportPort(desktopProblemReport);

  installLidarWorkflow();
  installLidarDisplayDescriptors();
  const shellBootstrap: ShellBootstrap = bootstrapShell(desktopSettingsPlatformAdapter, loadDesktopHealth);
  registerDesignOpenFailurePresenter(presentDesktopDesignOpenFailure);
  const disposeContinuousSave = installDesignContinuousSave();
  const disposeLaunchFile = installLaunchFile({ take: takePendingOpen, subscribe: subscribePendingOpen });
  const disposePlaceSearchSession = installPlaceSearchSession();
  const disposeToolRailLearning = installToolRailLearning();
  setShortcutPlatform(platform);
  const keyRouter = installDesktopKeyRouter(installKeyRouter, {
    target: window,
    canvas: currentCanvasKeyboardPort,
    singleKeys: singleKeyShortcuts,
    focus: focusOwner,
    platform,
    document,
  });
  const closeGuardLifetime: CloseGuardLifetime = registerCloseGuard();

  const dispose = () => {
    disposeLidarWorkflow();
    disposeLidarDisplayDescriptors();
    closeGuardLifetime.dispose();
    disposePlaceSearchSession();
    disposeToolRailLearning();
    keyRouter.dispose();
    disposeLaunchFile();
    disposeContinuousSave();
    registerDesignOpenFailurePresenter(null);
    shellBootstrap.dispose();
    disposeCatalog();
    disposeSpeciesCacheLoader();
    disposeGeoJsonWorkflow();
    disposeCanvasHost();
    disposePorts();
    disposeAssetUrlResolver();
    disposeFailureHooks();
  };
  disposeDesktopRoot = dispose;
  return dispose;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeDesktopRoot?.();
    disposeDesktopRoot = null;
  });
}
