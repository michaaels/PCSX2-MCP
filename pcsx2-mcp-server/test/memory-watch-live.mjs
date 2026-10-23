// node test/memory-watch-live.mjs <PCSX2> <built IOP fixture> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

assert.equal(process.argv.length, 6);
const [executable, fixture, configured, output] = process.argv.slice(2).map(v => path.resolve(v));
await fs.mkdir(output); const root = path.join(output, 'instance');
await fs.mkdir(path.join(root, 'inis'), { recursive: true });
let ini = await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'), 'utf8');
ini = ini.replace(/^HostFs\s*=.*\r?\n/gm, '');
ini = /^\[EmuCore\]\r?\n/m.test(ini) ? ini.replace(/^\[EmuCore\]\r?\n/m, '[EmuCore]\nHostFs = true\n') : ini + '\n[EmuCore]\nHostFs = true\n';
assert.match(ini, /HostFs = true/); await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'memory-watch-live', version: '1.0' });
let inspector = new DebugServerClient('127.0.0.1', port), owns = false;
const results = { executable, fixture, started_at: new Date().toISOString(), checks: [], observations: [], benchmarks: [] };
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
const hex = n => '0x' + n.toString(16).padStart(8, '0');
const passed = name => { results.checks.push(name); console.log('PASS ' + name); };
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!response.isError, name + ': ' + JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
async function rejected(name, args) {
  assert.equal((await mcp.callTool({ name, arguments: args })).isError, true, name);
}
function symbol(bytes, name) {
  const table = bytes.readUInt32LE(32), stride = bytes.readUInt16LE(46), count = bytes.readUInt16LE(48);
  for (let n = 0; n < count; n++) {
    const h = table + n * stride; if (bytes.readUInt32LE(h + 4) !== 2) continue;
    const strings = bytes.readUInt32LE(table + bytes.readUInt32LE(h + 24) * stride + 16);
    const begin = bytes.readUInt32LE(h + 16), end = begin + bytes.readUInt32LE(h + 20), size = bytes.readUInt32LE(h + 36);
    assert.ok(size >= 16);
    for (let entry = begin; entry < end; entry += size) {
      const start = strings + bytes.readUInt32LE(entry);
      if (bytes.subarray(start, bytes.indexOf(0, start)).toString('utf8') !== name) continue;
      const section = table + bytes.readUInt16LE(entry + 14) * stride;
      return { address: bytes.readUInt32LE(entry + 4), section_address: bytes.readUInt32LE(section + 12) };
    }
  }
  throw new Error('Missing fixture symbol: ' + name);
}
let ee, iop;
async function boot(mode = 'watch') {
  const elf = path.join(fixture, mode + '.elf'), identity = await inspectSourceElf(elf);
  assert.equal(identity.sha256, manifest.sha256[mode + '.elf']);
  // First switch affinity, then install a breakpoint for the exact new ELF.
  if (!(await inspector.getCapabilities()).elf.endsWith(elf)) {
    await inspector.pause(); await inspector.loadElf(elf); await inspector.resume();
    for (let n = 0; ; n++) {
      const caps = await inspector.getCapabilities(); if (caps.elf.endsWith(elf) && Number(caps.elf_crc)) break;
      assert.ok(n < 200); await delay(50);
    }
    await inspector.pause();
  }
  const source = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = source.split(/\r?\n/).findIndex(s => s.includes('/* READY:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  let events = await inspector.readEvents(0, 200);
  while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const bytes = await fs.readFile(elf);
  assert.ok(Buffer.from(await inspector.readMemory(hex(symbol(bytes, 'fixture_result').address), 4), 'hex').readInt32LE() >= 0);
  ee = hex(symbol(bytes, 'fixture_ee_counter').address);
  const modules = await call('pcsx2_iop_modules');
  const matching = modules.modules.filter(m => m.name === 'mcp_exception_fixture'); assert.equal(matching.length, 1);
  const module = matching[0], irx = await fs.readFile(path.join(fixture, 'iop-exceptions.irx'));
  const start = symbol(irx, '_start'), counter = symbol(irx, 'fixture_iop_counter');
  assert.equal(Number(module.entry) - Number(module.text_address), start.address - start.section_address);
  // Independent fixture-only relocation arithmetic, not a product IRX binding claim.
  iop = hex(Number(module.text_address) + counter.address - start.section_address);
  assert.ok(Number(iop) >= Number(module.text_address) + module.text_size + module.data_size);
  assert.ok(Number(iop) + 4 <= Number(module.text_address) + module.text_size + module.data_size + module.bss_size);
  return { elf, sha256: identity.sha256, ee, iop, observed_module: module };
}
const arm = (cpu = 'ee', options = {}) => call('pcsx2_memory_watch_start', {
  cpu, address: cpu === 'iop' ? iop : ee, sample_interval_ms: 50, timeout_ms: 5000, ...options });
const read = (w, wait_ms = 0) => call('pcsx2_memory_watch_status', { watch_id: w.watch_id, wait_ms });
const cancel = w => call('pcsx2_memory_watch_cancel', { watch_id: w.watch_id });
async function cancelAll() {
  for (const w of (await call('pcsx2_memory_watch_list')).watches) if (w.active) await cancel(w);
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  results.launch = await call('pcsx2_launch', { executable, elf: path.join(fixture, 'watch.elf'), data_directory: root }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause(); results.fixture_identity = await boot();
  const caps = await inspector.getCapabilities(); assert.ok(caps.features.includes('memory_change_watch'));
  const before = await inspector.getStatus();
  await assert.rejects(inspector.startMemoryWatch('a'.repeat(32), { ...caps, execution_epoch: caps.execution_epoch + 1 }, { address: ee }), /identity changed/);
  await assert.rejects(inspector.startMemoryWatch('b'.repeat(32), { ...caps, iop_reset_epoch: caps.iop_reset_epoch + 1 }, { cpu: 'iop', address: iop }), /identity changed/);
  for (const bad of [{ cpu: 'ee', address: '0x10000000' }, { cpu: 'iop', address: '0x00200000' },
    { cpu: 'ee', address: '0x80001000' }, { address: ee, size: 3 }, { address: ee, size: 1, mask: 256 }, { address: ee, sample_interval_ms: 49 },
    { address: 'invalid' }, { address: '0x00100000junk' }, { address: ee, size: 1.5 }, { address: ee, sample_interval_ms: true },
    { address: ee, mask: 1e30 }, { address: ee, pause_on_change: 'true' }]) {
    const response = await inspector.send({ cmd: 'memory_watch_start', watch_id: 'c'.repeat(32),
      expected_iop_lifetime_epoch: caps.iop_lifetime_epoch,
      expected_process_id: caps.process_id, expected_session: caps.session, expected_execution_epoch: caps.execution_epoch,
      expected_elf: caps.elf, expected_elf_crc: caps.elf_crc, expected_iop_reset_epoch: caps.iop_reset_epoch, ...bad });
    assert.equal(response.ok, false);
  }
  assert.deepEqual(await inspector.getStatus(), before);
  passed('native stale EE/IOP identities, unsafe RAM extents, aliases, widths, masks and timing refuse without resuming');
  const expiry = await arm('ee', { timeout_ms: 200 }); assert.equal(expiry.resumes_vm, false);
  await delay(350); const expired = await read(expiry); assert.equal(expired.state, 'expired'); assert.equal(expired.total_samples, 0);
  assert.deepEqual(await inspector.getStatus(), before);
  passed('wall TTL expires paused with zero guest memory samples and no implicit resume');
  const own = await arm(); await rejected('pcsx2_memory_watch_cancel', { watch_id: 'f'.repeat(32) });
  assert.equal((await read(own)).state, 'armed');
  await rejected('pcsx2_exception_watch_start', { screenshot: false });
  await rejected('pcsx2_progress_watch_start', { heartbeat_address: ee });
  await cancel(own);
  const ex = await call('pcsx2_exception_watch_start', { screenshot: false });
  await rejected('pcsx2_memory_watch_start', { address: ee }); await call('pcsx2_exception_watch_cancel', { watch_id: ex.watch_id });
  const pr = await call('pcsx2_progress_watch_start', { heartbeat_address: ee, screenshot: false });
  await rejected('pcsx2_memory_watch_start', { address: ee }); await call('pcsx2_progress_watch_cancel', { watch_id: pr.watch_id });
  passed('foreign cancellation and progress/exception conflicts preserve the current owner in both directions');
  const full = []; for (let n = 0; n < 16; n++) full.push(await arm());
  await rejected('pcsx2_memory_watch_start', { address: ee }); assert.equal((await call('pcsx2_memory_watch_list')).watches.length, 16);
  await cancel(full[0]); const replacement = await arm(); assert.equal((await read(replacement)).active, true);
  await rejected('pcsx2_memory_watch_status', { watch_id: full[0].watch_id }); await cancelAll();
  passed('sixteen active watches are bounded; capacity refusal preserves them and replacement evicts only the oldest terminal');

  await inspector.setBreakpoint('0x001f0000', { description: 'foreign EE sentinel' });
  await inspector.setBreakpoint('0x001f0000', { cpu: 'iop', description: 'foreign IOP sentinel' });
  const breakpoints = [await inspector.listBreakpoints(), await inspector.listBreakpoints('iop')];
  const eeWord = await arm('ee'), eeHalf = await arm('ee', { size: 2, mask: 0xff00 });
  const iopWord = await arm('iop'), iopHalf = await arm('iop', { size: 2, mask: 0xff00 });
  const eeHighByte = await arm('ee', { size: 1, address: hex(Number(ee) + 1) });
  const iopHighByte = await arm('iop', { size: 1, address: hex(Number(iop) + 1) });
  const eeByte = await arm('ee', { size: 1, timeout_ms: 3500 }), iopByte = await arm('iop', { size: 1, timeout_ms: 3500 });
  await inspector.resume();
  for (const w of [eeWord, eeHalf, iopWord, iopHalf, eeHighByte, iopHighByte]) {
    const value = await read(w, 4500); assert.equal(value.state, 'changed', JSON.stringify(value));
    assert.equal(value.writer_pc, null); assert.notEqual(value.change.previous.masked, value.change.current.masked);
    assert.notEqual(value.change.previous.cycles, value.change.current.cycles); results.observations.push(value);
  }
  assert.equal((await read(eeByte, 4500)).state, 'expired'); assert.equal((await read(iopByte, 4500)).state, 'expired');
  assert.equal((await inspector.getStatus()).paused, false);
  passed('real guest EE and resident IOP counters change in 1/2/4-byte masks while constant low-byte observers expire without false changes');

  // A running MCP write changes only the constant low byte; the guest adds 0x100.
  for (const cpu of ['ee', 'iop']) {
    const w = await arm(cpu, { size: 1 }); await delay(180);
    assert.ok((await read(w)).total_samples > 0);
    await inspector.writeMemory(cpu === 'ee' ? ee : iop, 'aa', cpu); await delay(200);
    assert.equal((await read(w)).state, 'armed');
    await inspector.pause(); await inspector.writeMemory(cpu === 'ee' ? ee : iop, 'bb', cpu); await delay(120);
    const paused = await read(w); await delay(100); assert.equal((await read(w)).total_samples, paused.total_samples);
    await inspector.resume(); await delay(200); assert.equal((await read(w)).state, 'armed'); await cancel(w);
  }
  passed('running MCP writes and paused writes rebase EE/IOP comparisons; paused polls never read guest memory');

  const disconnected = await arm('iop'); inspector.disconnect();
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } })).isError); await delay(300);
  inspector = new DebugServerClient('127.0.0.1', port); await inspector.connect();
  assert.equal((await read(disconnected)).state, 'changed');
  await inspector.pause(); const pausing = await arm('iop', { pause_on_change: true });
  await inspector.resume(); const frozen = await read(pausing, 2000); assert.equal(frozen.state, 'changed');
  assert.equal((await inspector.getStatus()).paused, true);
  assert.deepEqual([await inspector.listBreakpoints(), await inspector.listBreakpoints('iop')], breakpoints);
  await inspector.writeMemory(iop, '00000000', 'iop'); assert.deepEqual(await read(pausing), frozen);
  assert.equal((await cancel(pausing)).state, 'changed');
  results.observations.push(frozen);
  passed('native observation survives reconnect; optional IOP pause preserves foreign breakpoints and freezes evidence across later writes');
  await inspector.removeBreakpoint('0x001f0000'); await inspector.removeBreakpoint('0x001f0000', 'iop');

  // Small paired host experiment. No performance threshold or physical hardware claim.
  for (let round = 0; round < 3; round++) for (const watched of [false, true]) {
    const watches = [];
    if (watched) for (let n = 0; n < 16; n++) watches.push(await arm(n % 2 ? 'iop' : 'ee', { size: 1 }));
    const initial = await inspector.getStatus(), began = performance.now();
    await inspector.resume(); await delay(500); await inspector.pause();
    const elapsed = performance.now() - began, end = await inspector.getStatus();
    const states = []; for (const w of watches) states.push(await cancel(w));
    assert.ok(states.every(w => w.state === 'cancelled' && w.total_samples > 0));
    results.benchmarks.push({ round, watched, wall_ms: elapsed, ee_cycles_delta_mod32: (end.cycles - initial.cycles) >>> 0,
      samples: states.reduce((n, w) => n + w.total_samples, 0), sampling_cpu_ns: states.reduce((n, w) => n + w.sampling_cpu_ns, 0) });
  }
  passed('three paired 500ms control/16-observer runs record guest cycle progress and CPU sampling cost without a universal overhead claim');

  // Retention is bounded; benchmark watches may evict earlier terminal reports.
  const keep = await arm('iop'); await inspector.resume(); const immutable = await read(keep, 2000); await inspector.pause();
  assert.equal(immutable.state, 'changed');
  const resetEE = await arm('ee'), resetIOP = await arm('iop'); await inspector.loadElf(path.join(fixture, 'watch.elf'));
  assert.equal((await read(resetEE)).state, 'vm_changed'); assert.equal((await read(resetIOP)).state, 'vm_changed');
  assert.deepEqual(await read(keep), immutable);
  passed('ELF reset invalidates armed EE/IOP observers but preserves retained immutable change pairs');
  await inspector.resume(); await delay(800); await inspector.pause(); await boot('hardreset');
  const reset = await arm('iop'), eeSurvives = await arm('ee', { size: 1, timeout_ms: 900 });
  await inspector.resume(); assert.equal((await read(reset, 2000)).state, 'cpu_reset');
  assert.equal((await read(eeSurvives, 2000)).state, 'expired');
  assert.equal((await inspector.getStatus()).paused, false);
  passed('actual IOP CPU reset terminates IOP observations without inventing a full module/software-reset lifetime guard');
  results.passed = true;
} catch (error) { results.passed = false; results.error = String(error); results.stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(e => { results.cleanup_error = String(e); results.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + path.join(output, 'validation.json')); if (results.error) console.error(results.error);
}
