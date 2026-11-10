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
import { installFailureHooks } from "../failures/report";

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
  // Web application lifetime: the newest Draft reopens before first render,
  // and continuous save outlives every view.
  // "Drafts at launch" is whether Drafts are stored, not whether one reopened: a release Reload from the start
  // screen reopens none (2.1-Q189), yet its unkept Drafts still warn (canopi-eon8.15, 2.1-M181).
  let hasDrafts: boolean;
  try {
    browserDesignSessionController.restoreLatestDraft();
    hasDrafts = browserDesignSessionController.listDrafts().length > 0;
  } catch (error) {
    hasDrafts = true;
    console.error("Failed to restore the latest Design Draft:", error);
  }
  // Whether the browser keeps Drafts is read at each launch; stored Drafts not kept warn at once (2.1-Q82, Q190).
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
