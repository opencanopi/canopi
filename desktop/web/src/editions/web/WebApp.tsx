import type { ComponentChildren } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { activePanel, sidePanel } from "../../app/shell/state";
import { keyboardShortcutsDialogOpen } from "../../app/shell/dialogs";
import { workspaceCanvasCommandProjection } from "../../app/workspace-commands/canvas-actions";
import { designSessionStore } from "../../app/document-session/store";
import styles from "./WebApp.module.css";
import { BrowserAppShell } from "./BrowserAppShell";
import type { BrowserDesignShellCommands, BrowserShellCatalog, WebShellShortcutSource } from "./browser-shell-commands";
import {
  createBrowserShellCapabilities,
  createBrowserShellCatalog,
  browserPhoneSheetTabs,
  createBrowserShellCommandProjection,
} from "./browser-shell-commands";
import { browserDraftPersistence, type BrowserDraftPersistence } from "../../web/browser-draft-persistence";
import { browserReleaseWatch } from "./browser-release-watch";
import { installReleaseNotice } from "../../web/browser-notices";
import { WorkspaceDialogs } from "../../components/workspace/WorkspaceComposition";
import { SaveProblemDialog } from "../../components/shared/SaveProblemDialog";
import { SettingsDialog } from "../../components/shared/SettingsDialog";
import { KeyboardShortcutsDialog } from "../../components/shared/KeyboardShortcutsDialog";
import { detectPlatform } from "../../canvas/runtime/input/platform";
import { AboutCanopiDialog } from "../../components/shared/AboutCanopiDialog";
import { WebWorkspace } from "./WebWorkspace";
import { createBrowserGeoJsonWorkflow } from "./browser-geojson";
import { currentCanvasSession } from "../../canvas/session";
import type { GeoJsonWorkflow } from "../../app/geojson/workflow";
import {
  createWebShellCommands,
  designRevertAvailable,
  readWebDesignIdentity,
  reloadWebForRelease,
  resolveDesignConflict,
  retryDesignSave,
  setDesignName,
} from "./web-session";

interface WebAppProps {
  readonly commands?: BrowserDesignShellCommands;
  readonly workspace?: ComponentChildren;
  readonly geoJson?: GeoJsonWorkflow;
  /** The catalog the entry's keyboard shortcuts use; built here when absent. */
  readonly catalog?: BrowserShellCatalog;
  /** Whether the browser keeps Drafts (2.1-Q82). */
  readonly persistence?: Pick<BrowserDraftPersistence, "view" | "keep" | "showReason">;
}

/** Build the Web Edition command catalog backed by the live Session Core. */
export function createWebAppCatalog(
  commands: BrowserDesignShellCommands = createWebShellCommands(),
  geoJson: GeoJsonWorkflow = createBrowserGeoJsonWorkflow(),
): BrowserShellCatalog {
  return createBrowserShellCatalog(
    createBrowserShellCapabilities(commands, logWebAppCommandError, geoJson),
    {
      canvasReady: () => designSessionStore.hasCurrentDesign() && currentCanvasSession.peek() !== null,
    },
  );
}

/** What the Web keyboard shortcuts need to run shell commands against the live state. */
export function createWebShellShortcutSource(catalog: BrowserShellCatalog): WebShellShortcutSource {
  return {
    catalog,
    readState: () => ({
      hasDesign: designSessionStore.hasCurrentDesign(),
      revertAvailable: designRevertAvailable.peek(),
      activePanel: activePanel.peek(),
      sidePanel: sidePanel.peek(),
    }),
  };
}

export function WebApp({
  commands,
  workspace,
  geoJson,
  catalog,
  persistence = browserDraftPersistence,
}: WebAppProps) {
  const hasDesign = designSessionStore.currentDesign.value !== null;
  const designIdentity = readWebDesignIdentity();
  const shellCatalog = useMemo(
    () => catalog ?? createWebAppCatalog(commands ?? createWebShellCommands(), geoJson ?? createBrowserGeoJsonWorkflow()),
    [catalog, commands, geoJson],
  );
  const commandProjection = createBrowserShellCommandProjection({
    catalog: shellCatalog,
    state: {
      hasDesign,
      revertAvailable: designRevertAvailable.value,
      activePanel: activePanel.value,
      sidePanel: sidePanel.value,
    },
    canvas: workspaceCanvasCommandProjection.value,
  });

  useEffect(() => installReleaseNotice({
    waiting: browserReleaseWatch.notice,
    designOpen: () => designSessionStore.currentDesign.value !== null,
    reload: () => reloadWebForRelease(),
    dismiss: () => browserReleaseWatch.dismiss(),
    onError: logWebAppCommandError,
  }), []);

  return (
    <div className={styles.root} data-canopi-web-root>
      <BrowserAppShell
        commandProjection={commandProjection}
        designIdentity={designIdentity}
        onRenameDesign={(name) => setDesignName(name)}
        onRetrySave={() => {
          void retryDesignSave().catch(logWebAppCommandError);
        }}
        onResolveSaveConflict={() => {
          void resolveDesignConflict().catch(logWebAppCommandError);
        }}
        placeSearch={hasDesign}
        persistence={persistence}
        undo={hasDesign ? workspaceCanvasCommandProjection.value.historyActions.find((action) => action.id === "undo") : undefined}
      >
        {workspace ?? (
          <WebWorkspace
            panelProjection={commandProjection.panelBar}
            phoneTabs={browserPhoneSheetTabs(commandProjection.panelBar)}
          />
        )}
      </BrowserAppShell>
      <WorkspaceDialogs />
      <SaveProblemDialog />
      <SettingsDialog />
      {keyboardShortcutsDialogOpen.value && (
        <KeyboardShortcutsDialog
          menus={commandProjection.workspaceMenus}
          platform={detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown })}
          linuxPinchNote={false}
        />
      )}
      <AboutCanopiDialog />
    </div>
  );
}

function logWebAppCommandError(error: unknown): void {
  console.error("Browser Web App command failed:", error);
}
