// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubsystemHealth } from "../generated/contracts";

const mocks = vi.hoisted(() => ({
  disposeCloseGuard: vi.fn(),
  disposeSettings: vi.fn(),
  disposeTheme: vi.fn(),
  installDesktopKeyRouter: vi.fn(),
  disposeKeyRouter: vi.fn(),
  initTheme: vi.fn(),
  installSettingsProjection: vi.fn(),
  invoke: vi.fn(),
  registerCloseGuard: vi.fn(),
  browserSettingsAdapter: {
    load: vi.fn(),
    save: vi.fn(),
  },
  desktopSettingsAdapter: {
    load: vi.fn(),
    save: vi.fn(),
  },
  restoreLatestDraft: vi.fn(),
  listDrafts: vi.fn(),
  installContinuousSave: vi.fn(),
  uninstallContinuousSave: vi.fn(),
  installPlaceSearchSession: vi.fn(),
  disposePlaceSearchSession: vi.fn(),
  installToolRailLearning: vi.fn(),
  disposeToolRailLearning: vi.fn(),
  takeEarlierDataNotice: vi.fn(),
  showBrowserShellNotice: vi.fn(),
  installLaunchFile: vi.fn(),
  disposeLaunchFile: vi.fn(),
}));

vi.mock("../app/document-session/launch-file", () => ({
  installLaunchFile: mocks.installLaunchFile,
}));

vi.mock("../web/browser-app-data", () => ({
  browserAppDataStore: { takeEarlierDataNotice: mocks.takeEarlierDataNotice },
}));

vi.mock("../web/browser-shell-notice", () => ({
  showBrowserShellNotice: mocks.showBrowserShellNotice,
}));

vi.mock("../app/tool-rail/learning", () => ({
  installToolRailLearning: mocks.installToolRailLearning,
}));

vi.mock("../web/browser-design-session", () => ({
  browserDesignSessionController: {
    restoreLatestDraft: mocks.restoreLatestDraft,
    listDrafts: mocks.listDrafts,
    installContinuousSave: mocks.installContinuousSave,
  },
}));

vi.mock("../app/geocoding/place-search-session", () => ({
  installPlaceSearchSession: mocks.installPlaceSearchSession,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../commands/registry", () => ({
  installDesktopKeyRouter: mocks.installDesktopKeyRouter,
}));

vi.mock("../utils/theme", () => ({
  initTheme: mocks.initTheme,
}));

vi.mock("../app/settings/projection", () => ({
  installSettingsProjection: mocks.installSettingsProjection,
}));

vi.mock("../app/shell/close-guard", () => ({
  registerCloseGuard: mocks.registerCloseGuard,
}));

vi.mock("../platform/settings.browser", () => ({
  browserSettingsPlatformAdapter: mocks.browserSettingsAdapter,
}));

vi.mock("../platform/settings.desktop", () => ({
  desktopSettingsPlatformAdapter: mocks.desktopSettingsAdapter,
  // The real health query, through the mocked @tauri-apps/api/core invoke.
  loadDesktopHealth: async () => (await import("../ipc/health")).getHealth(),
}));

