// policy/git.test.mjs: the policy's one git object reader (policy/git.mjs) through real git, with each failure state
// it owns: unreadable, busy, cancelled, unmounted mid-request and retried (design check AR6; canopi-f47t.52.228.54).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitReadError, openGitReader } from './git.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (root, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' });
const readers = [];
const roots = [];
const open = (root) => {
  const reader = openGitReader(root);
  readers.push(reader);
  return reader;
};
after(() => {
  readers.forEach((r) => r.close());
  roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

/** A repository with `files` ({path: text}) committed; returns its root. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-git-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'policy@example.invalid');
  git(root, 'config', 'user.name', 'policy');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'files');
  return root;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

test('tree lists the files under a prefix at a revision with their blob ids', () => {
  const root = repo({ 'policy/ratchets/a.json': '{"a":1}', 'policy/ratchets/b.json': '{"b":2}', 'other.txt': 'x' });
  const tree = open(root).tree('HEAD', 'policy/ratchets/');
  assert.deepEqual([...tree.keys()].sort(), ['policy/ratchets/a.json', 'policy/ratchets/b.json']);
  assert.equal(tree.get('policy/ratchets/a.json'), git(root, 'rev-parse', 'HEAD:policy/ratchets/a.json').trim());
});

test('unreadable: a path missing at a revision reads as absent, never empty, and an empty file reads as empty', async () => {
  const root = repo({ 'empty.json': '', 'full.json': '{}' });
  const reader = open(root);
  assert.equal(await reader.readAt('HEAD', 'gone.json'), undefined);
  assert.equal(await reader.readAt('HEAD', 'empty.json'), '');
  assert.equal(await reader.readAt('HEAD', 'full.json'), '{}');
});

test('unreadable: a bad revision throws a named error', async () => {
  const reader = open(repo({ 'a.json': '{}' }));
  assert.throws(() => reader.tree('no-such-rev', ''), (e) => e instanceof GitReadError && e.code === 'bad-rev');
  await assert.rejects(reader.readAt('no-such-rev', 'a.json'), (e) => e instanceof GitReadError && e.code === 'bad-rev');
});

test('busy: one cat-file child serves every read of a run, and a second run in parallel gets its own', async () => {
  const root = repo({ 'a.json': '"busy a"', 'b.json': '"busy b"', 'c.json': '"busy c"', 'd.json': '"busy d"' });
  const [first, second] = [open(root), open(root)];
  const reads = await Promise.all([first.readAt('HEAD', 'a.json'), second.readAt('HEAD', 'c.json'), first.readAt('HEAD', 'b.json'), second.readAt('HEAD', 'd.json')]);
  assert.deepEqual(reads, ['"busy a"', '"busy c"', '"busy b"', '"busy d"']);
  assert.equal(first.spawns, 1);
  assert.equal(second.spawns, 1);
  assert.notEqual(first.pid, second.pid);
  const pid = first.pid;
  first.close();
  assert.ok(await gone(pid), 'close ends the cat-file child');
});

test('cancelled: SIGINT to the run kills its cat-file child and leaves no orphan', async () => {
  const root = repo({ 'a.json': '"cancelled"' });
  const script = `
    const { openGitReader } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./git.mjs', import.meta.url))).href)});
    const reader = openGitReader(${JSON.stringify(root)});
    await reader.readAt('HEAD', 'a.json');
    console.log(reader.pid);
    setInterval(() => {}, 1000);`;
  const run = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pid = await new Promise((resolve) => run.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  assert.ok(alive(pid), 'the cat-file child runs while the run does');
  const exited = new Promise((resolve) => run.once('exit', (code, signal) => resolve({ code, signal })));
  run.kill('SIGINT');
  assert.deepEqual(await exited, { code: null, signal: 'SIGINT' });
  assert.ok(await gone(pid), `cat-file child ${pid} outlived the run`);
});

test('unmounted mid-request: a cat-file child that exits early fails the read by name, never with a partial blob', async () => {
  const big = 'x'.repeat(8 * 1024 * 1024);
  const root = repo({ 'small.json': '"first"', 'big.txt': big });
  const reader = open(root);
  assert.equal(await reader.readAt('HEAD', 'small.json'), '"first"');
  const id = reader.tree('HEAD', 'big.txt').get('big.txt');
  const read = reader.blob(id);
  process.kill(reader.pid, 'SIGKILL');
  await assert.rejects(read, (e) => e instanceof GitReadError && e.code === 'cat-file-exited');
  await assert.rejects(reader.readAt('HEAD', 'big.txt'), (e) => e instanceof GitReadError && e.code === 'cat-file-exited');
});

test('unmounted mid-request: a removed worktree fails the read by name', async () => {
  const root = repo({ 'a.json': '"one"' });
  const reader = open(root);
  const id = reader.tree('HEAD', 'a.json').get('a.json');
  fs.rmSync(root, { recursive: true, force: true });
  await assert.rejects(reader.blob(id), (e) => e instanceof GitReadError && ['cat-file-exited', 'missing-object'].includes(e.code));
});

test('retried: blobs are cached by id, so a rerun returns identical results without another child', async () => {
  const root = repo({ 'a.json': '"retried"' });
  const first = open(root);
  const once = await first.readAt('HEAD', 'a.json');
  first.close();
  const again = open(root);
  assert.equal(await again.readAt('HEAD', 'a.json'), once);
  assert.equal(again.spawns, 0);
});
