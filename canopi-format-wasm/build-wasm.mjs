#!/usr/bin/env node
// canopi-format-wasm/build-wasm.mjs: builds the Web format worker's module from source (Step 2.0.4 R1-1; design check
// A23): `npm run build:format-wasm` in desktop/web, which every Web build runs first. Never committed: the .wasm and its
// glue land in canopi-format-wasm/dist/ (git-ignored), where src/platform/design-core.worker.ts imports them by `?url`.
//
// 1. The wasm-bindgen CLI on PATH must be the version Cargo.lock pins for the wasm-bindgen crate: the glue and the
//    module's custom section must agree, and a mismatch fails at bind time or worse at run time. CI installs the lock's
//    version (taiki-e/install-action, .github/workflows/build.yml); a mismatch here names the install command.
// 2. `cargo build --release --locked --target wasm32-unknown-unknown -p canopi-format-wasm` (the target comes from
//    rust-toolchain.toml), in Cargo's target directory as `cargo metadata` reports it, so CARGO_TARGET_DIR holds.
// 3. `wasm-bindgen --target web --no-typescript` into dist/: canopi_format_wasm.js and canopi_format_wasm_bg.wasm.
//
// CANOPI_FORMAT_WASM_MVP=1 builds for the WebAssembly MVP (`-C target-cpu=mvp`), the plan's fallback should an engine
// Canopi supports refuse the default target features; the probe (e2e/canvas/format-core-probe.spec.ts) found none.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = 'canopi-format-wasm';
const TARGET = 'wasm32-unknown-unknown';
export const CRATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CRATE_DIR);
export const OUT_DIR = path.join(CRATE_DIR, 'dist');

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
  const env = { ...process.env };
  if (process.env.CANOPI_FORMAT_WASM_MVP === '1') env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C target-cpu=mvp`.trim();
  const run = (command, args) => execFileSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  run('cargo', ['build', '--release', '--locked', '--target', TARGET, '-p', CRATE]);
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], { cwd: ROOT, env, encoding: 'utf8' }));
  const module = path.join(metadata.target_directory, TARGET, 'release', `${CRATE.replaceAll('-', '_')}.wasm`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  run('wasm-bindgen', ['--target', 'web', '--no-typescript', '--out-dir', OUT_DIR, module]);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
