/**
 * editions/desktop/boot.ts: L5 Desktop edition lifetime bootstrap (ADR 0022, ADR 0030, contracts §22).
 */
import { bootstrapShell, type ShellBootstrap } from "../../app/shell/bootstrap";
import { waitForCloseHold } from "../../app/shell/close-guard";
import { disposeLidarWorkflow, installLidarWorkflow } from "../../app/data-library/workflow";
import { disposeLidarDisplayDescriptors, installLidarDisplayDescriptors } from "../../app/data-library/display";
import {
  createJsonSessionCodec,
  createSessionCore,
  normalizeLoadedDocument,
} from "../../app/document-session/live-core";
import { withNewDesignDisplay } from "../../app/settings/new-design-defaults";
import { installLaunchFile } from "../../app/document-session/launch-file";
import { getRecentFiles } from "../../ipc/design";
import { NEW_DESIGN_LAYER_DEFAULTS } from "../../generated/new-design-defaults";
import { grantForRecent } from "../../ipc/design-home";
import { subscribePendingOpen, takePendingOpen } from "../../ipc/launch";
import { createDesktopLastOpenHomePort, encodeDesktopLastOpenHome } from "./last-open-home";
import { flushSettingsProjection, mutateSettingsProjection } from "../../app/settings/projection";
import { decodeLastOpenHome } from "../../platform/design-home";
import { lastOpenHome, singleKeyShortcuts } from "../../app/settings/state";
import { focusOwner } from "../../app/keyboard/focus-owner";
import { installKeyRouter } from "../../app/keyboard/key-router";
import { currentCanvasKeyboardPort } from "../../canvas/session";
import { detectPlatform } from "../../canvas/runtime/input/platform";
import { setShortcutPlatform } from "../../app/shell-commands/shortcut-text";
import { installDesktopKeyRouter } from "../../commands/registry";
import { presentDesktopDesignOpenFailure } from "./open-failure";
import { desktopSettingsPlatformAdapter, loadDesktopHealth } from "./settings";
import { installProblemReportPort } from "../../app/problem-report/submission";
import { desktopProblemReport } from "./problem-report";
import { capabilitiesForEdition, type RuntimeOs } from "../../generated/edition-capabilities";
import { desktopHomePort } from "./design-home";
import { createDesktopAppLifecyclePort, createDesktopSessionHomeStore, desktopDesignCorePort, desktopFileAccessPort } from "./session-ports";
import { DESKTOP_EDITION_MANIFEST } from "./manifest";
import { geocodingTransport as desktopGeocodingTransport } from "../../app/geocoding/transport.desktop";
import { t } from "../../i18n";
import { createDesktopFileDelivery } from "./file-delivery";
import { desktopDataLibraryPort } from "./library";
import { speciesCatalogWorkbench as desktopSpeciesCatalogWorkbench } from "./species-catalog";
import { installSpeciesCacheLoader } from "../../app/canvas-runtime/species-cache";
import { installGeoJsonWorkflow } from "../../app/geojson/workflow";
import { desktopGeoJsonWorkflow } from "./geojson";
import { getSpeciesBatch } from "../../ipc/species";
import { installNativeAssetUrlResolver } from "../../ipc/transport";
import { isPlantDbUnavailableError } from "../../ipc/plant-db-errors";
import { createDesktopCanvasHostRuntime } from "../../app/canvas-map-surface/desktop-workspace-runtime";
import { installAppLifetime } from "../install-app-lifetime";

const runtimeOsFromPlatform = (platform: ReturnType<typeof detectPlatform>): RuntimeOs =>
  platform.os === "mac" ? "macos" : platform.os === "windows" ? "windows" : "linux";

let disposeDesktopRoot: (() => void) | null = null;

export function bootDesktopEdition(): () => void {
  disposeDesktopRoot?.();

  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  const capabilities = capabilitiesForEdition("desktop", runtimeOsFromPlatform(platform));
  const desktopLifecycle = createDesktopAppLifecyclePort({ waitForCloseHold });
  const desktopSessionCore = createSessionCore({
    designHome: createDesktopSessionHomeStore(),
    fileAccess: desktopFileAccessPort,
    lifecycle: desktopLifecycle,
    codec: createJsonSessionCodec({
      designCore: desktopDesignCorePort,
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
    newDesignFactory: async () => {
      const created = await desktopDesignCorePort.newDesign({
        name: "Untitled",
        plant_display: null,
        created_at: new Date().toISOString(),
      });
      const normalized = normalizeLoadedDocument(created);
      if (normalized.layers.length === 0) {
        normalized.layers = NEW_DESIGN_LAYER_DEFAULTS.map((layer) => ({ ...layer }));
      }
      return normalized;
    },
  });

  const disposers: Array<() => void> = [
    installAppLifetime({
      failureStorage: "disk",
      ports: {
        capabilities,
        manifest: DESKTOP_EDITION_MANIFEST,
        settings: desktopSettingsPlatformAdapter,
        problemReport: desktopProblemReport,
        geocoding: desktopGeocodingTransport,
        fileDelivery: createDesktopFileDelivery(() => t("titleBar.untitledDesign")),
        dataLibrary: desktopDataLibraryPort,
        designHome: desktopHomePort,
        fileAccess: desktopFileAccessPort,
        appLifecycle: desktopLifecycle,
        designCore: desktopDesignCorePort,
      },
      speciesCatalog: desktopSpeciesCatalogWorkbench,
      createCanvasHostRuntime: () => createDesktopCanvasHostRuntime({ locationEnabled: capabilities.has("my-location") }),
      sessionCore: desktopSessionCore,
      openFailurePresenter: presentDesktopDesignOpenFailure,
    }),
    installNativeAssetUrlResolver(),
    installSpeciesCacheLoader({ getSpeciesBatch, isPlantDbUnavailableError }),
    installGeoJsonWorkflow(desktopGeoJsonWorkflow),
  ];
  installProblemReportPort(desktopProblemReport);
  installLidarWorkflow();
  installLidarDisplayDescriptors();
  const shellBootstrap: ShellBootstrap = bootstrapShell(desktopSettingsPlatformAdapter, loadDesktopHealth);
  setShortcutPlatform(platform);
  const keyRouter = installDesktopKeyRouter(installKeyRouter, {
    target: window,
    canvas: currentCanvasKeyboardPort,
    singleKeys: singleKeyShortcuts,
    focus: focusOwner,
    platform,
    document,
  });
  disposers.push(
    () => shellBootstrap.dispose(),
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