describe("settings platform bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.disposeCloseGuard.mockReset();
    mocks.disposeSettings.mockReset();
    mocks.disposeTheme.mockReset();
    mocks.disposeKeyRouter.mockReset();
    mocks.installDesktopKeyRouter.mockReset().mockReturnValue({ dispose: mocks.disposeKeyRouter });
    mocks.initTheme.mockReset().mockReturnValue(mocks.disposeTheme);
    mocks.installSettingsProjection.mockReset().mockReturnValue({
      ready: Promise.resolve(),
      dispose: mocks.disposeSettings,
    });
    mocks.invoke.mockReset().mockResolvedValue({
      plant_catalog: { status: { kind: "unavailable", code: { kind: "plant_db_unavailable", cause: "missing" } }, notice: null },
      library_catalogue: { status: { kind: "recovered", items: 2, generated: 1 }, notice: null },
      user_db: { status: { kind: "ready" }, notice: "moved_aside_pre_2_0" },
    });
    mocks.registerCloseGuard.mockReset().mockReturnValue({
      dispose: mocks.disposeCloseGuard,
    });
    mocks.restoreLatestDraft.mockReset().mockReturnValue(true);
    mocks.listDrafts.mockReset().mockReturnValue([{ id: "draft-1", name: "Orchard", updatedAt: "2026-10-01T00:00:00.000Z" }]);
    mocks.uninstallContinuousSave.mockReset();
    mocks.installContinuousSave.mockReset().mockReturnValue(mocks.uninstallContinuousSave);
    mocks.disposePlaceSearchSession.mockReset();
    mocks.installPlaceSearchSession.mockReset().mockReturnValue(mocks.disposePlaceSearchSession);
    mocks.disposeToolRailLearning.mockReset();
    mocks.installToolRailLearning.mockReset().mockReturnValue(mocks.disposeToolRailLearning);
    mocks.takeEarlierDataNotice.mockReset().mockReturnValue(false);
    mocks.showBrowserShellNotice.mockReset();
    mocks.disposeLaunchFile.mockReset();
    mocks.installLaunchFile.mockReset().mockReturnValue(mocks.disposeLaunchFile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces the Browser settings and theme lifecycle on repeated bootstrap", async () => {
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();
    bootstrapPlatform();

    expect(mocks.initTheme).toHaveBeenCalledTimes(2);
    expect(mocks.installSettingsProjection).toHaveBeenCalledTimes(2);
    expect(mocks.installSettingsProjection).toHaveBeenNthCalledWith(
      1,
      mocks.browserSettingsAdapter,
    );
    expect(mocks.initTheme.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installSettingsProjection.mock.invocationCallOrder[0]!,
    );
    expect(mocks.disposeSettings).toHaveBeenCalledOnce();
    expect(mocks.disposeTheme).toHaveBeenCalledOnce();
  });

  it("owns the Web Design Session lifetime: restores the newest Draft, then saves continuously", async () => {
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();

    expect(mocks.restoreLatestDraft).toHaveBeenCalledOnce();
    expect(mocks.installContinuousSave).toHaveBeenCalledOnce();
    expect(mocks.installPlaceSearchSession).toHaveBeenCalledOnce();
    expect(mocks.installSettingsProjection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restoreLatestDraft.mock.invocationCallOrder[0]!,
    );
    expect(mocks.restoreLatestDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installContinuousSave.mock.invocationCallOrder[0]!,
    );

    bootstrapPlatform();

    expect(mocks.uninstallContinuousSave).toHaveBeenCalledOnce();
    expect(mocks.disposePlaceSearchSession).toHaveBeenCalledOnce();
    expect(mocks.installToolRailLearning).toHaveBeenCalledTimes(2);
    expect(mocks.disposeToolRailLearning).toHaveBeenCalledOnce();
    expect(mocks.installContinuousSave).toHaveBeenCalledTimes(2);
  });

  it("tells once that browser data from before Canopi 2.0 was not opened, once the locale is known", async () => {
    mocks.takeEarlierDataNotice.mockReturnValue(true);
    const { t } = await import("../i18n");
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();
    expect(mocks.showBrowserShellNotice).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.takeEarlierDataNotice).toHaveBeenCalledOnce();
    expect(mocks.showBrowserShellNotice).toHaveBeenCalledOnce();
    expect(mocks.showBrowserShellNotice).toHaveBeenCalledWith({
      tone: "info",
      title: t("health.localDataNotOpenedTitle"),
      message: t("health.localDataNotOpened"),
    });
    expect(t("health.localDataNotOpenedTitle")).toBe("Earlier data not opened");
    expect(t("health.localDataNotOpened")).toBe(
      "Canopi 2.0 can’t open data saved by earlier versions. It was left unchanged, and Canopi started fresh.",
    );
    expect(mocks.restoreLatestDraft).toHaveBeenCalledOnce();
  });

  it("says nothing when no browser data from before Canopi 2.0 was found", async () => {
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.showBrowserShellNotice).not.toHaveBeenCalled();
    expect(mocks.restoreLatestDraft).toHaveBeenCalledOnce();
  });

  // canopi-eon8.15 (S1): a release Reload from the start screen reopens no Draft (2.1-Q189), yet the stored Drafts are
  // still there, so the launch is not a first visit: the warning and Keep my drafts show, and New/Open do not ask.
  it("canopi-eon8.15: Drafts stored at launch warn and offer Keep my drafts even when none reopened", async () => {
    mocks.restoreLatestDraft.mockReturnValue(false);
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) };
    Object.defineProperty(globalThis.navigator, "storage", { configurable: true, value: storage });
    try {
      const { browserDraftPersistence, canKeepDrafts } = await import("../web/browser-draft-persistence");
      const { bootstrapPlatform } = await import("../platform/browser");

      bootstrapPlatform();
      await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe("not-kept"));

      expect(browserDraftPersistence.view.value.notice, "the amber warning, not the first-visit reason").toBe("warning");
      expect(browserDraftPersistence.view.value.warn).toBe(true);
      expect(canKeepDrafts(browserDraftPersistence.view.value), "Keep my drafts is offered").toBe(true);
      const stopReason = browserDraftPersistence.showReason();
      browserDraftPersistence.requestOnce();
      stopReason();
      expect(storage.persist, "New and Open do not ask a user with Drafts").not.toHaveBeenCalled();
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  it("canopi-eon8.15: a launch with no stored Draft is a first visit", async () => {
    mocks.restoreLatestDraft.mockReturnValue(false);
    mocks.listDrafts.mockReturnValue([]);
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) };
    Object.defineProperty(globalThis.navigator, "storage", { configurable: true, value: storage });
    try {
      const { browserDraftPersistence, canKeepDrafts } = await import("../web/browser-draft-persistence");
      const { bootstrapPlatform } = await import("../platform/browser");

      bootstrapPlatform();
      await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe("not-kept"));

      expect(browserDraftPersistence.view.value.notice).toBe("reason");
      expect(canKeepDrafts(browserDraftPersistence.view.value)).toBe(false);
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  it("still saves continuously when restoring the newest Draft fails", async () => {
    const error = new Error("storage unavailable");
    mocks.restoreLatestDraft.mockImplementation(() => {
      throw error;
    });
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();

    expect(logError).toHaveBeenCalledWith("Failed to restore the latest Design Draft:", error);
    expect(mocks.installContinuousSave).toHaveBeenCalledOnce();
  });

  it("does not report a Browser settings failure from a replaced bootstrap", async () => {
    let rejectFirstLoad!: (error: unknown) => void;
    const firstReady = new Promise<void>((_resolve, reject) => {
      rejectFirstLoad = reject;
    });
    mocks.installSettingsProjection
      .mockReturnValueOnce({ ready: firstReady, dispose: mocks.disposeSettings })
      .mockReturnValueOnce({ ready: Promise.resolve(), dispose: mocks.disposeSettings });
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();
    bootstrapPlatform();
    rejectFirstLoad(new Error("obsolete settings load"));
    await Promise.resolve();

    expect(logError).not.toHaveBeenCalled();
  });

  for (const edition of ["desktop", "browser"] as const) {
    it(`bootstrapPlatform installs the failure hooks once; dispose or HMR removes them (${edition}, canopi-f47t.52.36)`, async () => {
      const platform = await import(`../platform/${edition}.ts`) as { bootstrapPlatform(): void };
      const ring = await import("../failures/ring");
      ring.resetFrontendDiagnosticsForTests();
      platform.bootstrapPlatform();
      platform.bootstrapPlatform();
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("first fault"), message: "first fault" }));
      expect(ring.ringEntries().filter((entry) => entry.source === "window.error")).toHaveLength(1);

      // A hot reload brings fresh module copies: the new install removes the old copy's listeners.
      vi.resetModules();
      const reloaded = await import(`../platform/${edition}.ts`) as { bootstrapPlatform(): void };
      const reloadedRing = await import("../failures/ring");
      reloaded.bootstrapPlatform();
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("second fault"), message: "second fault" }));
      expect(ring.ringEntries().filter((entry) => entry.source === "window.error")).toHaveLength(1);
      expect(reloadedRing.ringEntries().filter((entry) => entry.source === "window.error")).toHaveLength(1);

      // Disposing the install leaves no listener behind.
      const { installFailureHooks } = await import("../failures/report");
      installFailureHooks({ storage: "disk" }, window)();
      // A bare error event, which only a hook of ours would record ("Uncaught error").
      window.dispatchEvent(new Event("error"));
      expect(reloadedRing.ringEntries().filter((entry) => entry.source === "window.error")).toHaveLength(1);
    });
  }

  it("replaces the Desktop shell lifecycle while preserving the close guard", async () => {
    const { bootstrapPlatform } = await import("../platform/desktop");
    const { installKeyRouter } = await import("../app/keyboard/key-router");
    const { subscribePendingOpen, takePendingOpen } = await import("../ipc/launch");

    bootstrapPlatform();
    bootstrapPlatform();

    // The one Desktop key router: replaced with the rest of the platform lifetime.
    expect(mocks.installDesktopKeyRouter).toHaveBeenCalledTimes(2);
    expect(mocks.installDesktopKeyRouter).toHaveBeenLastCalledWith(installKeyRouter, expect.objectContaining({ target: window }));
    expect(mocks.disposeKeyRouter).toHaveBeenCalledOnce();

    expect(mocks.installSettingsProjection).toHaveBeenCalledTimes(2);
    expect(mocks.installSettingsProjection).toHaveBeenNthCalledWith(
      1,
      mocks.desktopSettingsAdapter,
    );
    expect(mocks.registerCloseGuard).toHaveBeenCalledTimes(2);
    expect(mocks.disposeCloseGuard).toHaveBeenCalledOnce();
    expect(mocks.installPlaceSearchSession).toHaveBeenCalledTimes(2);
    expect(mocks.disposePlaceSearchSession).toHaveBeenCalledOnce();
    expect(mocks.installToolRailLearning).toHaveBeenCalledTimes(2);
    expect(mocks.disposeToolRailLearning).toHaveBeenCalledOnce();
    // The Design file a launch names (2.1-M214): read from the launch IPC, replaced with the platform lifetime.
    expect(mocks.installLaunchFile).toHaveBeenCalledTimes(2);
    expect(mocks.installLaunchFile).toHaveBeenLastCalledWith({ take: takePendingOpen, subscribe: subscribePendingOpen });
    expect(mocks.disposeLaunchFile).toHaveBeenCalledOnce();
    expect(mocks.disposeSettings).toHaveBeenCalledOnce();
    expect(mocks.disposeTheme).toHaveBeenCalledOnce();
  });

  it("boots shell services and delegates settings lifecycle", async () => {
    const settingsAdapter = {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");
    const healthState = await import("../app/health/state");

    const bootstrap = bootstrapShell(settingsAdapter, getHealth);
    await bootstrap.ready;

    expect(mocks.initTheme).toHaveBeenCalledTimes(1);
    expect(mocks.installSettingsProjection).toHaveBeenCalledWith(settingsAdapter);
    expect(mocks.initTheme.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installSettingsProjection.mock.invocationCallOrder[0]!,
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("get_health");
    expect(healthState.plantDbStatus.value).toBe("missing");
    expect(healthState.lidarLibraryStatus.value).toEqual({ kind: "recovered", items: 2, generated: 1 });
    expect(healthState.localDataStatus.value).toEqual({ kind: "moved_aside" });

    bootstrap.dispose();

    expect(mocks.disposeSettings).toHaveBeenCalledOnce();
    expect(mocks.disposeTheme).toHaveBeenCalledOnce();
  });

  it("reports a settings load failure without rejecting shell readiness", async () => {
    const error = new Error("settings unavailable");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    // The rejected promise is made when bootstrap installs the projection, so it is never left without a handler
    // while the module import awaits (an unhandled rejection under some shuffle seeds).
    mocks.installSettingsProjection.mockImplementation(() => ({
      ready: Promise.reject(error),
      dispose: mocks.disposeSettings,
    }));
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");

    const bootstrap = bootstrapShell({
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    }, getHealth);

    await expect(bootstrap.ready).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("Failed to bootstrap settings:", error);
    bootstrap.dispose();
  });

  it("disposes one shell lifetime at most once", async () => {
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");
    const bootstrap = bootstrapShell({
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    }, getHealth);

    bootstrap.dispose();
    bootstrap.dispose();

    expect(mocks.disposeSettings).toHaveBeenCalledOnce();
    expect(mocks.disposeTheme).toHaveBeenCalledOnce();
  });

  it("ignores health returned after its shell lifetime is disposed", async () => {
    let resolveHealth!: (health: SubsystemHealth) => void;
    mocks.invoke.mockReturnValue(new Promise((resolve) => {
      resolveHealth = resolve;
    }));
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");
    const { lidarLibraryStatus, plantDbStatus } = await import("../app/health/state");
    plantDbStatus.value = "available";
    lidarLibraryStatus.value = { kind: "ready" };
    const bootstrap = bootstrapShell({
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    }, getHealth);

    bootstrap.dispose();
    resolveHealth({
      plant_catalog: { status: { kind: "unavailable", code: { kind: "plant_db_unavailable", cause: "missing" } }, notice: null },
      library_catalogue: { status: { kind: "unavailable", code: { kind: "library_read_only", reason: "unavailable" } }, notice: null },
    });
    await bootstrap.ready;

    expect(plantDbStatus.value).toBe("available");
    expect(lidarLibraryStatus.value).toEqual({ kind: "ready" });
  });
});
