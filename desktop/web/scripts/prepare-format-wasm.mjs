// Ensures `canopi-format-wasm/dist/` exists before Vitest loads any test importing the real Wasm DesignCore
// (`src/__tests__/support/design-wire.ts`). Mirrors `prepare-pdf-fonts.mjs` so a fresh checkout (including CI
// `full --area frontend`, where `coverage` runs before `build-web`) succeeds with no manual pre-step.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIST_DIR = resolve(REPO_ROOT, 'canopi-format-wasm/dist');
const BUILD_SCRIPT = resolve(REPO_ROOT, 'canopi-format-wasm/build-wasm.mjs');

export function ensureFormatWasm() {
  if (
    existsSync(resolve(DIST_DIR, 'canopi_format_wasm.js'))
    && existsSync(resolve(DIST_DIR, 'canopi_format_wasm_bg.wasm'))
  ) {
    return;
  }
  execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
}

export const setup = () => ensureFormatWasm();
