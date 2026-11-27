// policy/release-version.mjs: Cargo.toml [workspace.package] is the sole version owner (canopi-f47t.52.75).
// desktop/tauri.conf.json (Tauri 2 falls back to Cargo) and desktop/web/package.json carry no version copy;
// desktop/web/package-lock.json repeats it and is held equal by policy/check.mjs's default check as the
// `release-version` refusal (canopi-f47t.52.228.61).
import fs from 'node:fs';
import path from 'node:path';

/** The sole version authority: Cargo.toml [workspace.package] (canopi-f47t.52.75). */
const AUTHORITY_FILE = 'Cargo.toml';
const AUTHORITY_WHERE = 'Cargo.toml [workspace.package]';

const json = (text) => JSON.parse(text);
const readCargoVersion = (text) => {
  const table = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(table)?.[1];
};

/** Reads the single authoritative release version from Cargo.toml [workspace.package] (canopi-f47t.52.75). */
export function readCargoWorkspaceVersion(root) {
  const version = readCargoVersion(fs.readFileSync(path.join(root, AUTHORITY_FILE), 'utf8'));
  if (!version) throw new Error(`${AUTHORITY_WHERE} version missing`);
  return version;
}

/** Manifests that must not duplicate Cargo.toml's version (canopi-f47t.52.75). */
const NO_VERSION_MANIFESTS = [
  'desktop/tauri.conf.json',
  'desktop/web/package.json',
];

/** Lockfile entries that repeat the version and must agree with Cargo.toml [workspace.package]. */
const SOURCES = [
  ['desktop/web/package-lock.json', 'desktop/web/package-lock.json', (text) => json(text).version],
  ['desktop/web/package-lock.json packages[\'\']', 'desktop/web/package-lock.json', (text) => json(text).packages?.['']?.version],
];

const refusal = (where, message) => ({ code: 'release-version', where, message });

/** The version `read` finds in `rel`, or a reason it holds none (missing, unreadable, no version string). */
function versionIn(root, rel, read) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return { missing: `${rel} is missing` };
  try {
    const version = read(fs.readFileSync(file, 'utf8'));
    return typeof version === 'string' && version ? { version } : { missing: 'holds no version' };
  } catch (error) {
    return { missing: `unreadable: ${error.message}` };
  }
}

/**
 * Refuses duplicate version fields in tauri.conf.json or desktop/web/package.json, and refuses any lockfile
 * version that disagrees with Cargo.toml [workspace.package]. A repository without desktop/tauri.conf.json
 * (a planted case's) is not read.
 */
export function releaseVersionRefusals(root) {
  if (!fs.existsSync(path.join(root, 'desktop/tauri.conf.json'))) return [];
  const authority = versionIn(root, AUTHORITY_FILE, readCargoVersion);
  if (authority.missing) return [refusal(AUTHORITY_WHERE, authority.missing)];
  const duplicateRefusals = NO_VERSION_MANIFESTS.flatMap((rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return [];
    try {
      const data = json(fs.readFileSync(file, 'utf8'));
      return 'version' in data
        ? [refusal(rel, `must not carry a version copy: ${AUTHORITY_WHERE} is the sole version owner (canopi-f47t.52.75)`)]
        : [];
    } catch (error) {
      return [refusal(rel, `unreadable: ${error.message}`)];
    }
  });
  const lockRefusals = SOURCES.flatMap(([where, rel, read]) => {
    const { version, missing } = versionIn(root, rel, read);
    if (missing) return [refusal(where, missing)];
    return version === authority.version ? []
      : [refusal(where, `version ${version} is not ${AUTHORITY_WHERE}'s ${authority.version}: a release bump moves Cargo.toml and the lockfile`)];
  });
  return [...duplicateRefusals, ...lockRefusals];
}
