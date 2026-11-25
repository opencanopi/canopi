// policy/adapters/object-capability-gaps.mjs: named per-entry gap ratchet for the
// 28x57 object-capability matrix (contracts §21:877, 2.1-Q147, 2.1-M86).
//
// Reads `GAP_CELLS_BY_BEAD` from `app/command-table/object-capabilities.ts` (and
// its planted mirror under `policy/fixtures/rules/<id>/src/`) so every new
// `partial`/`no` gap cell fails until filled or decided, and every filled gap
// drops from `policy/ratchets/object-capability-gaps.json`.
import fs from 'node:fs';
import path from 'node:path';

const TARGET = /(?:^|\/)app\/command-table\/object-capabilities\.ts$/u;
const BLOCK_RE = /const\s+GAP_CELLS_BY_BEAD\b[^=]*=\s*\{([\s\S]*?)\n\}/u;
const ENTRY_RE = /'([^']+)'\s*:\s*\[([^\]]*)\]/gu;
const CELL_RE = /'([^']+)'/gu;

/** Collects every `kind:capability` gap entry declared in `GAP_CELLS_BY_BEAD`. */
export function collect({ root, paths }) {
  const sites = [];
  for (const file of paths) {
    if (!TARGET.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const block = BLOCK_RE.exec(text)?.[1];
    if (!block) continue;
    for (const match of block.matchAll(ENTRY_RE)) {
      const cellsText = match[2];
      for (const cellMatch of cellsText.matchAll(CELL_RE)) {
        sites.push({ rule: 'object-capability-gaps', name: cellMatch[1], path: file });
      }
    }
  }
  return sites;
}
