// node test/source-step-live.mjs <PCSX2> <ELF> <source file> <line> <artifacts> [fixture]
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

const [executable, elf, file, initialLine, output, fixture] = process.argv.slice(2);
assert.ok(output);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'source-step-'));
const identity = await inspectSourceElf(path.resolve(elf));
const mcp = new Client({ name: 'source-step-live', version: '1.0' }), inspector = new DebugServerClient();
const report = { elf, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [], results: [] };
let owns = false;
async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!result.isError, name + ': ' + JSON.stringify(result.content)); return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
async function boot(line) {
  const group = await call('pcsx2_breakpoint_source', { elf, file: fixture ? path.basename(file) : file, line: Number(line), expected_sha256: identity.sha256 });
  let history = await inspector.readEvents(0, 200);
  while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
  const cursor = history.next_cursor;
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  assert.equal((await inspector.getStatus()).paused, true);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
}
async function step(mode, extra = {}) {
  const result = await call('pcsx2_source_step', { mode, expected_sha256: identity.sha256, ...extra });
  report.results.push(result);
  assert.equal(result.paused, true); assert.equal(result.cleanup_complete, true);
  assert.equal((await inspector.listBreakpoints()).filter(bp => bp.description?.startsWith('MCP guarded step')).length, 0);
  return result;
}
async function symbolAddress(name) {
  const bytes = await fs.readFile(elf), offset = bytes.readUInt32LE(32), size = bytes.readUInt16LE(46), count = bytes.readUInt16LE(48);
  for (let section = 0; section < count; section++) {
    const header = offset + section * size;
    if (bytes.readUInt32LE(header + 4) !== 2) continue;
    const strings = offset + bytes.readUInt32LE(header + 24) * size, stringOffset = bytes.readUInt32LE(strings + 16);
    const begin = bytes.readUInt32LE(header + 16), end = begin + bytes.readUInt32LE(header + 20), stride = bytes.readUInt32LE(header + 36);
    assert.ok(stride >= 16);
    for (let entry = begin; entry < end; entry += stride) {
      const start = stringOffset + bytes.readUInt32LE(entry);
      if (bytes.subarray(start, bytes.indexOf(0, start)).toString('utf8') === name) return bytes.readUInt32LE(entry + 4);
    }
  }
  throw new Error('Fixture symbol not found: ' + name);
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause(); await boot(initialLine);
  const caps = await inspector.getCapabilities(), status = await inspector.getStatus();
  assert.ok(caps.features.includes('guarded_step')); assert.ok(Number.isSafeInteger(caps.execution_epoch));
  await assert.rejects(inspector.startGuardedStep({ ...caps, execution_epoch: caps.execution_epoch + 1 }, status.pc), /identity changed/);
  passed('native stale execution epoch refuses a step without resuming');
  const into = await step('into');
  assert.equal(into.completed, true, JSON.stringify(into));
  assert.ok(into.trace.length > 0); assert.equal(into.trace.at(-1).pc, into.pc);
  passed('real source into stops at another file/line with instruction PC/opcode evidence');
  if (fixture === 'inline') {
    let current = into;
    for (let n = 0; current.after.frames.length < 2 && n < 8; n++) {
      current = await step('into', { max_instruction_units: 64 }); assert.equal(current.completed, true, JSON.stringify(current));
    }
    assert.ok(current.after.frames.length > 1, 'Expected genuine inline frames');
    const breakpoints = await inspector.listBreakpoints(), snapshot = await inspector.getStatus();
    const rejected = await mcp.callTool({ name: 'pcsx2_source_step', arguments: { mode: 'out' } });
    assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /inline frame/);
    assert.deepEqual(await inspector.listBreakpoints(), breakpoints);
    assert.equal((await inspector.getStatus()).pc, snapshot.pc);
    passed('inline source is reported accurately and unsupported inline out leaves PC/breakpoints unchanged');
  } else if (fixture) {
    assert.equal(into.after.frames[0].function, 'step_add');
    const out = await step('out');
    assert.equal(out.completed, true, JSON.stringify(out)); assert.equal(out.reason, 'returned');
    assert.ok(out.trace.some(item => item.is_return)); assert.equal(out.after.frames[0].function, '_start');
    passed('out executes the function body and JR $ra/delay slot, reaching its actual caller');
    await boot(initialLine);
    const over = await step('over');
    assert.equal(over.completed, true, JSON.stringify(over));
    assert.equal(over.after.frames[0].function, '_start');
    assert.ok(over.trace.some(item => item.is_call)); assert.ok(over.trace.some(item => item.is_return));
    passed('over executes the call and return within its own instruction budget');
    // Re-run from the same genuine source breakpoint, then protect the first successor.
    await boot(initialLine);
    const target = over.trace[0].target;
    await inspector.setBreakpoint(target, { description: 'source-step foreign successor', condition: '1' });
    const preserved = await inspector.listBreakpoints();
    const refused = await step('into');
    assert.equal(refused.reason, 'native_refused'); assert.equal(refused.steps, 0);
    assert.deepEqual(await inspector.listBreakpoints(), preserved);
    await inspector.removeBreakpoint(target);
    passed('conditional foreign successor breakpoint is preserved and prevents an unsafe step');
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    const conditionLine = lines.findIndex(line => line.includes('i < 3')) + 1; assert.ok(conditionLine);
    await boot(conditionLine);
    const condition = await step('into');
    assert.equal(condition.completed, true, JSON.stringify(condition));
    assert.ok(condition.trace.some(item => [4, 5, 6, 7, 20, 21, 22, 23].includes(Number(item.opcode) >>> 26)));
    passed('conditional loop branch reaches its predicted successor with delay-slot evidence');
    const counter = await symbolAddress('step_counter'), hex = value => '0x' + value.toString(16).padStart(8, '0');
    await boot(initialLine);
    await inspector.setMemcheck(hex(counter), hex(counter + 4), { type: 'write', action: 'break', description: 'source-step user watchpoint' });
    const watched = await step('over');
    assert.equal(watched.reason, 'watchpoint', JSON.stringify(watched)); assert.equal(watched.completed, false);
    assert.ok((await inspector.listMemchecks()).some(item => item.start === hex(counter)));
    await inspector.removeMemcheck(hex(counter), hex(counter + 4));
    passed('a real EE memory watchpoint interrupts over and survives private breakpoint cleanup');
    // At the watched store, an execute breakpoint must not suppress its watchpoint.
    await inspector.setBreakpoint(watched.pc, { description: 'user execute breakpoint at watched store' });
    await inspector.setMemcheck(hex(counter), hex(counter + 4), { type: 'write', action: 'break' });
    const watchedAgain = await step('into');
    assert.equal(watchedAgain.reason, 'watchpoint', JSON.stringify(watchedAgain));
    assert.equal(watchedAgain.pc, watched.pc);
    assert.ok((await inspector.listBreakpoints()).some(bp => bp.address === watched.pc));
    await inspector.removeBreakpoint(watched.pc); await inspector.removeMemcheck(hex(counter), hex(counter + 4));
    passed('stepping from an execute breakpoint also preserves the watchpoint on that same instruction');
    const loopLine = lines.findIndex(line => line.includes('for (;;)')) + 1; assert.ok(loopLine);
    await boot(loopLine);
    const limited = await step('into', { max_instruction_units: 8 });
    assert.equal(limited.reason, 'instruction_limit', JSON.stringify(limited)); assert.equal(limited.completed, false);
    assert.ok(limited.instruction_units <= 8);
    assert.ok(limited.trace.some(item => item.instruction_units === 2));
    passed('same-line infinite loop stops at its instruction limit, including branch delay slots');
    const trapLine = lines.findIndex(line => line.includes('break 0')) + 1;
    if (trapLine) {
      await boot(trapLine - 1);
      await inspector.writeMemory(hex(await symbolAddress('step_control')), '01000000');
      const toTrap = await step('into'); assert.equal(toTrap.completed, true, JSON.stringify(toTrap));
      const trap = await step('into');
      assert.equal(trap.reason, 'exception', JSON.stringify(trap)); assert.equal(trap.completed, false);
      assert.equal((Number(trap.trace.at(-1).cause) >>> 2) & 31, 9);
      passed('a deliberate EE BREAK exception stops stepping and exposes the actual CP0 Cause/EPC');
    }
    await boot(initialLine);
    const detached = new DebugServerClient(); await detached.connect();
    const snapshot = await inspector.getStatus();
    const abandoned = await detached.startGuardedStep(await detached.getCapabilities(), snapshot.pc, 2, 100);
    detached.disconnect(); await delay(250);
    const recovered = await inspector.guardedStepStatus(abandoned.operation_id);
    assert.equal(recovered.active, false); assert.equal(recovered.paused, true); assert.equal(recovered.cleanup_complete, true);
    assert.ok(!(await inspector.listBreakpoints()).some(bp => bp.description?.startsWith('MCP guarded step')));
    passed('native watchdog cleans the private breakpoint after its client disconnects');
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); report.error_stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); report.passed = false; process.exitCode = 1; });
  await mcp.close();
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json')); if (report.error) console.error(report.error);
}
