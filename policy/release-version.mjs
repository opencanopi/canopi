// policy/release-version.mjs: the release version tauri.conf.json holds, which Cargo.toml's [workspace.package], desktop/web's
// package.json and its lockfile repeat, held equal by policy/check.mjs's default check as the `release-version` refusal
// (canopi-f47t.52.228.61). The Release Candidate's preflight compares the same five with the requested version; this
// check fails a bump that misses one on its own PR, as every lane that a manifest selects runs the policy checker.
import fs from 'node:fs';
import path from 'node:path';

/** The version authority: Cargo.toml [workspace.package] (.52.75), which every manifest repeats. */
const AUTHORITY_FILE = 'Cargo.toml';
const AUTHORITY_WHERE = 'Cargo.toml [workspace.package]';

const json = (text) => JSON.parse(text);
const readCargoVersion = (text) => {
  const table = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(table)?.[1];
};
/** Each place the version is repeated, by how the preflight names it, with the file it reads and how. */
const SOURCES = [
  ['desktop/tauri.conf.json', 'desktop/tauri.conf.json', (text) => json(text).version],
  ['desktop/web/package.json', 'desktop/web/package.json', (text) => json(text).version],
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
 * Refuses each repeated version that is not Cargo.toml's, or that a manifest does not hold. A repository without
 * desktop/tauri.conf.json (a planted case's) is not read.
 */
export function releaseVersionRefusals(root) {
  if (!fs.existsSync(path.join(root, 'desktop/tauri.conf.json'))) return [];
  const authority = versionIn(root, AUTHORITY_FILE, readCargoVersion);
  if (authority.missing) return [refusal(AUTHORITY_WHERE, authority.missing)];
  return SOURCES.flatMap(([where, rel, read]) => {
    const { version, missing } = versionIn(root, rel, read);
    if (missing) return [refusal(where, missing)];
    return version === authority.version ? []
      : [refusal(where, `version ${version} is not ${AUTHORITY_WHERE}'s ${authority.version}: a release bump moves all five`)];
  });
}
