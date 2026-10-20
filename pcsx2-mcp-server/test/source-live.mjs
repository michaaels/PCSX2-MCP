// node test/source-live.mjs <patched pcsx2 executable> <Clang source-debug.elf> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 5, 'Provide executable, source-debug.elf and artifact directory');
const [executable, elf, output] = process.argv.slice(2).map(value => path.resolve(value));
await fs.mkdir(output, { recursive: true });
const identity = await inspectSourceElf(elf);
const mcp = new Client({ name: 'source-live', version: '1.0' });
const inspector = new DebugServerClient();
const report = { elf, sha256: identity.sha256, started_at: new Date().toISOString(), checks: [] };
let owns = false;
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
function passed(message) { report.checks.push(message); console.log('PASS ' + message); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  const tools = (await mcp.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('pcsx2_source_locations') && tools.includes('pcsx2_source_pc'));
  const offline = await call('pcsx2_source_locations', { elf, addresses: [identity.entry, '0x40000000'], expected_sha256: identity.sha256 });
  const location = offline.locations[0];
  assert.equal(location.resolved, true); assert.equal(location.frames[0].function, '_start');
  assert.ok(location.frames[0].file.endsWith('source-debug.c'));
  const source = (await fs.readFile(path.join(path.dirname(elf), 'source-debug.c'), 'utf8')).split(/\r?\n/);
  assert.ok(source[location.frames[0].line - 1].includes('void _start'));
  assert.equal(offline.locations[1].resolved, false);
  report.offline = offline;
  passed('MCP stdio resolves genuine compiler DWARF to the exact source line without an emulator');
  const instructions = Array.from({ length: 16 }, (_, index) => '0x' + (Number(identity.entry) + index * 4).toString(16));
  const inline = await call('pcsx2_source_locations', { elf, addresses: instructions });
  assert.ok(inline.locations.some(location => location.frames.length > 1 && location.frames[0].function === 'source_tick'));
  report.inline = inline;
  passed('genuine DWARF inline frames preserve the inlined function and caller');
  const wrong = await mcp.callTool({ name: 'pcsx2_source_locations', arguments: { elf, addresses: [identity.entry], expected_sha256: '0'.repeat(64) } });
  assert.equal(wrong.isError, true);
  passed('wrong ELF SHA256 is rejected');
  await call('pcsx2_launch', { executable, elf }); owns = true;
  await inspector.connect();
  for (let attempt = 0; !(await inspector.getCapabilities()).elf; attempt++) {
    assert.ok(attempt < 80, 'ELF did not boot'); await delay(100);
  }
  await inspector.pause();
  report.capabilities = await inspector.getCapabilities();
  const before = await inspector.getStatus();
  const current = await call('pcsx2_source_pc');
  const after = await inspector.getStatus();
  assert.equal(current.locations[0].address, before.pc);
  assert.equal(current.locations[0].resolved, true);
  assert.equal(current.runtime.elf_crc, identity.elf_crc);
  assert.equal(current.paused_at_snapshot, true);
  assert.equal(after.pc, before.pc); assert.equal(after.paused, true);
  report.current = current;
  passed('live Windows EE PC resolves to source and matches the loaded ELF CRC without changing PC/pause state');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error); throw error;
} finally {
  inspector.disconnect();
  if (owns) await call('pcsx2_stop').catch(error => { report.cleanup_error = String(error); });
  await mcp.close();
  await fs.writeFile(path.join(output, 'source-live.json'), JSON.stringify(report, null, 2) + '\n');
}
