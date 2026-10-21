// node test/variables-live.mjs <PCSX2> <debug ELF> <source query> <line> <artifacts> [sms]
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

const [executable, elf, file, line, output, sms] = process.argv.slice(2);
assert.ok(output);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'variables-'));
const identity = await inspectSourceElf(path.resolve(elf));
const targetLine = line === 'marker' ? (await fs.readFile(path.join(path.dirname(elf), 'source-debug.c'), 'utf8')).split(/\r?\n/).findIndex(line => line.includes('INSPECT_HERE')) + 1 : Number(line);
const mcp = new Client({ name: 'variables-live', version: '1.0' }), inspector = new DebugServerClient();
const report = { elf, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [] };
let owns = false;
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 }); }
async function call(name, args = {}) {
  const result = await raw(name, args); assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause();
  const group = await call('pcsx2_breakpoint_source', { elf, file, line: targetLine, expected_sha256: identity.sha256 });
  let history = await inspector.readEvents(0, 200);
  while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: history.next_cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const before = await inspector.getStatus(), breakpoints = await inspector.listBreakpoints();
  const vars = await call('pcsx2_variables', { expected_sha256: identity.sha256, max_depth: 4 }); report.variables = vars;
  const get = name => { const variable = vars.variables.find(item => item.name === name); assert.ok(variable, name); return variable; };
  assert.equal(vars.read_only, true); assert.equal(vars.snapshot.pc, before.pc);
  if (sms) {
    assert.equal(vars.function, 'main');
    const argc = get('argc'), argv = get('argv');
    assert.equal(argc.status, 'available'); assert.equal(argc.register, 16);
    assert.equal(argc.value, String(BigInt.asIntN(32, BigInt(vars.snapshot.gpr[4]))));
    assert.equal(argc.value, String(BigInt.asIntN(32, BigInt(vars.snapshot.gpr[16]))));
    assert.equal(argv.status, 'available'); assert.equal(argv.register, 17);
    assert.equal(BigInt(argv.value), BigInt.asUintN(32, BigInt(vars.snapshot.gpr[5])));
    passed('actual optimized GCC DWARF2 argc/argv match saved and incoming EE argument registers after the prologue');
  } else {
    assert.equal(vars.function, 'inspect_values');
    assert.equal(get('argument').value, '23'); assert.equal(get('signed_local').value, '-7');
    if (line === 'marker') { assert.equal(get('computed').value, '46'); assert.equal(get('shadow').value, '47'); }
    assert.equal(get('wide').value, String(0xfedcba9876543210n));
    assert.deepEqual(get('values').children.map(item => item.value), ['3', '5', '8']);
    const record = get('record'); assert.equal(record.children[0].value, '11');
    assert.deepEqual(record.children[1].children.map(item => item.value), ['13', '17', '19']);
    // Contrast decoded scalar with a separate native RAM read, not its own renderer.
    assert.equal(await inspector.readMemoryStrict(get('signed_local').address, 4), 'f9ffffff');
    assert.equal(await inspector.readMemoryStrict(get('wide').address, 8), '1032547698badcfe');
    passed('real stack argument, signed scalar, exact uint64, array and structure match known values and independent RAM bytes');
    assert.equal(get('pointer').children, undefined);
    const followed = await call('pcsx2_variables', { names: ['pointer', 'input', 'invalid', 'nothing'], follow_pointers: true, max_depth: 4 }); report.followed = followed;
    const pointer = followed.variables.find(item => item.name === 'pointer');
    assert.equal(pointer.children[0].children[0].value, '11');
    const input = followed.variables.find(item => item.name === 'input');
    assert.equal(input.children[0].children[0].value, '29');
    assert.equal(followed.variables.find(item => item.name === 'invalid').children[0].status, 'unsupported_memory_region');
    assert.equal(followed.variables.find(item => item.name === 'nothing').children[0].status, 'null_pointer');
    passed('pointer following is opt-in, bounded and reports MMIO/null pointers without invented data');
    const bounded = await call('pcsx2_variables', { names: ['values'], max_children: 1, max_bytes: 16 });
    assert.equal(bounded.variables[0].truncated, true); assert.equal(bounded.variables[0].children.length, 1);
    assert.equal((await call('pcsx2_variables', { names: ['does_not_exist'] })).missing_names[0], 'does_not_exist');
    passed('array truncation and missing names are explicit');
  }
  assert.deepEqual(await inspector.listBreakpoints(), breakpoints); assert.equal((await inspector.getStatus()).pc, before.pc);
  assert.equal((await inspector.getStatus()).paused, true);
  assert.equal((await raw('pcsx2_variables', { expected_sha256: '0'.repeat(64) })).isError, true);
  assert.equal((await raw('pcsx2_variables', { frame_index: 1 })).isError, true);
  passed('inspection and rejected SHA/frame leave PC, paused state and user breakpoints unchanged');
  if (!sms && line === 'marker') {
    const stepped = await call('pcsx2_source_step', { mode: 'into', max_instruction_units: 64 });
    assert.equal(stepped.completed, true, JSON.stringify(stepped)); report.scope_step = stepped;
    const outside = await call('pcsx2_variables', { names: ['shadow', 'argument', 'computed'] }); report.outside_scope = outside;
    assert.ok(!outside.variables.some(item => item.name === 'shadow')); assert.ok(outside.missing_names.includes('shadow'));
    assert.equal(outside.variables.find(item => item.name === 'argument').value, '23');
    if (get('computed').location.valid_range && Number(outside.snapshot.pc) >= get('computed').location.valid_range[1]) {
      const expired = outside.variables.find(item => item.name === 'computed');
      assert.equal(expired.status, 'not_live_at_pc'); assert.equal(expired.value, undefined);
    }
    passed('a real lexical local disappears after leaving its scope; the outer argument remains available');
  }
  const caps = await inspector.getCapabilities(), snapshot = await inspector.inspectEE(caps);
  const state = { revision: snapshot.revision, pc: snapshot.pc };
  const invalid = await inspector.inspectEE(caps, state, '0x10000000', 4);
  assert.equal(invalid.memory.valid, false); assert.equal(invalid.memory.hex, undefined);
  // A same-value write still invalidates an outstanding inspection token.
  await inspector.writeRegister(0, 2, snapshot.gpr[2]);
  await assert.rejects(inspector.inspectEE(caps, state), /state changed/);
  passed('native RAM policy returns no fake zero bytes; same-value writes invalidate a snapshot');
  const entry = await call('pcsx2_breakpoint_source', { elf, file, line: sms ? 39 : 5 });
  const current = await inspector.inspectEE(caps);
  await inspector.loadElf(elf);
  await assert.rejects(inspector.inspectEE(caps, { revision: current.revision, pc: current.pc }), /changed|paused/);
  passed('reset invalidates a snapshot even for the same ELF');
  let cursor = await inspector.readEvents(0, 200);
  while (cursor.events.length === 200) cursor = await inspector.readEvents(cursor.next_cursor, 200);
  await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: cursor.next_cursor, type: 'breakpoint', timeoutMs: 15000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: entry.group_id });
  const prologue = await call('pcsx2_variables', { names: sms ? ['argc', 'argv'] : ['argument'] }); report.prologue = prologue;
  assert.equal(prologue.location_guard, 'prologue'); assert.ok(prologue.variables.every(item => item.status === 'unavailable_during_prologue' && item.value === undefined));
  assert.equal(prologue.bytes_read, 0);
  passed('function-entry inspection reports unverified prologue locations without reading stale argument values');
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); report.stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); report.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json')); if (report.error) console.error(report.error);
}
