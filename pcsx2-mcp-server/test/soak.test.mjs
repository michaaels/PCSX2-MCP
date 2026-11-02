import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkResources, limits } from './soak-support.mjs';
import { artifactUsage } from './soak-support.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('soak resource gates reject absolute/growth limits, invalid counters and reused PID', () => {
  const row = { pid: 7, started: 'boot', private_bytes: 100, working_set: 100, handles: 10, cpu_seconds: 2 };
  checkResources(row, 'native', row);
  for (const role of ['native', 'mcp']) {
    assert.throws(() => checkResources({ ...row, private_bytes: limits[role + '_private'] + 1 }, role));
    assert.throws(() => checkResources({ ...row, private_bytes: limits[role + '_growth'] + 101 }, role, row));
  }
  assert.throws(() => checkResources({ ...row, handles: limits.handles + 1 }, 'native'));
  assert.throws(() => checkResources({ ...row, handles: limits.handle_growth + 11 }, 'native', row));
  assert.throws(() => checkResources({ ...row, cpu_seconds: 1 }, 'native', row));
  assert.throws(() => checkResources({ ...row, started: 'another boot' }, 'native', row));
  assert.throws(() => checkResources({ ...row, private_bytes: NaN }, 'native'));
});

test('soak artifact budget counts nested files and refuses oversized artifacts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soak-budget-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'nested'));
  const file = path.join(directory, 'nested', 'artifact');
  await fs.writeFile(file, '1234');
  assert.deepEqual(await artifactUsage(directory), { bytes: 4, files: 1 });
  await fs.truncate(file, limits.artifact_bytes + 1);
  await assert.rejects(artifactUsage(directory), /Artifact byte budget exceeded/);
});
