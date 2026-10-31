import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushDesign: vi.fn(),
  flushSettingsProjection: vi.fn(),
  requestSaveProblemDecision: vi.fn(),
  currentDesign: { value: {}, peek() { return this.value; } },
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("../document-session/transition", () => ({
  designContinuousSave: { flush: mocks.flushDesign, conflict: { peek: () => null } },
}));
vi.mock("../document-session/store", () => ({ currentDesign: mocks.currentDesign }));
vi.mock("../document-session/save-problem", () => ({ requestSaveProblemDecision: mocks.requestSaveProblemDecision }));
vi.mock("../settings/projection", () => ({ flushSettingsProjection: mocks.flushSettingsProjection }));

// The update's exit flush writes the edits made so far, and the native drain before the exit waits only for writes
// already sent: an edit made after the flush would wait in continuous save's delay and be lost when Canopi exits. So
// from the update's close request no Design edit is accepted, through the Windows installer's verify and write and the
// Linux restart, until Canopi exits; Cancel or a failed install or restart gives editing back. A Linux install runs
// before its close request, so edits made while it installs are kept and written before the restart. Driven through
// the real controller, close guard and modal layer; the host's update commands are the fakes.
describe("the update's exit blocks Design edits", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.flushDesign.mockReset().mockResolvedValue(true);
    mocks.flushSettingsProjection.mockReset().mockResolvedValue(undefined);
    mocks.requestSaveProblemDecision.mockReset().mockResolvedValue("cancel");
    mocks.currentDesign.value = {};
  });

  type Os = "windows" | "linux";
  const INSTALL_FAILED = { code: { kind: "update_install_failed", bundle: "nsis" }, user_may_retry: true, op: "updater.install", detail: "" };

  async function blockedDuring(platform: Os, script: { install?: "fails", restart?: "fails", flush?: "cancelled" } = {}) {
    const { blockEditsWhile, flushBeforeExit, holdCloseUntilSettled } = await import("../shell/close-guard");
    const { modalLayerOpen, registerModalInertRegion } = await import("../shell/modal-layer");
    const { createUpdateController } = await import("./controller");
    mocks.flushDesign.mockResolvedValue(script.flush !== "cancelled");
    const attributes = new Set<string>();
    const workspace = {
      toggleAttribute: (name: string, on: boolean) => { if (on) attributes.add(name); else attributes.delete(name); return on; },
      removeAttribute: (name: string) => { attributes.delete(name); },
    } as unknown as HTMLElement;
    const unregister = registerModalInertRegion(workspace);
    const blocked = () => modalLayerOpen.peek() && attributes.has("inert");
    const seen: { install?: boolean, restart?: boolean } = {};
    const updater = createUpdateController({
      updater: {
        checkForUpdate: () => Promise.resolve({ version: "2.1.0", date: "2026-11-02", notes_url: "https://example.org" }),
        downloadUpdate: () => Promise.resolve({ kind: "verified" }),
        installUpdate: () => { seen.install = blocked(); return script.install ? Promise.reject(INSTALL_FAILED) : Promise.resolve(); },
        restartAfterUpdate: () => { seen.restart = blocked(); return script.restart ? Promise.reject(new Error("no restart")) : Promise.resolve(); },
        cancelUpdate: () => Promise.resolve(),
        getLaunchCheck: () => Promise.resolve(false),
      },
      platform,
      flushBeforeExit,
      holdCloseUntilSettled,
      mintOperationId: () => "op",
      currentDesignPath: () => null,
    });
    const unbind = blockEditsWhile(updater.exiting);
    await updater.check().then(() => updater.download());
    await updater.install();
    const result = { ...seen, after: blocked(), state: updater.state.value.kind };
    unbind();
    const unbound = blocked();
    unregister();
    return { ...result, unbound };
  }

  it("no Design edit is accepted from the update's close request until Canopi exits (canopi-f47t.52.228.15)", async () => {
    expect({
      windows: await blockedDuring("windows"),
      windowsInstallerFailed: await blockedDuring("windows", { install: "fails" }),
      windowsCancelled: await blockedDuring("windows", { flush: "cancelled" }),
      linux: await blockedDuring("linux"),
      linuxRestartFailed: await blockedDuring("linux", { restart: "fails" }),
    }).toEqual({
      windows: { install: true, after: true, state: "close_requested", unbound: false },
      windowsInstallerFailed: { install: true, after: false, state: "failed", unbound: false },
      windowsCancelled: { after: false, state: "verified", unbound: false },
      linux: { install: false, restart: true, after: true, state: "close_requested", unbound: false },
      linuxRestartFailed: { install: false, restart: true, after: false, state: "installed", unbound: false },
    });
  });
});
