import "./styles/global.css";
import styles from "./App.module.css";
import { TitleBar } from "./components/shared/TitleBar";
import { CommandPalette } from "./components/shared/CommandPalette";
import { AboutCanopiDialog, AboutUpdates } from "./components/shared/AboutCanopiDialog";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { NoticeRow } from "./components/shared/NoticeRow";
import { ProblemReportDialog, openProblemReport } from "./components/shared/ProblemReportDialog";
import { LaunchCheckSwitch, SettingsDialog, type LaunchCheckPort, type SettingsFoldersAdapter } from "./components/shared/SettingsDialog";
import { KeyboardShortcutsDialog } from "./components/shared/KeyboardShortcutsDialog";
import { detectPlatform } from "./canvas/runtime/input/platform";
import { DesktopPanelRail } from "./components/panels/DesktopPanelRail";
import { DesktopWorkspace } from "./components/workspace/DesktopWorkspace";
import { WorkspaceDialogs } from "./components/workspace/WorkspaceComposition";
import { keyboardShortcutsDialogOpen } from "./app/shell/dialogs";
import { appCommandGraphChromeProjection } from "./commands/registry";
import { getAppFolders, showAppFolder } from "./ipc/settings";
import { useEffect, useState } from "preact/hooks";
import { raiseLaunchNotices, raiseUpdateNotice, raiseUpdateNotInstalledNotice, withdrawUpdateNoticeOnInstall } from "./components/workspace/launch-notices";
import { installStoreNotices } from "./components/workspace/store-notices";
import { createUpdateController, type UpdateController, type UpdaterPort } from "./app/updates/controller";
import { blockEditsWhile, flushBeforeExit, holdCloseUntilSettled } from "./app/shell/close-guard";
import { designPath } from "./app/document-session/store";
import type { UpdateOs } from "./generated/contracts";
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
 * start screen is interactive (after the first paint), and its notices on the one notice row (launch-notices.ts).
 */
function useDesktopUpdates(ports: DesktopUpdatePorts): { readonly controller: UpdateController; readonly launchCheck: LaunchCheckPort } {
  const [controller] = useState(() => createUpdateController({
    updater: ports.updater,
    platform: updateOs(),
    flushBeforeExit,
    holdCloseUntilSettled,
    mintOperationId: ports.mintOperationId,
    currentDesignPath: () => designPath.peek(),
    onUpdateAvailable: raiseUpdateNotice,
  }));
  // No Design edit is accepted from the update's close request until Canopi exits: the exit flush has run.
  useEffect(() => blockEditsWhile(controller.exiting), [controller]);
  useEffect(() => withdrawUpdateNoticeOnInstall(controller), [controller]);
  useEffect(() => {
    void controller.launchCheck();
    ports.takeLaunchNotice().then((failed) => {
      if (failed) raiseUpdateNotInstalledNotice();
    }, () => {
      // The marker could not be read: there is nothing to say at this launch.
    });
  }, [controller, ports]);
  // Settings › About's "Check for updates at launch": its own key row through the host (2.1-M206).
  const [launchCheck] = useState<LaunchCheckPort>(() => ({ get: ports.updater.getLaunchCheck, set: ports.setLaunchCheck }));
  return { controller, launchCheck };
}

/** The Desktop root boundary's Reload: the exit flush first, as a window close runs it, then the reload on proceed. */
export function reloadAfterExitFlush(): void {
  void flushBeforeExit("close").then((answer) => {
    if (answer === "proceed") location.reload();
  });
}

export function App({ updates: ports }: { readonly updates: DesktopUpdatePorts }) {
  const updates = useDesktopUpdates(ports);
  useEffect(raiseLaunchNotices, []);
  // Report a problem opens the problem report; Update opens About, where the update installs.
  useEffect(() => installStoreNotices({ report: openProblemReport, updatesInAbout: true }), []);
  return (
    <div className={styles.appRoot}>
      <DesktopWorkspace />
      <TitleBar />
      <DesktopPanelRail />
      <CommandPalette />
      <WorkspaceDialogs />
      <SettingsDialog folders={DESKTOP_FOLDERS} updates={<LaunchCheckSwitch port={updates.launchCheck} />} />
      <DesktopKeyboardShortcuts />
      <AboutCanopiDialog updates={<AboutUpdates controller={updates.controller} downloadPage={updaterEndpoints.download_page} />} />
      <SaveProblemDialog />
      <ProblemReportDialog />
      <NoticeRow />
    </div>
  );
}

function DesktopKeyboardShortcuts() {
  if (!keyboardShortcutsDialogOpen.value) return null;
  // WebKitGTK delivers no trackpad pinch, so Linux gets the note.
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  return <KeyboardShortcutsDialog menus={appCommandGraphChromeProjection.value.menus} platform={platform} linuxPinchNote={platform.os === "linux"} />;
}
