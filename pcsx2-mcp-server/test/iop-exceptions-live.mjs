// node test/iop-exceptions-live.mjs <PCSX2> <built fixture directory> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

const [executable, fixtureDirectory, output] = process.argv.slice(2); assert.ok(output);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'iop-exception-'));
const mcp = new Client({ name: 'iop-exceptions-live', version: '1.0' });
let inspector = new DebugServerClient(), owns = false;
const report = { started_at: new Date().toISOString(), checks: [], results: [], fixture_directory: fixtureDirectory };
const fixtureManifest = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'));
report.fixture_manifest = fixtureManifest;
const source = await fs.readFile(path.join(fixtureDirectory, 'ee-iop-exceptions.c'), 'utf8');
const readyLine = source.split(/\r?\n/).findIndex(line => line.includes('/* READY:')) + 1;
async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!result.isError, name + ': ' + JSON.stringify(result.content)); return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
function symbol(bytes, name) {
  const offset = bytes.readUInt32LE(32), stride = bytes.readUInt16LE(46), count = bytes.readUInt16LE(48);
  for (let n = 0; n < count; n++) {
    const header = offset + n * stride;
    if (bytes.readUInt32LE(header + 4) !== 2) continue;
    const strings = offset + bytes.readUInt32LE(header + 24) * stride, stringOffset = bytes.readUInt32LE(strings + 16);
    const begin = bytes.readUInt32LE(header + 16), end = begin + bytes.readUInt32LE(header + 20), size = bytes.readUInt32LE(header + 36);
    assert.ok(size >= 16);
    for (let entry = begin; entry < end; entry += size) {
      const start = stringOffset + bytes.readUInt32LE(entry);
      if (bytes.subarray(start, bytes.indexOf(0, start)).toString('utf8') !== name) continue;
      const value = bytes.readUInt32LE(entry + 4), section = offset + bytes.readUInt16LE(entry + 14) * stride;
      return { address: value, file_offset: bytes.readUInt32LE(section + 16) + value - bytes.readUInt32LE(section + 12) };
    }
  }
  throw new Error('Fixture symbol not found: ' + name);
}
const hex = value => '0x' + value.toString(16).padStart(8, '0');
async function boot(mode) {
  const elf = path.join(fixtureDirectory, mode + '.elf'), identity = await inspectSourceElf(elf);
  assert.equal(identity.sha256, fixtureManifest.sha256[mode + '.elf']);
  let caps = await inspector.getCapabilities();
  if (!caps.elf.endsWith(elf)) {
    await inspector.pause(); await inspector.loadElf(elf); await inspector.resume();
    for (let n = 0;; n++) {
      caps = await inspector.getCapabilities(); if (caps.elf.endsWith(elf) && Number(caps.elf_crc)) break;
      assert.ok(n < 200, 'ELF did not boot'); await delay(50);
    }
    await inspector.pause();
  }
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line: readyLine, expected_sha256: identity.sha256 });
  let h = await inspector.readEvents(0, 200);
  while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: h.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const address = symbol(await fs.readFile(elf), 'fixture_result').address;
  const bytes = await inspector.readMemory(hex(address), 4);
  const moduleId = Buffer.from(bytes, 'hex').readInt32LE();
  assert.ok(moduleId >= 0, 'SifLoadModule failed: ' + moduleId);
  return { elf, module_id: moduleId, sha256: identity.sha256 };
}
function verify(result, code) {
  assert.equal(result.state, 'captured', JSON.stringify(result));
  const r = result.report;
  assert.equal(r.cpu, 'iop'); assert.equal(r.core.exception_code, code);
  assert.equal(r.iop_reset_epoch, result.iop_reset_epoch);
  assert.equal(r.elf_role, 'ee_boot_affinity_only'); assert.equal(r.module_identity, null);
  assert.equal(r.core.previous_exl, null); assert.ok(r.core.previous_status);
  assert.equal(r.instruction_evidence.status, 'unavailable');
  assert.ok(r.core.gpr.every(value => BigInt(value) <= 0xffffffffn));
  assert.equal(r.context_matches_stop, true, JSON.stringify(r.partial_reasons));
  assert.equal(r.context.cpu, 'iop'); assert.equal(r.context.status.data.pc, r.core.post_exception_pc);
  assert.ok(r.events.events.some(event => event.type === 'iop_exception' && event.cpu === 'iop' && event.detail === result.watch_id));
  assert.equal(r.complete, false); assert.ok(r.partial_reasons.includes('iop_module_identity_unavailable'));
  return r;
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await call('pcsx2_launch', { executable, elf: path.join(fixtureDirectory, 'normal.elf') }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause();
  report.initial = await boot('normal');
  const caps = await inspector.getCapabilities(); assert.ok(caps.features.includes('iop_exception_watch'));
  const rejectedId = 'a'.repeat(32), status = await inspector.getStatus();
  await assert.rejects(inspector.startExceptionWatch(rejectedId, { ...caps, iop_reset_epoch: caps.iop_reset_epoch + 1 }, { cpu: 'iop' }), /epoch changed/);
  assert.deepEqual(await inspector.getStatus(), status);
  passed('loaded resident IRX through real SifLoadModule; stale IOP reset epoch refuses arming without resuming');
  const sentinel = '0x001f0000'; await inspector.setBreakpoint(sentinel, { cpu: 'iop', description: 'foreign IOP exception sentinel' });
  const before = await inspector.listBreakpoints('iop');
  const watch = await call('pcsx2_exception_watch_start', { cpu: 'iop', exception_codes: [9], timeout_ms: 15000, screenshot: true });
  await inspector.resume(); inspector.disconnect(); await delay(3000);
  inspector = new DebugServerClient(); await inspector.connect();
  assert.equal((await inspector.exceptionWatchStatus(watch.watch_id)).state, 'captured');
  const normal = await call('pcsx2_exception_report', { watch_id: watch.watch_id, output_directory: directory });
  report.results.push(normal); const normalCore = verify(normal, 9).core;
  assert.equal(Number(BigInt(normalCore.gpr[8])), 0x13579bdf);
  assert.equal(normalCore.requested_branch_delay, false);
  const window = normal.report.memory.code, opcode = Buffer.from(window.hex, 'hex').readUInt32LE(Number(normalCore.exception_pc) - Number(window.address));
  const irx = await fs.readFile(path.join(fixtureDirectory, 'iop-exceptions.irx'));
  assert.equal(opcode, irx.readUInt32LE(symbol(irx, 'fixture_iop_break').file_offset));
  assert.deepEqual(await inspector.listBreakpoints('iop'), before);
  assert.equal(normal.report.context.screenshot.ok, false);
  passed('automatic IOP BREAK freezes 32-bit GPR/real CP0, canonical RAM, IOP context and events before polling; reconnect preserves foreign IOP breakpoint');
  passed('IRX instruction bytes match the actual trap; no GS frame and unknown IOP module identity remain explicit partial evidence');
  const immutable = await inspector.exceptionWatchStatus(watch.watch_id);
  await boot('normal');
  assert.deepEqual(await inspector.exceptionWatchStatus(watch.watch_id), immutable);
  passed('captured IOP report remains immutable after EE/IOP VM reset');
  await inspector.removeBreakpoint(sentinel, 'iop');
  await inspector.setBreakpoint(normalCore.exception_pc, { cpu: 'iop', description: 'owned test before genuine IOP BREAK' });
  let cursor = await inspector.readEvents(0, 200);
  while (cursor.events.length === 200) cursor = await inspector.readEvents(cursor.next_cursor, 200);
  await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: cursor.next_cursor, type: 'breakpoint', timeoutMs: 10000 })).timed_out, false);
  await inspector.removeBreakpoint(normalCore.exception_pc, 'iop');
  const eeWatch = await call('pcsx2_exception_watch_start', { cpu: 'ee', exception_codes: [9], screenshot: false });
  await inspector.resume(); await delay(150);
  assert.equal((await call('pcsx2_exception_report', { watch_id: eeWatch.watch_id })).state, 'armed');
  assert.equal((await inspector.getStatus()).paused, false);
  await inspector.pause(); await call('pcsx2_exception_watch_cancel', { watch_id: eeWatch.watch_id });
  passed('EE-only watch ignores a genuine IOP BREAK resumed from its actual IOP instruction breakpoint');
  await boot('delay');
  const delayedWatch = await call('pcsx2_exception_watch_start', { cpu: 'iop', exception_codes: [9], timeout_ms: 15000, screenshot: false });
  await inspector.resume();
  const delayed = await call('pcsx2_exception_report', { watch_id: delayedWatch.watch_id, wait_ms: 10000 });
  report.results.push(delayed); const delayedCore = verify(delayed, 9).core;
  assert.equal(Number(BigInt(delayedCore.gpr[8])), 0x13579bdf);
  const delayedWindow = delayed.report.memory.code, delayedBytes = Buffer.from(delayedWindow.hex, 'hex');
  const delayedOffset = Number(delayedCore.exception_pc) - Number(delayedWindow.address);
  assert.equal(delayedBytes.readUInt32LE(delayedOffset), irx.readUInt32LE(symbol(irx, 'fixture_iop_delay_break').file_offset));
  assert.equal(delayedBytes.readUInt32LE(delayedOffset - 4), irx.readUInt32LE(symbol(irx, 'fixture_iop_branch').file_offset));
  // Preserve the pinned upstream recompiler's observed BD limitation, not an idealized ISA result.
  assert.equal(delayedCore.requested_branch_delay, false);
  assert.equal(Number(delayedCore.epc), Number(delayedCore.exception_pc));
  report.delay_slot_probe = { fixture_expected_branch_delay: true, observed_bd_argument: delayedCore.requested_branch_delay,
    cause: delayedCore.cause, epc: delayedCore.epc, exception_pc: delayedCore.exception_pc,
    limitation: 'IOP recompiler supplied bd=false for a genuine delay-slot BREAK; no architectural repair or verified IOP instruction provenance' };
  passed('IOP delay-slot fixture matches IRX BREAK/branch bytes and preserves the observed upstream BD/EPC limitation');
  await boot('syscall');
  const syscallWatch = await call('pcsx2_exception_watch_start', { cpu: 'iop', exception_codes: [8], timeout_ms: 15000, screenshot: false });
  await inspector.resume();
  const syscall = await call('pcsx2_exception_report', { watch_id: syscallWatch.watch_id, wait_ms: 10000 });
  report.results.push(syscall); verify(syscall, 8);
  passed('explicit IOP syscall filter observes a real code-8 exception without EE BREAK provenance');
  await boot('reset');
  const resetWatch = await call('pcsx2_exception_watch_start', { cpu: 'iop', screenshot: false });
  const oldEpoch = resetWatch.iop_reset_epoch;
  await inspector.resume();
  const reset = await call('pcsx2_exception_report', { watch_id: resetWatch.watch_id, wait_ms: 5000 });
  report.results.push(reset); assert.equal(reset.state, 'armed', JSON.stringify(reset));
  assert.equal((await inspector.getCapabilities()).iop_reset_epoch, oldEpoch);
  assert.equal(reset.iop_reset_scope, 'cpu_reset_only');
  await call('pcsx2_exception_watch_cancel', { watch_id: resetWatch.watch_id }); await inspector.pause();
  passed('software SifIopReset is explicitly outside the CPU reset epoch; no false module identity or reset detection is claimed');
  await boot('hardreset');
  const hardWatch = await call('pcsx2_exception_watch_start', { cpu: 'iop', screenshot: false });
  await inspector.resume();
  const hardReset = await call('pcsx2_exception_report', { watch_id: hardWatch.watch_id, wait_ms: 5000 });
  report.results.push(hardReset); assert.equal(hardReset.state, 'cpu_reset', JSON.stringify(hardReset));
  assert.ok((await inspector.getCapabilities()).iop_reset_epoch > hardWatch.iop_reset_epoch); await inspector.pause();
  passed('verified guest MMIO CPU reset advances IOP epoch and disarms its watch with cpu_reset independently of EE identity');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error); report.error_stack = error.stack; process.exitCode = 1;
  try {
    let logs = await inspector.readLogs(0, 200);
    for (let n = 0; logs.logs.length === 200 && n < 12; n++) logs = await inspector.readLogs(logs.next_cursor, 200);
    report.failure_logs = logs;
  } catch {}
} finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); report.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json')); if (report.error) console.error(report.error);
}
