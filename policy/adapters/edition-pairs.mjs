// policy/adapters/edition-pairs.mjs: every *.desktop.ts(x) or *.browser.ts(x) module sits directly in
// desktop/web/src/platform/ beside a port module with the same stem (contracts §22, design check F3).
//
// Generated from one table (EDITION_PAIRS) rather than hand-written per pair; policy/generate/depcruise.mjs reads the
// same table for the edition-roots adapter-import rules. Works over both desktop/web/src/ and its planted mirror
// policy/fixtures/rules/<id>/src/ so --self-test runs the real adapter on planted violations.
import fs from 'node:fs';
import path from 'node:path';

/** The edition adapter suffixes and their edition names, shared with dependency-cruiser rule generation. */
export const EDITION_PAIRS = [
  { edition: 'desktop', suffix: '.desktop' },
  { edition: 'browser', suffix: '.browser' },
];

const SUFFIX_RE = new RegExp(`(${EDITION_PAIRS.map((p) => p.suffix.replace('.', '\\.')).join('|')})\\.tsx?$`, 'u');
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/u;
const SRC_ROOT = /^(?:desktop\/web|policy\/fixtures\/rules\/[^/]+)\/src\//u;

/** Whether `stem` has a sibling port file (`<stem>.ts` or `<stem>.tsx`) directly under `<srcRoot>platform/`. */
function hasSiblingPort(root, srcRoot, stem) {
  return ['.ts', '.tsx'].some((ext) => fs.statSync(path.join(root, `${srcRoot}platform/${stem}${ext}`), { throwIfNoEntry: false })?.isFile());
}

/** Collects every edition-suffixed file outside platform/ or missing its sibling port in platform/. */
export function collect({ root, paths }) {
  const sites = [];
  for (const file of paths) {
    if (TEST_FILE.test(file)) continue;
    const srcMatch = SRC_ROOT.exec(file);
    if (!srcMatch) continue;
    const suffixMatch = SUFFIX_RE.exec(file);
    if (!suffixMatch) continue;
    const srcRoot = srcMatch[0];
    const rel = file.slice(srcRoot.length);
    const inPlatformRoot = /^platform\/[^/]+$/u.test(rel);
    const stem = path.posix.basename(rel).slice(0, -suffixMatch[0].length);
    if (!inPlatformRoot || !hasSiblingPort(root, srcRoot, stem)) {
      sites.push({ rule: 'edition-pairs', path: file });
    }
  }
  return sites;
}
