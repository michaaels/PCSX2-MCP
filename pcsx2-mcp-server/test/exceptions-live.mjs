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
async function symbolAddress(name) {
  const result = await inspector.lookupSymbols({ query: name, exact: true });
  assert.equal(result.symbols.length, 1, JSON.stringify(result)); return result.symbols[0].address;
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
  const immutable = await inspector.exceptionWatchStatus(watch.watch_id);
  await boot();
  assert.deepEqual(await inspector.exceptionWatchStatus(watch.watch_id), immutable);
  passed('captured report remains immutable across ELF reset');

  await inspector.importSymbols();
  for (let n = 0; n < 100; n++) {
    const symbols = await inspector.lookupSymbols({ query: 'exception_mode', exact: true });
    if (symbols.symbols.length) break; await delay(50);
  }
  await inspector.writeMemory(await symbolAddress('exception_mode'), '01000000');
  const delayWatch = await call('pcsx2_exception_watch_start', { exception_codes: [9], screenshot: false, timeout_ms: 10000 });
  const stale = await mcp.callTool({ name: 'pcsx2_exception_report', arguments: { watch_id: watch.watch_id } });
  assert.equal(stale.isError, true);
  await inspector.resume();
  const delayed = await call('pcsx2_exception_report', { watch_id: delayWatch.watch_id, wait_ms: 5000 });
  report.results.push(delayed); assert.equal(delayed.state, 'captured', JSON.stringify(delayed));
  const core = delayed.report.core;
  assert.equal(core.exception_code, 9);
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
    limitation: 'Upstream recompiler may pass the branch PC and bd=false for delay-slot BREAK; entry PC is not a verified fault address' };
  passed('delay-slot probe preserves actual hook PC/BD/CP0; changed deferred state never supplies unrelated RAM/context; new ID supersedes old watch');

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
