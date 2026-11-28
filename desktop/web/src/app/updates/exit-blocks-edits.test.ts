import { afterEach, describe, expect, it, vi } from "vitest";
import type { Failure } from "../../generated/contracts";
import type { CanopiFile } from "../../types/design";
import { createTestSessionCore } from "../../__tests__/support/session-core-fixture";
import { answerSaveProblem, saveProblem } from "../document-session/save-problem";
import { blockEditsWhile, flushBeforeExit, holdCloseUntilSettled, registerCloseGuard } from "../shell/close-guard";
import { modalLayerOpen, registerModalInertRegion } from "../shell/modal-layer";
import { createUpdateController } from "./controller";

const WRITE_FAILURE: Failure = {
  code: { kind: "io", detail: "other" },
  user_may_retry: true,
  op: "design.write",
  operation: null,
  detail: null,
} as unknown as Failure;

function sampleDesign(): CanopiFile {
  return {
    version: 9,
    name: "Orchard",
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: "EUR",
    views: [],
    stories: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    extra: {},
  };
}

// The update's exit flush writes the edits made so far, and the native drain before the exit waits only for writes
// already sent: an edit made after the flush would wait in continuous save's delay and be lost when Canopi exits. So
// from the update's close request no Design edit is accepted, through the Windows installer's verify and write and the
// Linux restart, until Canopi exits; Cancel or a failed install or restart gives editing back. A Linux install runs
// before its close request, so edits made while it installs are kept and written before the restart. Driven through
// the real SessionCore, controller, close guard and modal layer; the host's update commands are the fakes.
describe("the update's exit blocks Design edits", () => {
  afterEach(() => {
    if (saveProblem.peek()) answerSaveProblem("cancel");
  });

  type Os = "windows" | "linux";
  const INSTALL_FAILED = { code: { kind: "update_install_failed", bundle: "nsis" }, user_may_retry: true, op: "updater.install", detail: "" };

  async function blockedDuring(platform: Os, script: { install?: "fails", restart?: "fails", flush?: "cancelled" } = {}) {
    const session = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    const guard = registerCloseGuard();
    if (script.flush === "cancelled") {
      session.core.document("rename", () => ({ name: "Unsaved" }));
      session.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });
    }

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
    });
    const unbind = blockEditsWhile(updater.exiting);
    try {
      await updater.check().then(() => updater.download());
      const installing = updater.install();
      if (script.flush === "cancelled") {
        await vi.waitFor(() => expect(saveProblem.value).not.toBeNull());
        answerSaveProblem("cancel");
      }
      await installing;
      const result = { ...seen, after: blocked(), state: updater.state.value.kind };
      unbind();
      const unbound = blocked();
      return { ...result, unbound };
    } finally {
      unbind();
      unregister();
      guard.dispose();
      session.dispose();
    }
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
