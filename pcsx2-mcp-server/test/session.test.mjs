import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { debugServer, screenshot, history, contextResponse } from './fixtures.mjs';

async function clientFor(t, reply) {
  const mock = await debugServer(t, reply);
  const client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect();
  t.after(() => client.disconnect());
  return { client, mock };
}

test('wait filters events, preserves dropped history and advances its cursor', async t => {
  const { client, mock } = await clientFor(t, request => {
    assert.equal(request.cmd, 'read_events');
    if (request.after === 0) return { ...history('events', [{ sequence: 10, timestamp_ms: 1, type: 'paused', cpu: 'ee', pc: '0x1000', detail: '' }]), dropped: true };
    return history('events', [{ sequence: 11, timestamp_ms: 2, type: 'breakpoint', cpu: 'ee', pc: '0x1004', detail: '' }]);
  });
  const result = await client.waitEvent({ type: 'breakpoint', timeoutMs: 1000 });
  assert.equal(result.timed_out, false);
  assert.equal(result.dropped, true);
  assert.equal(result.events[0].sequence, 11);
  assert.deepEqual(mock.requests.map(request => request.after), [0, 10]);
});

test('wait returns an explicit timeout and respects cancellation without sending a request', async t => {
  const { client, mock } = await clientFor(t, () => history('events', [], 5));
  const result = await client.waitEvent({ after: 5, timeoutMs: 0 });
  assert.equal(result.timed_out, true);
  assert.deepEqual(result.events, []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.waitEvent({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(mock.requests.length, 1);
});

test('a pending event wait leaves the connection available for resume', async t => {
  let resumed = false;
  const { client } = await clientFor(t, async request => {
    if (request.cmd === 'resume') { resumed = true; return { ok: true }; }
    if (!resumed) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return history('events');
    }
    return history('events', [{ sequence: 1, timestamp_ms: 1, type: 'resumed', cpu: 'ee', pc: '0x1000', detail: '' }]);
  });
  const waiting = client.waitEvent({ type: 'resumed', timeoutMs: 1000 });
  await client.resume();
  assert.equal((await waiting).events[0].type, 'resumed');
});

test('session tools reject old plugins and malformed history', async t => {
  let response = { ok: false, error: 'Unknown command: capabilities' };
  const { client } = await clientFor(t, () => response);
  await assert.rejects(client.getCapabilities(), /Rebuild PCSX2/);
  response = { ...history('events'), next_cursor: -1 };
  await assert.rejects(client.readEvents(), /greater than or equal to 0/);
});

test('context validates its screenshot and preserves explicitly partial snapshots', async t => {
  let response = contextResponse();
  const { client, mock } = await clientFor(t, () => response);
  const context = await client.captureContext({ memoryAddress: '00100000', memoryLength: 16 });
  assert.equal(context.screenshot.ok, true);
  assert.equal(mock.requests[0].memory_address, '0x00100000');
  response = contextResponse({ ok: false, error: 'No rendered frame available' });
  assert.equal((await client.captureContext()).screenshot.ok, false);
  response = contextResponse({ ...screenshot(), data: 'broken' });
  await assert.rejects(client.captureContext());
  await assert.rejects(client.captureContext({ memoryLength: -1 }));
  await assert.rejects(client.captureContext({ memoryAddress: '123456789' }));
});

test('ELF paths retain Windows separators and reject control characters', async t => {
  const { client, mock } = await clientFor(t, request => ({ ok: true, path: request.path, reset_requested: true }));
  const filename = 'D:\\dev\\PS2 project\\jellyfin.elf';
  assert.equal((await client.loadElf(filename)).path, filename);
  assert.equal(mock.requests[0].path, filename);
  await assert.rejects(client.loadElf('bad\npath.elf'));
  await assert.rejects(client.loadElf('relative.elf'), /absolute/);
});
