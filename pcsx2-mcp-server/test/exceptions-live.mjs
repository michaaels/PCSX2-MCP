// node test/exceptions-live.mjs <PCSX2> <ELF> <artifacts>
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
const directory = await fs.mkdtemp(path.join(output, 'exception-'));
const identity = await inspectSourceElf(path.resolve(elf));
const mcp = new Client({ name: 'exceptions-live', version: '1.0' });
let inspector = new DebugServerClient(), owns = false;
const report = { elf, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [], results: [] };
async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!result.isError, name + ': ' + JSON.stringify(result.content)); return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
// Independent linked ELF evidence, including assembler labels not imported by the debugger.
const elfBytes = await fs.readFile(elf);
function elfSymbol(name) {
  const table = elfBytes.readUInt32LE(32), stride = elfBytes.readUInt16LE(46), count = elfBytes.readUInt16LE(48);
  for (let section = 0; section < count; section++) {
    const header = table + section * stride;
    if (elfBytes.readUInt32LE(header + 4) !== 2) continue;
    const strings = table + elfBytes.readUInt32LE(header + 24) * stride, stringOffset = elfBytes.readUInt32LE(strings + 16);
    const begin = elfBytes.readUInt32LE(header + 16), end = begin + elfBytes.readUInt32LE(header + 20), size = elfBytes.readUInt32LE(header + 36);
    assert.ok(size >= 16);
    for (let entry = begin; entry < end; entry += size) {
      const start = stringOffset + elfBytes.readUInt32LE(entry);
      if (elfBytes.subarray(start, elfBytes.indexOf(0, start)).toString('utf8') === name) return elfBytes.readUInt32LE(entry + 4);
    }
  }
  throw new Error('Fixture ELF label missing: ' + name);
}
function elfOpcode(pc) {
  const table = elfBytes.readUInt32LE(28), stride = elfBytes.readUInt16LE(42), count = elfBytes.readUInt16LE(44);
  for (let n = 0; n < count; n++) {
    const header = table + n * stride, base = elfBytes.readUInt32LE(header + 8), size = elfBytes.readUInt32LE(header + 16);
    if (elfBytes.readUInt32LE(header) === 1 && pc >= base && pc + 4 <= base + size)
      return elfBytes.readUInt32LE(elfBytes.readUInt32LE(header + 4) + pc - base);
  }
  throw new Error('Fixture instruction outside PT_LOAD');
}
function verifyBreak(result, label, branchDelay) {
  const evidence = result.report.instruction_evidence, expected = elfSymbol(label);
  assert.equal(evidence.status, 'verified', JSON.stringify(evidence));
  assert.equal(Number(evidence.pc), expected); assert.equal(Number(evidence.opcode), elfOpcode(expected));
  assert.equal(evidence.branch_delay, branchDelay);
  assert.equal((Number(evidence.opcode) & 0xfc00003f), 13);
}
async function setMode(mode) {
  const bytes = Buffer.alloc(4); bytes.writeUInt32LE(mode);
  await inspector.writeMemory('0x' + elfSymbol('exception_mode').toString(16).padStart(8, '0'), bytes.toString('hex'));
}
async function boot() {
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'source-debug.c', line: 6, expected_sha256: identity.sha256 });
  let h = await inspector.readEvents(0, 200);
  while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: h.next_cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause(); await boot();
  assert.ok((await inspector.getCapabilities()).features.includes('ee_exception_watch'));
  assert.ok((await inspector.getCapabilities()).features.includes('ee_break_provenance'));
  const before = await inspector.getStatus();
  const expiry = await call('pcsx2_exception_watch_start', { timeout_ms: 100, screenshot: false });
  assert.equal(expiry.resumes_vm, false);
  assert.deepEqual(await inspector.getStatus(), before);
  await delay(180);
  assert.equal((await call('pcsx2_exception_report', { watch_id: expiry.watch_id })).state, 'expired');
  passed('arming does not resume; native TTL expires while VM remains paused');
  const cancelled = await call('pcsx2_exception_watch_start', { timeout_ms: 5000 });
  const foreignCancel = await mcp.callTool({ name: 'pcsx2_exception_watch_cancel', arguments: { watch_id: 'f'.repeat(32) } });
  assert.equal(foreignCancel.isError, true);
  assert.equal((await call('pcsx2_exception_report', { watch_id: cancelled.watch_id })).state, 'armed');
  assert.equal((await call('pcsx2_exception_watch_cancel', { watch_id: cancelled.watch_id })).state, 'cancelled');
  passed('foreign watch ID is rejected; explicit cancellation disarms only its own watch');

  const sentinel = '0x00108000'; await inspector.setBreakpoint(sentinel, { description: 'exception foreign breakpoint' });
  const preserved = await inspector.listBreakpoints();
  const watch = await call('pcsx2_exception_watch_start', { exception_codes: [9], timeout_ms: 10000 });
  const conflict = await mcp.callTool({ name: 'pcsx2_exception_watch_start', arguments: {} });
  assert.equal(conflict.isError, true);
  await inspector.resume(); inspector.disconnect();
  await delay(250); inspector = new DebugServerClient(); await inspector.connect();
  const frozen = await inspector.exceptionWatchStatus(watch.watch_id);
  assert.equal(frozen.state, 'captured', JSON.stringify(frozen));
  const observed = await call('pcsx2_exception_report', { watch_id: watch.watch_id, output_directory: directory });
  report.results.push(observed);
  assert.equal(observed.report.core.exception_code, 9);
  assert.equal(observed.report.context_matches_stop, true);
  assert.equal(observed.report.core.requested_branch_delay, false);
  verifyBreak(observed, 'exception_normal_break', false);
  assert.deepEqual(observed.report.instruction_evidence.consistency,
    { entry_pc_matches: true, bd_argument_matches: true, epc_matches: true, cause_bd_matches: true });
  const window = observed.report.memory.code, offset = Number(observed.report.core.exception_pc) - Number(window.address);
  assert.equal(window.valid, true);
  assert.equal((Buffer.from(window.hex, 'hex').readUInt32LE(offset) & 63), 13, 'Exception PC must point to BREAK');
  assert.deepEqual(await inspector.listBreakpoints(), preserved);
  assert.equal((await inspector.getStatus()).paused, true);
  assert.equal(Number((await inspector.getStatus()).pc), Number(observed.report.core.post_exception_pc));
  assert.equal(observed.report.context.ok, true);
  assert.equal(observed.report.context.screenshot.ok, false); // Fixture never initializes GS.
  assert.equal(observed.report.complete, false);
  assert.equal(JSON.parse(await fs.readFile(observed.artifacts.report, 'utf8')).report.core.exception_code, 9);
  passed('native BREAK capture completes before report polling, survives reconnect, preserves CP0/PC/RAM/events and foreign breakpoints');
  passed('no rendered GS frame yields a partial JSON report with usable CPU evidence');
  passed('normal BREAK provenance PC/opcode matches independent ELF label and instruction bytes');
  const immutable = await inspector.exceptionWatchStatus(watch.watch_id);
  await boot();
  assert.deepEqual(await inspector.exceptionWatchStatus(watch.watch_id), immutable);
  passed('captured report remains immutable across ELF reset');

  await setMode(1);
  const delayWatch = await call('pcsx2_exception_watch_start', { exception_codes: [9], screenshot: false, timeout_ms: 10000 });
  const stale = await mcp.callTool({ name: 'pcsx2_exception_report', arguments: { watch_id: watch.watch_id } });
  assert.equal(stale.isError, true);
  await inspector.resume();
  const delayed = await call('pcsx2_exception_report', { watch_id: delayWatch.watch_id, wait_ms: 5000 });
  report.results.push(delayed); assert.equal(delayed.state, 'captured', JSON.stringify(delayed));
  const core = delayed.report.core;
  assert.equal(core.exception_code, 9);
  verifyBreak(delayed, 'exception_delay_break', true);
  const branchPC = elfSymbol('exception_delay_branch');
  assert.equal(elfSymbol('exception_delay_break'), branchPC + 4);
  assert.equal(elfOpcode(branchPC) >>> 26, 4); // Fixture BEQ $zero,$zero.
  assert.equal(Number(core.exception_pc), branchPC); // Preserve observed v2.6.3 behavior.
  assert.equal(core.requested_branch_delay, false);
  assert.equal(delayed.report.instruction_evidence.consistency.entry_pc_matches, false);
  assert.equal(delayed.report.instruction_evidence.consistency.bd_argument_matches, false);
  if (!core.previous_exl) {
    assert.equal(Number(core.cause) >>> 31, Number(core.requested_branch_delay));
    assert.equal(Number(core.epc) + (core.requested_branch_delay ? 4 : 0), Number(core.exception_pc));
  }
  if (!delayed.report.context_matches_stop) {
    assert.equal(delayed.report.context.ok, false); assert.deepEqual(delayed.report.memory, {});
    assert.equal(delayed.report.complete, false);
  }
  report.delay_slot_probe = { requested_branch_delay: core.requested_branch_delay, exception_entry_pc: core.exception_pc,
    epc: core.epc, context_matches_stop: delayed.report.context_matches_stop,
    instruction_evidence: delayed.report.instruction_evidence,
    limitation: 'Upstream recompiler may pass the branch PC and bd=false for delay-slot BREAK; entry PC is not a verified fault address' };
  passed('delay-slot BREAK provenance matches ELF PC/BD while raw upstream PC/BD stays unchanged; changed deferred state withholds RAM/context');

  await boot();
  await setMode(2);
  const nestedWatch = await call('pcsx2_exception_watch_start', { exception_codes: [9], screenshot: false });
  await inspector.resume();
  const nested = await call('pcsx2_exception_report', { watch_id: nestedWatch.watch_id, wait_ms: 5000 });
  report.results.push(nested); assert.equal(nested.state, 'captured', JSON.stringify(nested));
  verifyBreak(nested, 'exception_nested_break', false);
  assert.equal(nested.report.core.previous_exl, true);
  assert.equal(Number(nested.report.core.epc), 0x00101234);
  assert.equal(nested.report.instruction_evidence.consistency.epc_matches, null);
  assert.equal(nested.report.instruction_evidence.consistency.cause_bd_matches, null);
  passed('nested EXL preserves deliberately older EPC and verified current BREAK origin without inferring architectural EPC/BD');

  await boot();
  await setMode(3);
  const syscallWatch = await call('pcsx2_exception_watch_start', { exception_codes: [8], screenshot: false });
  await inspector.resume();
  const syscall = await call('pcsx2_exception_report', { watch_id: syscallWatch.watch_id, wait_ms: 5000 });
  report.results.push(syscall); assert.equal(syscall.state, 'captured', JSON.stringify(syscall));
  assert.equal(syscall.report.core.exception_code, 8);
  assert.equal(Number(syscall.report.core.exception_pc), elfSymbol('exception_syscall'));
  assert.equal(syscall.report.core.instruction, null);
  assert.equal(syscall.report.instruction_evidence.status, 'unavailable');
  passed('explicitly selected real syscall has no stale BREAK provenance after reset/new watch');

  await boot();
  const filtered = await call('pcsx2_exception_watch_start', { exception_codes: [12], timeout_ms: 5000, screenshot: false });
  await inspector.resume(); await delay(100); await inspector.pause();
  assert.equal((await call('pcsx2_exception_report', { watch_id: filtered.watch_id })).state, 'armed');
  await call('pcsx2_exception_watch_cancel', { watch_id: filtered.watch_id });
  passed('a nonmatching BREAK does not trigger an arithmetic-only watch');
  await boot();
  const reset = await call('pcsx2_exception_watch_start', { screenshot: false });
  await inspector.loadElf(elf);
  assert.equal((await call('pcsx2_exception_report', { watch_id: reset.watch_id })).state, 'vm_changed');
  passed('reset invalidates an armed watch without capturing a different execution');
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); report.error_stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); report.passed = false; process.exitCode = 1; });
  await mcp.close();
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json')); if (report.error) console.error(report.error);
}
