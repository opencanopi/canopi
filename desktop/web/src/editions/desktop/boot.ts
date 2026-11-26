/**
 * editions/desktop/boot.ts: L5 Desktop edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22).
 */
import { bootstrapShell, type ShellBootstrap } from "../../app/shell/bootstrap";
import { registerCloseGuard, waitForCloseHold, type CloseGuardLifetime } from "../../app/shell/close-guard";
import { disposeLidarWorkflow, installLidarWorkflow } from "../../app/data-library/workflow";
import { disposeLidarDisplayDescriptors, installLidarDisplayDescriptors } from "../../app/data-library/display";
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from "../../app/document-session/live-core";
import { withNewDesignDisplay } from "../../app/settings/new-design-defaults";
import { installConsortiumSync } from "../../app/consortium/workflow";
import { installLaunchFile } from "../../app/document-session/launch-file";
import { getRecentFiles, newDesign } from "../../ipc/design";
import { grantForRecent } from "../../ipc/design-home";
import { subscribePendingOpen, takePendingOpen } from "../../ipc/launch";
import { createDesktopLastOpenHomePort, encodeDesktopLastOpenHome } from "./last-open-home";
import { flushSettingsProjection, mutateSettingsProjection } from "../../app/settings/projection";
import { decodeLastOpenHome } from "../../platform/design-home";
import { lastOpenHome, singleKeyShortcuts } from "../../app/settings/state";
import { installPlaceSearchSession } from "../../app/geocoding/place-search-session";
import { installToolRailLearning } from "../../app/tool-rail/learning";
import { focusOwner } from "../../app/keyboard/focus-owner";
import { installKeyRouter } from "../../app/keyboard/key-router";
import { currentCanvasKeyboardPort } from "../../canvas/session";
import { detectPlatform } from "../../canvas/runtime/input/platform";
import { setShortcutPlatform } from "../../app/shell-commands/shortcut-text";
import { installDesktopKeyRouter } from "../../commands/registry";
import { registerDesignOpenFailurePresenter } from "../../app/document-session/open-failure";
import { presentDesktopDesignOpenFailure } from "./open-failure";
import { desktopSettingsPlatformAdapter, loadDesktopHealth } from "./settings";
import { installProblemReportPort } from "../../app/problem-report/submission";
import { desktopProblemReport } from "./problem-report";
import { installFailureHooks } from "../../failures/report";
import { capabilitiesForEdition, type RuntimeOs } from "../../generated/edition-capabilities";
import { installEditionPorts } from "../../platform/edition-ports";
import { desktopHomePort } from "./design-home";
import { createDesktopAppLifecyclePort, createDesktopSessionHomeStore, desktopDesignCorePort, desktopFileAccessPort } from "./session-ports";
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

const runtimeOsFromPlatform = (platform: ReturnType<typeof detectPlatform>): RuntimeOs =>
  platform.os === "mac" ? "macos" : platform.os === "windows" ? "windows" : "linux";

let disposeDesktopRoot: (() => void) | null = null;

export function bootDesktopEdition(): () => void {
  disposeDesktopRoot?.();

  const disposers: Array<() => void> = [
    // Window error hooks first so a failure during bootstrap reaches the ring (ADR 0025).
    installFailureHooks({ storage: "disk" }, window),
    installNativeAssetUrlResolver(),
    installConsortiumSync(),
  ];
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  const capabilities = capabilitiesForEdition("desktop", runtimeOsFromPlatform(platform));
  const desktopLifecycle = createDesktopAppLifecyclePort({ waitForCloseHold });
  disposers.push(
    installEditionPorts({
      capabilities,
      manifest: DESKTOP_EDITION_MANIFEST,
      settings: desktopSettingsPlatformAdapter,
      problemReport: desktopProblemReport,
      geocoding: desktopGeocodingTransport,
      canvasPdfDelivery: createDesktopPdfDelivery,
      budgetExportDelivery: deliverDesktopBudgetCsv,
      designHome: desktopHomePort,
      fileAccess: desktopFileAccessPort,
      appLifecycle: desktopLifecycle,
      designCore: desktopDesignCorePort,
    }),
    installSpeciesCatalogWorkbench(desktopSpeciesCatalogWorkbench),
    installSpeciesCacheLoader({ getSpeciesBatch, getFlowerColorBatch, isPlantDbUnavailableError }),
    installGeoJsonWorkflow(desktopGeoJsonWorkflow),
    installCanvasHostRuntime(() => createDesktopCanvasHostRuntime({ locationEnabled: capabilities.has("my-location") })),
  );
  installProblemReportPort(desktopProblemReport);
  installLidarWorkflow();
  installLidarDisplayDescriptors();
  const shellBootstrap: ShellBootstrap = bootstrapShell(desktopSettingsPlatformAdapter, loadDesktopHealth);
  registerDesignOpenFailurePresenter(presentDesktopDesignOpenFailure);
  setShortcutPlatform(platform);
  const keyRouter = installDesktopKeyRouter(installKeyRouter, {
    target: window,
    canvas: currentCanvasKeyboardPort,
    singleKeys: singleKeyShortcuts,
    focus: focusOwner,
    platform,
    document,
  });
  const desktopSessionCore = createSessionCore({
    designHome: createDesktopSessionHomeStore(),
    fileAccess: desktopFileAccessPort,
    lifecycle: desktopLifecycle,
    codec: createJsonSessionCodec({
      designCore: desktopDesignCorePort,
      readNewerDesign: desktopDesignCorePort.readNewerDesign,
    }),
    settings: {
      readLastOpenHome: async () => decodeLastOpenHome(lastOpenHome.peek()),
      writeLastOpenHome: async (home) => {
        const encoded = await encodeDesktopLastOpenHome(home);
        mutateSettingsProjection((draft) => {
          draft.lastOpenHome = encoded;
        });
      },
      flushSettings: flushSettingsProjection,
      applyNewDesignDefaults: withNewDesignDisplay,
    },
    newDesignFactory: newDesign,
  });
  const closeGuardLifetime: CloseGuardLifetime = registerCloseGuard();
  disposers.push(
    () => shellBootstrap.dispose(),
    () => registerDesignOpenFailurePresenter(null),
    installLiveSessionCore(desktopSessionCore),
    installLaunchFile({
      take: takePendingOpen,
      subscribe: subscribePendingOpen,
      lastOpenHome: createDesktopLastOpenHomePort({
        settingsReady: shellBootstrap.ready,
        getRecentFiles,
        grantForRecent,
      }),
    }),
    () => keyRouter.dispose(),
    installToolRailLearning(),
    installPlaceSearchSession(),
    () => closeGuardLifetime.dispose(),
    disposeLidarDisplayDescriptors,
    disposeLidarWorkflow,
  );

  const dispose = () => {
    for (let i = disposers.length; i--;) disposers[i]!();
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
