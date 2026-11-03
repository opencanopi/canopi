// policy/core/path-filters.mjs: path-filter-matches-a-file (design check AR23; 2.1-M348), path drift carried past the
// family files to the path filters other tools read. Each must match a tracked or unignored file, so a renamed path
// never leaves a filter that silently selects nothing:
//   - every glob of a workflow's `on.<event>.paths` and `paths-ignore` (.github/workflows/*.yml), a `!` negation by the
//     glob it negates; a workflow that is not YAML is refused, never read as one without filters;
//   - every include and exclude glob of a floor family's vitest floors, relative to desktop/web (vite's root);
//   - every path alternative of a cargo-llvm-cov exclude regex: each alternative of a top-level group, put back alone
//     in its group, must match a file (an alternative naming no path, as `^` in `(^|/)`, is no path), and a regex
//     without such a group must match one whole.
// Globs are read by the one glob engine (core/globs.mjs) and workflows by desktop/web's `yaml`, both needing its npm ci.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { refusal, RefusalError, REPO_ROOT } from './base.mjs';
import { GLOB_ENGINE_BASE, matchesGlob } from './globs.mjs';
import { shapeOf } from './ratchets.mjs';

const CODE = 'path-filter-matches-a-file';
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const FILTERS = ['paths', 'paths-ignore'];
/** Each coverage tool's filters: globs under a root, or regexes over repository paths. */
const COVERAGE = { vitest: { glob: 'desktop/web/' }, 'cargo-llvm-cov': { regex: true } };

let yaml;
function loadYaml() {
  try {
    yaml ??= createRequire(path.join(GLOB_ENGINE_BASE, 'package.json'))('yaml');
    return yaml;
  } catch {
    throw new RefusalError('glob-engine', `${path.relative(REPO_ROOT, GLOB_ENGINE_BASE)}/node_modules/yaml`, 'the YAML reader is not installed; run npm ci in desktop/web');
  }
}

/** The regex `source` once per path alternative of each top-level group, that group holding only the alternative. */
export function regexAlternatives(source) {
  const out = [];
  let depth = 0;
  let start;
  let cuts = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') { while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1; continue; }
    if (c === '(') {
      if (depth === 0) { start = i + 1 + (source.startsWith('?:', i + 1) ? 2 : 0); cuts = []; }
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        const bounds = [start, ...cuts.flatMap((at) => [at, at + 1]), i];
        for (let k = 0; k < bounds.length; k += 2) {
          const alt = source.slice(bounds[k], bounds[k + 1]);
          if (cuts.length && /[A-Za-z0-9]/u.test(alt.replace(/\\./gu, ''))) out.push(`${source.slice(0, start)}${alt}${source.slice(i)}`);
        }
      }
    } else if (c === '|' && depth === 1) cuts.push(i);
  }
  return out.length ? out : [source];
}

/** The refusals for each path filter under `root` that matches none of `files` (repository paths). */
export function pathFilterRefusals(root, families, files) {
  const refusals = [];
  for (const file of files.filter((f) => WORKFLOW.test(f))) {
    let doc;
    try {
      doc = loadYaml().parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (error) {
      if (error instanceof RefusalError) throw error;
      refusals.push(refusal(CODE, file, `cannot be read as YAML: ${error.message.split('\n')[0]}`));
      continue;
    }
    const on = doc?.on ?? doc?.true;
    for (const [event, spec] of Object.entries(typeof on === 'object' && on !== null && !Array.isArray(on) ? on : {})) {
      for (const filter of FILTERS) {
        for (const glob of Array.isArray(spec?.[filter]) ? spec[filter] : []) {
          const bare = String(glob).replace(/^!/u, '');
          if (!files.some((f) => matchesGlob(f, bare))) refusals.push(refusal(CODE, file, `on.${event}.${filter} ${glob} matches no file`));
        }
      }
    }
  }
  for (const { file, doc } of families.values()) {
    if (shapeOf(doc) !== 'floors') continue;
    for (const [tool, held] of Object.entries(doc.floors)) {
      const kind = COVERAGE[tool];
      if (!kind) continue;
      for (const field of ['include', 'exclude']) {
        for (const filter of held[field] ?? []) {
          if (kind.glob !== undefined) {
            if (!files.some((f) => f.startsWith(kind.glob) && matchesGlob(f.slice(kind.glob.length), filter))) {
              refusals.push(refusal(CODE, file, `${tool} ${field} ${filter} matches no file under ${kind.glob}`));
            }
            continue;
          }
          for (const alternative of regexAlternatives(filter)) {
            const re = new RegExp(alternative);
            if (!files.some((f) => re.test(f))) refusals.push(refusal(CODE, file, `${tool} ${field} alternative ${alternative} matches no file`));
          }
        }
      }
    }
  }
  return refusals;
}
