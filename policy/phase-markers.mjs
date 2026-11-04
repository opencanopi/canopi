// policy/phase-markers.mjs: the "to be created by Phase N" markers a phase close leaves stale (canopi-f47t.52.258;
// design check AR14). ADRs and guides mark a check they promise with the phase that builds it; once that phase closes the
// check exists or was re-planned, so `check.mjs --phase-close <phase>` refuses each marker naming <phase> or an earlier
// one in rules.json's `phases` order, never a `closed` field (the order alone serves, and four readers use the bare
// list). Pure file reads over the tracked Markdown; the decision ledgers (docs/decisions/) are kept history, never read.
import fs from 'node:fs';
import path from 'node:path';
import { refusal } from './core/base.mjs';
import { listFiles } from './core/exec.mjs';

/** The marker and the phase text after it, up to the clause's end (a full stop ends it, the dots of 2.0.4 do not). */
const MARKER = /to be created by (?:phases? )?([^);:,\n]+?)(?=[);:,\n]|\.(?:\s|$)|$)/giu;
const KEPT_HISTORY = /^docs\/decisions\//u;

/**
 * The phase a marker's text names, as an index in `phases`, or -1 when it names none (a quoted placeholder). Parts
 * joined by "and" each name the last label they hold, so "3 N1" is the step N1 and "0 F4" the stream F4; the marker is
 * due at the latest part.
 *
 * @testonly
 */
export function markerPhase(text, phases) {
  return Math.max(-1, ...text.split(/\s+and\s+/u).map((part) => {
    const labels = part.split(/\s+/u).filter((token) => phases.includes(token));
    return labels.length ? phases.indexOf(labels.at(-1)) : -1;
  }));
}

/** At `--phase-close <phase>`, a `phase-marker` refusal per marker whose phase is <phase> or earlier; none for an unknown phase. */
export function phaseMarkerRefusals(root, phases, phase) {
  const at = phases.indexOf(phase);
  if (at === -1) return [];
  const refusals = [];
  for (const file of listFiles(root).filter((f) => f.endsWith('.md') && !KEPT_HISTORY.test(f)).sort()) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
      for (const [marker, named] of line.matchAll(MARKER)) {
        const due = markerPhase(named.trim(), phases);
        if (due === -1 || due > at) continue;
        refusals.push(refusal('phase-marker', `${file}:${i + 1}`, `"${marker.trim()}": phase ${phases[due]} has closed with --phase-close ${phase}; say what exists (built in Phase ${phases[due]}) or re-plan it`));
      }
    });
  }
  return refusals;
}
