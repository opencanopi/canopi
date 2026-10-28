// policy/adapters/bundle-size.mjs: the bytes of each built chunk, by edition and name (2.1-Q203, 2.1-M240; ADR 0029
// Performance budgets).
//
// The `bundle-size` budget family's scope names the one Vite config that builds both editions,
// desktop/web/vite.config.ts (Desktop in Vite's default mode, Web in mode `web`); build output is git-ignored, so the
// scope never names it. This adapter loads the config through desktop/web's Vite as `vite build` does, once per
// edition, and reads that edition's `build.outDir` (relative to the config's directory, where the package scripts
// run) once both are built: `npm run build` and `npm run build:web`, then `npm run test:policies:bundle`.
//
// Every .js file under an output dir is a chunk Rolldown wrote as `<name>-<hash>.js`. The hash is cut by the edition's
// length, read from `build.rolldownOptions.output.chunkFileNames` (`[hash:16]` on Web, Vite's `[hash]`, 8, on
// Desktop), never by splitting on a separator, since a hash holds `-` and `_`. Desktop repeats a name across chunks
// (a package bundled into the app and into a worker), so a key, `<edition> chunk: <name>`, measures the byte total of
// every chunk with that name. A config that cannot load, an output dir that is missing or holds no chunk, a file name
// with no hash of the edition's length and a path that is neither the config nor its build output are
// `tool-failed`. Rolldown builds are byte-stable, so the family's tolerance is headroom: a chunk over it is a bead.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = 'desktop/web';
/** Each edition and the mode its package script builds it in (`vite build`, `vite build --mode web`). */
const EDITIONS = [['desktop', 'production'], ['web', 'web']];
const CONFIG = /(^|\/)vite\.config\.[cm]?[jt]s$/;
/** Rolldown's `[hash]` length, which Vite's default chunk file names use. */
const DEFAULT_HASH = 8;

const fail = (message) => { throw Object.assign(new Error(`bundle-size: ${message}`), { code: 'tool-failed' }); };

/** The hash length of the chunk file names an edition's loaded config gives Rolldown. */
function hashLength(config, where) {
  const output = config.build?.rolldownOptions?.output ?? {};
  const names = Array.isArray(output) ? fail(`${where} gives Rolldown several outputs`) : output.chunkFileNames ?? 'assets/[name]-[hash].js';
  if (typeof names !== 'string') fail(`${where} names chunks by a function, whose hash length cannot be read`);
  const hash = /\[hash(?::(\d+))?\]/.exec(names) ?? fail(`${where} names chunks with no [hash]`);
  return hash[1] ? Number(hash[1]) : DEFAULT_HASH;
}

/** Every file under `dir`, relative to it with forward slashes. */
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

/** `<edition> chunk: <name>` -> bytes for one built edition's output dir. */
function chunkBytes(edition, outDir, hash, where, root) {
  const shown = path.relative(root, outDir).split(path.sep).join('/');
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) fail(`${where} has no build output at ${shown}; build the edition first`);
  const bytes = {};
  const chunks = walk(outDir).filter((f) => f.endsWith('.js'));
  if (!chunks.length) fail(`${where} wrote no chunk to ${shown}`);
  for (const file of chunks) {
    const base = path.posix.basename(file, '.js');
    const name = base.slice(0, -hash - 1);
    if (!name || base[name.length] !== '-' || !/^[\w-]+$/.test(base.slice(-hash))) fail(`${shown}/${file} has no ${hash}-character hash`);
    const key = `${edition} chunk: ${name}`;
    bytes[key] = (bytes[key] ?? 0) + fs.statSync(path.join(outDir, file)).size;
  }
  return bytes;
}

export async function measure({ root, paths }) {
  const configs = paths.filter((p) => CONFIG.test(p));
  if (configs.length !== 1) fail(`one Vite config builds both editions; given ${configs.join(', ') || 'none'}`);
  const [file] = configs;
  const require = createRequire(path.join(root, WEB, 'package.json'));
  let vite;
  try {
    vite = await import(pathToFileURL(require.resolve('vite')).href);
  } catch (error) {
    fail(`desktop/web's vite cannot be loaded (${error.message}); run npm ci in desktop/web`);
  }
  const dir = path.dirname(path.join(root, file));
  const observed = {};
  const outDirs = [];
  for (const [edition, mode] of EDITIONS) {
    const where = `${file} (${edition})`;
    let config;
    try {
      config = (await vite.loadConfigFromFile({ command: 'build', mode }, path.join(root, file), dir, 'silent'))?.config ?? {};
    } catch (error) {
      fail(`${where} does not load: ${error.message}`);
    }
    const outDir = path.resolve(dir, config.root ?? '.', config.build?.outDir ?? 'dist');
    outDirs.push(outDir);
    Object.assign(observed, chunkBytes(edition, outDir, hashLength(config, where), where, root));
  }
  const stray = paths.find((p) => p !== file && !outDirs.some((d) => path.join(root, p).startsWith(`${d}${path.sep}`)));
  if (stray) fail(`${stray} is neither the Vite config nor an edition's build output`);
  return observed;
}
