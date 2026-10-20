import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { debugServer, contextResponse, history } from './fixtures.mjs';

test('session tools work over MCP, filter logs, validate arguments and write unique artifacts', async t => {
  const image = contextResponse();
  const mock = await debugServer(t, request => {
    if (request.cmd === 'status') return image.status;
    if (request.cmd === 'capture_context') return image;
    if (request.cmd === 'read_logs') return history('logs', [
      { sequence: 1, timestamp_ms: 1, source: 'console', level: 3, message: 'SMS booted', truncated: false },
      { sequence: 2, timestamp_ms: 2, source: 'console', level: 2, message: 'UDPFS disconnected', truncated: false },
    ]);
    if (request.cmd === 'load_elf') return { ok: true, path: request.path, reset_requested: true };
    if (request.cmd === 'read_events') return history('events');
    if (request.cmd === 'capabilities') return { ok: true, protocol_version: 2, session: 1, elf: 'test.elf', elf_crc: '0x12345678', features: ['capture_context'] };
    throw new Error(request.cmd);
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-session-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = new Client({ name: 'session-test', version: '1.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const tool of ['capabilities', 'read_events', 'wait_event', 'read_logs', 'load_elf', 'capture_context']) assert.ok(tools.includes('pcsx2_' + tool));
  const resource = await client.readResource({ uri: 'ps2://debug_sessions' });
  assert.match(resource.contents[0].text, /next_cursor/);
  assert.equal((await client.callTool({ name: 'pcsx2_capture_context', arguments: {} })).isError, true);
  await client.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: mock.port } });

  const result = await client.callTool({ name: 'pcsx2_read_logs', arguments: { contains: 'UDPFS' } });
  const logs = JSON.parse(result.content[0].text);
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.next_cursor, 2);
  const saved = [];
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: 'pcsx2_capture_context', arguments: { output_directory: directory } });
    assert.ok(!result.isError);
    const report = JSON.parse(result.content[0].text);
    saved.push(report.artifacts.directory);
    assert.equal(result.content[1].type, 'image');
    const disk = JSON.parse(await fs.readFile(report.artifacts.report, 'utf8'));
    assert.equal(disk.complete, true);
    assert.equal(disk.screenshot.data, undefined);
    assert.deepEqual(await fs.readFile(report.artifacts.screenshot), Buffer.from(image.screenshot.data, 'base64'));
  }
  assert.notEqual(saved[0], saved[1]);
  const invalid = await client.callTool({ name: 'pcsx2_capture_context', arguments: { memory_length: 4097 } });
  assert.equal(invalid.isError, true);
  const timed = await client.callTool({ name: 'pcsx2_wait_event', arguments: { timeout_ms: 0 } });
  assert.equal(JSON.parse(timed.content[0].text).timed_out, true);
});
