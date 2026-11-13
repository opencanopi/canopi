/**
 * boot-guard/guard.ts: the start-up guard (canopi-4kfl; 2.1-M471, 2.1-M489). An engine below the floor shows an empty
 * window: the entry module does not parse, a chunk fails to load, or an API the app calls is missing. This classic
 * script, run before the entry module, shows "Canopi couldn't start" with the update hint instead.
 *
 * Invariant: the app acknowledges its boot once, when `RootBoundary` mounts (`BootAcknowledgement`); from then on
 * failures are RootBoundary's and the guard never shows for them. Before it, the guard shows at a same-origin script
 * error or SyntaxError (the entry or a chunk it needs failed, so the boot cannot finish), and at the load event at the
 * latest (module scripts run before it, so a normal boot, however slow, has acknowledged by then; a top-level await on
 * the entry's static graph would defer the mount past it, which scripts/check-build-identifiers.mjs refuses in both
 * editions, canopi-72fm). A missing required API shows the message at once, acknowledged or not. A guard that fails to
 * load changes nothing: the app never reads it.
 * It is a parser-blocking script on purpose (defer would let an early modulepreload error fire before its listener), so
 * a stalled request for its 6.5 KB delays the boot; a fast failure does not.
 *
 * Wiring: this file is a script, not an app module; the app imports only its types. vite.config.ts's `bootGuardPlugin`
 * strips its types, defines `__CANOPI_BOOT_GUARD_TEXTS__` as the edition's strings from the 11 locale files
 * (`startup.*`, the one exception to `t`), lowers it to ES2015 inside a function scope and loads the result as a
 * hashed classic script before the entry module in both editions. So it imports nothing and calls only what an engine
 * far below the floor has.
 */

/** The boot acknowledgement on the window: set once when `RootBoundary` mounts, after which failures are its own. */
export interface BootAcknowledgement {
  __CANOPI_BOOT_ACKNOWLEDGED__?: true
}

/** One language's message: `startup.title` and the edition's hint. */
interface BootGuardText {
  readonly title: string
  readonly hint: string
}

/** The edition's message per primary language subtag, `en` the fallback; defined by the plugin at build time. */
declare const __CANOPI_BOOT_GUARD_TEXTS__: { readonly en: BootGuardText; readonly [language: string]: BootGuardText }

function bootGuard(win: Window & Readonly<BootAcknowledgement>, texts: typeof __CANOPI_BOOT_GUARD_TEXTS__): void {
  const doc = win.document
  const scope = win as unknown as { readonly [name: string]: unknown }
  const has = (owner: unknown, name: string): boolean =>
    owner != null && typeof (owner as { readonly [key: string]: unknown })[name] === 'function'
  // The APIs the app calls that every floor engine (engine-floor.ts) has and older engines lack. Only those: one a floor
  // engine lacks would cover a working app (Intl.Segmenter, absent before Firefox 125, is why the app never calls it);
  // never indexedDB.databases(), which the Web Edition feature-detects (design check A19).
  const supported = has(win, 'fetch') && has(win, 'Promise') && has(win, 'Worker') && has(win, 'ResizeObserver')
    && typeof scope.WebAssembly === 'object' && has(scope.crypto, 'randomUUID')
    && has(Object, 'hasOwn') && has(Array.prototype, 'at')
  const tag = String(win.navigator.language || '').toLowerCase().split('-')[0] || ''
  const language = tag !== 'en' && Object.prototype.hasOwnProperty.call(texts, tag) ? tag : 'en'
  const text = texts[language] ?? texts.en
  const origin = `${win.location.protocol}//${win.location.host}/`
  const sameOrigin = (url: unknown): boolean => typeof url === 'string' && url.indexOf(origin) === 0
  let shown = false

  const show = (always: boolean): void => {
    if (shown || (!always && win.__CANOPI_BOOT_ACKNOWLEDGED__)) return
    const body = doc.body
    if (!body) {
      doc.addEventListener('DOMContentLoaded', () => show(always))
      return
    }
    shown = true
    const box = doc.createElement('div')
    box.setAttribute('role', 'alert')
    box.setAttribute('lang', language)
    box.setAttribute('data-boot-guard', '')
    // Above the app, in the system's colours: no stylesheet of the app's may have loaded. Each newer value follows an
    // older one that an engine which ignores it keeps.
    box.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;flex-direction:column;'
      + 'justify-content:center;padding:24px;color-scheme:light dark;background:#fff;background:Canvas;color:#000;color:CanvasText;'
      + 'font:16px/1.5 sans-serif;font:16px/1.5 system-ui,sans-serif;text-align:center'
    const title = doc.createElement('h1')
    title.style.cssText = 'margin:0 0 8px;font-size:20px;font-weight:600'
    title.textContent = text.title
    const hint = doc.createElement('p')
    hint.style.cssText = 'margin:0 auto;max-width:32em'
    hint.textContent = text.hint
    box.appendChild(title)
    box.appendChild(hint)
    body.appendChild(box)
  }

  // A script's ErrorEvent, or a failed <script> or <link rel=modulepreload> element's Event.
  const onError = (event: Event): void => {
    if (win.__CANOPI_BOOT_ACKNOWLEDGED__) return
    // A stylesheet or image that fails never stops the boot, so only scripts and module preloads count.
    const target = event.target as { readonly tagName?: string; readonly rel?: string; readonly src?: string; readonly href?: string } | null
    const element = target && (target.tagName === 'SCRIPT' || (target.tagName === 'LINK' && target.rel === 'modulepreload')) ? target : null
    const { filename, error } = event as Partial<ErrorEvent>
    if (element ? sameOrigin(element.src || element.href) : sameOrigin(filename) || (!filename && error instanceof SyntaxError)) show(false)
  }
  win.addEventListener('error', onError, true)
  win.addEventListener('load', () => {
    show(false)
    if (win.__CANOPI_BOOT_ACKNOWLEDGED__) win.removeEventListener('error', onError, true)
  })
  if (!supported) show(true)
}

bootGuard(window, __CANOPI_BOOT_GUARD_TEXTS__)
