// node test/progress-live.mjs <PCSX2> <heartbeat ELF> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

const [executable, elf, output] = process.argv.slice(2); assert.ok(output);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'progress-'));
const identity = await inspectSourceElf(path.resolve(elf)), bytes = await fs.readFile(elf);
const mcp = new Client({ name: 'progress-live', version: '1.0' });
let inspector = new DebugServerClient(), owns = false;
const report = { elf, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [], results: [] };
const hex = n => '0x' + n.toString(16).padStart(8, '0');
function symbol(name) {
  const table = bytes.readUInt32LE(32), stride = bytes.readUInt16LE(46), count = bytes.readUInt16LE(48);
  for (let section = 0; section < count; section++) {
    const h = table + section * stride;
    if (bytes.readUInt32LE(h + 4) !== 2) continue;
    const strings = bytes.readUInt32LE(table + bytes.readUInt32LE(h + 24) * stride + 16);
    const begin = bytes.readUInt32LE(h + 16), end = begin + bytes.readUInt32LE(h + 20), size = bytes.readUInt32LE(h + 36);
    assert.ok(size >= 16);
    for (let entry = begin; entry < end; entry += size) {
      const start = strings + bytes.readUInt32LE(entry);
      if (bytes.subarray(start, bytes.indexOf(0, start)).toString('utf8') === name) return hex(bytes.readUInt32LE(entry + 4));
    }
  }
  throw new Error('Missing linked fixture symbol: ' + name);
}
async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!result.isError, name + ': ' + JSON.stringify(result.content)); return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
async function write(name, value) {
  const data = Buffer.alloc(4); data.writeUInt32LE(value); await inspector.writeMemory(symbol(name), data.toString('hex'));
}
async function boot() {
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'source-debug.c', line: 7, expected_sha256: identity.sha256 });
  let h = await inspector.readEvents(0, 200);
  while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: h.next_cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
}
async function arm(options = {}) {
  return call('pcsx2_progress_watch_start', { heartbeat_address: symbol('progress_heartbeat'), active_address: symbol('progress_active'),
    sample_interval_ms: 50, stall_ms: 300, timeout_ms: 5000, screenshot: false, ...options });
}
async function read(watch, wait_ms = 0, save = false) {
  const value = await call('pcsx2_progress_report', { watch_id: watch.watch_id, wait_ms, ...(save ? { output_directory: directory } : {}) });
  report.results.push(value); return value;
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause(); await boot();
  const caps = await inspector.getCapabilities(); assert.ok(caps.features.includes('ee_progress_watch'));
  const before = await inspector.getStatus();
  await assert.rejects(inspector.startProgressWatch('a'.repeat(32), { ...caps, execution_epoch: caps.execution_epoch + 1 },
    { heartbeat_address: symbol('progress_heartbeat') }), /identity changed/);
  assert.deepEqual(await inspector.getStatus(), before);
  const expiry = await arm({ timeout_ms: 200 }); assert.equal(expiry.resumes_vm, false);
  await delay(350); assert.equal((await read(expiry)).state, 'expired');
  assert.deepEqual(await inspector.getStatus(), before);
  passed('stale VM identity refuses arming; arming and wall TTL expiry never resume a paused VM');

  const owned = await arm();
  const foreign = await mcp.callTool({ name: 'pcsx2_progress_watch_cancel', arguments: { watch_id: 'f'.repeat(32) } });
  assert.equal(foreign.isError, true); assert.equal((await read(owned)).state, 'armed');
  assert.equal((await mcp.callTool({ name: 'pcsx2_exception_watch_start', arguments: {} })).isError, true);
  assert.equal((await mcp.callTool({ name: 'pcsx2_progress_watch_start', arguments: { heartbeat_address: symbol('progress_heartbeat') } })).isError, true);
  assert.equal((await call('pcsx2_progress_watch_cancel', { watch_id: owned.watch_id })).state, 'cancelled');
  const exception = await call('pcsx2_exception_watch_start', { screenshot: false });
  assert.equal((await mcp.callTool({ name: 'pcsx2_progress_watch_start', arguments: { heartbeat_address: symbol('progress_heartbeat') } })).isError, true);
  await call('pcsx2_exception_watch_cancel', { watch_id: exception.watch_id });
  passed('foreign cancellation and conflicting exception/progress watches preserve the active owner');

  const healthy = await arm({ timeout_ms: 900 });
  await inspector.resume(); assert.equal((await read(healthy, 2000)).state, 'expired');
  assert.ok(Buffer.from(await inspector.readMemory(symbol('progress_heartbeat'), 4), 'hex').readUInt32LE() > 1);
  assert.equal((await inspector.getStatus()).paused, false); await inspector.pause();
  passed('running heartbeat changes do not trigger a stall observation');
  await boot(); await write('progress_mode', 1); await write('progress_active', 0);
  const waiting = await arm({ timeout_ms: 900 }); await inspector.resume();
  const expectedWait = await read(waiting, 2000); assert.equal(expectedWait.state, 'expired');
  assert.ok(expectedWait.total_samples >= 3); assert.equal(expectedWait.unchanged_ms, 0);
  assert.equal((await inspector.getStatus()).paused, false); await inspector.pause();
  passed('explicit expected-wait gate suppresses a stationary heartbeat while EE continues running');

  await boot(); await write('progress_mode', 1);
  const paused = await arm({ stall_ms: 500, timeout_ms: 6000 });
  await inspector.resume(); await delay(150); await inspector.pause(); await delay(650);
  assert.equal((await read(paused)).state, 'armed');
  await inspector.resume(); await delay(150); await inspector.pause();
  assert.equal((await read(paused)).state, 'armed');
  await inspector.resume(); const afterPause = await read(paused, 3000);
  assert.equal(afterPause.state, 'captured', JSON.stringify(afterPause));
  assert.ok(afterPause.report.samples.some(s => s.phase === 'paused'));
  assert.ok(afterPause.report.unchanged_ms >= 500); assert.equal(afterPause.report.streak_fully_retained, true);
  assert.equal(afterPause.report.complete, true);
  passed('long pause and separate short runs never accumulate into a stall; fresh continuous running window captures later');

  await boot(); await write('progress_mode', 1);
  await inspector.setBreakpoint(symbol('progress_loop'), { description: 'real progress loop breakpoint' });
  const atBreakpoint = await arm(); await inspector.resume();
  for (let n = 0; !(await inspector.getStatus()).paused; n++) { assert.ok(n < 100); await delay(20); }
  await delay(500); assert.equal((await read(atBreakpoint)).state, 'armed');
  assert.equal((await inspector.getStatus()).pc, symbol('progress_loop'));
  await call('pcsx2_progress_watch_cancel', { watch_id: atBreakpoint.watch_id });
  await inspector.removeBreakpoint(symbol('progress_loop'));
  passed('a real execute breakpoint pauses without being classified as missing progress');

  await boot(); await write('progress_mode', 1);
  await write('progress_active', 0x81);
  await inspector.setBreakpoint('0x001f0000', { description: 'foreign progress sentinel' });
  const breakpoints = await inspector.listBreakpoints();
  const stall = await arm({ stall_ms: 600, max_samples: 8, screenshot: true, heartbeat_mask: 0xff, active_mask: 0xf });
  await inspector.resume(); inspector.disconnect(); await delay(1400);
  inspector = new DebugServerClient(); await inspector.connect();
  const capturedBeforePolling = await inspector.progressWatchStatus(stall.watch_id);
  assert.equal(capturedBeforePolling.state, 'captured', JSON.stringify(capturedBeforePolling));
  const stalled = await read(stall, 0, true); const r = stalled.report;
  assert.equal(r.observation, 'configured_heartbeat_stall'); assert.equal(r.context_matches_stop, true);
  assert.equal(r.samples.length, 8); assert.ok(r.samples_dropped > 0); assert.ok(r.unchanged_intervals >= 3);
  assert.equal(r.streak_fully_retained, false); assert.ok(r.partial_reasons.includes('progress_streak_start_not_retained'));
  assert.equal(r.context.screenshot.ok, false); assert.equal(r.complete, false);
  assert.ok(r.samples.every(s => s.phase === 'unchanged' && s.heartbeat !== null));
  assert.ok(r.samples.every(s => Number(s.heartbeat) <= 0xff && Number(s.active_value) === 1));
  assert.ok(r.samples.slice(1).every((s, i) => s.cycles !== r.samples[i].cycles));
  assert.equal(r.memory.code.valid, true); assert.equal(r.memory.stack.valid, true);
  assert.ok(r.events.events.some(e => e.type === 'progress_stall' && e.detail === stall.watch_id));
  assert.equal((await inspector.getStatus()).paused, true); assert.deepEqual(await inspector.listBreakpoints(), breakpoints);
  assert.equal(JSON.parse(await fs.readFile(stalled.artifacts.report, 'utf8')).report.observation, 'configured_heartbeat_stall');
  passed('native stall capture completes before polling across reconnect with bounded samples, CPU/RAM/logs/events and foreign breakpoint preserved');
  passed('missing GS frame and cropped streak start remain explicit partial evidence in a saved JSON report');
  const immutable = await inspector.progressWatchStatus(stall.watch_id);
  assert.equal((await call('pcsx2_progress_watch_cancel', { watch_id: stall.watch_id })).state, 'captured');
  await write('progress_active', 0); assert.deepEqual(await inspector.progressWatchStatus(stall.watch_id), immutable);
  assert.equal((await read(stall)).report.unchanged_ms, r.unchanged_ms);
  await boot();
  assert.deepEqual(await inspector.progressWatchStatus(stall.watch_id), immutable);
  passed('captured progress report remains immutable across memory writes and ELF reset');
  const reset = await arm();
  assert.equal((await mcp.callTool({ name: 'pcsx2_progress_report', arguments: { watch_id: stall.watch_id } })).isError, true);
  await inspector.loadElf(elf); assert.equal((await read(reset)).state, 'vm_changed');
  passed('superseded IDs are rejected and reset invalidates an armed watch');
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); report.error_stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(e => { report.cleanup_error = String(e); report.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json')); if (report.error) console.error(report.error);
}
