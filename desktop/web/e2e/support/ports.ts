// The browser checks' two ports (canopi-f47t.52.228.10, ADR 0028): the built Web Edition's preview server and the UI
// gallery's dev server. scripts/gate.py gives each worktree its own pair through CANOPI_E2E_WEB_PORT and
// CANOPI_E2E_GALLERY_PORT, so two worktrees' runs never share a server; unset, they are 4174 and 1422 (`npm run dev:ui`).
// playwright.config.ts, e2e/support and ui-gallery/vite.config.ts read them here, once, on import.

function port(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be a port number, not "${value}"`)
  return parsed
}

/** The Web Edition's preview server (`vite preview --mode web`). */
export const WEB_PORT = port('CANOPI_E2E_WEB_PORT', 4174)
/** The UI gallery's dev server (ui-gallery/vite.config.ts). */
export const GALLERY_PORT = port('CANOPI_E2E_GALLERY_PORT', 1422)
