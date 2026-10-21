import { installPlaceSearchSession } from "../app/geocoding/place-search-session";
import { installToolRailLearning } from "../app/tool-rail/learning";
import { installSettingsProjection } from "../app/settings/projection";
import { initTheme } from "../utils/theme";
import { registerDesignOpenFailurePresenter } from "../app/document-session/open-failure";
import { browserDesignSessionController } from "../web/browser-design-session";
import { showBrowserShellNotice } from "../web/browser-shell-notice";
import { browserAppDataStore } from "../web/browser-app-data";
import { browserDraftPersistence } from "../web/browser-draft-persistence";
import { t } from "../i18n";
import { browserSettingsPlatformAdapter } from "./settings.browser";

let disposePlatformBootstrap: (() => void) | null = null;

export function bootstrapPlatform(): void {
  disposePlatformBootstrap?.();

  const disposeTheme = initTheme();
  const settingsInstallation = installSettingsProjection(browserSettingsPlatformAdapter);
  let disposed = false;
  void settingsInstallation.ready.catch((error) => {
    if (!disposed) console.error("Failed to bootstrap settings:", error);
  });
  // Browser data from before Canopi 2.0 stays in place, unread (ADR 0021);
  // the told-once notice waits for the user's locale.
  if (browserAppDataStore.takeEarlierDataNotice(new Date().toISOString())) {
    void settingsInstallation.ready.catch(() => undefined).then(() => {
      if (disposed) return;
      showBrowserShellNotice({
        tone: "info",
        title: t("health.localDataNotOpenedTitle"),
        message: t("health.localDataNotOpened"),
      });
    });
  }
  // Whether the browser keeps Drafts is read at each launch, before the newest Draft reopens (2.1-Q82, Q190).
  let hasDrafts = false;
  try {
    hasDrafts = browserAppDataStore.listDrafts().length > 0;
  } catch (error) {
    console.error("Failed to list Design Drafts:", error);
  }
  const disposeDraftPersistence = browserDraftPersistence.start({ hasDrafts });
  // Web application lifetime: the newest Draft reopens before first render,
  // and continuous save outlives every view.
  try {
    browserDesignSessionController.restoreLatestDraft();
  } catch (error) {
    console.error("Failed to restore the latest Design Draft:", error);
  }
  const uninstallContinuousSave = browserDesignSessionController.installContinuousSave();
  registerDesignOpenFailurePresenter(showBrowserShellNotice);
  const disposePlaceSearchSession = installPlaceSearchSession();
  const disposeToolRailLearning = installToolRailLearning();

  disposePlatformBootstrap = () => {
    if (disposed) return;
    disposed = true;
    registerDesignOpenFailurePresenter(null);
    disposeToolRailLearning();
    disposePlaceSearchSession();
    uninstallContinuousSave();
    disposeDraftPersistence();
    settingsInstallation.dispose();
    disposeTheme();
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposePlatformBootstrap?.();
    disposePlatformBootstrap = null;
  });
}
