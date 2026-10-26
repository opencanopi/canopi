// policy/adapters/cargo-manifest.mjs: the workspace-manifest rule over each member's Cargo.toml (contracts §12, §18;
// 2.1-M188; ADR 0028).
//
// Every workspace member inherits the workspace lints and is never published: its manifest has `[lints]
// workspace = true`, no `[lints.<tool>]` table of its own, and `publish = false` (cargo-deny allows path wildcards
// only between unpublished crates). The members come from `cargo metadata --no-deps --format-version 1`, and each
// member manifest is read with a TOML parser, since cargo metadata reports `publish` but not `lints`. Each breach is one
// site `{ rule, path }`, `path` the member's Cargo.toml: `lints-workspace` (no `[lints] workspace = true`), `own-lints`
// (a `[lints.<tool>]` table) and `publish-false`. Metadata that is not one whole JSON document with the workspace's
// members is refused as tool-failed, never read as a workspace without members.
//
// The workspace is the repository's, or a planted directory's own (policy/fixtures/rules/<rule>/, its own
// `[workspace]`), chosen by the paths a run is given (`workspaceDir`); the cargo-deny and cargo-shear adapters share
// that choice and `readToml`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PLANTED = /^policy\/fixtures\/rules\/[^/]+\//;

const fail = (message) => { throw Object.assign(new Error(`cargo-manifest: ${message}`), { code: 'tool-failed' }); };

// Python's tomllib (the TOML parser scripts/check_docs.py uses) prints one TOML file as JSON.
const TOML_TO_JSON = 'import json, sys, tomllib\nwith open(sys.argv[1], "rb") as f:\n    print(json.dumps(tomllib.load(f)))\n';

/**
 * One TOML file (absolute path) as an object, read by Python's tomllib. It runs here, never through a run's `exec`: it
 * is the parser, not the tool a planted case replays. A file it cannot read or parse is tool-failed.
 */
export function readToml(file) {
  let out;
  try {
    out = execFileSync('python3', ['-I', '-c', TOML_TO_JSON, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const why = String(error.stderr ?? error.message).trim().split('\n').at(-1);
    throw Object.assign(new Error(`cannot read ${file} as TOML: ${why}`), { code: 'tool-failed' });
  }
  return JSON.parse(out);
}

/**
 * The repository-relative directory whose Cargo workspace a run checks: the planted directory when every path is in
 * one (policy/fixtures/rules/<rule>/), else the repository root (''). Paths from two planted directories, or a planted
 * directory and the repository, are refused: one run checks one workspace.
 */
export function workspaceDir(paths) {
  const dirs = new Set(paths.map((p) => PLANTED.exec(p)?.[0] ?? ''));
  if (dirs.size > 1) fail(`the paths span ${[...dirs].map((d) => d || 'the repository').join(' and ')}; one run checks one workspace`);
  return (dirs.values().next().value ?? '').replace(/\/$/, '');
}

/** `cargo metadata --no-deps` stdout as { workspaceRoot, members: [{ name, manifest, publish }] }, refusing anything else. */
export function parseMetadata(stdout, status, stderr = '') {
  if (status !== 0) fail(`cargo metadata exited ${status}: ${stderr.trim().split('\n').at(-1) ?? ''}`);
  let meta;
  try {
    meta = JSON.parse(stdout);
  } catch {
    fail(`cargo metadata printed no whole JSON document (${stdout.length} bytes); truncated output is never read as no members`);
  }
  if (!meta || typeof meta.workspace_root !== 'string' || !Array.isArray(meta.packages) || !Array.isArray(meta.workspace_members)
    || meta.workspace_members.length === 0) {
    fail('cargo metadata gave no workspace_root, packages and workspace members');
  }
  const ids = new Set(meta.workspace_members);
  const members = meta.packages.filter((p) => ids.has(p.id));
  if (members.length !== ids.size || members.some((p) => typeof p.name !== 'string' || typeof p.manifest_path !== 'string')) {
    fail('cargo metadata lists a workspace member it gives no package, name and manifest path for');
  }
  return {
    workspaceRoot: meta.workspace_root,
    members: members.map((p) => ({ name: p.name, manifest: p.manifest_path, publish: p.publish })),
  };
}

/** The members of the workspace in `dir` (repository-relative), each with its manifest relative to the repository. */
export function workspaceMembers({ root, dir, exec }) {
  const manifest = path.posix.join(dir, 'Cargo.toml');
  if (!fs.existsSync(path.join(root, manifest))) fail(`${manifest} is missing`);
  const { status, stdout, stderr } = exec('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest], { cwd: root });
  const { workspaceRoot, members } = parseMetadata(stdout, status, stderr);
  return members.map((m) => ({ ...m, path: path.posix.join(dir, path.relative(workspaceRoot, m.manifest).split(path.sep).join('/')) }));
}

/** The workspace-manifest breaches of one member manifest (parsed) with cargo metadata's `publish`. */
export function manifestBreaches(manifest, publish) {
  const lints = manifest.lints;
  const breaches = [];
  if (!lints || lints.workspace !== true) breaches.push('lints-workspace');
  if (lints && Object.keys(lints).some((k) => k !== 'workspace')) breaches.push('own-lints');
  if (!(Array.isArray(publish) && publish.length === 0)) breaches.push('publish-false');
  return breaches;
}

export function collect({ root, paths, exec }) {
  const dir = workspaceDir(paths);
  return workspaceMembers({ root, dir, exec }).flatMap((m) => manifestBreaches(readToml(path.join(root, m.path)), m.publish)
    .map((rule) => ({ rule, path: m.path })));
}
