#!/usr/bin/env node
// canopi-format-wasm/build-wasm.mjs: builds the Web format worker's module from source (Step 2.0.4 R1-1; design check
// A23): `npm run build:format-wasm` in desktop/web, which every Web build runs first. Never committed: the .wasm and its
// glue land in canopi-format-wasm/dist/ (git-ignored), where src/platform/design-core.worker.ts imports them through
// canopi-format-wasm/glue.js (the .wasm by `?url`).
//
// 1. The wasm-bindgen CLI on PATH must be the version Cargo.lock pins for the wasm-bindgen crate: the glue and the
//    module's custom section must agree, and a mismatch fails at bind time or worse at run time. CI installs the lock's
//    version (taiki-e/install-action, in each workflow that builds the Web edition, held to the lock by
//    build-wasm.test.ts); a mismatch here names the install command.
// 2. `cargo build --release --locked --target wasm32-unknown-unknown -p canopi-format-wasm` (the target comes from
//    rust-toolchain.toml), in Cargo's target directory as `cargo metadata` reports it, so CARGO_TARGET_DIR holds, with
//    the builder's paths remapped (moduleRustflags) so the module is the same bytes on every machine.
//    The build is for size (MODULE_PROFILE: opt-level s, fat LTO, one codegen unit), set through Cargo's profile
//    variables for this one command, so the workspace's release profile, Desktop's, stays as it is.
// 3. `wasm-bindgen --target web --no-typescript --remove-name-section` into dist/: canopi_format_wasm.js and
//    canopi_format_wasm_bg.wasm, without the name section, which only names functions for a debugger (a quarter of the
//    module). policy/ratchets/bundle-size.json holds the result to its ceiling.
//
// CANOPI_FORMAT_WASM_MVP=1 builds for the WebAssembly MVP (`-C target-cpu=mvp`), the plan's fallback should an engine
// Canopi supports refuse the default target features; the probe (e2e/canvas/format-core-probe.spec.ts) found none among
// the current engines it runs in, and has not yet run at the engine floor (see the spec's header).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = 'canopi-format-wasm';
const TARGET = 'wasm32-unknown-unknown';
export const CRATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CRATE_DIR);
export const OUT_DIR = path.join(CRATE_DIR, 'dist');

/** The release settings the module is built with, as Cargo profile variables (measured, canopi-f47t.52.270). */
export const MODULE_PROFILE = Object.freeze({
  CARGO_PROFILE_RELEASE_OPT_LEVEL: 's',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
});

/** The wasm-bindgen arguments before the output directory and the module. */
export const BIND_ARGS = Object.freeze(['--target', 'web', '--no-typescript', '--remove-name-section']);

/** The version Cargo.lock pins for the registry package `name`, or undefined when it holds none or several. */
export function lockedVersion(lockText, name) {
  const versions = [];
  for (const block of String(lockText).split(/^\[\[package\]\]$/mu).slice(1)) {
    const fields = Object.fromEntries([...block.matchAll(/^(name|version|source) = "([^"]*)"$/gmu)].map((m) => [m[1], m[2]]));
    if (fields.name === name && fields.source?.startsWith('registry+')) versions.push(fields.version);
  }
  return versions.length === 1 ? versions[0] : undefined;
}

/** The version `wasm-bindgen --version` printed (`wasm-bindgen 0.2.130`), or undefined. */
export function cliVersion(output) {
  return /^wasm-bindgen (\S+)\s*$/u.exec(String(output).trim())?.[1];
}

/** Why the installed CLI cannot bind this lock's module, or undefined when the versions agree. */
export function versionRefusal(locked, installed) {
  if (locked === undefined) return 'Cargo.lock pins no single wasm-bindgen version';
  const install = `cargo install --locked wasm-bindgen-cli --version ${locked}`;
  if (installed === undefined) return `the wasm-bindgen CLI is not installed; install it with \`${install}\``;
  if (installed !== locked) {
    return `the wasm-bindgen CLI is ${installed} and Cargo.lock pins the wasm-bindgen crate at ${locked}; install it with \`${install}\``;
  }
  return undefined;
}

/**
 * The module's rustflags, encoded as CARGO_ENCODED_RUSTFLAGS (the variable Cargo reads first, so these flags always
 * apply): the caller's own (CARGO_ENCODED_RUSTFLAGS, else RUSTFLAGS), then the remaps of the builder's home, Cargo home
 * and repository paths, the most specific last since rustc applies the last matching remap, then the MVP flag. The
 * remaps keep panic locations from naming the builder's paths, so the module and its hashed name are the same on every
 * machine and a local release build publishes no username. The home maps to `~`, not an absolute root, so every absolute
 * Rust source path left in the module starts with `/cargo/`, `/canopi/` or rustc's own `/rustc/` and `/rust/deps/`, and
 * the probe spec can tell a leaked path from a remapped one on any host.
 */
export function moduleRustflags({ env, home, cargoHome, root, mvp }) {
  const own = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (env.RUSTFLAGS ?? '').split(/\s+/u);
  const remaps = [[home, '~'],[cargoHome, '/cargo'], [root, '/canopi']].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  return [...own.filter(Boolean), ...remaps, ...(mvp ? ['-C', 'target-cpu=mvp'] : [])].join('\x1f');
}

function installedCli() {
  try {
    return cliVersion(execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    return undefined;
  }
}

function main() {
  const locked = lockedVersion(fs.readFileSync(path.join(ROOT, 'Cargo.lock'), 'utf8'), 'wasm-bindgen');
  const refusal = versionRefusal(locked, installedCli());
  if (refusal) {
    console.error(`build-wasm: ${refusal}`);
    return 1;
  }
  const env = {
    ...process.env,
    ...MODULE_PROFILE,
    CARGO_ENCODED_RUSTFLAGS: moduleRustflags({
      env: process.env,
      home: os.homedir(),
      cargoHome: process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'),
      root: ROOT,
      mvp: process.env.CANOPI_FORMAT_WASM_MVP === '1',
    }),
  };
  const run = (command, args) => execFileSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  run('cargo', ['build', '--release', '--locked', '--target', TARGET, '-p', CRATE]);
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], { cwd: ROOT, env, encoding: 'utf8' }));
  const module = path.join(metadata.target_directory, TARGET, 'release', `${CRATE.replaceAll('-', '_')}.wasm`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  run('wasm-bindgen', [...BIND_ARGS, '--out-dir', OUT_DIR, module]);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
