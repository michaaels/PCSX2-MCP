// node test/iop-bindings-live.mjs <PCSX2> <built IOP fixture> <configured data root> <new output>
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
const mcp = new Client({ name: 'iop-bindings-live', version: '1.0' }), inspector = new DebugServerClient('127.0.0.1', port);
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
let elf = path.join(fixture, 'lifetime.elf');
const irx = path.join(fixture, 'iop-exceptions.debug.irx'), load = path.join(fixture, 'iop-exceptions.irx');
async function boot(mode = 'lifetime') {
  elf = path.join(fixture, mode + '.elf');
  await inspector.pause();
  if (!(await inspector.getCapabilities()).elf.endsWith(elf)) {
    await inspector.loadElf(elf); await inspector.resume();
    for (let n = 0; !(await inspector.getCapabilities()).elf.endsWith(elf); n++) { assert.ok(n < 200); await delay(20); }
    await inspector.pause();
  }
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


async function tail() {
  let e = await inspector.readEvents(0, 200); while (e.events.length === 200) e = await inspector.readEvents(e.next_cursor, 200); return e.next_cursor;
}
async function runTo(address) {
  await inspector.setBreakpoint(address, { cpu: 'iop', description: 'owned lifetime probe' });
  try {
    const after = await tail(); await inspector.resume();
    assert.equal((await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  } finally { await inspector.removeBreakpoint(address, 'iop'); }
}
const lifetime = () => call('pcsx2_iop_lifetime');

const bind = (watch, options = {}) => call('pcsx2_iop_binding_create', { irx, module_record: watch.module_record, load_watch_id: watch.watch_id, ttl_ms: 300000, ...options });
const lookup = (binding, addresses) => call('pcsx2_iop_binding_source', { binding_id: binding.binding_id, addresses });
const refuseBinding = binding => rejected('pcsx2_iop_binding_source', { binding_id: binding.binding_id });
async function loadAndBind(mode = 'lifetime') {
  await boot(mode); const w = await start(); await finishLoad(); const receipt = await report(w), binding = await bind(receipt);
  return { receipt, binding, module: (await call('pcsx2_iop_modules')).modules.find(m => m.record_address === receipt.module_record) };
}
const watchMemory = (cpu, address) => call('pcsx2_memory_watch_start', { cpu, address, size: 4, mask: 1, timeout_ms: 15000 });
const memory = w => call('pcsx2_memory_watch_status', { watch_id: w.watch_id });
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  result.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true; await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  const debug = await inspectIrx(irx), first = await loadAndBind(), base = Number(first.module.text_address);
  assert.equal(first.binding.observed_generation.scope, 'observed_loadcore_registration');
  assert.ok(first.binding.observed_generation.sequence > 0); assert.equal(first.binding.origin.file_sha256, first.receipt.file_sha256);
  const at = hex(base + symbol(debug.bytes, 'fixture_iop_break'));
  const initial = await lookup(first.binding, [at]); result.evidence.push({ first, initial });
  assert.equal(initial.locations[0].resolved, true); assert.equal(initial.evidence.original_loaded_file_sha256, null);
  passed('a binding requires first-pause full-file provenance and a native observed registration; later lookup reports origin SHA as historical');
  const caps = await inspector.getCapabilities(), table = await call('pcsx2_iop_modules');
  assert.ok(table.modules.some(m => m.observed_generation === null));
  await assert.rejects(inspector.iopModuleImage({ ...caps, revision: table.revision, registration_namespace: first.binding.observed_generation.namespace,
    registration_sequence: first.binding.observed_generation.sequence + 1 }, first.module.record_address), /generation/);
  await assert.rejects(inspector.iopModuleImage({ ...caps, revision: table.revision, registration_namespace: '0:0:0',
    registration_sequence: first.binding.observed_generation.sequence }, first.module.record_address), /namespace/);
  await assert.rejects(inspector.startExceptionWatch('b'.repeat(32), { ...caps, iop_lifetime_epoch: caps.iop_lifetime_epoch - 1 }, { cpu: 'iop', screenshot: false }), /lifetime/);
  await assert.rejects(inspector.startMemoryWatch('c'.repeat(32), { ...caps, iop_lifetime_epoch: caps.iop_lifetime_epoch - 1 }, { cpu: 'iop', address: first.module.text_address }), /lifetime/);
  passed('native generation mismatch refuses before returning an image even when current pause and record are correct');
  await inspector.resume(); await delay(80); await inspector.pause();
  const later = await lookup(first.binding, [at]); assert.equal(later.locations[0].resolved, true);
  assert.equal(later.binding.observed_generation.sequence, first.binding.observed_generation.sequence);
  assert.ok(later.runtime.revision > initial.runtime.revision); assert.equal((await report(first.receipt)).binding_available, false);
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } })).isError);
  assert.equal((await lookup(first.binding, [at])).binding.binding_id, first.binding.binding_id);
  passed('resume/pause and reconnect permit fresh file/image/source revalidation without reviving the old first-pause receipt');
  const eeAddress = hex(symbol(await fs.readFile(elf), 'fixture_result'));
  const iopMemory = await watchMemory('iop', first.module.text_address), eeMemory = await watchMemory('ee', eeAddress);
  await runTo(hex(base + symbol(debug.bytes, 'fixture_released')));
  const released = await call('pcsx2_iop_modules'); assert.ok(!released.modules.some(m => m.record_address === first.module.record_address));
  assert.equal((await memory(iopMemory)).state, 'lifetime_changed'); assert.equal((await memory(eeMemory)).state, 'armed');
  await refuseBinding(first.binding);
  passed('real module release removes it from the list, revokes its binding and terminates IOP observation while preserving the EE watch');
  await runTo(hex(base + symbol(debug.bytes, 'fixture_reregistered')));
  const reregistered = (await call('pcsx2_iop_modules')).modules.find(m => m.record_address === first.module.record_address); assert.ok(reregistered);
  assert.ok(reregistered.observed_generation.sequence > first.binding.observed_generation.sequence);
  assert.notEqual(reregistered.module_id, first.module.module_id);
  const fresh = await call('pcsx2_iop_verify_irx', { irx, module_record: reregistered.record_address });
  assert.equal(fresh.evidence.normalized_readonly_sha256, initial.evidence.normalized_readonly_sha256);
  await refuseBinding(first.binding); await rejected('pcsx2_iop_binding_create', { irx, module_record: reregistered.record_address, load_watch_id: first.receipt.watch_id });
  result.evidence.push({ reregistered, fresh });
  passed('same-address identical-code re-registration receives another sequence/ID and cannot reuse an old binding or historical receipt');
  await call('pcsx2_memory_watch_cancel', { watch_id: eeMemory.watch_id });
  const service = await loadAndBind('service'), serviceBase = Number(service.module.text_address);
  const ex = await call('pcsx2_exception_watch_start', { cpu: 'iop', screenshot: false });
  await runTo(hex(serviceBase + symbol(debug.bytes, 'fixture_service_done')));
  const returnValue = Buffer.from(await inspector.readMemory(hex(serviceBase + symbol(debug.bytes, 'fixture_lifetime_result')), 4, 'iop'), 'hex').readInt32LE();
  assert.ok(returnValue < 0, 'invalid buffer must fail in the original guest loader');
  assert.equal((await call('pcsx2_exception_report', { watch_id: ex.watch_id })).state, 'lifetime_changed');
  const serviceModule = (await call('pcsx2_iop_modules')).modules.find(m => m.record_address === service.module.record_address);
  assert.equal(serviceModule.observed_generation, null); await refuseBinding(service.binding);
  const journal = await lifetime(); assert.ok(journal.events.some(e => e.kind === 'module_service_call' && Number(e.address) === 10));
  result.evidence.push({ serviceModule, returnValue, journal });
  passed('a genuine failed modload buffer-load call revokes retained generations and IOP exception observation without replacing original loader behavior');
  const changed = await loadAndBind('watch');
  const raw = await inspector.readMemory(eeAddress, 4); await inspector.writeMemory(eeAddress, raw);
  await refuseBinding(changed.binding); assert.equal((await call('pcsx2_iop_modules')).modules.find(m => m.record_address === changed.module.record_address).observed_generation, null);
  passed('even a same-byte DebugServer write revokes registration tracking and cannot silently restore the prior binding');
  const artifact = await loadAndBind('watch'), original = await fs.readFile(irx);
  try { await fs.appendFile(irx, Buffer.from([0])); await refuseBinding(artifact.binding); }
  finally { await fs.writeFile(irx, original); }
  await refuseBinding(artifact.binding);
  passed('a changed local artifact permanently invalidates its binding even after restoring the original bytes');
  const state = await loadAndBind('normal'); await pine.connect(); await pine.saveState(7); let saved;
  for (let n = 0; n < 200; n++) {
    const names = await fs.readdir(states).catch(() => []), filename = names.find(name => name.endsWith('.07.p2s'));
    if (filename) { const b = await fs.readFile(path.join(states, filename)); if (b.length >= 22 && b.readUInt32LE(b.length - 22) === 0x06054b50) { saved = filename; break; } }
    await delay(50);
  }
  assert.ok(saved); const restoreWatch = await call('pcsx2_exception_watch_start', { cpu: 'iop', screenshot: false });
  await pine.loadState(7);
  for (let n = 0; n < 200; n++) { if (!(await report(state.receipt)).binding_available) break; await delay(50); }
  assert.equal((await call('pcsx2_exception_report', { watch_id: restoreWatch.watch_id })).state, 'lifetime_changed');
  await refuseBinding(state.binding); assert.equal((await call('pcsx2_iop_modules')).status, 'unavailable');
  assert.equal((await report(state.receipt)).file_sha256, state.binding.origin.file_sha256);
  passed('native savestate restore revokes registration/binding and pending IOP exception watch while preserving historical origin bytes');
  const software = await loadAndBind('reset'), swMemory = await watchMemory('iop', software.module.text_address);
  const identity = await inspectSourceElf(elf), src = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = src.split(/\r?\n/).findIndex(s => s.includes('/* AFTER_SOFTWARE_RESET:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  const cursor = await tail(); await inspector.resume(); assert.equal((await inspector.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  assert.equal((await memory(swMemory)).state, 'lifetime_changed'); await refuseBinding(software.binding);
  passed('actual SifIopReset/SifIopSync revokes reusable binding and raw IOP memory observation across software reboot');
  const expiry = await loadAndBind('watch');
  const short = await bind(expiry.receipt, { ttl_ms: 100 }); await delay(150);
  await refuseBinding(short); assert.equal((await call('pcsx2_iop_binding_list')).bindings.find(b => b.binding_id === short.binding_id).status, 'expired');
  await rejected('pcsx2_iop_binding_drop', { binding_id: 'f'.repeat(32) });
  await call('pcsx2_iop_binding_drop', { binding_id: short.binding_id });
  assert.ok((await call('pcsx2_iop_binding_list')).bindings.some(b => b.binding_id === expiry.binding.binding_id));
  passed('wall expiry and foreign/drop ownership affect only selected bindings without guest execution or broad cleanup');
  await boot('normal'); await refuseBinding(expiry.binding);
  passed('VM reload changes affinity and old binding identity stays revoked even when an address is reused');
  result.passed = true;
} catch (error) { result.passed = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally {
  pine.disconnect(); inspector.disconnect(); if (owned) await call('pcsx2_stop').catch(e => { result.cleanup_error = String(e); result.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + path.join(output, 'validation.json')); if (result.error) console.error(result.stack);
}
