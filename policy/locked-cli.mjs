// policy/locked-cli.mjs: the CLIs whose one pin is desktop/web's devDependency (2.1-M216; canopi-f47t.52.228), held by
// policy/check.mjs's default check as the `unlocked-cli` refusal.
import fs from 'node:fs';
import path from 'node:path';
import { LANE_RUNNERS } from './selection.mjs';

const refusal = (code, where, message) => ({ code, where, message });

/**
 * The CLIs whose one pin is desktop/web's devDependency, run through a package script (`npm run tauri`), never an npx
 * fetch (2.1-M216): a second pin in a script or workflow is left behind by a bump and fetches the old version.
 */
const LOCKED_CLIS = ['@tauri-apps/cli'];
/** The trees whose lines can run a CLI beside the package scripts: workflows and their composite actions, and the
 * repository scripts lanes call. */
const LINE_SOURCES = [
  { dir: '.github', file: /\.ya?ml$/ },
  { dir: 'scripts', file: /\.(?:sh|mjs|py)$/ },
];

/** The repository-relative paths under `dir` whose name matches `file`, sorted. */
function filesUnder(root, dir, file) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && file.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Refuses each package script, and each workflow, composite action or repository script line (comments aside), that
 * pins a locked CLI or fetches it through a package runner (npx, npm exec, pnpm or yarn dlx, pnpx, bunx).
 */
export function unlockedCliRefusals(root) {
  const names = LOCKED_CLIS.map((cli) => cli.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const runner = 'npx|pnpx|bunx|(?:pnpm|yarn)\\s+dlx|npm\\s+(?:exec|x|i|install|add)';
  const pin = new RegExp(`(?:${names})@|\\b(?:${runner})\\b.*?(?:${names})\\b`);
  const refusals = [];
  const pkg = path.join(root, LANE_RUNNERS);
  if (fs.existsSync(pkg)) {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
    } catch (error) {
      refusals.push(refusal('unreadable', LANE_RUNNERS, error.message));
    }
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command === 'string' && pin.test(command)) {
        refusals.push(refusal('unlocked-cli', LANE_RUNNERS, `script ${name} runs ${command.match(pin)[0]}: run the devDependency (npm run tauri)`));
      }
    }
  }
  for (const rel of LINE_SOURCES.flatMap(({ dir, file }) => filesUnder(root, dir, file))) {
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*(?:#|\/\/)/.test(line) && pin.test(line)) {
        refusals.push(refusal('unlocked-cli', `${rel}:${i + 1}`, `runs ${line.match(pin)[0]}: run desktop/web's devDependency (npm run tauri)`));
      }
    });
  }
  return refusals;
}
