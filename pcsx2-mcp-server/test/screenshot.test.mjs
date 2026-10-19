import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { parseScreenshot } from '../dist/screenshot.js';
import { debugServer, screenshot } from './fixtures.mjs';

test('accepts a PNG image and its matching dimensions', () => {
  const response = screenshot();
  assert.deepEqual(parseScreenshot(response), { width: 1, height: 1, data: response.data });
});

test('rejects malformed image envelopes and truncated PNGs', () => {
  const response = screenshot();
  for (const invalid of [
    null, {}, { ...response, width: 0 }, { ...response, width: 1281 },
    { ...response, height: 1025 }, { ...response, width: 1.5 },
    { ...response, mime_type: 'image/jpeg' }, { ...response, width: 2 },
    { ...response, data: 'not a PNG' }, { ...response, data: response.data + '\n' },
    { ...response, data: Buffer.from(response.data, 'base64').subarray(0, 33).toString('base64') },
    { ...response, data: 'A'.repeat(8 * 1024 * 1024 + 4) },
  ]) assert.throws(() => parseScreenshot(invalid), /Invalid/);
});

test('receives a large fragmented PNG and serializes concurrent commands', async t => {
  const response = screenshot(640, 480);
  assert.ok(response.data.length > 1024 * 1024);
  const mock = await debugServer(t, request => request.cmd === 'screenshot'
    ? response : { ok: true, data: { alive: true, paused: false, pc: '00100000', cycles: 1 } });
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect());
  await client.connect();
  const [image, status] = await Promise.all([client.captureScreenshot(), client.getStatus()]);
  assert.equal(image.data, response.data);
  assert.equal(status.alive, true);
  assert.deepEqual(mock.requests, [{ cmd: 'screenshot', width: 640, height: 480 }, { cmd: 'status', cpu: 'ee' }]);
});

test('rejects invalid requested sizes before contacting the emulator', async () => {
  const client = new DebugServerClient();
  for (const [width, height] of [[0, 480], [1281, 480], [640, 1025], [1.5, 2], [NaN, 1]]) {
    await assert.rejects(client.captureScreenshot(width, height), /Screenshot width/);
  }
});

test('reports old plugins and no-frame errors without breaking subsequent requests', async t => {
  const replies = [
    { ok: false, error: 'Unknown command: screenshot' },
    { ok: false, error: 'No rendered frame available' }, screenshot(),
  ];
  const mock = await debugServer(t, () => replies.shift());
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect());
  await client.connect();
  await assert.rejects(client.captureScreenshot(), /Unknown command.*Rebuild/);
  await assert.rejects(client.captureScreenshot(), /No rendered frame/);
  assert.equal((await client.captureScreenshot()).width, 1);
});

test('rejects screenshots exceeding the requested bounds', async t => {
  const mock = await debugServer(t, () => screenshot(2, 2));
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect());
  await client.connect();
  await assert.rejects(client.captureScreenshot(1, 1), /exceeds requested/);
});

test('rejects an in-flight capture promptly when the connection closes', async t => {
  const mock = await debugServer(t, () => null);
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect());
  await client.connect();
  await assert.rejects(client.captureScreenshot(), /connection closed/);
  assert.equal(client.isConnected(), false);
});

test('bounds an oversized TCP response and disconnects', async t => {
  const mock = await debugServer(t, () => ({ ok: true, data: 'A'.repeat(9 * 1024 * 1024) }));
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect());
  await client.connect();
  await assert.rejects(client.captureScreenshot(), /exceeds 9 MiB/);
  assert.equal(client.isConnected(), false);
});
