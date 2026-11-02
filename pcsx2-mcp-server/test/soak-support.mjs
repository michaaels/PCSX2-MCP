import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const limits = Object.freeze({
  native_private: 1536 * 1024 ** 2, mcp_private: 256 * 1024 ** 2,
  native_growth: 256 * 1024 ** 2, mcp_growth: 64 * 1024 ** 2,
  handles: 4096, handle_growth: 512, artifact_bytes: 256 * 1024 ** 2,
  artifact_files: 384, log_bytes: 4 * 1024 ** 2,
});

// Inspect only explicitly owned PIDs; process start time prevents PID reuse.
export async function resources(pids) {
  assert.ok(pids.every(p => Number.isInteger(p) && p > 0));
  const script = `$ErrorActionPreference='Stop'; @(Get-Process -Id ${pids.join(',')} | ForEach-Object { [pscustomobject]@{pid=$_.Id;started=$_.StartTime.ToUniversalTime().ToString('o');private_bytes=$_.PrivateMemorySize64;working_set=$_.WorkingSet64;handles=$_.HandleCount;cpu_seconds=$_.CPU} }) | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, pids.length, 'Missing owned process');
  return rows;
}

export function checkResources(row, role, baseline) {
  for (const key of ['pid', 'private_bytes', 'working_set', 'handles', 'cpu_seconds'])
    assert.ok(Number.isFinite(row[key]) && row[key] >= 0, 'Invalid resource ' + key);
  assert.ok(row.private_bytes <= limits[role + '_private'], role + ' private memory ceiling exceeded');
  assert.ok(row.handles <= limits.handles, role + ' handle ceiling exceeded');
  if (baseline) {
    assert.equal(row.pid, baseline.pid); assert.equal(row.started, baseline.started, 'PID reused');
    assert.ok(row.cpu_seconds >= baseline.cpu_seconds, 'CPU counter regressed');
    assert.ok(row.private_bytes - baseline.private_bytes <= limits[role + '_growth'], role + ' memory growth ceiling exceeded');
    assert.ok(row.handles - baseline.handles <= limits.handle_growth, role + ' handle growth ceiling exceeded');
  }
}

export async function artifactUsage(directory) {
  let bytes = 0, files = 0;
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = directory + '/' + item.name;
    assert.ok(!item.isSymbolicLink(), 'Unexpected artifact symlink');
    if (item.isDirectory()) { const sub = await artifactUsage(full); bytes += sub.bytes; files += sub.files; }
    else { bytes += (await fs.stat(full)).size; files++; }
  }
  assert.ok(bytes <= limits.artifact_bytes, 'Artifact byte budget exceeded');
  assert.ok(files <= limits.artifact_files, 'Artifact file budget exceeded');
  return { bytes, files };
}
