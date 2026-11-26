import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Failure } from "../generated/contracts";
import type { CanopiFile } from "../types/design";
import {
  answerSaveProblem,
  saveProblem,
  type SaveProblemChoice,
  type SaveProblemRequest,
} from "../app/document-session/save-problem";
import { flushBeforeExit, registerCloseGuard, type CloseGuardLifetime } from "../app/shell/close-guard";
import {
  createTestSessionCore,
  type TestSessionCoreHandle,
} from "./support/session-core-fixture";

const WRITE_FAILURE: Failure = {
  code: { kind: "io", detail: "other" },
  user_may_retry: true,
  op: "design.write",
  operation: null,
  detail: null,
} as unknown as Failure;

function sampleDesign(name = "Orchard"): CanopiFile {
  return {
    version: 10,
    name,
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

async function waitForProblem(): Promise<SaveProblemRequest> {
  await vi.waitFor(() => {
    expect(saveProblem.value).not.toBeNull();
  });
  return saveProblem.value!;
}

async function answerNext(choice: SaveProblemChoice): Promise<SaveProblemRequest> {
  const req = await waitForProblem();
  answerSaveProblem(choice);
  return req;
}

describe("registerCloseGuard", () => {
  let handle: TestSessionCoreHandle | null = null;
  let guard: CloseGuardLifetime | null = null;

  beforeEach(() => {
    handle = null;
    guard = null;
  });

  afterEach(() => {
    guard?.dispose();
    guard = null;
    if (saveProblem.peek()) answerSaveProblem("cancel");
    handle?.dispose();
    handle = null;
  });

  it("cleans up the previous guard when re-registering and prompts once per question", async () => {
    const flushSettings = vi.fn(async () => { throw new Error("busy"); });
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    const g1 = registerCloseGuard();
    guard = registerCloseGuard();
    g1.dispose();

    const closing = handle.core.close("close");
    const asked = await answerNext("cancel");
    expect(asked).toEqual({ kind: "settings-failed", designSaved: true });
    expect(await closing).toBe("cancelled");
    expect(handle.lifecycle.destroyedCount()).toBe(0);
  });

  it("prevents a clean close until settings finish flushing, then destroys the window", async () => {
    let resolveFlush!: () => void;
    const flushSettings = vi.fn(() => new Promise<void>((resolve) => { resolveFlush = resolve; }));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    handle.core.document("rename", () => ({ name: "Updated" }));
    const writeSpy = vi.spyOn(handle.home, "write");

    const closePromise = handle.core.close("quit");
    await vi.waitFor(() => expect(flushSettings).toHaveBeenCalledTimes(1));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(saveProblem.value).toBeNull();
    expect(handle.lifecycle.destroyedCount()).toBe(0);

    resolveFlush();
    expect(await closePromise).toBe("closed");
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("canopi-eon8.14.1: an unsaveable settings store flushes the Design, then offers Retry and Close anyway", async () => {
    const order: string[] = [];
    const flushSettings = vi.fn(async () => {
      order.push("settings");
      throw new Error("settings unavailable");
    });
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();
    const origWrite = handle.home.write.bind(handle.home);
    vi.spyOn(handle.home, "write").mockImplementation(async (...args) => {
      order.push("design");
      return origWrite(...args);
    });

    handle.core.document("rename", () => ({ name: "SavedBeforeSettings" }));
    const closePromise = handle.core.close("quit");
    const asked = await answerNext("discard");
    expect(await closePromise).toBe("closed");

    expect(order).toEqual(["design", "settings"]);
    expect(asked).toEqual({ kind: "settings-failed", designSaved: true });
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("canopi-eon8.14.1: settings Retry asks again while it fails and closes once it succeeds", async () => {
    const flushSettings = vi.fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    const closePromise = handle.core.close("quit");
    await answerNext("retry");
    await answerNext("retry");
    expect(await closePromise).toBe("closed");

    expect(flushSettings).toHaveBeenCalledTimes(3);
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("canopi-eon8.14.1: Cancel or Escape on the settings dialog keeps the window open", async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error("busy"));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    const closePromise = handle.core.close("quit");
    const asked = await answerNext("cancel");
    expect(await closePromise).toBe("cancelled");

    expect(asked).toEqual({ kind: "settings-failed", designSaved: true });
    expect(handle.core.state.value.kind).toBe("open");
    expect(handle.lifecycle.destroyedCount()).toBe(0);
  });

  it("canopi-eon8.14.1: a Design closed without saving, then unsaveable settings, asks twice in order", async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error("busy"));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    handle.core.document("rename", () => ({ name: "Unsaveable" }));
    handle.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });

    const closePromise = handle.core.close("quit");
    const first = await answerNext("discard");
    const second = await answerNext("discard");
    expect(await closePromise).toBe("closed");

    expect([first, second]).toEqual([
      { kind: "flush-failed", purpose: "close", conflict: false },
      { kind: "settings-failed", designSaved: false },
    ]);
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("canopi-eon8.14.1: disposing the guard while the settings dialog is open never answers or destroys", async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error("busy"));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    void handle.core.close("quit");
    await waitForProblem();
    guard.dispose();
    guard = null;
    answerSaveProblem("discard");
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.lifecycle.destroyedCount()).toBe(0);
  });

  it("writes the Design to its home before destroying the window, without asking", async () => {
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "CleanClose" }));
    const writeSpy = vi.spyOn(handle.home, "write");

    handle.lifecycle.emit({ kind: "close-requested" });
    await vi.waitFor(() => expect(handle!.lifecycle.destroyedCount()).toBe(1));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(saveProblem.value).toBeNull();
  });

  it("asks once when the write fails and retries on request", async () => {
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "RetryMe" }));
    handle.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });

    const closePromise = handle.core.close("quit");
    const asked = await waitForProblem();
    expect(asked).toEqual({ kind: "flush-failed", purpose: "close", conflict: false });

    handle.home.setWriteResult(null);
    answerSaveProblem("retry");
    expect(await closePromise).toBe("closed");
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("closes without saving when the user chooses to", async () => {
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "DiscardMe" }));
    handle.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });

    const closePromise = handle.core.close("quit");
    await answerNext("discard");
    expect(await closePromise).toBe("closed");
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("canopi-f47t.52.248: after a cancelled close, the next close request runs the close workflow again", async () => {
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "CancelThenClose" }));
    handle.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });

    const firstClose = handle.core.close("quit");
    await answerNext("cancel");
    expect(await firstClose).toBe("cancelled");
    expect(handle.lifecycle.destroyedCount()).toBe(0);

    const secondClose = handle.core.close("quit");
    await answerNext("discard");
    expect(await secondClose).toBe("closed");
    expect(handle.lifecycle.destroyedCount()).toBe(1);
  });

  it("writes the Design when the window loses focus", async () => {
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi" });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "FocusSaved" }));
    const writeSpy = vi.spyOn(handle.home, "write");

    await handle.core.handleLifecycle({ kind: "focus-lost" });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(handle.core.dirty.value).toBe(false);
  });
});

