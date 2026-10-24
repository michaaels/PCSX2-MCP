// node test/visual-live.mjs <PCSX2> <project-manifest> <configured-data-root> <new-output>
// The deliberate mismatch alters a reference PNG, never the running guest.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { decodeVisualPng, visualHash } from '../dist/visual-comparison.js';

assert.equal(process.argv.length, 6);
const [executable, manifestPath, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
const manifest = JSON.parse(await fs.readFile(manifestPath));
const elf = path.join(path.dirname(manifestPath), manifest.debug_elf);
await fs.mkdir(output); const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
await fs.copyFile(path.join(configured, 'inis', 'PCSX2.ini'), path.join(root, 'inis', 'PCSX2.ini'));
const reservation = createServer(); await new Promise((resolve, reject) => {
  reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'visual-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const result = { started_at: new Date().toISOString(), build_id: manifest.build_id,
  elf_sha256: manifest.elf_sha256, checks: [], hardware: 'not_tested', passed: false,
  induced_mismatch: 'reference_PNG_fixture_perturbed_not_guest_code_or_behavior' };
let owned = false;
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 }); }
async function call(name, args = {}) {
  const response = await raw(name, args); assert.ok(!response.isError, 'MCP ' + name + ' failed');
  return JSON.parse(response.content[0].text);
}
function passed(message) { result.checks.push(message); console.log('PASS ' + message); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  const launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true;
  assert.equal(launch.sha256, manifest.elf_sha256); await inspector.connect();
  let boot = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await inspector.getCapabilities()).elf_crc === manifest.pcsx2_crc) {
      let cursor = 0;
      for (let page = 0; page < 11; page++) {
        const logs = await inspector.readLogs(cursor, 200);
        boot ||= logs.logs.some(log => /^JFCLIENT event=boot /.test(log.message));
        if (logs.next_cursor === cursor) break; cursor = logs.next_cursor;
      }
      if (boot) { try { await inspector.captureScreenshot(320, 240); break; } catch {} }
    }
    await delay(200);
  }
  assert.ok(boot, 'SMS boot marker not observed');
  await inspector.pause(); await inspector.captureScreenshot(320, 240);
  const native = await inspector.captureScreenshot(320, 240);
  const baseline = Buffer.from(native.data, 'base64'), decoded = decodeVisualPng(baseline);
  assert.ok(decoded.width >= 8 && decoded.height >= 8);
  const reference = path.join(output, 'native-reference.png'); await fs.writeFile(reference, baseline, { flag: 'wx' });
  result.native_reference = { path: reference, sha256: visualHash(baseline), width: decoded.width, height: decoded.height };
  passed('actual SMS boot/ELF hash and native PNG captured in a private owned Windows instance');
  const step = { action: 'assert_screenshot', width: 320, height: 240, baseline_path: reference,
    baseline_sha256: visualHash(baseline), expected_elf_sha256: manifest.elf_sha256 };
  const half = Math.floor(decoded.width / 2), regions = [
    { name: 'left', x: 0, y: 0, width: half, height: decoded.height },
    { name: 'right', x: half, y: 0, width: decoded.width - half, height: decoded.height },
  ];
  const before = await inspector.getStatus();
  const exact = await call('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'native-two-region-match',
    expected_elf_crc: manifest.pcsx2_crc, steps: [{ ...step, policy: { regions } }] } });
  assert.ok(exact.passed && exact.final_paused); assert.deepEqual(await inspector.getStatus(), before);
  const comparison = exact.steps[0].result; assert.equal(comparison.observation.elf_sha256, manifest.elf_sha256);
  assert.ok(comparison.regions.every(r => r.pixels_over_tolerance === 0)); result.exact = exact.artifacts.report;
  passed('real screenshot scenario matches both exact pixel regions, pins current ELF/epoch and preserves paused PC/cycles');
  const changed = new PNG({ width: decoded.width, height: decoded.height }); decoded.data.copy(changed.data);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) changed.data[(y * decoded.width + x) * 4] ^= 255;
  const altered = PNG.sync.write(changed), alteredPath = path.join(output, 'perturbed-reference-fixture.png');
  await fs.writeFile(alteredPath, altered, { flag: 'wx' });
  const failed = await raw('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'controlled-reference-regression',
    expected_elf_crc: manifest.pcsx2_crc, steps: [{ ...step, baseline_path: alteredPath, baseline_sha256: visualHash(altered), policy: { regions } },
      { action: 'frames', frames: 10 }] } });
  assert.equal(failed.isError, true); const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.passed, false); assert.equal(failure.steps.length, 1); assert.ok(failure.final_paused);
  assert.equal(failure.steps[0].result.regions[0].pixels_over_tolerance, 16);
  assert.equal(failure.steps[0].result.regions[1].pixels_over_tolerance, 0);
  assert.deepEqual(await inspector.getStatus(), before); result.induced_failure = failure.artifacts.report;
  passed('controlled 4x4 reference perturbation fails exactly one region, saves diff/input evidence and prevents the next frame-execution step');
  const masked = await call('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'explicit-mask',
    steps: [{ ...step, baseline_path: alteredPath, baseline_sha256: visualHash(altered),
      policy: { ignore_regions: [{ x: 1, y: 1, width: 4, height: 4 }] } }] } });
  assert.equal(masked.steps[0].result.coverage.ignored_pixels, 16); assert.ok(masked.passed);
  result.masked = masked.artifacts.report;
  passed('an explicit ignored rectangle removes only the 16 fixture pixels from live comparison coverage');
  const small = new PNG({ width: decoded.width, height: decoded.height }); decoded.data.copy(small.data);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) small.data[(y * decoded.width + x) * 4] ^= 3;
  const smallBytes = PNG.sync.write(small), smallPath = path.join(output, 'small-delta-reference-fixture.png');
  await fs.writeFile(smallPath, smallBytes, { flag: 'wx' });
  const tolerant = await call('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'channel-tolerance',
    steps: [{ ...step, baseline_path: smallPath, baseline_sha256: visualHash(smallBytes),
      policy: { regions: [{ ...regions[0], channel_tolerance: 3 }, regions[1]] } }] } });
  assert.ok(tolerant.passed); assert.equal(tolerant.steps[0].result.regions[0].pixels_with_any_difference, 16);
  assert.equal(tolerant.steps[0].result.regions[0].pixels_over_tolerance, 0); result.tolerant = tolerant.artifacts.report;
  passed('per-region channel tolerance accepts bounded sample deltas while retaining all 16 raw differing pixels');
  const budget = await call('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'pixel-fraction-boundary',
    steps: [{ ...step, baseline_path: alteredPath, baseline_sha256: visualHash(altered),
      policy: { regions: [{ ...regions[0], max_changed_fraction: 16 / (half * decoded.height) }, regions[1]] } }] } });
  assert.ok(budget.passed); assert.equal(budget.steps[0].result.regions[0].pixels_over_tolerance, 16);
  result.pixel_budget = budget.artifacts.report;
  passed('per-region pixel budget accepts its exact 16-pixel fraction boundary without rounding the verdict');
  const legacy = await call('pcsx2_run_scenario', { output_directory: output, scenario: { name: 'legacy-encoded-SHA',
    steps: [{ action: 'screenshot', width: 320, height: 240, expected_sha256: visualHash(baseline) }] } });
  assert.ok(legacy.passed); result.legacy = legacy.artifacts.report;
  passed('legacy encoded-PNG SHA screenshot assertion retains its exact-byte semantics');
  assert.equal((await call('pcsx2_stop')).stopped, true); owned = false;
  passed('owned emulator stops through MCP and offline comparisons require no emulator connection');
  const rgb = PNG.sync.write(changed, { colorType: 2, inputColorType: 6 });
  const rgbaPath = path.join(output, 'reencoded-rgb.png'); await fs.writeFile(rgbaPath, rgb, { flag: 'wx' });
  const offline = await call('pcsx2_compare_screenshots', { baseline_path: alteredPath, baseline_sha256: visualHash(altered),
    current_path: rgbaPath, current_sha256: visualHash(rgb), output_directory: output });
  assert.ok(offline.passed); assert.notEqual(visualHash(altered), visualHash(rgb));
  assert.equal(offline.observation.vm_identity, 'not_observed_offline'); result.offline = offline.artifacts.report;
  passed('offline MCP tool compares equal decoded pixels across different RGB/RGBA encodings without a VM');
  const rejected = await raw('pcsx2_compare_screenshots', { baseline_path: alteredPath, baseline_sha256: '0'.repeat(64),
    current_path: rgbaPath, current_sha256: visualHash(rgb), output_directory: output });
  assert.equal(rejected.isError, true);
  passed('offline MCP rejects a stale reference SHA instead of accepting a different baseline');
  result.passed = true;
} finally {
  inspector.disconnect();
  if (owned) {
    const response = await raw('pcsx2_stop'); result.cleanup_confirmed = !response.isError;
    if (response.isError) result.passed = false;
  } else result.cleanup_confirmed = true;
  await mcp.close(); result.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2));
}
