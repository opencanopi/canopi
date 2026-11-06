// policy/adapters/cargo-manifest.test.mjs: the workspace members reader, the one place policy/ reads the crate
// paths (design check AR9; plan 2-1-foundations.md "reading crate and area paths from one table";
// canopi-f47t.52.228.54).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workspaceMemberDirs } from './cargo-manifest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function workspace(manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-members-'));
  roots.push(root);
  if (manifest !== undefined) fs.writeFileSync(path.join(root, 'Cargo.toml'), manifest);
  return root;
}

test('the repository workspace members are its crates', () => {
  assert.deepEqual(workspaceMemberDirs(REPO), ['desktop', 'canopi-types', 'bindings-gen']);
});

test('members on several lines, with comments and a trailing comma, read in order', () => {
  const root = workspace('[package]\nname = "x"\nmembers = ["not-this"]\n\n[workspace]\n# the crates\nmembers = [\n  "core", # the core\n  \'tools/extra\',\n]\nresolver = "2"\n\n[workspace.package]\nmembers = ["nor-this"]\n');
  assert.deepEqual(workspaceMemberDirs(root), ['core', 'tools/extra']);
});

test('a missing manifest, a manifest without workspace members or a glob member fails the run', () => {
  const failed = (root) => assert.throws(() => workspaceMemberDirs(root), (e) => e.code === 'tool-failed');
  failed(workspace(undefined));
  failed(workspace('[package]\nname = "x"\n'));
  failed(workspace('[workspace]\nmembers = ["crates/*"]\n'));
  failed(workspace('[workspace]\nmembers = ["a", b]\n'));
});
