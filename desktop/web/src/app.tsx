import "./styles/global.css";
import styles from "./App.module.css";
import { TitleBar } from "./components/shared/TitleBar";
import { DegradedBanner } from "./components/shared/DegradedBanner";
import { CommandPalette } from "./components/shared/CommandPalette";
import { AboutCanopiDialog, AboutUpdates, UpdateAvailableNotice } from "./components/shared/AboutCanopiDialog";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { LaunchCheckSwitch, SettingsDialog, type LaunchCheckPort, type SettingsFoldersAdapter } from "./components/shared/SettingsDialog";
import { KeyboardShortcutsDialog } from "./components/shared/KeyboardShortcutsDialog";
import { detectPlatform } from "./canvas/runtime/input/platform";
import { DesktopPanelRail } from "./components/panels/DesktopPanelRail";
import { DesktopWorkspace } from "./components/workspace/DesktopWorkspace";
import { WorkspaceDialogs } from "./components/workspace/WorkspaceComposition";
import { keyboardShortcutsDialogOpen } from "./app/shell/dialogs";
import { appCommandGraphChromeProjection } from "./commands/registry";
import { getAppFolders, showAppFolder } from "./ipc/settings";
import { useEffect, useRef, useState } from "preact/hooks";
import { Toast } from "./components/shared/Toast";
import { useMapOccluder } from "./components/shared/useMapChrome";
import { dismissMultiOpenNotice, multiOpenNotice } from "./app/document-session/launch-file";
import { t } from "./i18n";
import { createUpdateController, type UpdateController, type UpdaterPort } from "./app/updates/controller";
import { flushBeforeExit } from "./app/shell/close-guard";
import { designPath } from "./app/document-session/store";
import type { UpdateOffer, UpdateOs } from "./generated/contracts";
import updaterEndpoints from "../../updater-endpoints.json";

/** Settings › Files and data on Desktop: the app-data folders and Show in folder. */
const DESKTOP_FOLDERS: SettingsFoldersAdapter = { load: getAppFolders, show: showAppFolder };

/** The Desktop updater's host ports, which the Desktop root passes in (platform/updates.desktop.ts). */
export interface DesktopUpdatePorts {
  readonly updater: UpdaterPort;
  /** Writes the launch-check key row, `updater.check_at_launch` (2.1-M206). */
  readonly setLaunchCheck: (on: boolean) => Promise<void>;
  /** Whether this launch follows a Windows update that did not install: true once (2.1-Q234). */
  readonly takeLaunchNotice: () => Promise<boolean>;
  readonly mintOperationId: () => string;
}

/** The updater's platform: Windows saves before its installer quits Canopi; Linux installs first (2.1-Q233). */
function updateOs(): UpdateOs {
  const { os } = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  if (os === "windows") return "windows";
  return os === "mac" ? "darwin" : "linux";
}

/**
 * The Desktop updater (contracts §3): one controller over the host's update commands, its launch check once the
 * start screen is interactive (after the first paint), the one available-update notice (2.1-Q164, M211) and the
 * Windows next-launch "Update not installed" (2.1-Q234). Notices take no focus; only the user's action moves it.
 */
function useDesktopUpdates(ports: DesktopUpdatePorts): { readonly controller: UpdateController; readonly launchCheck: LaunchCheckPort; readonly offer: UpdateOffer | null; readonly failedLastLaunch: boolean; dismissOffer(): void; dismissFailure(): void } {
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [failedLastLaunch, setFailedLastLaunch] = useState(false);
  const [controller] = useState(() => createUpdateController({
    updater: ports.updater,
    platform: updateOs(),
    flushBeforeExit,
    mintOperationId: ports.mintOperationId,
    currentDesignPath: () => designPath.peek(),
    onUpdateAvailable: setOffer,
  }));
  useEffect(() => {
    void controller.launchCheck();
    ports.takeLaunchNotice().then(setFailedLastLaunch, () => {
      // The marker could not be read: there is nothing to say at this launch.
    });
  }, [controller, ports]);
  // Settings › About's "Check for updates at launch": its own key row through the host (2.1-M206).
  const [launchCheck] = useState<LaunchCheckPort>(() => ({ get: ports.updater.getLaunchCheck, set: ports.setLaunchCheck }));
  return { controller, launchCheck, offer, failedLastLaunch, dismissOffer: () => setOffer(null), dismissFailure: () => setFailedLastLaunch(false) };
}

export function App({ updates: ports }: { readonly updates: DesktopUpdatePorts }) {
  const updates = useDesktopUpdates(ports);
  return (
    <div className={styles.appRoot}>
      <DesktopWorkspace />
      <TitleBar />
      <DesktopPanelRail />
      <DegradedBanner />
      <CommandPalette />
      <WorkspaceDialogs />
      <SettingsDialog folders={DESKTOP_FOLDERS} updates={<LaunchCheckSwitch port={updates.launchCheck} />} />
      <DesktopKeyboardShortcuts />
      <AboutCanopiDialog updates={<AboutUpdates controller={updates.controller} downloadPage={updaterEndpoints.download_page} />} />
      <SaveProblemDialog />
      <ProblemReportDialog />
      <LaunchNotices updates={updates} />
    </div>
  );
}

/**
 * The launch notices, toasts that take no focus, as status chrome on the visible-map-area seam (`frames: false`), so
 * they never move the camera's framing: "Canopi opens one Design at a time" when a launch named several files
 * (2.1-Q228), the launch check's available update (M211) and a Windows update that did not install (Q234).
 */
function LaunchNotices({ updates }: { readonly updates: ReturnType<typeof useDesktopUpdates> }) {
  const id = multiOpenNotice.value;
  const slot = useRef<HTMLDivElement>(null);
  const shown = id !== null || updates.offer !== null || updates.failedLastLaunch;
  useMapOccluder(slot, "bottom", shown, { frames: false });
  if (!shown) return null;
  return (
    <div ref={slot} className={styles.launchNotice}>
      {id !== null && (
        <div data-multi-open-notice="">
          <Toast key={id} icon="info" message={t("launch.oneDesignAtATime")} onDismiss={() => dismissMultiOpenNotice(id)} />
        </div>
      )}
      {updates.failedLastLaunch && (
        <div data-update-failed-notice="">
          <Toast icon="info" message={t("update.failure.notInstalledPlain")} onDismiss={updates.dismissFailure} />
        </div>
      )}
      {updates.offer !== null && (
        <UpdateAvailableNotice key={updates.offer.version} version={updates.offer.version} onDismiss={updates.dismissOffer} />
      )}
    </div>
  );
}

function DesktopKeyboardShortcuts() {
  if (!keyboardShortcutsDialogOpen.value) return null;
  // WebKitGTK delivers no trackpad pinch, so Linux gets the note.
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  return <KeyboardShortcutsDialog menus={appCommandGraphChromeProjection.value.menus} platform={platform} linuxPinchNote={platform.os === "linux"} />;
}
