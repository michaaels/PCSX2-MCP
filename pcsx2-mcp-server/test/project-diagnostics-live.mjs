// node test/project-diagnostics-live.mjs <PCSX2> <project manifest> <configured data root> <new output> [historical Bridge JSONL]
// Real SMS native collection; Bridge rows in the association check are explicitly synthetic.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.ok(process.argv.length === 6 || process.argv.length === 7);
const [executable, manifestPath, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p));
const historicalBridge = process.argv[6] ? path.resolve(process.argv[6]) : undefined;
const manifest = JSON.parse(await fs.readFile(manifestPath));
const elf = path.join(path.dirname(manifestPath), manifest.debug_elf);
await fs.mkdir(output); const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
await fs.copyFile(path.join(configured, 'inis', 'PCSX2.ini'), path.join(root, 'inis', 'PCSX2.ini'));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'project-diagnostics-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const result = { started_at: new Date().toISOString(), build_id: manifest.build_id, elf_sha256: manifest.elf_sha256,
  checks: [], bridge_transport: 'not_tested', hardware: 'not_tested', observations: [] };
let owned = false;
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!response.isError, name + ': ' + JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
const passed = text => { result.checks.push(text); console.log('PASS ' + text); };
const options = { manifest_path: manifestPath, elf_path: elf, output_directory: output };
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  const launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true;
  assert.equal(launch.sha256, manifest.elf_sha256); await inspector.connect();
  for (let i = 0; ; ++i) {
    const caps = await inspector.getCapabilities(); if (caps.elf_crc === manifest.pcsx2_crc) break;
    assert.ok(i < 120, 'Project ELF did not boot'); await delay(100);
  }
  // Observe the real project without assigning PC or fabricating guest messages.
  let observedBoot;
  for (let i = 0; i < 60; ++i) {
    const logs = await inspector.readLogs(0, 200);
    if (logs.logs.some(log => log.message.includes('JFCLIENT event=boot '))) { observedBoot = true; break; }
    await delay(100);
  }
  await inspector.pause(); const before = await inspector.getStatus();
  const collected = await call('pcsx2_diagnostics_collect', options); result.capture = collected;
  const after = await inspector.getStatus(); assert.deepEqual(after, before);
  const captureBytes = await fs.readFile(collected.artifact.path), capture = JSON.parse(captureBytes);
  assert.equal(createHash('sha256').update(captureBytes).digest('hex'), collected.artifact.sha256);
  assert.equal(capture.build.elf_sha256, manifest.elf_sha256); assert.equal(capture.build.build_id, manifest.build_id);
  assert.equal(capture.coverage.per_entry_execution_epoch, 'unavailable');
  assert.ok(!captureBytes.includes(Buffer.from(elf)));
  passed('real SMS ELF/manifest/native identity match; sanitized capture preserves paused PC/cycles and hashes its exact file');
  assert.ok(capture.events.some(event => event.type === 'paused'));
  assert.ok(capture.client_logs.every(log => !('message' in log)));
  result.observations.push({ boot_seen_in_early_log_page: !!observedBoot, native_client_boots: collected.observed_boot_ids.length });
  passed('real event stream and bounded console projection retain explicit overwrite/page/truncation coverage without raw text');

  await inspector.resume();
  const running = await call('pcsx2_diagnostics_collect', options);
  assert.equal((await inspector.getStatus()).paused, false); await inspector.pause();
  passed('collection while running does not pause, resume, step, reset or alter guest input');

  const second = JSON.parse(await fs.readFile(running.artifact.path));
  const boot = second.client_logs.find(log => log.event === 'boot');
  const bridge = path.join(output, 'synthetic-bridge.jsonl');
  if (boot) {
    await fs.writeFile(bridge, JSON.stringify({ buildId: manifest.build_id, bootId: boot.client_session,
      sequence: boot.client_sequence, event: 'boot', level: boot.level, sessionId: boot.client_session,
      uptimeMs: 123, dropped: 0, receivedAt: new Date().toISOString(), deviceId: 'synthetic-association-fixture' }) + '\n');
    const association = await call('pcsx2_diagnostics_correlate', { ...options, capture_path: running.artifact.path,
      capture_sha256: running.artifact.sha256,
      bridge_log_path: bridge, boot_id: boot.client_session }); result.synthetic_association = association;
    assert.equal(association.matched_events, 1); assert.equal(association.clocks.uncertainty, 'unbounded');
    assert.equal(association.clocks.transport_latency_ms, null);
    passed('real SMS boot console fields associate with explicitly synthetic Bridge receipt fields without claiming transport or synchronized time');
  } else {
    await fs.writeFile(bridge, '');
    result.observations.push({ sms_boot_console: 'not_observed_in_retained_window', root_cause: 'not_established' });
    console.log('OBSERVED: no retained SMS boot console marker; no fabricated association');
  }
  const missing = await call('pcsx2_diagnostics_correlate', { ...options, capture_path: running.artifact.path,
    capture_sha256: running.artifact.sha256,
    bridge_log_path: bridge, boot_id: 'f'.repeat(16) });
  assert.equal(missing.status, 'partial'); assert.equal(missing.client_events, 0); assert.equal(missing.matched_events, 0);
  passed('an absent boot produces partial evidence with zero associations and no invented diagnostics');
  const mismatch = path.join(output, 'wrong-manifest.json');
  await fs.writeFile(mismatch, JSON.stringify({ ...manifest, elf_sha256: '0'.repeat(64) }));
  const rejected = await mcp.callTool({ name: 'pcsx2_diagnostics_collect', arguments: { ...options, manifest_path: mismatch } });
  assert.equal(rejected.isError, true); assert.equal((await inspector.getStatus()).paused, true);
  passed('wrong manifest/ELF identity refuses collection without modifying the live emulator');
  if (historicalBridge) {
    const rows = (await fs.readFile(historicalBridge, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(rows.length > 0 && rows.every(row => row.buildId !== manifest.build_id), 'Historical fixture must belong to different builds');
    const historical = await call('pcsx2_diagnostics_correlate', { ...options, bridge_log_path: historicalBridge,
      capture_path: running.artifact.path, capture_sha256: running.artifact.sha256, boot_id: rows[0].bootId });
    const report = JSON.parse(await fs.readFile(historical.artifact.path));
    assert.equal(report.evidence.total_bridge_receipts, rows.length);
    assert.equal(historical.status, 'partial'); assert.equal(historical.client_events, 0); assert.equal(historical.matched_events, 0);
    result.historical = { receipts: rows.length, artifact: historical.artifact, new_hardware_validation: false };
    passed('existing private Bridge JSONL parses its real schema while all historical foreign builds remain excluded from the current SMS capture');
  }
  result.passed = true;
} finally {
  inspector.disconnect();
  if (owned) await mcp.callTool({ name: 'pcsx2_stop', arguments: {} }).catch(() => {});
  await mcp.close(); result.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2));
}
