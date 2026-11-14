// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreId, SubsystemHealth } from "../generated/contracts";

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
  launch: vi.fn(),
  installNewerDrafts: vi.fn(),
  uninstallNewerDrafts: vi.fn(),
  listDrafts: vi.fn(),
  listedNewerDrafts: vi.fn(),
  draftListingComplete: vi.fn(),
  installContinuousSave: vi.fn(),
  uninstallContinuousSave: vi.fn(),
  installFormatCore: vi.fn(),
  uninstallFormatCore: vi.fn(),
  installPlaceSearchSession: vi.fn(),
  disposePlaceSearchSession: vi.fn(),
  installToolRailLearning: vi.fn(),
  disposeToolRailLearning: vi.fn(),
  takeEarlierDataNotice: vi.fn(),
  raiseEarlierDataNotice: vi.fn(),
  openSpeciesLists: vi.fn(),
  installLaunchFile: vi.fn(),
  disposeLaunchFile: vi.fn(),
}));

vi.mock("../app/document-session/launch-file", () => ({
  installLaunchFile: mocks.installLaunchFile,
}));

vi.mock("../web/browser-app-data", () => ({
  browserAppDataStore: { takeEarlierDataNotice: mocks.takeEarlierDataNotice, openSpeciesLists: mocks.openSpeciesLists },
}));

vi.mock("../web/browser-notices", () => ({
  raiseEarlierDataNotice: mocks.raiseEarlierDataNotice,
  presentBrowserDesignOpenFailure: vi.fn(),
}));

vi.mock("../app/tool-rail/learning", () => ({
  installToolRailLearning: mocks.installToolRailLearning,
}));

