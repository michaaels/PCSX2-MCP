// node test/source-breakpoint-live.mjs <PCSX2> <debug ELF> <source file> <line> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf } from '../dist/source-debug.js';

assert.equal(process.argv.length, 7);
const executable = path.resolve(process.argv[2]), elf = path.resolve(process.argv[3]), file = process.argv[4];
const line = Number(process.argv[5]), output = path.resolve(process.argv[6]);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'source-breakpoint-'));
const identity = await inspectSourceElf(elf);
const mcp = new Client({ name: 'source-breakpoint-live', version: '1.0' });
const inspector = new DebugServerClient();
const report = { elf, file, line, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [] };
let owns = false;
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 }); }
async function call(name, args = {}) {
  const result = await raw(name, args); assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
async function bootToTarget(filename, addresses) {
  await inspector.loadElf(filename);
  const cursor = (await inspector.readEvents(0, 200)).next_cursor;
  await inspector.resume();
  const hit = await inspector.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: 15000 });
  assert.ok(!hit.timed_out, 'Did not hit a real line breakpoint');
  const status = await inspector.getStatus(); assert.equal(status.paused, true); assert.ok(addresses.includes(status.pc));
  return status;
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  const options = { elf, file, line, expected_sha256: identity.sha256 };
  const resolved = await call('pcsx2_source_addresses', options);
  assert.equal(resolved.resolved, true); assert.equal(resolved.resolved_line, line);
  report.resolved = resolved;
  assert.equal((await call('pcsx2_source_addresses', { ...options, line: 2147483647 })).resolved, false);
  assert.equal((await raw('pcsx2_source_addresses', { ...options, expected_sha256: '0'.repeat(64) })).isError, true);
  passed('real DWARF resolves exact statement addresses; empty lines are not shifted and wrong hashes fail');
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let attempt = 0; !(await inspector.getCapabilities()).elf; attempt++) {
    assert.ok(attempt < 100); await delay(100);
  }
  await inspector.pause();
  const caps = await inspector.getCapabilities(); assert.ok(caps.features.includes('source_breakpoints'));
  const initial = await inspector.listBreakpoints();
  assert.equal((await raw('pcsx2_breakpoint_source', { ...options, line: 2147483647 })).isError, true);
  assert.deepEqual(await inspector.listBreakpoints(), initial);
  await assert.rejects(inspector.installSourceBreakpoints('a'.repeat(32), resolved.addresses, { ...caps, session: caps.session + 1 }), /identity changed/);
  assert.deepEqual(await inspector.listBreakpoints(), initial);
  passed('empty-line and native stale-session refusal preserve the breakpoint list');
  // Exercise the native 64-address boundary without running those breakpoints.
  const batch = Array.from({ length: 64 }, (_, index) => '0x' + (0x100000 + index * 4).toString(16).padStart(8, '0'));
  await inspector.installSourceBreakpoints('b'.repeat(32), batch, caps);
  assert.equal((await inspector.removeSourceBreakpoints('b'.repeat(32))).removed_addresses.length, 64);
  await assert.rejects(inspector.installSourceBreakpoints('b'.repeat(32), [...batch, '0x00100100'], caps));
  assert.deepEqual(await inspector.listBreakpoints(), initial);
  passed('native 64-address batch installs/removes completely; excessive batch changes nothing');
  const target = resolved.addresses[0];
  await inspector.setBreakpoint(target, { description: 'user-preserved', condition: '1' });
  const user = await inspector.listBreakpoints();
  assert.equal((await raw('pcsx2_breakpoint_source', options)).isError, true);
  assert.deepEqual(await inspector.listBreakpoints(), user);
  await inspector.removeBreakpoint(target);
  passed('existing conditional user breakpoint is unchanged by a source-line conflict');
  const installed = await call('pcsx2_breakpoint_source', options);
  report.installed = installed;
  report.stopped = await bootToTarget(elf, resolved.addresses);
  const current = await call('pcsx2_source_pc'); report.source = current;
  assert.ok(current.locations[0].frames.some(frame => frame.file?.replaceAll('\\', '/') === resolved.file && frame.line === line));
  assert.equal((await call('pcsx2_remove_source_breakpoints', { group_id: installed.group_id })).complete, true);
  passed('actual instruction breakpoint hits the requested source line after reset, with PC-to-source confirmation');
  const sentinel = '0x01fffff0'; await inspector.setBreakpoint(sentinel, { description: 'foreign sentinel' });
  const replaced = await call('pcsx2_breakpoint_source', options);
  await inspector.removeBreakpoint(target);
  await inspector.setBreakpoint(target, { description: 'replacement user breakpoint' });
  const preserved = await raw('pcsx2_remove_source_breakpoints', { group_id: replaced.group_id });
  assert.equal(preserved.isError, true);
  const list = await inspector.listBreakpoints();
  assert.ok(list.some(bp => bp.address === sentinel));
  assert.ok(list.some(bp => bp.address === target && bp.description === 'replacement user breakpoint'));
  await inspector.removeBreakpoint(target); await inspector.removeBreakpoint(sentinel);
  passed('group cleanup preserves a replaced target and unrelated user breakpoint');
  const guarded = await call('pcsx2_breakpoint_source', options);
  const other = path.join(directory, 'same-code-other-path.elf');
  await fs.copyFile(elf, other, fs.constants.COPYFILE_EXCL);
  await bootToTarget(other, guarded.addresses);
  const beforeRemoval = await inspector.listBreakpoints();
  assert.equal((await raw('pcsx2_remove_source_breakpoints', { group_id: guarded.group_id })).isError, true);
  assert.deepEqual(await inspector.listBreakpoints(), beforeRemoval);
  await bootToTarget(elf, guarded.addresses);
  await call('pcsx2_remove_source_breakpoints', { group_id: guarded.group_id });
  passed('changed running ELF prevents group removal; returning to the matching ELF permits cleanup');
  assert.deepEqual(await inspector.listBreakpoints(), initial);
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); report.passed = false; process.exitCode = 1; });
  await mcp.close();
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + path.join(directory, 'validation.json'));
  if (report.error) console.error(report.error);
}
