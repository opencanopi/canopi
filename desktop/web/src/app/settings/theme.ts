import { effect } from "@preact/signals";
import { locale, theme } from "./state";
import { primeThemeProjectionFromFirstPaintCache } from "./projection";

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", resolved);
}

const themeEffectSlot: { dispose: (() => void) | null } = { dispose: null };

function readCachedTheme(): "light" | "dark" | null {
  try {
    const cached = localStorage.getItem("canopi:first-paint-theme");
    return cached === "light" || cached === "dark" ? cached : null;
  } catch {
    return null;
  }
}

function writeCachedTheme(resolved: "light" | "dark"): void {
  try {
    localStorage.setItem("canopi:first-paint-theme", resolved);
  } catch {
    // Theme cache is optional; the active settings adapter remains authoritative.
  }
}

/**
 * Initialize the theme reactive effect.
 *
 * The active platform settings adapter is the persistence source of truth.
 * localStorage is used ONLY as a synchronous cache for first-paint — it
 * prevents theme flash by providing the last-known theme before the async
 * settings bootstrap resolves. The effect writes to localStorage on every
 * change so the cache stays in sync with the durable platform setting.
 */
export function initTheme(): () => void {
  // Clean up previous init (HMR safety)
  themeEffectSlot.dispose?.();

  // Read the sync cache for instant first-paint (avoids flash)
  const cached = readCachedTheme();
  if (cached) {
    primeThemeProjectionFromFirstPaintCache(cached);
  }

  // Apply theme reactively whenever the signal changes, and sync the cache
  const installedEffect = effect(() => {
    applyTheme(theme.value);
    // The page language follows the UI locale: screen readers, hyphenation and
    // the CJK type sizes (`:root:lang(zh|ja|ko)` in global.css) read it.
    document.documentElement.lang = locale.value;
    // Keep the sync cache up to date (settings bootstrap overwrites the signal,
    // which triggers this effect, which updates the cache for next startup)
    writeCachedTheme(theme.value);
  });
  themeEffectSlot.dispose = installedEffect;

  return () => {
    if (themeEffectSlot.dispose !== installedEffect) return;
    themeEffectSlot.dispose = null;
    installedEffect();
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    themeEffectSlot.dispose?.();
  });
}
