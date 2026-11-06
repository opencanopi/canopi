// policy/release-version.test.mjs: the release version every manifest repeats, held equal to tauri.conf.json's by the
// policy checker's default check (policy/release-version.mjs; canopi-f47t.52.228.61), on this repository and on
// written repositories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './core/base.mjs';
import { writtenRepo } from './core/test-repo.mjs';
import { releaseVersionRefusals } from './release-version.mjs';

const repo = (files) => writtenRepo(files, 'policy-release-version-');
const manifests = ({ tauri = '2.1.0', cargo = '2.1.0', pkg = '2.1.0', lock = '2.1.0', lockRoot = '2.1.0' } = {}) => ({
  'desktop/tauri.conf.json': JSON.stringify({ productName: 'Canopi', version: tauri }),
  'Cargo.toml': `[workspace]\nmembers = ["desktop"]\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`,
  'desktop/web/package.json': JSON.stringify({ name: 'canopi-web', version: pkg }),
  'desktop/web/package-lock.json': JSON.stringify({ name: 'canopi-web', version: lock, packages: { '': { version: lockRoot } } }),
});

test('this repository\'s manifests carry tauri.conf.json\'s version (canopi-f47t.52.228.61)', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'desktop/tauri.conf.json')), 'tauri.conf.json is the authority the check reads');
  assert.deepEqual(releaseVersionRefusals(REPO_ROOT), []);
});

test('canopi-f47t.52.228.61: a bump that misses tauri.conf.json is refused at each manifest it moved', () => {
  const root = repo(manifests({ tauri: '2.1.0', cargo: '2.1.1', pkg: '2.1.1', lock: '2.1.1', lockRoot: '2.1.1' }));
  assert.deepEqual(releaseVersionRefusals(root).map((r) => `${r.code} ${r.where}`), [
    'release-version Cargo.toml [workspace.package]',
    'release-version desktop/web/package.json',
    'release-version desktop/web/package-lock.json',
    'release-version desktop/web/package-lock.json packages[\'\']',
  ]);
  assert.deepEqual(releaseVersionRefusals(repo(manifests({ lockRoot: '2.0.9' }))).map((r) => r.where),
    ['desktop/web/package-lock.json packages[\'\']']);
  assert.deepEqual(releaseVersionRefusals(repo(manifests())), []);
});

test('canopi-f47t.52.228.61: a manifest that holds no version is refused, and a repository without tauri.conf.json is not read', () => {
  const files = manifests();
  files['Cargo.toml'] = '[workspace]\nmembers = ["desktop"]\n\n[workspace.dependencies]\nserde = { version = "1" }\n';
  delete files['desktop/web/package-lock.json'];
  assert.deepEqual(releaseVersionRefusals(repo(files)).map((r) => r.where),
    ['Cargo.toml [workspace.package]', 'desktop/web/package-lock.json', 'desktop/web/package-lock.json packages[\'\']']);
  assert.deepEqual(releaseVersionRefusals(repo({ 'Cargo.toml': '[workspace]\n' })), []);
});