vi.mock("../web/browser-design-session", () => ({
  browserDesignSessionController: {
    launch: mocks.launch,
    installNewerDrafts: mocks.installNewerDrafts,
    listDrafts: mocks.listDrafts,
    listedNewerDrafts: mocks.listedNewerDrafts,
    draftListingComplete: mocks.draftListingComplete,
    installContinuousSave: mocks.installContinuousSave,
    installFormatCore: mocks.installFormatCore,
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
  retrySettingsLoad: async () => false,
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
    mocks.launch.mockReset().mockResolvedValue(true);
    mocks.uninstallNewerDrafts.mockReset();
    mocks.openSpeciesLists.mockReset();
    mocks.installNewerDrafts.mockReset().mockReturnValue(mocks.uninstallNewerDrafts);
    mocks.listDrafts.mockReset().mockReturnValue([{ id: "draft-1", name: "Orchard", updatedAt: "2026-10-01T00:00:00.000Z" }]);
    mocks.listedNewerDrafts.mockReset().mockReturnValue([]);
    mocks.draftListingComplete.mockReset().mockReturnValue(true);
    mocks.uninstallContinuousSave.mockReset();
    mocks.installContinuousSave.mockReset().mockReturnValue(mocks.uninstallContinuousSave);
    mocks.uninstallFormatCore.mockReset();
    mocks.installFormatCore.mockReset().mockReturnValue(mocks.uninstallFormatCore);
    mocks.disposePlaceSearchSession.mockReset();
    mocks.installPlaceSearchSession.mockReset().mockReturnValue(mocks.disposePlaceSearchSession);
    mocks.disposeToolRailLearning.mockReset();
    mocks.installToolRailLearning.mockReset().mockReturnValue(mocks.disposeToolRailLearning);
    mocks.takeEarlierDataNotice.mockReset().mockReturnValue(false);
    mocks.raiseEarlierDataNotice.mockReset();
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

    expect(mocks.launch).toHaveBeenCalledOnce();
    // canopi-f47t.52.272: 2.1's Draft store reader is the session's before the launch reads its ids (2.1-Q321, A18).
    expect(mocks.installNewerDrafts).toHaveBeenCalledOnce();
    expect(mocks.installNewerDrafts.mock.invocationCallOrder[0]).toBeLessThan(mocks.launch.mock.invocationCallOrder[0]!);
    // The species lists read 2.1's key through the reader the launch passes in (2.1-Q319, Q320).
    expect(mocks.openSpeciesLists).toHaveBeenCalledOnce();
    const { readSpeciesListRecord } = await import("../platform/browser-record");
    expect(mocks.openSpeciesLists.mock.calls[0]![0]).toBe(readSpeciesListRecord);
    expect(mocks.installContinuousSave).toHaveBeenCalledOnce();
    expect(mocks.installPlaceSearchSession).toHaveBeenCalledOnce();
    expect(mocks.installSettingsProjection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]!,
    );
    expect(mocks.launch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installContinuousSave.mock.invocationCallOrder[0]!,
    );
    // canopi-f47t.52.270: the format core is the session's before a Draft reopens, so a newer one opens read-only.
    expect(mocks.installFormatCore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]!,
    );

    bootstrapPlatform();

    expect(mocks.uninstallFormatCore).toHaveBeenCalledOnce();
    expect(mocks.uninstallNewerDrafts).toHaveBeenCalledOnce();
    expect(mocks.uninstallContinuousSave).toHaveBeenCalledOnce();
    expect(mocks.disposePlaceSearchSession).toHaveBeenCalledOnce();
    expect(mocks.installToolRailLearning).toHaveBeenCalledTimes(2);
    expect(mocks.disposeToolRailLearning).toHaveBeenCalledOnce();
    expect(mocks.installContinuousSave).toHaveBeenCalledTimes(2);
  });

  // The notice holds locale keys (failures/notices.ts), so raised at once it reads in the user's locale once it loads.
  it("tells once that browser data from before Canopi 2.0 was not opened, at launch, ahead of any later notice", async () => {
    mocks.takeEarlierDataNotice.mockReturnValue(true);
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();

    expect(mocks.takeEarlierDataNotice).toHaveBeenCalledOnce();
    expect(mocks.raiseEarlierDataNotice).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it("says nothing when no browser data from before Canopi 2.0 was found", async () => {
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.raiseEarlierDataNotice).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  // canopi-eon8.15 (S1): a release Reload from the start screen reopens no Draft (2.1-Q189), yet the stored Drafts are
  // still there, so the launch is not a first visit: the warning and Keep my drafts show, and New/Open do not ask.
  it("canopi-eon8.15: Drafts stored at launch warn and offer Keep my drafts even when none reopened", async () => {
    mocks.launch.mockResolvedValue(false);
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
    mocks.launch.mockResolvedValue(false);
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

  // The launch's 2.1 listing counts: an origin whose only Drafts are 2.1's IndexedDB ones is not a first visit (2.1-Q82,
  // Q190), so Drafts are counted once that listing settles.
  it("R3 canopi-f47t.52.272: an origin with only 2.1 Drafts warns when storage is not kept", async () => {
    let finishLaunch!: (restored: boolean) => void;
    mocks.launch.mockReturnValue(new Promise<boolean>((resolve) => { finishLaunch = resolve; }));
    mocks.listDrafts.mockReturnValue([]);
    mocks.listedNewerDrafts.mockReturnValue(null);
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) };
    Object.defineProperty(globalThis.navigator, "storage", { configurable: true, value: storage });
    try {
      const { browserDraftPersistence } = await import("../web/browser-draft-persistence");
      const { bootstrapPlatform } = await import("../platform/browser");

      bootstrapPlatform();
      mocks.listedNewerDrafts.mockReturnValue([{ id: "draft-1", name: "Orchard in 2.1", updatedAt: "2026-12-01T00:00:00.000Z" }]);
      finishLaunch(false);
      await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe("not-kept"));

      expect(browserDraftPersistence.view.value.notice, "the amber warning, not the first-visit reason").toBe("warning");
      expect(browserDraftPersistence.view.value.warn).toBe(true);
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  // With no listing completed, 2.1 may hold Drafts this launch could not see: count them, so the warning shows.
  it("R3 canopi-f47t.52.272: a launch whose 2.1 listing never completed warns as if Drafts were kept", async () => {
    mocks.listDrafts.mockReturnValue([]);
    mocks.listedNewerDrafts.mockReturnValue([]);
    mocks.draftListingComplete.mockReturnValue(false);
    Object.defineProperty(globalThis.navigator, "storage", { configurable: true, value: { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) } });
    try {
      const { browserDraftPersistence } = await import("../web/browser-draft-persistence");
      const { bootstrapPlatform } = await import("../platform/browser");

      bootstrapPlatform();
      await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe("not-kept"));
      expect(browserDraftPersistence.view.value.notice, "the amber warning, not the first-visit reason").toBe("warning");
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  it("still saves continuously when restoring the newest Draft fails", async () => {
    const error = new Error("storage unavailable");
    mocks.launch.mockRejectedValue(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bootstrapPlatform } = await import("../platform/browser");

    bootstrapPlatform();

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith("Failed to restore the latest Design Draft:", error));
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
    const health = await import("../failures/health");

    const bootstrap = bootstrapShell(settingsAdapter, getHealth);
    await bootstrap.ready;

    expect(mocks.initTheme).toHaveBeenCalledTimes(1);
    expect(mocks.installSettingsProjection).toHaveBeenCalledWith(settingsAdapter);
    expect(mocks.initTheme.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installSettingsProjection.mock.invocationCallOrder[0]!,
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("get_health");
    // The boot snapshot feeds the one health model (failures/health.ts) its readers share.
    expect(health.plantCatalogCause()).toBe("missing");
    expect(health.storeStatus("library_catalogue")).toEqual({ kind: "recovered", items: 2, generated: 1 });
    expect(health.storeHealth.value.user_db).toEqual({ status: { kind: "ready" }, notice: "moved_aside_pre_2_0" });

    bootstrap.dispose();

    expect(mocks.disposeSettings).toHaveBeenCalledOnce();
    expect(mocks.disposeTheme).toHaveBeenCalledOnce();
  });

  it("canopi-f47t.52.36: a dismissed one-time store notice stays dismissed after the shell bootstraps again in the same app run", async () => {
    // The host's health outlives the page: a reload (location.reload) asks the same native process again.
    const host: SubsystemHealth = { user_db: { status: { kind: "ready" }, notice: "moved_aside_pre_2_0" } };
    mocks.invoke.mockImplementation(async (command: string, args?: { store: StoreId }) => {
      if (command === "get_health") return structuredClone(host);
      if (command === "dismiss_store_notice" && args) {
        host[args.store] = { ...host[args.store]!, notice: null };
        return null;
      }
      throw new Error(`unexpected command ${command}`);
    });
    // The Desktop root's wiring: its store notices with the host's dismissal, then the shell's boot snapshot.
    const boot = async () => {
      const { bootstrapShell } = await import("../app/shell/bootstrap");
      const { dismissStoreNoticeOnHost, getHealth } = await import("../ipc/health");
      const { installStoreNotices } = await import("../components/workspace/store-notices");
      const queue = await import("../failures/notices");
      const disposeNotices = installStoreNotices({ report: null, updatesInAbout: true, dismissOnHost: dismissStoreNoticeOnHost });
      const shell = bootstrapShell({ load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) }, getHealth);
      await shell.ready;
      return { queue, dispose: () => { disposeNotices(); shell.dispose(); } };
    };

    const first = await boot();
    const [told] = first.queue.notices.value;
    expect(told?.message).toBe("health.localDataNotOpened");
    first.queue.dismissNotice(told!.id);
    await vi.waitFor(() => expect(host.user_db?.notice).toBeNull());
    first.dispose();

    // Reload after dismissing the pre-2.0 notice: fresh modules, the same host; it is not shown again.
    vi.resetModules();
    const second = await boot();
    expect(second.queue.notices.value).toEqual([]);
    const { storeHealth } = await import("../failures/health");
    expect(storeHealth.value.user_db).toEqual({ status: { kind: "ready" }, notice: null });
    second.dispose();
  });

  it("get_health rejects -> every store opening, one sink entry", async () => {
    mocks.invoke.mockRejectedValue("the health snapshot is unavailable");
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");
    const { storeHealth, storeStatus } = await import("../failures/health");
    const { ringEntries } = await import("../failures/ring");

    const bootstrap = bootstrapShell({ load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) }, getHealth);
    await expect(bootstrap.ready).resolves.toBeUndefined();

    // Nothing reported a store, so each still opens: never ready.
    expect(storeHealth.value).toEqual({});
    for (const store of ["plant_catalog", "user_db", "settings", "library_catalogue"] as const) {
      expect(storeStatus(store)).toEqual({ kind: "opening" });
    }
    // The transport's settlement is the one entry; the shell's report of the same rejection adds none.
    expect(ringEntries().map((entry) => [entry.source, entry.code.kind])).toEqual([["ipc.get_health", "internal"]]);
    bootstrap.dispose();
  });

  it("leaves a settings load failure to the settings projection's one report without rejecting shell readiness", async () => {
    const error = new Error("settings unavailable");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reportFailure } = await import("../failures/report");
    const { ringEntries } = await import("../failures/ring");
    // The projection reports its own load failure (SET-05, 2.1-Q67), as the real one does through the sink. The
    // rejected promise is made when bootstrap installs the projection, so it is never left without a handler while
    // the module import awaits (an unhandled rejection under some shuffle seeds).
    mocks.installSettingsProjection.mockImplementation(() => {
      reportFailure(error, { shown: "none", source: "settings.load" });
      return { ready: Promise.reject(error), dispose: mocks.disposeSettings };
    });
    const { bootstrapShell } = await import("../app/shell/bootstrap");
    const { getHealth } = await import("../ipc/health");

    const bootstrap = bootstrapShell({
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    }, getHealth);

    await expect(bootstrap.ready).resolves.toBeUndefined();
    // The shell starts on defaults and adds no second report of its own: one entry, the projection's, no console line.
    expect(ringEntries().map((entry) => entry.source)).toEqual(["settings.load"]);
    expect(logError).not.toHaveBeenCalled();
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

    // The one health model (failures/health.ts) is left untouched: every store still opening.
    const { storeHealth, storeStatus } = await import("../failures/health");
    expect(storeHealth.value).toEqual({});
    expect(storeStatus("plant_catalog")).toEqual({ kind: "opening" });
    expect(storeStatus("library_catalogue")).toEqual({ kind: "opening" });
  });
});
