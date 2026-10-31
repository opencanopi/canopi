// policy/locked-cli.mjs: the CLIs whose one pin is desktop/web's devDependency (2.1-M216; canopi-f47t.52.228), held by
// policy/check.mjs's default check as the `unlocked-cli` refusal.
import fs from 'node:fs';
import path from 'node:path';

const refusal = (code, where, message) => ({ code, where, message });

/**
 * The CLIs whose one pin is desktop/web's devDependency, run through a package script (`npm run tauri`), never an npx
 * fetch (2.1-M216): a second pin in a script or workflow is left behind by a bump and fetches the old version.
 */
const LOCKED_CLIS = ['@tauri-apps/cli'];
/**
 * The repository-relative paths a lane can run a CLI from, sorted: every package.json (its scripts), each workflow and
 * composite action under .github, and each script in a `scripts` directory (repository, desktop/web, any other).
 * Dot directories other than .github (.git, the agents' .rq-scratch worktrees), node_modules and target are skipped.
 */
function runSources(root, dir = '') {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const skipped = (entry.name.startsWith('.') && rel !== '.github') || ['node_modules', 'target'].includes(entry.name);
      return skipped ? [] : runSources(root, rel);
    }
    const runs = entry.name === 'package.json'
      || (rel.startsWith('.github/') && /\.ya?ml$/.test(entry.name))
      || (/(?:^|\/)scripts\//.test(rel) && /\.(?:sh|mjs|cjs|js|ts|py)$/.test(entry.name));
    return entry.isFile() && runs ? [rel] : [];
  }).sort();
}

const NAMES = LOCKED_CLIS.map((cli) => cli.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
/** A locked CLI named with a version (`@tauri-apps/cli@2.11.0`), and named at all. */
const PIN = new RegExp(`(?:${NAMES})@`);
const NAMED = new RegExp(`(?:${NAMES})(?![\\w-])`);
/** A package runner that fetches: npx, pnpx, bunx, any dlx, and npm, pnpm, yarn or bun exec, x or install, flags between. */
const RUNNER = /\b(?:npx|pnpx|bunx|dlx)\b|\b(?:npm|pnpm|yarn|bun)(?:\s+-\S+)*\s+(?:exec|x|i|install|add)\b/;

/** Whether one command pins a locked CLI, or names it beside a runner anywhere in it (as the package or a --package). */
const fetchesLocked = (command) => PIN.test(command) || (RUNNER.test(command) && NAMED.test(command));

/**
 * The line before its comment: a `#` or `//` at the start or after whitespace, outside quotes, opens one (shell, YAML,
 * Python, JS). A quote left open keeps the rest of the line, so a mis-read quote refuses rather than passes.
 */
function uncommented(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if ((i === 0 || /\s/.test(line[i - 1])) && (ch === '#' || line.startsWith('//', i))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The file's commands with their first line numbers, comments left out: a line ending in a backslash continues on the
 * next, but a comment never does (the shell runs the line after it), and a trailing comment naming a runner and a
 * locked CLI is no fetch.
 */
function commands(text) {
  const out = [];
  let open = false;
  text.split('\n').forEach((raw, i) => {
    const line = uncommented(raw);
    if (!open && !line.trim()) return;
    const body = line.replace(/\\\s*$/, '');
    if (open) out[out.length - 1].command += ` ${body.trim()}`;
    else out.push({ at: i + 1, command: body });
    open = body !== line;
  });
  return out;
}

/**
 * Refuses each package script, and each workflow, composite action or script command (comments aside), that pins a
 * locked CLI or fetches it through a package runner.
 */
export function unlockedCliRefusals(root) {
  const refusals = [];
  for (const rel of runSources(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (rel.endsWith('package.json')) {
      let scripts = {};
      try {
        scripts = JSON.parse(text).scripts ?? {};
      } catch (error) {
        refusals.push(refusal('unreadable', rel, error.message));
      }
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === 'string' && fetchesLocked(command)) {
          refusals.push(refusal('unlocked-cli', rel, `script ${name} runs ${command}: run the devDependency (npm run tauri)`));
        }
      }
      continue;
    }
    for (const { at, command } of commands(text)) {
      if (fetchesLocked(command)) {
        refusals.push(refusal('unlocked-cli', `${rel}:${at}`, `runs ${command.trim()}: run desktop/web's devDependency (npm run tauri)`));
      }
    }
  }
  return refusals;
}
