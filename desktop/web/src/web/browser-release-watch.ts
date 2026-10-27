// web/browser-release-watch.ts
// Owner of the Web release watch fetch (fetch-only-in-owners, ADR 0028; §18 F15). Invariant:
// the release manifest is fetched only here, from the origin table's origins.

import { signal, type ReadonlySignal } from "@preact/signals";
import { CANOPI_VERSION } from "../app/about/metadata";

/**
 * Notices a Web release other than this tab's own (2.1-Q83, Q186, Q187, M179; Step 2.0.3 serving). Web-only: Desktop's
 * page assets ship inside its binary, so no deploy can skew them (policy "Desktop never reaches the Web release watch").
 *
 * - Reads the edition manifest (`canopi-web-edition-manifest.json` beside `index.html`, `no-cache`) on window focus and
 *   on becoming visible, each at most once a minute, and on every `vite:preloadError` (a lazy chunk this tab's release
 *   named is gone). One read is in flight at a time; triggers join it. It never prevents the event: the import error
 *   proceeds as before. Only this module listens for that event (policy).
 * - Shows when the manifest names any other release, older included, so a rollback reaches open tabs (Q186). An
 *   unreadable, missing or malformed manifest (`vite preview` and dev have none) is silent and logs nothing.
 * - Dismissible (Q187): reads continue and compare against the dismissed release; a further release or a failed import
 *   shows it again. While it shows, nothing reads.
 * The signal is shaped as Phase 1's app-lifecycle `release-waiting{source: manifest}` (2.1-M98); W1 swaps the fetch for
 * `registration.update()` (2.1-M99). Reload is the session's (`browser-design-session.ts` `reloadForRelease`).
 */
interface BrowserReleaseWaiting {
  readonly source: "manifest";
  /** The release the manifest names. */
  readonly version: string;
}

/** The page events the watch reads on. */
export interface BrowserReleaseWatchTarget {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

type ManifestFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;

interface BrowserReleaseWatchOptions {
  readonly ownVersion?: string;
  readonly manifestUrl?: string;
  readonly fetch?: ManifestFetch;
  readonly now?: () => number;
}

interface BrowserReleaseWatch {
  /** The release waiting on screen; null when none waits or it was dismissed. */
  readonly notice: ReadonlySignal<BrowserReleaseWaiting | null>;
  /** Listens on `target`; the returned dispose removes the listeners, aborts a read in flight and clears the notice. */
  start(target?: BrowserReleaseWatchTarget): () => void;
  dismiss(): void;
}

/** Focus and becoming visible each read at most this often. */
export const RELEASE_READ_INTERVAL_MS = 60_000;

const EDITION_NAME = "Canopi Web Edition";
const MANIFEST_NAME = "canopi-web-edition-manifest.json";
const PRELOAD_ERROR = "vite:preloadError";

type Trigger = "focus" | "visible" | "failed-import";

interface Read {
  readonly abort: AbortController;
  failedImport: boolean;
}

export function createBrowserReleaseWatch({
  ownVersion = CANOPI_VERSION,
  manifestUrl = `${import.meta.env.BASE_URL}${MANIFEST_NAME}`,
  fetch: fetchManifest = (url, init) => globalThis.fetch(url, init),
  now = () => Date.now(),
}: BrowserReleaseWatchOptions = {}): BrowserReleaseWatch {
  const notice = signal<BrowserReleaseWaiting | null>(null);
  let dismissed: string | null = null;
  let inFlight: Read | null = null;
  const lastRead: Partial<Record<Trigger, number>> = {};
  let generation = 0;

  function read(trigger: Trigger, launch: number): void {
    if (launch !== generation || notice.peek() !== null) return;
    if (trigger !== "failed-import") {
      const last = lastRead[trigger];
      if (last !== undefined && now() - last < RELEASE_READ_INTERVAL_MS) return;
      lastRead[trigger] = now();
    }
    if (inFlight) {
      if (trigger === "failed-import") inFlight.failedImport = true;
      return;
    }
    const current: Read = { abort: new AbortController(), failedImport: trigger === "failed-import" };
    inFlight = current;
    void readManifestVersion(current.abort.signal).then((version) => {
      if (inFlight === current) inFlight = null;
      if (launch !== generation || version === null) return;
      settle(version, current.failedImport);
    });
  }

  async function readManifestVersion(abort: AbortSignal): Promise<string | null> {
    try {
      const response = await fetchManifest(manifestUrl, { cache: "no-store", credentials: "same-origin", signal: abort });
      if (!response.ok) return null;
      return manifestVersion(await response.json());
    } catch {
      // Offline, aborted, or not JSON (dev and `vite preview` answer without a manifest): try at the next trigger.
      return null;
    }
  }

  function settle(version: string, failedImport: boolean): void {
    if (version === ownVersion) {
      dismissed = null;
      notice.value = null;
      return;
    }
    if (failedImport || version !== dismissed) {
      dismissed = null;
      notice.value = { source: "manifest", version };
    }
  }

  function start(
    target: BrowserReleaseWatchTarget = { window: globalThis.window, document: globalThis.document },
  ): () => void {
    const launch = ++generation;
    const onFocus = () => read("focus", launch);
    const onVisibility = () => {
      if (target.document.visibilityState === "visible") read("visible", launch);
    };
    const onFailedImport = () => read("failed-import", launch);
    target.window.addEventListener("focus", onFocus);
    target.document.addEventListener("visibilitychange", onVisibility);
    target.window.addEventListener(PRELOAD_ERROR, onFailedImport);
    return () => {
      target.window.removeEventListener("focus", onFocus);
      target.document.removeEventListener("visibilitychange", onVisibility);
      target.window.removeEventListener(PRELOAD_ERROR, onFailedImport);
      generation += 1;
      inFlight?.abort.abort();
      inFlight = null;
      dismissed = null;
      notice.value = null;
    };
  }

  function dismiss(): void {
    const waiting = notice.peek();
    if (!waiting) return;
    dismissed = waiting.version;
    notice.value = null;
  }

  return { notice, start, dismiss };
}

/** The version a well-formed edition manifest names, else null. */
function manifestVersion(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { name, version } = body as { readonly name?: unknown; readonly version?: unknown };
  if (name !== EDITION_NAME || typeof version !== "string" || version.length === 0) return null;
  return version;
}

export const browserReleaseWatch = createBrowserReleaseWatch();
