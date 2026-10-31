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

/**
 * Refuses each package script, and each workflow, composite action or script line (comments aside), that
 * pins a locked CLI or fetches it through a package runner (npx, npm exec, pnpm or yarn dlx, pnpx, bunx).
 */
export function unlockedCliRefusals(root) {
  const names = LOCKED_CLIS.map((cli) => cli.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const runner = 'npx|pnpx|bunx|(?:pnpm|yarn)\\s+dlx|npm\\s+(?:exec|x|i|install|add)';
  const pin = new RegExp(`(?:${names})@|\\b(?:${runner})\\b.*?(?:${names})\\b`);
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
        if (typeof command === 'string' && pin.test(command)) {
          refusals.push(refusal('unlocked-cli', rel, `script ${name} runs ${command.match(pin)[0]}: run the devDependency (npm run tauri)`));
        }
      }
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (!/^\s*(?:#|\/\/)/.test(line) && pin.test(line)) {
        refusals.push(refusal('unlocked-cli', `${rel}:${i + 1}`, `runs ${line.match(pin)[0]}: run desktop/web's devDependency (npm run tauri)`));
      }
    });
  }
  return refusals;
}
