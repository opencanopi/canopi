// policy/adapters/cargo-shear.mjs: cargo-shear's JSON as named sites (contracts §12; 2.1-Q13, DR28; ADR 0028).
//
// cargo-shear replaced scripts/check_unused_crates.py: over a planted corpus the script caught nothing shear misses
// (policy/fixtures/check/adapters/cargo-shear-parity.json). This adapter runs the pinned cargo-shear (VERSION) as
// `cargo shear --format json` over the repository's workspace or a planted directory's own (`workspaceDir`; a planted
// run is offline) and makes each finding one site `{ rule, name }`, `rule` its code without `shear/`:
//   - a dependency finding (unused, misplaced, unused optional, ...) is `<crate>: <dependency>`, the crate being the
//     package whose Cargo.toml declares it (`workspace` for the root's [workspace.dependencies]);
//   - any other finding (an empty or unlinked file, a stale ignore) is `<crate>: <code> <detail>`.
// Each entry of a `[package.metadata.cargo-shear]` or `[workspace.metadata.cargo-shear]` `ignored` list is a site too
// (`<crate>: <dependency>`, rule `ignored`; `ignored-paths` entries `<crate>: ignored-path <glob>`), read from the
// manifests among the paths, so an ignore needs a family entry with its bead.
//
// It fails closed: a missing cargo-shear (the message names the install command) or another version, output that is
// not one whole JSON report, a summary whose counts differ from the findings listed, a code outside `shear/`, and an
// exit status that disagrees with the errors (0 with errors is reporter-exit). cargo-shear built from crates.io
// prints `Version: dev`; its version is then read from the install record beside the binary cargo runs
// (`.crates2.json`, which `cargo install` writes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToml, workspaceDir } from './cargo-manifest.mjs';

export const VERSION = '1.13.2';
const INSTALL = `cargo install --locked --version ${VERSION} cargo-shear`;
/** One command prints the version of the cargo-shear it runs, then that run's report, so both are on stdout. */
const RUN = 'cargo shear --version && exec cargo shear "$@"';

const fail = (code, message) => { throw Object.assign(new Error(`cargo-shear: ${message}`), { code }); };
const lastLine = (text) => String(text ?? '').trim().split('\n').at(-1) ?? '';

/**
 * The version `cargo install` recorded for the cargo-shear binary cargo runs: the first `cargo-shear` on PATH, then in
 * $CARGO_HOME/bin (cargo's subcommand search), its record in the install root above it. Undefined when there is none.
 */
function recordedVersion() {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(cargoHome, 'bin')];
  const exe = process.platform === 'win32' ? 'cargo-shear.exe' : 'cargo-shear';
  const bin = dirs.find((d) => fs.existsSync(path.join(d, exe)));
  if (!bin) return undefined;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(bin, '..', '.crates2.json'), 'utf8'));
    const key = Object.keys(record.installs ?? {}).find((k) => k.startsWith('cargo-shear ') && record.installs[k].bins?.includes(exe));
    return key?.split(' ')[1];
  } catch {
    return undefined;
  }
}

/** One run's stdout without its first line, the version, after refusing a missing or other cargo-shear. */
function versionChecked(stdout, stderr) {
  const [first, ...rest] = String(stdout).split('\n');
  const printed = /^Version: (\S+)$/.exec(first.trim())?.[1];
  if (!printed) fail('tool-failed', `cargo-shear is not installed (${lastLine(stderr) || 'no version printed'}); install it with \`${INSTALL}\``);
  const got = printed === 'dev' ? recordedVersion() : printed;
  if (!got) fail('tool-failed', `cargo-shear prints Version: dev and no install record names its version; install it with \`${INSTALL}\``);
  if (got !== VERSION) fail('tool-failed', `cargo-shear ${got} is installed and ${VERSION} is pinned; install it with \`${INSTALL}\``);
  return rest.join('\n');
}

/** A manifest's owner in a site name: its package, or `workspace` for a virtual root manifest. */
const ownerOf = (manifest) => manifest.package?.name ?? 'workspace';

/** One finding as a site; `manifestAt(file)` parses a manifest the finding names, relative to the workspace. */
function siteOf(finding, manifestAt) {
  if (typeof finding.code !== 'string' || !finding.code.startsWith('shear/')) fail('tool-failed', `a finding with no shear/ code: ${finding.message}`);
  const rule = finding.code.slice('shear/'.length);
  const [head, ...detail] = String(finding.message ?? '').split('\n');
  const named = /`([^`]+)`/.exec(head)?.[1];
  if (typeof finding.file === 'string' && path.posix.basename(finding.file) === 'Cargo.toml' && named) {
    return { rule, name: `${ownerOf(manifestAt(finding.file))}: ${named}` };
  }
  return { rule, name: `${named ?? 'workspace'}: ${rule}${detail.length ? ` ${detail.map((l) => l.trim()).join(', ')}` : ''}` };
}

/** The sites of a cargo-shear `--format json` report run with exit `status`, failing closed on one that does not add up. */
export function reportSites(output, status, manifestAt) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    fail('tool-failed', `exit ${status} with no whole JSON report (truncated output?): ${lastLine(output).slice(0, 120)}`);
  }
  const { summary, findings } = report ?? {};
  if (!Number.isInteger(summary?.errors) || !Number.isInteger(summary?.warnings) || !Array.isArray(findings)) {
    fail('tool-failed', 'the report has no summary counts and findings');
  }
  if (summary.errors + summary.warnings !== findings.length) {
    fail('tool-failed', `the summary counts ${summary.errors + summary.warnings} finding(s) and the report lists ${findings.length}`);
  }
  if (status === 0 && summary.errors) fail('reporter-exit', `exit 0 with ${summary.errors} error(s)`);
  if (status !== 0 && !summary.errors) fail('tool-failed', `exit ${status} with no error reported`);
  return findings.map((f) => siteOf(f, manifestAt));
}

/** The `ignored` and `ignored-paths` entries of the cargo-shear metadata in the manifests among `paths`, a site each. */
function ignoreSites(root, paths) {
  return paths.filter((p) => path.posix.basename(p) === 'Cargo.toml').flatMap((p) => {
    const manifest = readToml(path.join(root, p));
    const owner = ownerOf(manifest);
    return [manifest.package?.metadata?.['cargo-shear'], manifest.workspace?.metadata?.['cargo-shear']].filter(Boolean).flatMap((meta) => [
      ...(meta.ignored ?? []).map((dep) => ({ rule: 'ignored', name: `${owner}: ${dep}` })),
      ...(meta['ignored-paths'] ?? []).map((glob) => ({ rule: 'ignored-path', name: `${owner}: ignored-path ${glob}` })),
    ]);
  });
}

export function collect({ root, paths, exec }) {
  const dir = workspaceDir(paths);
  const project = dir || '.';
  const { status, stdout, stderr } = exec('sh', ['-c', RUN, 'sh', '--format', 'json', ...(dir ? ['--offline'] : []), project], { cwd: root });
  const manifestAt = (file) => readToml(path.join(root, project, file));
  return [...reportSites(versionChecked(stdout, stderr), status, manifestAt), ...ignoreSites(root, paths)];
}
