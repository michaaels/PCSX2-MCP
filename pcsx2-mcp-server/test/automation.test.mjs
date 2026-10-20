import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { EmulatorLauncher, validateElf } from '../dist/emulator-launcher.js';
import { debugServer } from './fixtures.mjs';

const operation = (active = true, reason = '') => ({ ok: true, session: 1, operation_id: 1, active,
  start_frame: 10, target_frame: 17, current_frame: active ? 12 : 17, frames_advanced: active ? 2 : 7, reason, paused: !active });
async function clientFor(t, reply) {
  const mock = await debugServer(t, reply);
  const client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect(); t.after(() => client.disconnect());
  return { client, mock };
}

test('frame/input automation maps named buttons, raw axes and exact completion counts', async t => {
  const { client, mock } = await clientFor(t, request => request.cmd === 'automation_status' ? operation(false, 'completed') : operation());
  const result = await client.advanceFrames(7, { input: { buttons: ['cross', 'right'], left_x: 0 } });
  assert.equal(result.completed, true);
  assert.equal(mock.requests[0].buttons, (1 << 6) | (1 << 1));
  assert.equal(mock.requests[0].left_x, 0);
  assert.equal(mock.requests[0].right_y, 127);
  assert.equal(mock.requests[1].operation_id, 1);
  await assert.rejects(client.startFrameAdvance(0));
  await assert.rejects(client.startFrameAdvance(1, { controller: 2 }));
  await assert.rejects(client.startFrameAdvance(1, { left_x: 256 }));
});

test('interrupted automation is not reported as completed', async t => {
  const { client } = await clientFor(t, request => request.cmd === 'automation_status'
    ? { ...operation(false, 'paused_early'), frames_advanced: 2, current_frame: 12 } : operation());
  assert.equal((await client.advanceFrames(7)).completed, false);
});

test('concurrent frame tools on one connection are rejected without cancelling the first', async t => {
  const { client, mock } = await clientFor(t, async request => {
    if (request.cmd === 'automation_status') { await new Promise(resolve => setTimeout(resolve, 20)); return operation(false, 'completed'); }
    return operation();
  });
  const first = client.advanceFrames(7);
  await assert.rejects(client.advanceFrames(1), /already pending/);
  assert.equal((await first).completed, true);
  assert.ok(!mock.requests.some(request => request.cmd === 'automation_cancel'));
});

test('timed out automation requests native cancellation before returning', async t => {
  const { client, mock } = await clientFor(t, async request => {
    if (request.cmd === 'automation_status') await new Promise(resolve => setTimeout(resolve, 5));
    return operation(request.cmd !== 'automation_cancel', request.cmd === 'automation_cancel' ? 'cancelled' : '');
  });
  await assert.rejects(client.advanceFrames(7, { timeoutMs: 1 }), /timed out/);
  assert.equal(mock.requests.at(-1).cmd, 'automation_cancel');
});

test('cancellation after operation start restores through the native cancel command', async t => {
  const controller = new AbortController();
  const { client, mock } = await clientFor(t, request => {
    if (request.cmd === 'frame_advance') controller.abort();
    return operation(request.cmd !== 'automation_cancel');
  });
  await assert.rejects(client.advanceFrames(7, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(mock.requests.at(-1).cmd, 'automation_cancel');
});

test('failed cancellation is explicitly uncertain instead of claiming a restored VM', async t => {
  const { client } = await clientFor(t, async request => {
    if (request.cmd === 'automation_status') await new Promise(resolve => setTimeout(resolve, 5));
    if (request.cmd === 'automation_cancel') return { ok: false, error: 'VM unavailable' };
    return operation();
  });
  await assert.rejects(client.advanceFrames(7, { timeoutMs: 1 }), /cancellation could not be confirmed/);
});

test('connection loss before the operation ID reports unconfirmed cleanup', async t => {
  const { client } = await clientFor(t, () => null);
  await assert.rejects(client.advanceFrames(7), /without an operation ID; cancellation could not be confirmed/);
});

test('launcher validates a MIPS ELF identity and rejects invalid files without starting a process', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-launch-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'valid.elf');
  const header = Buffer.alloc(52);
  header.write('7f454c46', 0, 'hex'); header[4] = 1; header[5] = 1;
  header.writeUInt16LE(8, 18); header.writeUInt32LE(0x100000, 24);
  await fs.writeFile(filename, header);
  const identity = await validateElf(filename);
  assert.equal(identity.entry, '0x00100000');
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  await fs.writeFile(filename, 'invalid');
  const launcher = new EmulatorLauncher();
  await assert.rejects(launcher.launch({ executable: process.execPath, elf: filename }), /MIPS ELF/);
  await assert.rejects(launcher.stop(), /No emulator owned/);
  await assert.rejects(launcher.launch({ executable: 'relative', elf: filename }), /absolute/);
});
