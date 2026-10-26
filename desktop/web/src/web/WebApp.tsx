import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { activePanel, sidePanel } from "../app/shell/state";
import { keyboardShortcutsDialogOpen } from "../app/shell/dialogs";
import { workspaceCanvasCommandProjection } from "../app/workspace-commands/canvas-actions";
import styles from "./WebApp.module.css";
import { BrowserAppShell } from "./BrowserAppShell";
import type { BrowserShellCatalog, WebShellShortcutSource } from "./browser-shell-commands";
import {
  createBrowserShellCapabilities,
  createBrowserShellCatalog,
  browserPhoneSheetTabs,
  createBrowserShellCommandProjection,
} from "./browser-shell-commands";
import {
  browserDesignSessionController,
  type BrowserDesignSessionController,
} from "./browser-design-session";
import { browserDraftPersistence, type BrowserDraftPersistence } from "./browser-draft-persistence";
import { browserReleaseWatch } from "./browser-release-watch";
import { hasConfiguredStaticDesignTemplates } from "../app/community/catalog.browser";
import { WorkspaceDialogs } from "../components/workspace/WorkspaceComposition";
import { SaveProblemDialog } from "../components/shared/SaveProblemDialog";
import { SettingsDialog } from "../components/shared/SettingsDialog";
import { KeyboardShortcutsDialog } from "../components/shared/KeyboardShortcutsDialog";
import { detectPlatform } from "../canvas/runtime/input/platform";
import { AboutCanopiDialog } from "../components/shared/AboutCanopiDialog";
import { WebWorkspace } from "./WebWorkspace";
import { createBrowserGeoJsonWorkflow } from "./browser-geojson";
import { currentCanvasSession } from "../canvas/session";
import type { GeoJsonWorkflow } from "../app/geojson/workflow";

interface WebAppProps {
  readonly controller?: BrowserDesignSessionController;
  readonly templatesEnabled?: boolean;
  readonly workspace?: ComponentChildren;
  readonly geoJson?: GeoJsonWorkflow;
  /** The catalog the entry's keyboard shortcuts use; built here when absent. */
  readonly catalog?: BrowserShellCatalog;
  /** Whether the browser keeps Drafts (2.1-Q82). */
  readonly persistence?: Pick<BrowserDraftPersistence, "view" | "keep" | "showReason">;
}

/** Build the Web Edition command catalog for a controller and its GeoJSON workflow. */
export function createWebAppCatalog(
  controller: BrowserDesignSessionController = browserDesignSessionController,
  geoJson: GeoJsonWorkflow = createBrowserGeoJsonWorkflow(),
  templatesEnabled: boolean = hasConfiguredStaticDesignTemplates(),
): BrowserShellCatalog {
  return createBrowserShellCatalog(
    createBrowserShellCapabilities(controller, logWebAppCommandError, geoJson),
    {
      templatesEnabled,
      canvasReady: () => controller.hasCurrentDesign() && currentCanvasSession.peek() !== null,
    },
  );
}

/** What the Web keyboard shortcuts need to run shell commands against the live state. */
export function createWebShellShortcutSource(
  catalog: BrowserShellCatalog,
  controller: BrowserDesignSessionController = browserDesignSessionController,
): WebShellShortcutSource {
  return {
    catalog,
    readState: () => ({
      hasDesign: controller.hasCurrentDesign(),
      revertAvailable: controller.continuousSave.revertAvailable.peek(),
      activePanel: activePanel.peek(),
      sidePanel: sidePanel.peek(),
    }),
  }
}

export function WebApp({
  controller = browserDesignSessionController,
  templatesEnabled = hasConfiguredStaticDesignTemplates(),
  workspace,
  geoJson,
  catalog,
  persistence = browserDraftPersistence,
}: WebAppProps) {
  const hasDesign = controller.hasCurrentDesign();
  const designIdentity = controller.readDesignIdentity();
  const shellCatalog = useMemo(
    () => catalog ?? createWebAppCatalog(controller, geoJson ?? createBrowserGeoJsonWorkflow(), templatesEnabled),
    [catalog, controller, geoJson, templatesEnabled],
  );
  const commandProjection = createBrowserShellCommandProjection({
    catalog: shellCatalog,
    state: {
      hasDesign,
      revertAvailable: controller.continuousSave.revertAvailable.value,
      activePanel: activePanel.value,
      sidePanel: sidePanel.value,
    },
    canvas: workspaceCanvasCommandProjection.value,
  });

  // Reload saves first: Saving… until the session reloads the page, or the user cancels its save problem (M179).
  const [reloading, setReloading] = useState(false);
  const releaseNotice = browserReleaseWatch.notice.value ? {
    reloading,
    onReload: () => {
      setReloading(true);
      void controller.reloadForRelease().then((reloaded) => {
        if (reloaded) return;
        setReloading(false);
      }, (error: unknown) => {
        setReloading(false);
        logWebAppCommandError(error);
      });
    },
    onDismiss: () => browserReleaseWatch.dismiss(),
  } : null;

  return (
    <div className={styles.root} data-canopi-web-root>
      <BrowserAppShell
        commandProjection={commandProjection}
        designIdentity={designIdentity}
        onRenameDesign={(name) => controller.renameDesign(name)}
        onRetrySave={() => {
          void controller.continuousSave.save().catch(logWebAppCommandError);
        }}
        onResolveSaveConflict={() => {
          void controller.resolveSaveConflict().catch(logWebAppCommandError);
        }}
        placeSearch={hasDesign}
        persistence={persistence}
        release={releaseNotice}
        undo={hasDesign ? workspaceCanvasCommandProjection.value.historyActions.find((action) => action.id === "undo") : undefined}
      >
        {workspace ?? (
          <WebWorkspace
            controller={controller}
            panelProjection={commandProjection.panelBar}
            phoneTabs={browserPhoneSheetTabs(commandProjection.panelBar)}
            templatesEnabled={templatesEnabled}
          />
        )}
      </BrowserAppShell>
      <WorkspaceDialogs />
      <SaveProblemDialog />
      <SettingsDialog />
      {keyboardShortcutsDialogOpen.value && (
        // Browsers on Linux deliver a trackpad pinch as Ctrl + wheel: no Linux note.
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
