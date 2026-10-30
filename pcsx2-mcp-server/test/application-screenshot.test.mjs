import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { applicationScreenshotOptions, parseApplicationScreenshot } from '../dist/application-screenshot.js';
import { parseScreenshot } from '../dist/screenshot.js';
import { debugServer, screenshot } from './fixtures.mjs';

const image = (target = 'debugger', width = 1, height = 1) => ({ ...screenshot(width, height), target,
  source: 'qt_widget', window_title: 'PCSX2 Debugger' });
test('application capture validates target metadata and rejects PNG/target substitution', () => {
  const options = applicationScreenshotOptions.parse({});
  assert.equal(parseApplicationScreenshot(image(), options).target, 'debugger');
  for (const value of [image('main'), { ...image(), source: 'desktop' }, { ...image(), window_title: 'x'.repeat(2049) },
    { ...image(), data: 'invalid' }, { ...image(), width: 2 }]) {
    assert.throws(() => parseApplicationScreenshot(value, options));
  }
});
test('larger Qt screenshots do not relax the existing GS dimensions', () => {
  const value = image('debugger', 1400, 1);
  assert.equal(parseApplicationScreenshot(value, applicationScreenshotOptions.parse({})).width, 1400);
  assert.throws(() => parseScreenshot(value), /Invalid/);
  assert.throws(() => parseApplicationScreenshot(value, applicationScreenshotOptions.parse({ width: 100 })), /Invalid/);
});
test('application target and limits reject before any native request', async () => {
  const client = new DebugServerClient();
  for (const input of [{ target: 'desktop' }, { target: 'arbitrary PID' }, { width: 2561 }, { height: 1601 }, { width: 0 }]) {
    await assert.rejects(client.captureApplicationScreenshot(input));
  }
});
test('application requests preserve explicit target and parse the actual image', async t => {
  const mock = await debugServer(t, request => image(request.target));
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect()); await client.connect();
  assert.equal((await client.captureApplicationScreenshot({ target: 'main', width: 100, height: 80 })).source, 'qt_widget');
  assert.deepEqual(mock.requests, [{ cmd: 'application_screenshot', target: 'main', width: 100, height: 80 }]);
});
test('unsupported and unavailable window errors leave the connection usable', async t => {
  const replies = [{ ok: false, error: 'Unknown command: application_screenshot' },
    { ok: false, error: 'Requested PCSX2 window is not visible or is minimized' }, image()];
  const mock = await debugServer(t, () => replies.shift());
  const client = new DebugServerClient('127.0.0.1', mock.port);
  t.after(() => client.disconnect()); await client.connect();
  await assert.rejects(client.captureApplicationScreenshot(), /Rebuild/);
  await assert.rejects(client.captureApplicationScreenshot(), /not visible/);
  assert.equal((await client.captureApplicationScreenshot()).width, 1);
});
