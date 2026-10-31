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
const WORKFLOWS_DIR = '.github/workflows';

/** Refuses each package script and workflow line (comments aside) that pins a locked CLI or runs it through npx or npm. */
export function unlockedCliRefusals(root) {
  const names = LOCKED_CLIS.map((cli) => cli.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const pin = new RegExp(`(?:${names})@|\\b(?:npx|npm\\s+(?:exec|x|i|install|add))\\b.*?(?:${names})\\b`);
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
  const dir = path.join(root, WORKFLOWS_DIR);
  const workflows = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  for (const name of workflows) {
    fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trimStart().startsWith('#') && pin.test(line)) {
        refusals.push(refusal('unlocked-cli', `${WORKFLOWS_DIR}/${name}:${i + 1}`, `runs ${line.match(pin)[0]}: run desktop/web's devDependency (npm run tauri)`));
      }
    });
  }
  return refusals;
}
