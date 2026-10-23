// node test/iop-lifetime-live.mjs <PCSX2> <built IOP fixture> <configured data root> <new output>
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
const mcp = new Client({ name: 'iop-lifetime-live', version: '1.0' }), inspector = new DebugServerClient('127.0.0.1', port);
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
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  result.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true; await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await boot(); const stopped = await inspector.getStatus(), initial = await lifetime();
  assert.equal(initial.scope, 'observed_boundaries_only'); assert.equal(initial.module_generation, null);
  assert.deepEqual(await inspector.getStatus(), stopped); assert.deepEqual(await lifetime(), initial);
  passed('lifetime history is bounded read-only evidence; repeated paused queries never resume or invent a module generation');
  const cap = await inspector.getCapabilities(), f = await inspectIrx(load), debug = await inspectIrx(irx);
  await assert.rejects(inspector.iopModuleSnapshot({ ...cap, iop_lifetime_epoch: cap.iop_lifetime_epoch - 1 }), /lifetime/);
  await assert.rejects(inspector.startIopLoadWatch('a'.repeat(32), { ...cap, iop_lifetime_epoch: cap.iop_lifetime_epoch - 1 },
    { path: f.irx, sha256: f.sha256, size: f.bytes.length, prefix: f.bytes.subarray(0, 64).toString('hex'), timeout_ms: 1000 }), /lifetime/);
  assert.deepEqual(await inspector.getStatus(), stopped);
  passed('stale lifetime epochs refuse native module reads and load arming before observation without changing pause');
  const watch = await start(); await finishLoad(); const receipt = await report(watch), loadedCaps = await inspector.getCapabilities();
  const table = await call('pcsx2_iop_modules'), module = table.modules.find(m => m.name === debug.name); assert.ok(module);
  assert.equal(receipt.iop_lifetime_epoch, table.iop_lifetime_epoch); assert.equal(receipt.binding_available, true);
  const proof = await call('pcsx2_iop_verify_irx', { irx, module_record: module.record_address, load_watch_id: watch.watch_id });
  result.evidence.push({ receipt, proof, lifetime: await lifetime() });
  passed('real HostFs load and registration publish the guarded lifetime epoch with verified full-file provenance');
  const base = Number(module.text_address);
  await runTo(hex(base + symbol(debug.bytes, 'fixture_released')));
  const released = await lifetime(), releasedTable = await call('pcsx2_iop_modules');
  assert.equal(releasedTable.status, 'observed'); assert.ok(!releasedTable.modules.some(m => m.record_address === module.record_address));
  assert.ok(released.events.some(e => e.kind === 'release_module_call' && e.address === module.record_address));
  assert.ok(released.iop_lifetime_epoch > loadedCaps.iop_lifetime_epoch);
  assert.equal((await inspector.getCapabilities()).iop_reset_epoch, loadedCaps.iop_reset_epoch);
  await assert.rejects(inspector.iopModuleSnapshot(loadedCaps), /lifetime/);
  assert.equal((await report(watch)).binding_available, false);
  result.evidence.push({ released, releasedTable });
  passed('a genuine loadcore release call advances lifetime independently of CPU reset and rejects the previous table identity');
  await runTo(hex(base + symbol(debug.bytes, 'fixture_reregistered')));
  const registered = await lifetime(), again = await call('pcsx2_iop_modules');
  const current = again.modules.find(m => m.record_address === module.record_address); assert.ok(current);
  assert.equal(current.name, module.name); assert.equal(current.text_address, module.text_address);
  assert.ok(registered.iop_lifetime_epoch > released.iop_lifetime_epoch);
  assert.ok(registered.events.some(e => e.kind === 'register_module_call' && e.address === module.record_address));
  const fresh = await call('pcsx2_iop_verify_irx', { irx, module_record: current.record_address });
  assert.equal(fresh.evidence.normalized_readonly_sha256, proof.evidence.normalized_readonly_sha256);
  await rejected('pcsx2_iop_verify_irx', { irx, module_record: current.record_address, load_watch_id: watch.watch_id });
  result.evidence.push({ registered, current, fresh });
  passed('registering the same guest record with identical code gets a new boundary epoch; old file receipt cannot become a generation token');
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } })).isError); assert.deepEqual(await lifetime(), registered);
  passed('reconnecting preserves the journal and current lifetime epoch without replacing historical evidence');
  const address = hex(symbol(await fs.readFile(elf), 'fixture_result')), bytes = await inspector.readMemory(address, 4);
  for (let n = 0; n < 70; n++) await inspector.writeMemory(address, bytes);
  const bounded = await lifetime(); assert.equal(bounded.events.length, 64); assert.equal(bounded.history_truncated, true);
  assert.ok(bounded.events.every(e => e.kind === 'debugger_mutation'));
  assert.equal(bounded.iop_lifetime_epoch, registered.iop_lifetime_epoch + 70);
  assert.equal((await report(watch)).file_sha256, f.sha256);
  passed('seventy explicit writes invalidate conservatively, retain only 64 ordered boundaries and preserve the original file history');
  await boot('reset'); await finishLoad(); const resetCaps = await inspector.getCapabilities(), pending = await start();
  const identity = await inspectSourceElf(elf), src = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = src.split(/\r?\n/).findIndex(s => s.includes('/* AFTER_SOFTWARE_RESET:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  const after = await tail(); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const software = await lifetime(), softwareCaps = await inspector.getCapabilities(); result.evidence.push({ software, resetCaps, softwareCaps });
  assert.ok(software.events.some(e => e.kind === 'sif_reset_packet' && e.epoch > resetCaps.iop_lifetime_epoch));
  assert.equal(softwareCaps.iop_reset_epoch, resetCaps.iop_reset_epoch);
  assert.ok(softwareCaps.iop_lifetime_epoch > resetCaps.iop_lifetime_epoch);
  assert.equal((await report(pending)).state, 'software_reset_requested');
  await assert.rejects(inspector.iopModuleSnapshot(resetCaps), /lifetime/);
  passed('actual SifIopReset/SifIopSync transports a standard reset packet, invalidates pending provenance and rejects old lifetime without fabricating a CPU reset');
  await boot('normal'); const restored = await start(); await finishLoad(); const restoreCaps = await inspector.getCapabilities();
  await pine.connect(); await pine.saveState(7); let saved;
  for (let n = 0; n < 200; n++) {
    const names = await fs.readdir(states).catch(() => []), filename = names.find(name => name.endsWith('.07.p2s'));
    if (filename) { const b = await fs.readFile(path.join(states, filename)); if (b.length >= 22 && b.readUInt32LE(b.length - 22) === 0x06054b50) { saved = filename; break; } }
    await delay(50);
  }
  assert.ok(saved); await pine.loadState(7); let restoredState;
  for (let n = 0; n < 200; n++) { restoredState = await report(restored); if (!restoredState.binding_available) break; await delay(50); }
  assert.equal(restoredState.binding_reason, 'savestate_load_attempt');
  const restore = await lifetime(), noLocator = await call('pcsx2_iop_modules'); result.evidence.push({ restore, noLocator });
  assert.ok(restore.iop_lifetime_epoch > restoreCaps.iop_lifetime_epoch); assert.equal(noLocator.status, 'unavailable');
  assert.equal(noLocator.list_address, '0x00000000'); await assert.rejects(inspector.iopModuleSnapshot(restoreCaps), /lifetime/);
  passed('native savestate loading advances lifetime, clears the old locator and keeps captured file bytes historical rather than current');
  await boot('hardreset'); await finishLoad(); const hardCaps = await inspector.getCapabilities();
  await inspector.resume(); await delay(200); await inspector.pause(); const hard = await lifetime(); result.evidence.push(hard);
  assert.ok(hard.iop_reset_epoch > hardCaps.iop_reset_epoch); assert.ok(hard.iop_lifetime_epoch > hardCaps.iop_lifetime_epoch);
  assert.ok(hard.events.some(e => e.kind === 'cpu_reset' && e.epoch > hardCaps.iop_lifetime_epoch));
  passed('a real guest MMIO CPU reset advances both distinct epochs and records its own boundary');
  const previous = await lifetime(); await inspector.loadElf(elf); const reset = await lifetime();
  assert.ok(reset.iop_lifetime_epoch > previous.iop_lifetime_epoch); assert.ok(reset.events.some(e => e.kind === 'vm_reset' && e.epoch > previous.iop_lifetime_epoch));
  passed('VM reset advances the host-owned lifetime epoch instead of rolling it back with guest state');
  result.passed = true;
} catch (error) { result.passed = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally {
  pine.disconnect(); inspector.disconnect(); if (owned) await call('pcsx2_stop').catch(e => { result.cleanup_error = String(e); result.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + path.join(output, 'validation.json')); if (result.error) console.error(result.stack);
}
