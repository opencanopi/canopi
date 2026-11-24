// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("settings bootstrap theme lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a disposer that stops theme synchronization", async () => {
    localStorage.setItem("canopi:first-paint-theme", "dark");
    const { theme } = await import("../app/settings/state");
    const { initTheme } = await import("../app/settings/theme");

    const dispose = initTheme();

    expect(theme.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    dispose();
    theme.value = "light";

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("keeps applying the theme when the first-paint cache is unavailable", async () => {
    const cacheError = new Error("storage denied");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw cacheError;
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw cacheError;
    });
    const { initTheme } = await import("../app/settings/theme");

    expect(() => initTheme()).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  });

  it("hydrates Browser settings and replaces the first-paint cache before render", async () => {
    localStorage.setItem("canopi:first-paint-theme", "light");
    const { browserAppDataStore } = await import("../web/browser-app-data");
    browserAppDataStore.saveSettings({ locale: "fr", theme: "dark" });
    const { locale, theme } = await import("../app/settings/state");
    const { bootWebEdition: bootstrapPlatform } = await import("../editions/web/boot");

    bootstrapPlatform();

    expect(locale.value).toBe("fr");
    expect(theme.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("canopi:first-paint-theme")).toBe("dark");
  });
  it("leaves the 1.x first-paint theme key unread and unchanged", async () => {
    // Canopi 1.x cached its theme under "canopi-theme"; 2.0 starts fresh and never touches 1.x data (ADR 0021).
    localStorage.setItem("canopi-theme", "dark");
    const { theme } = await import("../app/settings/state");
    const { initTheme } = await import("../app/settings/theme");

    initTheme();
    expect(document.documentElement.getAttribute("data-theme"), "the 1.x cache is not read").toBe("light");
    theme.value = "dark";
    theme.value = "light";

    expect(localStorage.getItem("canopi-theme"), "nor written").toBe("dark");
  });
});
