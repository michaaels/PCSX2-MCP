import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { dumpOptions, parseDump, verifyDump } from '../dist/gs-dump.js';
import { startGsDump, readGsDump, cancelGsDump } from '../dist/gs-dump-tools.js';
import { debugServer } from './fixtures.mjs';

const id = 'a'.repeat(32), caps = { ok: true, protocol_version: 2, process_id: 12, session: 2,
  execution_epoch: 3, elf: 'game.elf', elf_crc: '0x12345678', features: ['gs_dump'] };
const state = (overrides = {}) => ({ ok: true, operation_id: id, state: 'queued', active: true, reason: '',
  session: 2, execution_epoch: 3, elf: caps.elf, elf_crc: caps.elf_crc, path: `/tmp/${id}.gs`,
  frames_requested: 1, bytes_submitted: 0, max_bytes: 64 * 1024 * 1024, format: 'uncompressed_gs', ...overrides });
async function setup(t, reply) {
  const mock = await debugServer(t, reply);
  const client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect(); t.after(() => client.disconnect());
  return { mock, client };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-dump-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, `${id}.gs`);
  const header = Buffer.alloc(44);
  header.writeUInt32LE(0xffffffff, 0); header.writeUInt32LE(36, 4);
  header.writeUInt32LE(9, 8); header.writeUInt32LE(4, 12); header.writeUInt32LE(36, 16); header.writeUInt32LE(36, 36);
  const transfer = Buffer.alloc(6 + 16); transfer[0] = 0; transfer[1] = 1; transfer.writeUInt32LE(16, 2);
  const bytes = Buffer.concat([header, Buffer.alloc(4 + 8192), Buffer.from([3]), Buffer.alloc(8192), transfer, Buffer.from([2, 1, 0, 0, 0, 1, 0])]);
  await fs.writeFile(filename, bytes);
  return { filename, bytes };
}

test('dump bounds, ID, state and native byte budget are strict', () => {
  assert.equal(dumpOptions.parse({}).frames, 1);
  for (const invalid of [{ frames: 0 }, { frames: 301 }, { timeout_ms: 99 }, { timeout_ms: 30001 }, { max_bytes: 0 }])
    assert.equal(dumpOptions.safeParse(invalid).success, false);
  assert.equal(parseDump(state(), id).state, 'queued');
  for (const invalid of [{ operation_id: 'b'.repeat(32) }, { state: 'closed' }, { path: '/tmp/other.gs' },
    { bytes_submitted: 64 * 1024 * 1024 + 1 }, { max_bytes: undefined }]) assert.throws(() => parseDump(state(invalid), id));
});

test('closed stream verification parses headers/packets and hashes actual bytes', async t => {
  const { filename, bytes } = await fixture(t);
  const result = await verifyDump(filename, 1024 * 1024, 1);
  assert.equal(result.verified, true); assert.equal(result.vsync_packets, 1);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.bytes, bytes.length);
  await assert.rejects(verifyDump(filename, 1024 * 1024, 2), /before the requested/);
});

test('truncated, malformed, oversized and cancelled artifacts never verify', async t => {
  const { filename, bytes } = await fixture(t);
  for (const mutate of [buffer => buffer.writeUInt32LE(0, 0), buffer => buffer.writeUInt32LE(0xffffffff, 12),
    buffer => buffer.writeUInt32LE(1, 8), buffer => buffer.writeUInt32LE(0xffffffff, buffer.length - 6),
    buffer => buffer[44 + 4 + 8192] = 9, buffer => buffer[buffer.length - 1] = 2]) {
    const malformed = Buffer.from(bytes); mutate(malformed); await fs.writeFile(filename, malformed);
    await assert.rejects(verifyDump(filename, 1024 * 1024, 1));
  }
  await fs.writeFile(filename, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(verifyDump(filename, 1024 * 1024, 1), /Truncated/);
  await fs.writeFile(filename, bytes);
  const handle = await fs.open(filename, 'r+'); await handle.truncate(1024 * 1024 + 1); await handle.close();
  await assert.rejects(verifyDump(filename, 1024 * 1024, 1), /file size/);
  await fs.writeFile(filename, bytes);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyDump(filename, 1024 * 1024, 1, controller.signal), { name: 'AbortError' });
});