describe("flushBeforeExit", () => {
  let handle: TestSessionCoreHandle | null = null;
  let guard: CloseGuardLifetime | null = null;

  afterEach(() => {
    guard?.dispose();
    guard = null;
    if (saveProblem.peek()) answerSaveProblem("cancel");
    handle?.dispose();
    handle = null;
  });

  it("before an update it writes the Design, then the settings, and proceeds without asking or closing the window", async () => {
    const order: string[] = [];
    const flushSettings = vi.fn(async () => { order.push("settings"); });
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();
    const origWrite = handle.home.write.bind(handle.home);
    vi.spyOn(handle.home, "write").mockImplementation(async (...args) => {
      order.push("design");
      return origWrite(...args);
    });
    handle.core.document("rename", () => ({ name: "BeforeUpdate" }));

    await expect(flushBeforeExit("update")).resolves.toBe("proceed");

    expect(order).toEqual(["design", "settings"]);
    expect(saveProblem.value).toBeNull();
    expect(handle.lifecycle.destroyedCount()).toBe(0);
  });

  it("a failed Design write before an update offers Retry, Close without saving or Cancel, and Cancel keeps Canopi open", async () => {
    const flushSettings = vi.fn(async () => {});
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();
    handle.core.document("rename", () => ({ name: "FailUpdate" }));
    handle.home.setWriteResult({ kind: "failed", failure: WRITE_FAILURE });

    const pending = flushBeforeExit("update");
    const asked = await answerNext("cancel");

    await expect(pending).resolves.toBe("cancel");
    expect(asked).toEqual({ kind: "flush-failed", purpose: "close", conflict: false });
    expect(flushSettings).not.toHaveBeenCalled();
  });

  it("a failed settings write before an update offers Retry, Close anyway or Cancel; Cancel keeps Canopi open", async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error("settings unavailable"));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    const pending = flushBeforeExit("update");
    const first = await answerNext("retry");
    const second = await answerNext("cancel");

    await expect(pending).resolves.toBe("cancel");
    expect(flushSettings).toHaveBeenCalledTimes(2);
    expect([first, second]).toEqual([
      { kind: "settings-failed", designSaved: true },
      { kind: "settings-failed", designSaved: true },
    ]);
  });

  it("Close anyway after a failed settings write lets the update go on without destroying the window", async () => {
    const flushSettings = vi.fn().mockRejectedValue(new Error("settings unavailable"));
    handle = createTestSessionCore({ file: sampleDesign(), path: "/orchard.canopi", flushSettings });
    guard = registerCloseGuard();

    const pending = flushBeforeExit("update");
    await answerNext("discard");

    await expect(pending).resolves.toBe("proceed");
    expect(handle.lifecycle.destroyedCount()).toBe(0);
  });
});
