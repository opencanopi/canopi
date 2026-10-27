// canvas-commands-reach-no-platform: a planted Node built-in subpath (`node:fs/promises`), which dependency-cruiser
// names `fs/promises`, the rule forbids.
import { readFile } from 'node:fs/promises';
export const plantedBuiltin = readFile;
