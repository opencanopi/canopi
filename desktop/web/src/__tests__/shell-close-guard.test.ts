import { signal } from "@preact/signals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  flushDesign: vi.fn(),
  flushSettingsProjection: vi.fn(),
  getCurrentWindow: vi.fn(),
  onCloseRequested: vi.fn(),
  onFocusChanged: vi.fn(),
  requestSaveProblemDecision: vi.fn(),
  unlistenA: vi.fn(),
  unlistenB: vi.fn(),
  unlistenFocus: vi.fn(),
  currentDesign: { value: {} as object | null, peek() { return this.value; } },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}));

vi.mock("../app/document-session/transition", () => ({
  designContinuousSave: {
    flush: mocks.flushDesign,
    conflict: signal(null),
  },
}));

vi.mock("../app/document-session/store", () => ({
  currentDesign: mocks.currentDesign,
}));

vi.mock("../app/document-session/save-problem", () => ({
  requestSaveProblemDecision: mocks.requestSaveProblemDecision,
}));

vi.mock("../app/settings/projection", () => ({
  flushSettingsProjection: mocks.flushSettingsProjection,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
type FocusHandler = (event: { payload: boolean }) => void;

describe("registerCloseGuard", () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.destroy.mockReset();
    mocks.flushDesign.mockReset().mockResolvedValue(true);
    mocks.flushSettingsProjection.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentWindow.mockReset();
    mocks.onCloseRequested.mockReset();
    mocks.onFocusChanged.mockReset().mockResolvedValue(mocks.unlistenFocus);
    mocks.requestSaveProblemDecision.mockReset();
    mocks.unlistenA.mockReset();
    mocks.unlistenB.mockReset();
    mocks.unlistenFocus.mockReset();
    mocks.currentDesign.value = {};
    mocks.getCurrentWindow.mockReturnValue({
      onCloseRequested: mocks.onCloseRequested,
      onFocusChanged: mocks.onFocusChanged,
      destroy: mocks.destroy,
    });
    mocks.onCloseRequested
      .mockResolvedValueOnce(mocks.unlistenA)
      .mockResolvedValueOnce(mocks.unlistenB);
  });

  it("cleans up the previous listener when re-registering", async () => {
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    registerCloseGuard();
    await flushMicrotasks();
    registerCloseGuard();
    await flushMicrotasks();

    expect(mocks.onCloseRequested).toHaveBeenCalledTimes(2);
    expect(mocks.unlistenA).toHaveBeenCalledTimes(1);
  });

  it("disposes stale async listeners when register is called twice before the first promise settles", async () => {
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    registerCloseGuard();
    registerCloseGuard();
    await flushMicrotasks();

    expect(mocks.onCloseRequested).toHaveBeenCalledTimes(2);
    expect(mocks.unlistenA).toHaveBeenCalledTimes(1);
  });

  it("disposes a listener that settles after its close-guard lifetime ends", async () => {
    let resolveRegistration!: (unlisten: () => void) => void;
    mocks.onCloseRequested.mockReset().mockReturnValue(new Promise<() => void>((resolve) => {
      resolveRegistration = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    const lifetime = registerCloseGuard();
    lifetime.dispose();
    resolveRegistration(mocks.unlistenA);
    await flushMicrotasks();

    expect(mocks.unlistenA).toHaveBeenCalledTimes(1);
  });

  it("disposes a settled close-guard listener at most once", async () => {
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    const lifetime = registerCloseGuard();
    await flushMicrotasks();
    lifetime.dispose();
    lifetime.dispose();

    expect(mocks.unlistenA).toHaveBeenCalledTimes(1);
  });

  it("does not report a listener registration failure after its lifetime ends", async () => {
    let rejectRegistration!: (error: unknown) => void;
    mocks.onCloseRequested.mockReset().mockReturnValue(new Promise<() => void>((_resolve, reject) => {
      rejectRegistration = reject;
    }));
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    const lifetime = registerCloseGuard();
    lifetime.dispose();
    rejectRegistration(new Error("obsolete registration"));
    await flushMicrotasks();

    expect(logError).not.toHaveBeenCalled();
    logError.mockRestore();
  });

  it("reports a listener registration failure for the active lifetime", async () => {
    const error = new Error("listener unavailable");
    mocks.onCloseRequested.mockReset().mockRejectedValue(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registerCloseGuard } = await import("../app/shell/close-guard");

    registerCloseGuard();
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith("Failed to register close guard:", error);
    logError.mockRestore();
  });

  it("prevents a clean close until settings finish flushing, then destroys the window", async () => {
    let resolveFlush!: () => void;
    mocks.flushSettingsProjection.mockReturnValue(new Promise<void>((resolve) => {
      resolveFlush = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    const event = { preventDefault: vi.fn() };
    const close = handler(event);
    await flushMicrotasks();

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();

    resolveFlush();
    await close;

    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("coalesces close requests while the close workflow is in flight", async () => {
    let resolveFlush!: () => void;
    mocks.flushSettingsProjection.mockReturnValue(new Promise<void>((resolve) => {
      resolveFlush = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };
    const firstClose = handler(firstEvent);
    const secondClose = handler(secondEvent);
    await flushMicrotasks();

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(1);

    resolveFlush();
    await Promise.all([firstClose, secondClose]);

    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not finish a close after its guard lifetime is disposed during flush", async () => {
    let resolveFlush!: () => void;
    mocks.flushSettingsProjection.mockReturnValue(new Promise<void>((resolve) => {
      resolveFlush = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    const lifetime = registerCloseGuard();
    await flushMicrotasks();
    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    const event = { preventDefault: vi.fn() };

    const close = handler(event);
    lifetime.dispose();
    resolveFlush();
    await close;

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("canopi-eon8.14.1: an unsaveable settings store flushes the Design, then offers Retry and Close anyway", async () => {
    mocks.flushSettingsProjection.mockRejectedValue(new Error("settings unavailable"));
    mocks.requestSaveProblemDecision.mockResolvedValue("discard");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.flushDesign.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.flushSettingsProjection.mock.invocationCallOrder[0]!);
    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledWith({ kind: "settings-failed", designSaved: true });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("canopi-eon8.14.1: settings Retry asks again while it fails and closes once it succeeds", async () => {
    mocks.flushSettingsProjection
      .mockRejectedValueOnce(new Error("busy"))
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    mocks.requestSaveProblemDecision.mockResolvedValue("retry");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(3);
    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledTimes(2);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("canopi-eon8.14.1: Cancel or Escape on the settings dialog keeps the window open", async () => {
    mocks.flushSettingsProjection.mockRejectedValue(new Error("busy"));
    mocks.requestSaveProblemDecision.mockResolvedValue("cancel");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledWith({ kind: "settings-failed", designSaved: true });
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("canopi-eon8.14.1: with no Design open, the settings dialog never calls a Design saved", async () => {
    mocks.flushDesign.mockResolvedValue(true);
    mocks.flushSettingsProjection.mockRejectedValue(new Error("settings unavailable"));
    mocks.requestSaveProblemDecision.mockResolvedValue("cancel");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    mocks.currentDesign.value = null;
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.requestSaveProblemDecision.mock.calls).toEqual([
      [{ kind: "settings-failed", designSaved: false }],
    ]);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("canopi-eon8.14.1: a Design closed without saving, then unsaveable settings, asks twice in order", async () => {
    mocks.flushDesign.mockResolvedValue(false);
    mocks.flushSettingsProjection.mockRejectedValue(new Error("busy"));
    mocks.requestSaveProblemDecision.mockResolvedValue("discard");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.requestSaveProblemDecision.mock.calls).toEqual([
      [{ kind: "flush-failed", purpose: "close", conflict: false }],
      [{ kind: "settings-failed", designSaved: false }],
    ]);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("canopi-eon8.14.1: disposing the guard while the settings dialog is open never destroys", async () => {
    let answer!: (choice: string) => void;
    mocks.flushSettingsProjection.mockRejectedValue(new Error("busy"));
    mocks.requestSaveProblemDecision.mockReturnValue(new Promise<string>((resolve) => {
      answer = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    const lifetime = registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    const close = handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.requestSaveProblemDecision).toHaveBeenCalledTimes(1));
    lifetime.dispose();
    answer("discard");
    await close;

    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("canopi-eon8.14.1: a second close request during the settings dialog asks no second time", async () => {
    let answer!: (choice: string) => void;
    mocks.flushSettingsProjection.mockRejectedValue(new Error("busy"));
    mocks.requestSaveProblemDecision.mockReturnValue(new Promise<string>((resolve) => {
      answer = resolve;
    }));
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    const firstClose = handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.requestSaveProblemDecision).toHaveBeenCalledTimes(1));
    const secondClose = handler({ preventDefault: vi.fn() });
    answer("discard");
    await Promise.all([firstClose, secondClose]);

    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledTimes(1);
    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("contains and reports a window-destroy failure", async () => {
    const error = new Error("window unavailable");
    mocks.destroy.mockRejectedValue(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await expect(handler({ preventDefault: vi.fn() })).resolves.toBeUndefined();

    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("Failed to complete close workflow:", error);
    logError.mockRestore();
  });

  it("writes the Design to its home before destroying the window, without asking", async () => {
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("asks once when the write fails and retries on request", async () => {
    mocks.flushDesign.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.requestSaveProblemDecision.mockResolvedValue("retry");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.requestSaveProblemDecision).toHaveBeenCalledWith({
      kind: "flush-failed",
      purpose: "close",
      conflict: false,
    });
    expect(mocks.flushDesign).toHaveBeenCalledTimes(2);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("closes without saving when the user chooses to", async () => {
    mocks.flushDesign.mockResolvedValue(false);
    mocks.requestSaveProblemDecision.mockResolvedValue("discard");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the window open when the user cancels after a failed write", async () => {
    mocks.flushDesign.mockResolvedValue(false);
    mocks.requestSaveProblemDecision.mockResolvedValue("cancel");
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await handler({ preventDefault: vi.fn() });

    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("contains and reports a failed close dialog", async () => {
    const error = new Error("dialog unavailable");
    mocks.flushDesign.mockResolvedValue(false);
    mocks.requestSaveProblemDecision.mockRejectedValue(error);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    registerCloseGuard();
    await flushMicrotasks();

    const handler = mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler;
    await expect(handler({ preventDefault: vi.fn() })).resolves.toBeUndefined();

    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("Failed to complete close workflow:", error);
    logError.mockRestore();
  });

  it("writes the Design when the window loses focus, not when it gains it", async () => {
    const { registerCloseGuard } = await import("../app/shell/close-guard");
    const lifetime = registerCloseGuard();
    await flushMicrotasks();

    const onFocus = mocks.onFocusChanged.mock.calls[0]?.[0] as FocusHandler;
    onFocus({ payload: true });
    expect(mocks.flushDesign).not.toHaveBeenCalled();
    onFocus({ payload: false });
    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);

    lifetime.dispose();
    expect(mocks.unlistenFocus).toHaveBeenCalledTimes(1);
    onFocus({ payload: false });
    expect(mocks.flushDesign).toHaveBeenCalledTimes(1);
  });
});

describe("flushBeforeExit", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.destroy.mockReset();
    mocks.flushDesign.mockReset().mockResolvedValue(true);
    mocks.flushSettingsProjection.mockReset().mockResolvedValue(undefined);
    mocks.requestSaveProblemDecision.mockReset();
    mocks.currentDesign.value = {};
  });

  it("before an update it writes the Design, then the settings, and proceeds without asking or closing the window", async () => {
    const { flushBeforeExit } = await import("../app/shell/close-guard");

    await expect(flushBeforeExit("update")).resolves.toBe("proceed");

    expect(mocks.flushDesign.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.flushSettingsProjection.mock.invocationCallOrder[0]!);
    expect(mocks.requestSaveProblemDecision).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("a failed Design write before an update offers Retry, Close without saving or Cancel, and Cancel keeps Canopi open", async () => {
    mocks.flushDesign.mockResolvedValue(false);
    mocks.requestSaveProblemDecision.mockResolvedValue("cancel");
    const { flushBeforeExit } = await import("../app/shell/close-guard");

    await expect(flushBeforeExit("update")).resolves.toBe("cancel");

    expect(mocks.requestSaveProblemDecision.mock.calls).toEqual([
      [{ kind: "flush-failed", purpose: "close", conflict: false }],
    ]);
    expect(mocks.flushSettingsProjection).not.toHaveBeenCalled();
  });

  it("a failed settings write before an update offers Retry, Close anyway or Cancel; Cancel or Escape keeps Canopi open", async () => {
    mocks.flushSettingsProjection.mockRejectedValue(new Error("settings unavailable"));
    mocks.requestSaveProblemDecision.mockResolvedValueOnce("retry").mockResolvedValueOnce("cancel");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { flushBeforeExit } = await import("../app/shell/close-guard");

    await expect(flushBeforeExit("update")).resolves.toBe("cancel");

    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(2);
    expect(mocks.requestSaveProblemDecision.mock.calls).toEqual([
      [{ kind: "settings-failed", designSaved: true }],
      [{ kind: "settings-failed", designSaved: true }],
    ]);
    vi.mocked(console.error).mockRestore();
  });

  it("Close anyway after a failed settings write lets the update go on", async () => {
    mocks.flushSettingsProjection.mockRejectedValue(new Error("settings unavailable"));
    mocks.requestSaveProblemDecision.mockResolvedValue("discard");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { flushBeforeExit } = await import("../app/shell/close-guard");

    await expect(flushBeforeExit("update")).resolves.toBe("proceed");

    expect(mocks.destroy).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
  });

  // Until N1's drain an update install during a LiDAR job stops it as today's Quit does (2.1-M63, Q61): the update
  // takes the window close's own flush, which asks nothing about jobs, and the host's exit ends the job, which the next
  // launch shows as Interrupted.
  it("an update install while a LiDAR job runs stops it as Quit does: the update takes the window close's flush and asks nothing about the job", async () => {
    mocks.getCurrentWindow.mockReturnValue({
      onCloseRequested: mocks.onCloseRequested.mockReset().mockResolvedValue(mocks.unlistenA),
      onFocusChanged: mocks.onFocusChanged.mockReset().mockResolvedValue(mocks.unlistenFocus),
      destroy: mocks.destroy,
    });
    const { flushBeforeExit, registerCloseGuard } = await import("../app/shell/close-guard");
    const steps = () => ({
      design: mocks.flushDesign.mock.calls.length,
      settings: mocks.flushSettingsProjection.mock.calls.length,
      asked: mocks.requestSaveProblemDecision.mock.calls.length,
    });

    const lifetime = registerCloseGuard();
    await flushMicrotasks();
    await (mocks.onCloseRequested.mock.calls[0]?.[0] as CloseHandler)({ preventDefault: vi.fn() });
    const quit = steps();
    mocks.flushDesign.mockClear();
    mocks.flushSettingsProjection.mockClear();

    await expect(flushBeforeExit("update")).resolves.toBe("proceed");

    expect(steps()).toEqual(quit);
    expect(quit).toEqual({ design: 1, settings: 1, asked: 0 });
    lifetime.dispose();
  });
});
