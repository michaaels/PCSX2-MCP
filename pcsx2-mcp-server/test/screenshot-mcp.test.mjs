import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { debugServer, screenshot } from './fixtures.mjs';

test('exposes screenshots over MCP stdio as PNG image content', async t => {
  let response = screenshot();
  const mock = await debugServer(t, request => request.cmd === 'status'
    ? { ok: true, data: { alive: true, paused: true, pc: '00100000', cycles: 0 } }
    : response);
  const client = new Client({ name: 'screenshot-test', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const listing = await client.listTools();
  const tool = listing.tools.find(tool => tool.name === 'pcsx2_screenshot');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.width.default, 640);
  assert.equal(tool.inputSchema.properties.height.default, 480);

  const disconnected = await client.callTool({ name: 'pcsx2_screenshot', arguments: {} });
  assert.equal(disconnected.isError, true);
  assert.match(disconnected.content[0].text, /requires DebugServer/);

  await client.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: mock.port } });
  const image = await client.callTool({ name: 'pcsx2_screenshot', arguments: {} });
  assert.ok(!image.isError);
  assert.deepEqual(image.content[0], { type: 'image', mimeType: 'image/png', data: response.data });
  assert.match(image.content[1].text, /1 x 1/);
  assert.deepEqual(mock.requests.at(-1), { cmd: 'screenshot', width: 640, height: 480 });

  await client.callTool({ name: 'pcsx2_screenshot', arguments: { width: 1280, height: 720 } });
  assert.deepEqual(mock.requests.at(-1), { cmd: 'screenshot', width: 1280, height: 720 });
  const requestCount = mock.requests.length;
  const invalid = await client.callTool({ name: 'pcsx2_screenshot', arguments: { width: 1.5 } });
  assert.equal(invalid.isError, true);
  assert.equal(mock.requests.length, requestCount);

  response = { ok: false, error: 'Unknown command: screenshot' };
  const oldPlugin = await client.callTool({ name: 'pcsx2_screenshot', arguments: {} });
  assert.equal(oldPlugin.isError, true);
  assert.match(oldPlugin.content[0].text, /Rebuild PCSX2/);
});
