// node test/load-provenance-live.mjs <PCSX2> <built IOP fixture> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { PineClient } from '../dist/pine-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { inspectIrx } from '../dist/irx.js';
import { decodeLoadReceipt } from '../dist/iop-load.js';

assert.equal(process.argv.length, 6);
const [executable, inputFixture, configured, output] = process.argv.slice(2).map(v => path.resolve(v));
await fs.mkdir(output); const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const fixture = path.join(output, 'fixture'); await fs.cp(inputFixture, fixture, { recursive: true });
let ini = (await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'), 'utf8')).replace(/^HostFs\s*=.*\r?\n/gm, '');
ini = /^\[EmuCore\]\r?\n/m.test(ini) ? ini.replace(/^\[EmuCore\]\r?\n/m, '[EmuCore]\nHostFs = true\n') : ini + '\n[EmuCore]\nHostFs = true\n';
await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
async function freePort() {
  const reservation = createServer(); await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); return port;
}
const port = await freePort(), pinePort = await freePort();
assert.notEqual(port, pinePort);
function setting(section, key, value) {
  const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), '');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
}
setting('EmuCore', 'EnablePINE', 'true'); setting('EmuCore', 'PINESlot', pinePort);
const states = path.join(root, 'sstates'); setting('Folders', 'Savestates', states);
await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
const mcp = new Client({ name: 'iop-load-live', version: '1.0' }), inspector = new DebugServerClient('127.0.0.1', port);
const pine = new PineClient('127.0.0.1', pinePort);
let owned = false;
const result = { started_at: new Date().toISOString(), fixture, checks: [], evidence: [] };
const passed = name => { result.checks.push(name); console.log('PASS ' + name); };
const hex = n => '0x' + n.toString(16).padStart(8, '0');
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!response.isError, name + ': ' + JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
const rejected = async (name, args) => assert.equal((await mcp.callTool({ name, arguments: args })).isError, true);
function symbol(b, name) {
  const sh = b.readUInt32LE(32), stride = b.readUInt16LE(46), count = b.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const at = sh + i * stride; if (b.readUInt32LE(at + 4) !== 2) continue;
    const str = b.readUInt32LE(sh + b.readUInt32LE(at + 24) * stride + 16);
    const off = b.readUInt32LE(at + 16), end = off + b.readUInt32LE(at + 20), step = b.readUInt32LE(at + 36); assert.ok(step >= 16);
    for (let p = off; p < end; p += step) {
      const n = str + b.readUInt32LE(p);
      if (b.subarray(n, b.indexOf(0, n)).toString() === name) return b.readUInt32LE(p + 4);
    }
  }
  throw new Error('Missing symbol ' + name);
}
const elf = path.join(fixture, 'normal.elf'), irx = path.join(fixture, 'iop-exceptions.debug.irx'), load = path.join(fixture, 'iop-exceptions.irx');
async function boot() {
  await inspector.pause();
  const identity = await inspectSourceElf(elf), source = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = source.split(/\r?\n/).findIndex(s => s.includes('/* BEFORE_LOAD:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  return { identity };
}
const start = (options = {}) => call('pcsx2_iop_load_watch_start', { irx: load, timeout_ms: 8000, ...options });
const report = w => call('pcsx2_iop_load_report', { watch_id: w.watch_id });
const cancel = w => call('pcsx2_iop_load_watch_cancel', { watch_id: w.watch_id });
async function finishLoad() {
  const identity = await inspectSourceElf(elf), src = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = src.split(/\r?\n/).findIndex(s => s.includes('/* READY:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const bytes = await fs.readFile(elf);
  assert.ok(Buffer.from(await inspector.readMemory(hex(symbol(bytes, 'fixture_result')), 4), 'hex').readInt32LE() >= 0);
}

try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  result.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true; await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await boot();
  const f = await inspectIrx(load), debug = await inspectIrx(irx), c = await inspector.getCapabilities(), before = await inspector.getStatus();
  const payload = { path: f.irx, sha256: f.sha256, size: f.bytes.length, prefix: f.bytes.subarray(0, 64).toString('hex'), timeout_ms: 8000 };
  await assert.rejects(inspector.startIopLoadWatch('a'.repeat(32), { ...c, execution_epoch: c.execution_epoch + 1 }, payload), /identity/);
  const ttl = await start({ timeout_ms: 200 }); assert.equal(ttl.resumes_vm, false); await delay(350);
  assert.equal((await report(ttl)).state, 'expired'); assert.deepEqual(await inspector.getStatus(), before);
  passed('arming and wall expiry do not resume; stale native VM identity refuses before observation');
  const own = await start(); await rejected('pcsx2_iop_load_watch_start', { irx: load });
  await rejected('pcsx2_iop_load_watch_cancel', { watch_id: 'f'.repeat(32) }); assert.equal((await report(own)).state, 'armed');
  assert.equal((await report(own)).timed_out, true); assert.equal((await cancel(own)).state, 'cancelled');
  passed('competing start, foreign cancel and report timeout preserve ownership; only the chosen pending ID is cancelled');
  const mutated = await start(), bytes = await fs.readFile(elf), address = hex(symbol(bytes, 'fixture_result'));
  await inspector.writeMemory(address, await inspector.readMemory(address, 4));
  assert.equal((await report(mutated)).state, 'debugger_mutation');
  passed('a DebugServer mutation interrupts an armed provenance chain rather than mixing guest state');

  const w = await start(); await finishLoad();
  const raw = await inspector.iopLoadWatchStatus(w.watch_id); assert.equal(raw.state, 'registered');
  decodeLoadReceipt(raw); const r = await report(w); result.evidence.push(r);
  assert.equal(r.file_sha256, f.sha256); assert.equal(r.covered_bytes, f.bytes.length); assert.equal(r.file_closed, true);
  assert.ok(r.read_count > 0); assert.equal(r.binding_available, true); assert.ok(r.binding_revision > 0);
  assert.equal(r.module_record, hex(Number(raw.file_info[3]) - 48));
  assert.equal(r.source_bytes_base64, undefined);
  passed('actual HostFs descriptor covers every file byte, closes unchanged in size and matches the complete loadcore input and module registration');
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } })).isError);
  assert.equal((await report(w)).file_sha256, f.sha256);
  const args = { irx, module_record: r.module_record, expected_sha256: debug.sha256, load_watch_id: w.watch_id };
  const verified = await call('pcsx2_iop_verify_irx', args); result.evidence.push(verified);
  assert.equal(verified.evidence.original_loaded_file_sha256, f.sha256); assert.notEqual(debug.sha256, f.sha256);
  assert.equal(verified.evidence.exports[0].library, 'mcptest'); assert.equal(verified.evidence.exports[0].functions, 4);
  const breakAddress = hex(Number(raw.file_info[3]) + symbol(debug.bytes, 'fixture_iop_break'));
  const source = await call('pcsx2_iop_source', { ...args, addresses: [breakAddress] }); result.evidence.push(source);
  assert.equal(source.locations[0].resolved, true); assert.equal(source.locations[0].frames[0].function, 'worker');
  assert.equal(source.load_provenance.file_sha256, f.sha256); assert.equal(source.evidence.module_generation, null);
  passed('reconnect preserves full-file provenance; matching debug companion resolves real IOP sources with the original loaded file SHA');
  const exportAddress = verified.evidence.exports[0].start;
  const excluded = await call('pcsx2_iop_source', { ...args, addresses: [exportAddress] }); assert.equal(excluded.locations[0].resolved, false);
  const changedData = Buffer.from(debug.bytes), ph = debug.bytes.readUInt32LE(28), loadOffset = debug.bytes.readUInt32LE(ph + 36);
  changedData[loadOffset + debug.image.length - 1] ^= 1;
  const wrong = path.join(output, 'changed-initializer.debug.irx'); await fs.writeFile(wrong, changedData, { flag: 'wx' });
  const candidate = { irx: wrong, module_record: r.module_record };
  assert.equal((await call('pcsx2_iop_verify_irx', candidate)).evidence.original_loaded_file_sha256, null);
  await rejected('pcsx2_iop_verify_irx', { ...candidate, load_watch_id: w.watch_id });
  passed('same code with a different writable initializer fails full-load provenance; export tables never become source instructions');
  const pointer = hex(Number(exportAddress) + 20), original = await inspector.readMemory(pointer, 4, 'iop');
  try { await inspector.writeMemory(pointer, '00000000', 'iop'); await rejected('pcsx2_iop_verify_irx', { irx, module_record: r.module_record }); }
  finally { await inspector.writeMemory(pointer, original, 'iop'); }
  const history = await report(w); assert.equal(history.file_sha256, f.sha256); assert.equal(history.binding_available, false);
  await rejected('pcsx2_iop_source', { ...args, addresses: [breakAddress] });
  passed('relocated export function pointers remain checked; later debugger writes preserve historical bytes but invalidate association');

  await boot(); const fresh = await start(); await finishLoad(); const live = await report(fresh);
  const at = hex(Number(live.file_info[3]) + symbol(debug.bytes, 'fixture_iop_break'));
  await inspector.setBreakpoint(at, { cpu: 'iop', description: 'real post-load IOP stop' });
  let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.resume(); assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 10000 })).timed_out, false);
  assert.equal((await report(fresh)).binding_available, false);
  await rejected('pcsx2_iop_verify_irx', { irx, module_record: live.module_record, load_watch_id: fresh.watch_id });
  await inspector.removeBreakpoint(at, 'iop');
  passed('resume to a genuine later IOP breakpoint ends the capture-pause binding; no stale generation token is reused');

  await boot(); const restored = await start(); await finishLoad(); assert.equal((await report(restored)).binding_available, true);
  await pine.connect(); await pine.saveState(7);
  let stateFile;
  for (let n = 0; n < 200; n++) {
    const names = await fs.readdir(states).catch(() => []);
    stateFile = names.find(name => name.endsWith('.07.p2s'));
    if (stateFile) {
      const bytes = await fs.readFile(path.join(states, stateFile));
      if (bytes.length >= 22 && bytes.readUInt32LE(bytes.length - 22) === 0x06054b50) break;
    }
    stateFile = undefined; await delay(50);
  }
  assert.ok(stateFile, 'owned save-state archive did not close'); await pine.loadState(7);
  let restoredReport;
  for (let n = 0; n < 200; n++) {
    restoredReport = await report(restored); if (!restoredReport.binding_available) break; await delay(50);
  }
  assert.equal(restoredReport.binding_reason, 'savestate_load_attempt'); assert.equal(restoredReport.file_sha256, f.sha256);
  await rejected('pcsx2_iop_verify_irx', { irx, module_record: restoredReport.module_record, load_watch_id: restored.watch_id });
  passed('native save-state load invalidates the captured pause association while preserving historical file evidence');

  await boot(); const resized = await start();
  await fs.appendFile(load, Buffer.from([0]));
  try { await finishLoad(); assert.equal((await report(resized)).state, 'file_mode_or_size_mismatch'); }
  finally { await fs.writeFile(load, f.bytes); }
  passed('file-size change after arming refuses provenance while leaving the original guest loader behavior intact');
  await boot(); const reset = await start(); await inspector.loadElf(elf); assert.equal((await report(reset)).state, 'vm_changed');
  passed('VM reset invalidates a pending watch without fabricating a file or module receipt');
  result.passed = true;

} catch (error) { result.passed = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally {
  pine.disconnect(); inspector.disconnect(); if (owned) await call('pcsx2_stop').catch(e => { result.cleanup_error = String(e); result.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + path.join(output, 'validation.json')); if (result.error) console.error(result.error);
}
