// policy/core/exec.mjs: running tools and git for the policy checker (2.1-M348): exec() for a family's tool, git() in
// one directory and nowhere else, and the files a scope glob can match.
import { execFileSync } from 'node:child_process';

/**
 * Runs git in `cwd` and nowhere else. A hook exports GIT_DIR and GIT_INDEX_FILE (a linked worktree's hook names the
 * real repository), so every GIT_* variable is dropped; signing is off so a developer's config cannot break or stall
 * the planted cases' commits and tags.
 */
export const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
  cwd,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
});

/** Runs a tool and returns its exit status and output, never throwing on a non-zero status. */
export function exec(command, args, { cwd }) {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    if (typeof error.status !== 'number') throw Object.assign(new Error(`${command}: ${error.message}`), { code: 'tool-failed' });
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * The files under the git work tree `root` a scope glob can match: tracked and unignored files still on disk. A
 * tracked file deleted or moved without staging is gone, so its entry is path drift. Outside git this throws.
 */
export function listFiles(root) {
  const ls = (...args) => git(root, ['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  const deleted = new Set(ls('--deleted'));
  return ls('--cached', '--others', '--exclude-standard').filter((f) => !deleted.has(f));
}
