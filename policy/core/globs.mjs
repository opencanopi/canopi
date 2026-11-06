// policy/core/globs.mjs: the repository's one glob engine, picomatch, loaded from desktop/web (2.1-M348).
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT, RefusalError } from './base.mjs';

/** Where the one glob engine is installed: desktop/web, whose lockfile pins it (K2's one-glob-engine note). */
export const GLOB_ENGINE_BASE = path.join(REPO_ROOT, 'desktop/web');
let picomatch;

/**
 * picomatch, the repository's one glob engine (the generator, the checker and the CSS policy test share it), required
 * from `base`'s installed packages; missing, it is a `glob-engine` refusal naming `npm ci`, never a stack trace.
 */
export function loadGlobEngine(base = GLOB_ENGINE_BASE) {
  try {
    return createRequire(path.join(base, 'package.json'))('picomatch');
  } catch {
    throw new RefusalError('glob-engine', `${path.relative(REPO_ROOT, base) || '.'}/node_modules/picomatch`, 'the glob engine is not installed; run npm ci in desktop/web');
  }
}

const matchers = new Map();
/**
 * Whether the repository path `p` matches the scope glob `glob`: picomatch with `dot: true`, so a wildcard matches a
 * segment that starts with a dot and `**` reaches .github/, .cargo/ and every dotfile a family must count, and with
 * `posix: true`, so `[!x]` is a negated class (without it picomatch 4 also reads `[!x]` as the literal text).
 */
export function matchesGlob(p, glob) {
  picomatch ??= loadGlobEngine();
  let match = matchers.get(glob);
  if (!match) {
    match = picomatch(glob, { dot: true, posix: true });
    matchers.set(glob, match);
  }
  return match(p);
}