test('start passes exact VM identity and bounds without issuing resume; refusal preserves another operation', async t => {
  const { client, mock } = await setup(t, request => request.cmd === 'capabilities' ? caps :
    state({ operation_id: request.operation_id, path: `/tmp/${request.operation_id}.gs` }));
  const result = await startGsDump(client);
  assert.match(result.operation_id, /^[a-f0-9]{32}$/);
  const request = mock.requests[1];
  assert.equal(request.expected_process_id, 12); assert.equal(request.expected_execution_epoch, 3);
  assert.equal(request.expected_elf_crc, caps.elf_crc); assert.equal(request.frames, 1);
  assert.ok(!mock.requests.some(request => request.cmd === 'resume'));
  const refused = await setup(t, request => request.cmd === 'capabilities' ? caps : { ok: false, error: 'Another dump is active' });
  await assert.rejects(startGsDump(refused.client), /Another dump is active/);
  assert.ok(!refused.mock.requests.some(request => request.cmd === 'gs_dump_cancel'));
});

test('old backend refuses before mutation and uncertain start cancels only its generated ID', async t => {
  const old = await setup(t, () => ({ ...caps, features: [] }));
  await assert.rejects(startGsDump(old.client), /Rebuild/); assert.equal(old.mock.requests.length, 1);
  const { client, mock } = await setup(t, request => {
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'gs_dump_start') return state({ operation_id: request.operation_id, execution_epoch: 99, path: `/tmp/${request.operation_id}.gs` });
    return state({ operation_id: request.operation_id, state: 'cancelled', active: false, path: `/tmp/${request.operation_id}.gs` });
  });
  await assert.rejects(startGsDump(client), /start failed/);
  assert.equal(mock.requests.at(-1).cmd, 'gs_dump_cancel');
  assert.equal(mock.requests.at(-1).operation_id, mock.requests[1].operation_id);
});

test('status never verifies an active/failed file; cancelled waits leave the native dump untouched', async t => {
  const { client, mock } = await setup(t, () => state());
  const result = await readGsDump(client, id);
  assert.equal(result.timed_out, true); assert.equal(result.artifact.verified, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGsDump(client, id, 1000, controller.signal), { name: 'AbortError' });
  assert.ok(!mock.requests.some(request => request.cmd === 'gs_dump_cancel'));
});

test('status requires a native close, exact file byte count and stable operation while verifying', async t => {
  const { filename, bytes } = await fixture(t);
  const { client } = await setup(t, () => state({ state: 'closed', active: false, path: filename, bytes_submitted: bytes.length }));
  assert.equal((await readGsDump(client, id)).artifact.verified, true);
  const wrong = await setup(t, () => state({ state: 'closed', active: false, path: filename, bytes_submitted: bytes.length + 1 }));
  await assert.rejects(readGsDump(wrong.client, id), /file size differs/);
  let requests = 0;
  const changed = await setup(t, () => state({ state: 'closed', active: false, path: filename, bytes_submitted: bytes.length, execution_epoch: requests++ ? 7 : 3 }));
  await assert.rejects(readGsDump(changed.client, id), /changed while/);
});

test('cancel waits for a native terminal state and never sends broad stop/reset commands', async t => {
  const { client, mock } = await setup(t, request => state(request.cmd === 'gs_dump_cancel'
    ? { state: 'cancelling' } : { state: 'cancelled', active: false }));
  assert.equal((await cancelGsDump(client, id)).state, 'cancelled');
  assert.deepEqual(mock.requests.map(request => request.cmd), ['gs_dump_cancel', 'gs_dump_status']);
});
