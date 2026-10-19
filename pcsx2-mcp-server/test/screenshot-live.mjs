// Optional end-to-end check against a running, rebuilt PCSX2. Not part of npm test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const port = Number(process.argv[2] ?? 21512);
const output = resolve(process.argv[3] ?? '../release/screenshot-validation');
const client = new Client({ name: 'screenshot-live-validation', version: '1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  stderr: 'pipe',
});
const results = [];
let resume = false;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
}
async function status() { return (await call('pcsx2_status')).content.map(c => c.text ?? '').join('\n'); }
async function capture(name, args = {}) {
  let result;
  // A freshly booted VM can accept debugging commands before its first GS frame.
  for (let attempt = 0; attempt < 60; attempt++) {
    result = await client.callTool({ name: 'pcsx2_screenshot', arguments: args });
    if (!result.isError || name !== 'initial' || !JSON.stringify(result).includes('No rendered frame')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(!result.isError, JSON.stringify(result));
  const image = result.content.find(c => c.type === 'image');
  assert.ok(image, 'No image returned by MCP');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width > 0 && width <= (args.width ?? 640));
  assert.ok(height > 0 && height <= (args.height ?? 480));
  await writeFile(resolve(output, name + '.png'), png);
  const entry = { name, width, height, bytes: png.length, status: await status() };
  results.push(entry);
  console.log(JSON.stringify(entry));
  return png;
}
try {
  await mkdir(output, { recursive: true });
  await client.connect(transport);
  let connected;
  for (let attempt = 0; attempt < 30; attempt++) {
    connected = await call('pcsx2_connect', { mode: 'debug', debug_port: port });
    if (JSON.stringify(connected).includes('DebugServer: connected')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.match(JSON.stringify(connected), /DebugServer: connected/);
  const initial = await status();
  assert.match(initial, /DebugServer: .*connected/);
  await capture('initial');
  await capture('wide', { width: 1280, height: 720 });
  if (initial.includes('Paused: false')) {
    resume = true;
    await call('pcsx2_pause');
  }
  for (let i = 0; i < 50 && !(await status()).includes('Paused: true'); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(await status(), /Paused: true/);
  const paused = await capture('paused');
  const repeated = await capture('paused-repeat');
  assert.deepEqual(repeated, paused, 'Paused captures should show exactly the same frame');
  assert.match(await status(), /Paused: true/);
  const invalid = await client.callTool({ name: 'pcsx2_screenshot', arguments: { width: 0 } });
  assert.equal(invalid.isError, true);
  console.log('Invalid dimensions rejected; live MCP captures saved to ' + output);
} finally {
  if (resume) await call('pcsx2_continue').catch(error => console.error('Resume failed:', error.message));
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  await client.close();
}
