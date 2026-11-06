// policy/check.mjs's timings (canopi-f47t.52.240): where a run's time goes, per observed family, so the suite's cost
// can be measured before it is cut. The real entry over this repository, one cheap family.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('canopi-f47t.52.240: a check prints each observed family\'s wall time and appends one JSON line to CANOPI_POLICY_TIMINGS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-timings-'));
  const file = path.join(dir, 'timings.jsonl');
  fs.writeFileSync(file, '{"earlier":true}\n');
  try {
    const run = spawnSync(process.execPath, ['policy/check.mjs', '--family', 'python-lines'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, CANOPI_POLICY_TIMINGS: file },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^policy check timings: .*python-lines \d+\.\d s/m);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'the run appends, never overwrites');
    const line = JSON.parse(lines[1]);
    assert.deepEqual(Object.keys(line.families), ['python-lines']);
    assert.equal(line.lane, 'commit');
    for (const value of [line.families['python-lines'], line.setup, line.total]) assert.equal(typeof value, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
