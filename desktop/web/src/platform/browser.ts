import { installPlaceSearchSession } from "../app/geocoding/place-search-session";
import { installToolRailLearning } from "../app/tool-rail/learning";
import { installSettingsProjection } from "../app/settings/projection";
import { initTheme } from "../utils/theme";
import { registerDesignOpenFailurePresenter } from "../app/document-session/open-failure";
import { browserDesignSessionController } from "../web/browser-design-session";
import { presentBrowserDesignOpenFailure, raiseEarlierDataNotice } from "../web/browser-notices";
import { browserAppDataStore } from "../web/browser-app-data";
import { browserDraftPersistence } from "../web/browser-draft-persistence";
import { browserReleaseWatch } from "../web/browser-release-watch";
import { browserSettingsPlatformAdapter } from "./settings.browser";
import { readSpeciesListRecord } from "./browser-record";
import { createDesignCore } from "./design-core";
import { createDraftRecordsReader } from "./draft-records.browser";
import { installFailureHooks, reportFailure } from "../failures/report";

let disposePlatformBootstrap: (() => void) | null = null;

export function bootstrapPlatform(): void {
  disposePlatformBootstrap?.();

  // The window error hooks first, so a failure while the rest bootstraps reaches the ring (ADR 0025).
  const disposeFailureHooks = installFailureHooks({ storage: "device" }, window);
  const disposeTheme = initTheme();
  const settingsInstallation = installSettingsProjection(browserSettingsPlatformAdapter);
  let disposed = false;
  void settingsInstallation.ready.catch((error) => {
    if (!disposed) console.error("Failed to bootstrap settings:", error);
  });
  // Browser data from before Canopi 2.0 stays in place, unread (ADR 0021);
  // the told-once notice is raised at once, ahead of any later notice, and reads in the user's locale once it loads.
  if (browserAppDataStore.takeEarlierDataNotice(new Date().toISOString())) raiseEarlierDataNotice();
  // Species lists a newer Canopi saved, or damaged ones, say so once at launch rather than at the first list (2.1-Q319).
  browserAppDataStore.openSpeciesLists(readSpeciesListRecord);
  // Web application lifetime: the newest Draft reopens before first render,
  // and continuous save outlives every view.
  // "Drafts at launch" is whether Drafts are stored, not whether one reopened: a release Reload from the start
  // screen reopens none (2.1-Q189), yet its unkept Drafts still warn (canopi-eon8.15, 2.1-M181).
  // The format core reads a Design a newer Canopi saved, read-only (2.1-M478); its worker starts on the first such open.
  const uninstallFormatCore = browserDesignSessionController.installFormatCore(createDesignCore());
  // 2.1's Drafts after a rollback, read-only (2.1-Q321, Q322): the launch reads their ids before it restores, and a
  // version change from a 2.1 tab closes the read and offers Reload (2.1-Q40, design check A18).
  const uninstallNewerDrafts = browserDesignSessionController.installNewerDrafts(createDraftRecordsReader({
    onVersionChange: () => browserReleaseWatch.storeChanged(),
    report: (error) => reportFailure(error, { shown: "none", source: "web-drafts.read" }),
  }));
  void browserDesignSessionController.launch().catch((error: unknown) => {
    if (!disposed) console.error("Failed to restore the latest Design Draft:", error);
  });
  // Whether the browser keeps Drafts is read at each launch; stored Drafts not kept warn at once (2.1-Q82, Q190).
  const hasDrafts = browserDesignSessionController.listDrafts().length > 0;
  const disposeDraftPersistence = browserDraftPersistence.start({ hasDrafts });
  const uninstallContinuousSave = browserDesignSessionController.installContinuousSave();
  // A deploy while this tab is open: the manifest names another release and the shell offers Reload (2.1-Q83, M179).
  const stopReleaseWatch = browserReleaseWatch.start();
  registerDesignOpenFailurePresenter(presentBrowserDesignOpenFailure);
  const disposePlaceSearchSession = installPlaceSearchSession();
  const disposeToolRailLearning = installToolRailLearning();

  disposePlatformBootstrap = () => {
    if (disposed) return;
    disposed = true;
    registerDesignOpenFailurePresenter(null);
    disposeToolRailLearning();
    disposePlaceSearchSession();
    stopReleaseWatch();
    uninstallContinuousSave();
    uninstallNewerDrafts();
    uninstallFormatCore();
    disposeDraftPersistence();
    settingsInstallation.dispose();
    disposeTheme();
    disposeFailureHooks();
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposePlatformBootstrap?.();
    disposePlatformBootstrap = null;
  });
}
