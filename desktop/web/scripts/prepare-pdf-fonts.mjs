// The pinned PDF fonts (src/app/canvas-pdf/font-assets.json), verified by SHA-256 and fetched when missing or corrupt.
// One script, three callers, no npm pre-hook (.52.33 TST-01): `npm run prepare:pdf-fonts` (the explicit command, also
// run by the agent tools), `pdfFontsPlugin()` in every Vite config that builds the PDF export, and Vitest's global
// setup (`setup`). The fonts are git-ignored and live in the checkout's own source tree, where font-urls.ts imports them
// so each build names the files by content (2.1-M176): two worktrees never share a directory. A write goes through a
// temporary name unique to the process and a rename, so a dev server and a test run preparing at once never read half a
// file. Their licences are hand rows of THIRD_PARTY_NOTICES.md (scripts/notices-hand-rows.json).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PDF_FONTS_DIR = new URL('../src/app/canvas-pdf/fonts/', import.meta.url);
const ASSETS_URL = new URL('../src/app/canvas-pdf/font-assets.json', import.meta.url);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Verifies every pinned font under `root`, fetching a missing or corrupt one; offline with a font missing, it fails
 * naming the command to run once online. */
export async function preparePdfFonts({
  root = fileURLToPath(PDF_FONTS_DIR),
  fetch = globalThis.fetch,
  assets,
  log = console.log,
} = {}) {
  const pinned = assets ?? JSON.parse(await readFile(ASSETS_URL, 'utf8'));
  await mkdir(root, { recursive: true });
  for (const asset of pinned) {
    const target = resolve(root, asset.file);
    let data;
    try { data = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data || sha256(data) !== asset.sha256) {
      data = await fetchFont(asset, fetch);
      const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
      try { await writeFile(temporary, data); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
    }
    log(`Verified PDF font ${asset.id}: ${data.length} bytes`);
  }
}

async function fetchFont(asset, fetch) {
  const fail = (reason) => new Error(
    `PDF font ${asset.id} (${asset.file}) is missing or corrupt and ${reason}; run npm run prepare:pdf-fonts with network access.`,
  );
  let response;
  try { response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) }); }
  catch (error) { throw fail(`could not be fetched (${error instanceof Error ? error.message : String(error)})`); }
  if (!response.ok) throw fail(`its download answered HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (sha256(data) !== asset.sha256) throw fail('its download does not match the pinned SHA-256');
  return data;
}

/** Prepares the fonts before a Vite build or dev server reads them. Vitest uses `setup` instead. */
export function pdfFontsPlugin() {
  return {
    name: 'canopi-pdf-fonts',
    apply: (_config, { mode }) => mode !== 'test',
    buildStart: () => preparePdfFonts({ log: () => {} }),
  };
}

/** Vitest global setup (vite.config.ts `test.globalSetup`): once per run, before any test file loads. */
export const setup = () => preparePdfFonts({ log: () => {} });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePdfFonts();
