// node test/workflow-live.mjs <patched pcsx2 executable> <symbol-bearing homebrew ELF> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

const [executable, elf, output] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(executable && elf && output);
await fs.mkdir(output, { recursive: true });
const mcp = new Client({ name: 'workflow-live', version: '1.0' });
const inspector = new DebugServerClient();
const results = { executable, elf, started_at: new Date().toISOString(), checks: [] };
let owns = false;
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
function passed(message) { results.checks.push(message); console.log('PASS ' + message); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  const launched = await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let attempt = 0; !(await inspector.getCapabilities()).elf; attempt++) {
    assert.ok(attempt < 80, 'ELF did not boot'); await delay(250);
  }
  await call('pcsx2_import_symbols');
  let main;
  for (let attempt = 0; ; attempt++) {
    const symbols = await inspector.lookupSymbols({ query: 'main', kind: 'function', exact: true });
    if (symbols.symbols.length === 1 && symbols.elf) { main = symbols.symbols[0]; break; }
    assert.ok(attempt < 80, 'Expected this test ELF to import an exact main function'); await delay(250);
  }
  await inspector.pause();
  const first = await call('pcsx2_lookup_symbols', { kind: 'function', limit: 2 });
  const second = await call('pcsx2_lookup_symbols', { kind: 'function', limit: 2, offset: first.next_offset });
  assert.equal(first.symbols.length, 2); assert.equal(second.symbols.length, 2);
  assert.notDeepEqual(first.symbols, second.symbols);
  const resolved = await call('pcsx2_resolve_address', { address: main.address });
  assert.ok(resolved.symbols.some(symbol => symbol.name === 'main' && symbol.offset === 0));
  if (main.size > 1) {
    const inside = '0x' + (Number.parseInt(main.address, 16) + 1).toString(16);
    assert.ok((await inspector.resolveAddress(inside)).symbols.some(symbol => symbol.name === 'main' && symbol.offset === 1));
  }
  results.main = main;
  const globals = await call('pcsx2_lookup_symbols', { kind: 'global', limit: 10 });
  assert.ok(globals.symbols.length > 0, 'Expected this fixture to include global variable symbols');
  const global = globals.symbols[0];
  assert.ok((await inspector.resolveAddress(global.address)).symbols.some(symbol => symbol.kind === 'global' && symbol.name === global.name));
  passed('native imported symbols paginate, resolve addresses and expose exact offsets');
  await assert.rejects(inspector.readMemoryStrict('0x40000000', 1), /unmapped/);
  passed('strict native memory reads reject unmapped bytes');
  const entrySymbols = (await inspector.resolveAddress(launched.entry)).symbols;
  const entry = entrySymbols.find(symbol => symbol.kind === 'function' && symbol.address === launched.entry);
  assert.ok(entry, 'Expected an entry-point function symbol');
  const count = (await inspector.listBreakpoints()).length;
  const missing = await mcp.callTool({ name: 'pcsx2_breakpoint_symbol', arguments: { name: '__missing_pcsx2_workflow_symbol__' } });
  assert.equal(missing.isError, true);
  assert.equal((await inspector.listBreakpoints()).length, count);
  const breakpoint = await call('pcsx2_breakpoint_symbol', { name: entry.name });
  assert.equal(breakpoint.address, launched.entry);
  await inspector.loadElf(elf);
  const events = await inspector.readEvents(0, 200);
  await inspector.resume();
  const hit = await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 15000 });
  assert.ok(!hit.timed_out);
  assert.equal((await inspector.getStatus()).pc, launched.entry);
  await inspector.removeBreakpoint(launched.entry);
  await call('pcsx2_import_symbols');
  for (let attempt = 0; !(await inspector.lookupSymbols({ query: 'main', exact: true, kind: 'function' })).symbols.length; attempt++) {
    assert.ok(attempt < 80, 'Reimport did not complete'); await delay(100);
  }
  passed('breakpoint by imported function name stops at the real ELF entry; missing names change nothing');

  const identity = await inspector.getCapabilities();
  const boot = await call('pcsx2_run_scenario', { output_directory: output, scenario: {
    name: 'entry-to-main', expected_elf_crc: identity.elf_crc, steps: [
      { action: 'run_to_symbol', symbol: 'main' },
      { action: 'assert_expression', expression: '1 + 1', equals: '2' },
      { action: 'assert_log', contains: '(VMManager) Resuming...' },
    ],
  } });
  assert.equal(boot.passed, true); assert.equal(boot.final_paused, true);
  assert.equal((await inspector.getStatus()).pc, main.address);
  assert.equal((await inspector.listBreakpoints()).length, count);
  passed('scenario runs to main, evaluates expressions, verifies new logs and removes its breakpoint');
  results.boot_report = boot.artifacts.report;

  await inspector.resume();
  for (let attempt = 0; ; attempt++) {
    try { await inspector.captureScreenshot(); break; }
    catch (error) { assert.ok(attempt < 80, error.message); await delay(250); }
  }
  await inspector.pause();
  const expected = await inspector.readMemory(main.address, 16);
  const runtime = await call('pcsx2_run_scenario', { output_directory: output, scenario: {
    name: 'runtime-smoke', expected_elf_crc: identity.elf_crc, steps: [
      { action: 'frames', frames: 7 }, { action: 'input', buttons: ['cross'], frames: 2 },
      { action: 'assert_memory', address: main.address, expected_hex: expected },
      { action: 'assert_controller' }, { action: 'screenshot' }, { action: 'context' },
    ],
  } });
  assert.equal(runtime.passed, true); assert.equal(runtime.steps.length, 6);
  results.runtime_report = runtime.artifacts.report;
  passed('scenario advances video, injects input, checks memory/controller and saves actual PNG/context');

  const failed = await mcp.callTool({ name: 'pcsx2_run_scenario', arguments: { output_directory: output, scenario: {
    name: 'intentional-failure', steps: [ { action: 'assert_expression', expression: '1', equals: '2' }, { action: 'frames', frames: 60 } ],
  } } });
  assert.equal(failed.isError, true);
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.passed, false); assert.equal(failure.steps.length, 1); assert.equal(failure.final_paused, true);
  assert.ok(failure.diagnostic.screenshot);
  results.failure_report = failure.artifacts.report;
  passed('failed assertion stops remaining steps, saves failure context and leaves VM paused');
  const guarded = await mcp.callTool({ name: 'pcsx2_run_scenario', arguments: { output_directory: output, scenario: {
    name: 'wrong-build', expected_elf_crc: identity.elf_crc === '0x00000000' ? '1' : '0', steps: [{ action: 'frames' }],
  } } });
  assert.equal(guarded.isError, true);
  assert.equal(JSON.parse(guarded.content[0].text).steps.length, 0);
  passed('wrong-build scenario fails before running any steps');
  results.passed = true;
} finally {
  inspector.disconnect();
  if (owns) await mcp.callTool({ name: 'pcsx2_stop', arguments: {} }).catch(() => {});
  await mcp.close();
  results.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
