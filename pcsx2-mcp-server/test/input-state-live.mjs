// node test/input-state-live.mjs <existing pinned-native .p2s> <expected SHA256> <new output>
// Real MCP stdio/file inspection; does not launch or load an emulator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.equal(process.argv.length, 5);
const source = path.resolve(process.argv[2]), expected = process.argv[3], output = path.resolve(process.argv[4]);
assert.match(expected, /^[\da-f]{64}$/); await fs.mkdir(output);
const hash = b => createHash('sha256').update(b).digest('hex');
const report = { kind: 'offline_actual_savestate_MCP_inspection', created_at: new Date().toISOString(), node: process.version, passed: false, checks: [], native_load: 'not_performed',
  native_process_launched: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const mcp = new Client({ name: 'input-state-inspector-live', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' });
transport.stderr?.resume();
const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
async function raw(input) { return mcp.callTool({ name: 'pcsx2_input_state_inspect', arguments: input }, undefined, { timeout: 30000 }); }
try {
  report.inputs = {};
  for (const relative of ['../dist/input-state.js', '../dist/input-movie-tools.js', '../src/input-state.ts', '../src/input-movie-tools.ts', './input-state-live.mjs'])
    report.inputs[relative] = hash(await fs.readFile(fileURLToPath(new URL(relative, import.meta.url))));
  const original = await fs.readFile(source); assert.equal(hash(original), expected); report.source = { path: source, sha256: expected };
  const copy = path.join(output, 'companion.p2s'); await fs.writeFile(copy, original, { flag: 'wx' });
  await mcp.connect(transport); report.mcp_pid = transport.pid;
  assert.ok((await mcp.listTools()).tools.some(t => t.name === 'pcsx2_input_state_inspect'));
  passed('Actual MCP stdio advertises the offline companion inspector without an emulator connection');
  const inspected = await raw({ path: copy, expected_sha256: expected }); assert.ok(!inspected.isError, JSON.stringify(inspected.content));
  const data = JSON.parse(inspected.content[0].text); report.inspection = data;
  assert.equal(data.sha256, expected); assert.equal(data.producer_reported, 'v2.9.147'); assert.equal(data.save_version, '0x9a590000');
  assert.equal(data.archive_and_payloads_verified, true); assert.ok(data.entries.length >= 15);
  assert.equal(data.entries.find(e => e.name === 'eeMemory.bin').bytes, 33554432);
  assert.equal(data.native_load, 'not_performed'); assert.equal(data.elf_association, 'not_verified');
  assert.ok(data.entries.every(e => /^[\da-f]{8}$/.test(e.crc32)));
  assert.ok(!JSON.stringify(data).includes('payload_hex'));
  passed('A hash-pinned genuine v2.9.147 ZIP validates every decoded payload CRC/length and version while leaving load/ELF identity unclaimed');
  const wrong = await raw({ path: copy, expected_sha256: '0'.repeat(64) }); assert.equal(wrong.isError, true); assert.match(wrong.content[0].text, /SHA256 mismatch/);
  passed('Wrong caller SHA refuses the artifact');
  const truncated = path.join(output, 'truncated.p2s'); await fs.writeFile(truncated, original.subarray(0, -22), { flag: 'wx' });
  const rejected = await raw({ path: truncated }); assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /finalized ZIP/);
  passed('Missing ZIP finalization refuses the partial companion');
  const corrupted = Buffer.from(original), payload = 30 + original.readUInt16LE(26) + original.readUInt16LE(28);
  corrupted[payload + 4] ^= 1; const corrupt = path.join(output, 'corrupt.p2s'); await fs.writeFile(corrupt, corrupted, { flag: 'wx' });
  const failed = await raw({ path: corrupt }); assert.equal(failed.isError, true); assert.match(failed.content[0].text, /CRC mismatch/);
  assert.equal(hash(await fs.readFile(source)), expected); assert.equal(hash(await fs.readFile(copy)), expected);
  passed('Actual payload corruption fails CRC; original and copied source bytes remain unchanged');
  report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; process.exitCode = 1; }
finally {
  try { await mcp.close(); report.mcp_stopped = transport.pid === null; } catch (error) { report.cleanup_error = String(error); report.passed = false; }
  if (!report.mcp_stopped) report.passed = false;
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2)+'\n');
  if (!report.passed) process.exitCode = 1;
}
