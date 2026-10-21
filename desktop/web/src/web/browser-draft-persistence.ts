import { computed, signal, type ReadonlySignal } from "@preact/signals";

/**
 * Asks the browser to keep this origin's storage, so it does not clear the Web Edition's Drafts to free space
 * (2.1-Q82; Q190, Q191, Q194, M180; Step 2.0.3 persist). Web-only: Desktop never reaches it (policy "Desktop never
 * reaches the Web Draft persistence request").
 *
 * - Launch read: `navigator.storage.persisted()` plus, where supported, `permissions.query('persistent-storage')`,
 *   at each launch; nothing is stored. A denied permission is a refusal without asking.
 * - Request: `requestOnce()`, called by New, Open and Open template in the synchronous prefix of their click, so
 *   Firefox's prompt keeps the click's activation; at most once per launch while not kept and not denied.
 * - View: the line (`reason` before and during the ask, `warning` when the browser may clear Drafts) and the save
 *   status's warning. The warning shows after a refusal, when the API is unavailable, or from launch when Drafts
 *   exist and are not kept, then in the reason line's tone, so the reason is on screen when New or Open asks (the
 *   welcome screen, or the shell's row while a Design is open); never on a first visit before the ask, and it never
 *   flashes while a prompt is unanswered.
 * The grant is per origin; 2b swaps only the store under it, and N5 reuses the request.
 */
type BrowserDraftPersistenceState = "checking" | "kept" | "not-kept" | "asking" | "refused" | "unavailable";

export interface BrowserDraftPersistenceView {
  readonly state: BrowserDraftPersistenceState;
  /** The line shown, if any: the reason before and during the ask, else the warning. */
  readonly notice: "reason" | "warning" | null;
  /** Whether the save status warns that the browser may clear the Draft. */
  readonly warn: boolean;
}

/** The part of `navigator` the request reads; either half may be missing (insecure context, older engines). */
interface BrowserDraftPersistenceNavigator {
  readonly storage?: Partial<Pick<StorageManager, "persist" | "persisted">>;
  readonly permissions?: Partial<Pick<Permissions, "query">>;
}

interface BrowserDraftPersistence {
  readonly view: ReadonlySignal<BrowserDraftPersistenceView>;
  /** Reads the launch state; the returned dispose drops any answer still in flight. */
  start(launch: { readonly hasDrafts: boolean }): () => void;
  /** Asks the browser once per launch; a no-op unless the launch read found Drafts not kept. */
  requestOnce(): void;
}

interface BrowserDraftPersistenceOptions {
  readonly navigator?: () => BrowserDraftPersistenceNavigator | undefined;
  /** Logs a failure by name only: an engine's message may name local paths. */
  readonly logError?: (message: string, name: string) => void;
}

export function createBrowserDraftPersistence({
  navigator: readNavigator = () => globalThis.navigator as BrowserDraftPersistenceNavigator | undefined,
  logError = (message, name) => console.error(message, name),
}: BrowserDraftPersistenceOptions = {}): BrowserDraftPersistence {
  const state = signal<BrowserDraftPersistenceState>("checking");
  const hadDrafts = signal(false);
  let generation = 0;
  let storage: BrowserDraftPersistenceNavigator["storage"] = undefined;

  const view = computed<BrowserDraftPersistenceView>(() => {
    const current = state.value;
    const waiting = current === "not-kept" || current === "asking";
    const warn = current === "refused" || current === "unavailable" || (hadDrafts.value && waiting);
    // Before and during the ask the line is the reason, so it is on screen when the request is made, Drafts or not
    // (review F1); `warn` gives it the warning tone when Drafts already exist.
    return { state: current, notice: waiting ? "reason" : warn ? "warning" : null, warn };
  });

  function settleIf(launch: number, next: BrowserDraftPersistenceState): void {
    if (launch === generation) state.value = next;
  }

  function start({ hasDrafts }: { readonly hasDrafts: boolean }): () => void {
    const launch = ++generation;
    hadDrafts.value = hasDrafts;
    state.value = "checking";
    const nav = readNavigator();
    storage = nav?.storage;
    const dispose = () => {
      if (launch !== generation) return;
      generation += 1;
      storage = undefined;
      state.value = "checking";
    };
    if (typeof storage?.persisted !== "function" || typeof storage.persist !== "function") {
      state.value = "unavailable";
      return dispose;
    }
    let persisted: Promise<boolean>;
    try {
      persisted = Promise.resolve(storage.persisted());
    } catch (error) {
      logError("Draft persistence read failed:", errorName(error));
      state.value = "unavailable";
      return dispose;
    }
    Promise.all([persisted, readPermission(nav?.permissions)]).then(
      ([kept, permission]) => settleIf(launch, kept ? "kept" : permission === "denied" ? "refused" : "not-kept"),
      (error: unknown) => {
        if (launch !== generation) return;
        logError("Draft persistence read failed:", errorName(error));
        state.value = "unavailable";
      },
    );
    return dispose;
  }

  function requestOnce(): void {
    if (state.peek() !== "not-kept" || typeof storage?.persist !== "function") return;
    const launch = generation;
    state.value = "asking";
    let request: Promise<boolean>;
    try {
      request = Promise.resolve(storage.persist());
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (granted) => settleIf(launch, granted ? "kept" : "refused"),
      (error: unknown) => {
        if (launch !== generation) return;
        logError("Draft persistence request failed:", errorName(error));
        state.value = "refused";
      },
    );
  }

  return { view, start, requestOnce };
}

/** The permission's state, or null where the engine cannot say (WebKit throws a TypeError). */
async function readPermission(permissions: BrowserDraftPersistenceNavigator["permissions"]): Promise<PermissionState | null> {
  try {
    if (typeof permissions?.query !== "function") return null;
    const status = await permissions.query({ name: "persistent-storage" as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : typeof error;
}

/** `data-notice` of every on-screen reason line, which the e2e spy reads at each persist() call. */
export const DRAFT_PERSISTENCE_REASON = "draft-persistence-reason";

/** The Web application's one request, started by `platform/browser.ts` at launch. */
export const browserDraftPersistence = createBrowserDraftPersistence();
