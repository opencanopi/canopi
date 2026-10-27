import "./styles/global.css";
import styles from "./App.module.css";
import { TitleBar } from "./components/shared/TitleBar";
import { DegradedBanner } from "./components/shared/DegradedBanner";
import { CommandPalette } from "./components/shared/CommandPalette";
import { AboutCanopiDialog } from "./components/shared/AboutCanopiDialog";
import { SaveProblemDialog } from "./components/shared/SaveProblemDialog";
import { ProblemReportDialog } from "./components/shared/ProblemReportDialog";
import { SettingsDialog, type SettingsFoldersAdapter } from "./components/shared/SettingsDialog";
import { KeyboardShortcutsDialog } from "./components/shared/KeyboardShortcutsDialog";
import { detectPlatform } from "./canvas/runtime/input/platform";
import { DesktopPanelRail } from "./components/panels/DesktopPanelRail";
import { DesktopWorkspace } from "./components/workspace/DesktopWorkspace";
import { WorkspaceDialogs } from "./components/workspace/WorkspaceComposition";
import { keyboardShortcutsDialogOpen } from "./app/shell/dialogs";
import { appCommandGraphChromeProjection } from "./commands/registry";
import { getAppFolders, showAppFolder } from "./ipc/settings";
import { useRef } from "preact/hooks";
import { Toast } from "./components/shared/Toast";
import { useMapOccluder } from "./components/shared/useMapChrome";
import { dismissMultiOpenNotice, multiOpenNotice } from "./app/document-session/launch-file";
import { t } from "./i18n";

/** Settings › Files and data on Desktop: the app-data folders and Show in folder. */
const DESKTOP_FOLDERS: SettingsFoldersAdapter = { load: getAppFolders, show: showAppFolder };

export function App() {
  return (
    <div className={styles.appRoot}>
      <DesktopWorkspace />
      <TitleBar />
      <DesktopPanelRail />
      <DegradedBanner />
      <CommandPalette />
      <WorkspaceDialogs />
      <SettingsDialog folders={DESKTOP_FOLDERS} />
      <DesktopKeyboardShortcuts />
      <AboutCanopiDialog />
      <SaveProblemDialog />
      <ProblemReportDialog />
      <MultiOpenNotice />
    </div>
  );
}

/**
 * "Canopi opens one Design at a time" when a launch named several files (2.1-Q228): a toast that takes no focus, as
 * status chrome on the visible-map-area seam (`frames: false`), so it never moves the camera's framing.
 */
function MultiOpenNotice() {
  const id = multiOpenNotice.value;
  const slot = useRef<HTMLDivElement>(null);
  useMapOccluder(slot, "bottom", id !== null, { frames: false });
  if (id === null) return null;
  return (
    <div ref={slot} className={styles.launchNotice} data-multi-open-notice="">
      <Toast key={id} icon="info" message={t("launch.oneDesignAtATime")} onDismiss={() => dismissMultiOpenNotice(id)} />
    </div>
  );
}

function DesktopKeyboardShortcuts() {
  if (!keyboardShortcutsDialogOpen.value) return null;
  // WebKitGTK delivers no trackpad pinch, so Linux gets the note.
  const platform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown });
  return <KeyboardShortcutsDialog menus={appCommandGraphChromeProjection.value.menus} platform={platform} linuxPinchNote={platform.os === "linux"} />;
}
