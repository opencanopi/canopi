import "./styles/global.css";
import styles from "./App.module.css";
import { TitleBar } from "./components/shared/TitleBar";
import { DegradedBanner } from "./components/shared/DegradedBanner";
import { CommandPalette } from "./components/shared/CommandPalette";
import { AboutCanopiDialog, AboutUpdates } from "./components/shared/AboutCanopiDialog";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { NoticeRow } from "./components/shared/NoticeRow";
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
import { useEffect, useState } from "preact/hooks";
import { effect } from "@preact/signals";
import { dismissMultiOpenNotice, multiOpenNotice } from "./app/document-session/launch-file";
import { openAboutCanopiDialog } from "./app/about/state";
import { dismissNotice, notices, raiseNotice } from "./failures/notices";
import { createUpdateController, type UpdateController, type UpdaterPort } from "./app/updates/controller";
import { blockEditsWhile, closeWaitsFor, flushBeforeExit, holdCloseUntilSettled } from "./app/shell/close-guard";
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
 * start screen is interactive (after the first paint), and its notices on the one notice row (2.1-Q290): the launch
 * check's available update (2.1-Q164, M211), which stays until dismissed or installed this session and, since the
 * launch check runs once per launch and nothing is stored, shows again at the next launch until installed (2.1-Q293);
 * and the Windows next-launch "Update not installed" (2.1-Q234). Notices take no focus; only the user's action moves it.
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
  // An installed update leaves nothing to offer.
  useEffect(() => effect(() => {
    if (controller.state.value.kind === "installed") withdrawNotice(UPDATE_AVAILABLE);
  }), [controller]);
  useEffect(() => {
    void controller.launchCheck();
    ports.takeLaunchNotice().then((failed) => {
      if (failed) raiseNotice({ key: "update.not-installed", message: "update.failure.notInstalledPlain", tone: "warning" });
    }, () => {
      // The marker could not be read: there is nothing to say at this launch.
    });
  }, [controller, ports]);
  // Settings › About's "Check for updates at launch": its own key row through the host (2.1-M206).
  const [launchCheck] = useState<LaunchCheckPort>(() => ({ get: ports.updater.getLaunchCheck, set: ports.setLaunchCheck }));
  return { controller, launchCheck };
}

const UPDATE_AVAILABLE = "update.available";
const UPDATE_CLOSING = "update.closing";

function raiseUpdateNotice(offer: UpdateOffer): void {
  raiseNotice({
    key: UPDATE_AVAILABLE,
    message: "update.available",
    params: { version: offer.version },
    action: { label: "about.title", run: openAboutCanopiDialog },
  });
}

/** Removes the notice queued under `key`, if it still waits. */
function withdrawNotice(key: string): void {
  const queued = notices.peek().find((notice) => notice.key === key);
  if (queued) dismissNotice(queued.id);
}

export function App({ updates: ports }: { readonly updates: DesktopUpdatePorts }) {
  const updates = useDesktopUpdates(ports);
  useEffect(raiseLaunchNotices, []);
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
      <NoticeRow />
    </div>
  );
}

/**
 * The launch notices on the one notice row, each kept until dismissed (2.1-Q290): "Canopi opens one Design at a time"
 * when a launch named several files (2.1-Q228), and "Installing update…" or "Finishing update…" while a window close
 * waits for an update's install or exit (Q254), withdrawn once it settles. Returns the dispose.
 */
function raiseLaunchNotices(): () => void {
  const multiOpen = effect(() => {
    if (multiOpenNotice.value === null) return;
    raiseNotice({
      key: "launch.multi-open",
      message: "launch.oneDesignAtATime",
      onDismiss: () => {
        const id = multiOpenNotice.peek();
        if (id !== null) dismissMultiOpenNotice(id);
      },
    });
  });
  const closing = effect(() => {
    const waitsFor = closeWaitsFor.value;
    withdrawNotice(UPDATE_CLOSING);
    if (waitsFor !== null) raiseNotice({ key: UPDATE_CLOSING, message: waitsFor === "install" ? "update.installing" : "update.finishing" });
  });
  return () => {
    multiOpen();
    closing();
  };
}

function DesktopKeyboardShortcuts() {
  if (!keyboardShortcutsDialogOpen.value) return null;
  // WebKitGTK delivers no trackpad pinch, so Linux gets the note.
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  return <KeyboardShortcutsDialog menus={appCommandGraphChromeProjection.value.menus} platform={platform} linuxPinchNote={platform.os === "linux"} />;
}
