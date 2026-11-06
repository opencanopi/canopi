// policy/core/base.mjs: the policy checker's shared constants and refusal shape (2.1-M348): the repository root, the
// policy file locations, a refusal and the RefusalError thrown where no refusal list is returned. Every policy module
// reads these from here, never restating them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RATCHETS_DIR = 'policy/ratchets';
export const SCHEMA_FILE = `${RATCHETS_DIR}/ratchet.schema.json`;
export const LAYER_TABLE = 'policy/layers.json';
/** A tool's adapter, the registry of tools: a family's tool is valid only with one. */
export const adapterFile = (tool) => `policy/adapters/${tool}.mjs`;
/** The directory the layer table's module paths are relative to. */
export const MODULE_ROOT = 'desktop/web/src';
export const CASES_DIR = 'policy/fixtures/check';
/** Planted violations and recorded tool output: never a family's site, whatever its scope. */
export const FIXTURES_DIR = 'policy/fixtures';
export const POLICY_DIR = 'policy';
/** The table that holds the required rows and the plan's phase order. */
export const RULES_TABLE = `${POLICY_DIR}/rules.json`;

export const refusal = (code, where, message) => ({ code, where, message });

/** A refusal thrown where no refusal list is returned (the diff). */
export class RefusalError extends Error {
  constructor(code, where, message) {
    super(`${code}: ${where}: ${message}`);
    Object.assign(this, { code, where });
  }
}
export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isRepoPath(p) {
  return p.trim() === p && !p.startsWith('/') && !p.endsWith('/') && !p.includes('\\') && !p.includes(': ')
    && p.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}
