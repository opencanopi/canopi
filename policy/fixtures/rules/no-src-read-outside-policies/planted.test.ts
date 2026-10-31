// Planted violation of no-src-read-outside-policies (ADR 0028, 2.1-M20): a test asserting a module's source text.
import { readFileSync } from 'node:fs'

export const plantedSource = (): string => readFileSync('src/maplibre/site-overlay.ts', 'utf8')
