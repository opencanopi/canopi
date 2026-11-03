// policy/git.mjs: the policy's one reader of git objects (design check AR6; 2.1-M348). tree() lists the files under a
// prefix at a revision with their blob ids (`git ls-tree`); blob() reads a blob by id through one long-lived
// `git cat-file --batch` child per reader, started at the first miss; readAt() is both. Blob text is cached by id for
// the whole process: an id names its content, so a rerun reads the same text and never asks git twice.
//
// Failure states, each a GitReadError with a code: a revision git cannot resolve is `bad-rev`; a path missing at a
// revision reads as absent (undefined), never as empty; a child that exits or cannot start with reads pending (a
// removed worktree) fails each of them, and every later read, as `cat-file-exited`, never with a partial blob; an id
// git does not have is `missing-object`. The child is closed by close(), and killed when the process exits or takes
// SIGINT or SIGTERM (the signal then does what it would have done), so a cancelled run leaves no orphan. A reader
// holds its process open only while reads are pending.
import { execFileSync, spawn } from 'node:child_process';

/** A read git could not serve; `code` names which (see the header). */
export class GitReadError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** Blob id -> text, for every reader of the process. */
const blobs = new Map();
/** Live cat-file children, killed on exit and on SIGINT or SIGTERM. */
const live = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM'];

function killLive() {
  for (const child of live) child.kill('SIGKILL');
  live.clear();
}
function onSignal(signal) {
  killLive();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  // Only this listener held the signal: re-raise it so it ends the process as it would have without us.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
function track(child) {
  if (live.size === 0) {
    process.on('exit', killLive);
    for (const s of SIGNALS) process.on(s, onSignal);
  }
  live.add(child);
}
function untrack(child) {
  live.delete(child);
  if (live.size === 0) {
    process.removeListener('exit', killLive);
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}

/** git's environment without GIT_* (a hook's GIT_DIR names another repository), as policy/core/exec.mjs runs it. */
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** A reader of the repository at `root`. */
export function openGitReader(root) {
  let child;
  let dead;
  let buffer = Buffer.alloc(0);
  const pending = [];
  const reader = { spawns: 0, pid: undefined };

  const fail = (why) => {
    dead = new GitReadError('cat-file-exited', `git cat-file --batch in ${root} ${why}`);
    if (child) untrack(child);
    buffer = Buffer.alloc(0);
    for (const request of pending.splice(0)) request.reject(dead);
  };
  const hold = (on) => {
    if (!child) return;
    for (const handle of [child, child.stdout, child.stdin]) on ? handle.ref?.() : handle.unref?.();
  };

  /** Parses every whole response in the buffer; a partial one waits for more output. */
  const drain = () => {
    while (pending.length) {
      const eol = buffer.indexOf(10);
      if (eol === -1) return;
      const header = buffer.subarray(0, eol).toString('utf8');
      const [, kind, size] = header.split(' ');
      const request = pending[0];
      if (kind === 'missing' || kind === 'ambiguous' || size === undefined) {
        buffer = buffer.subarray(eol + 1);
        pending.shift();
        request.reject(new GitReadError('missing-object', `${request.id} is ${kind ?? 'unreadable'} in ${root}`));
        continue;
      }
      const end = eol + 1 + Number(size);
      if (buffer.length < end + 1) return;
      const text = buffer.subarray(eol + 1, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      pending.shift();
      blobs.set(request.id, text);
      request.resolve(text);
    }
    if (!pending.length) hold(false);
  };

  const start = () => {
    reader.spawns++;
    child = spawn('git', ['cat-file', '--batch'], { cwd: root, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    reader.pid = child.pid;
    track(child);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
    child.stdin.on('error', () => {}); // EPIPE from a child that died: its 'close' fails the reads
    child.on('error', (error) => fail(`could not start: ${error.message}`));
    child.on('close', (code, signal) => {
      if (!dead) fail(`exited (${signal ?? `status ${code}`})${pending.length ? ` with ${pending.length} reads pending` : ''}`);
    });
  };

  /** The text of blob `id`. */
  reader.blob = (id) => {
    if (blobs.has(id)) return Promise.resolve(blobs.get(id));
    if (dead) return Promise.reject(dead);
    if (!child) start();
    return new Promise((resolve, reject) => {
      pending.push({ id, resolve, reject });
      hold(true);
      child.stdin.write(`${id}\n`);
    });
  };

  /** File path -> blob id for each file at `rev` under `prefix` (a directory with its slash, or one file). */
  reader.tree = (rev, prefix) => {
    let out;
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { cwd: root, env: gitEnv(), stdio: 'ignore' });
      out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...(prefix ? [prefix] : [])], {
        cwd: root, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
      });
    } catch (error) {
      throw new GitReadError('bad-rev', `${rev} is no revision in ${root}: ${String(error.stderr ?? error.message).trim()}`);
    }
    const files = new Map();
    for (const line of out.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const [, type, id] = line.slice(0, tab).split(' ');
      if (type === 'blob') files.set(line.slice(tab + 1), id);
    }
    return files;
  };

  /** The text of `file` at `rev`, or undefined when the revision has no such file. */
  reader.readAt = async (rev, file) => {
    const id = reader.tree(rev, file).get(file);
    return id === undefined ? undefined : reader.blob(id);
  };

  /** Ends the child; later reads still served from the cache, others fail as `cat-file-exited`. */
  reader.close = () => {
    if (!child || dead) return;
    fail('was closed');
    child.stdin.end();
  };
  return reader;
}
