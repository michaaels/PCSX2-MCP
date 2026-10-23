import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { parseP2m2, inspectMovie, parseMovie, movieOptions, hashLocalFile } from '../dist/input-movie.js';
import { startInputMovie, readInputMovie } from '../dist/input-movie-tools.js';
import { debugServer } from './fixtures.mjs';

const id = 'a'.repeat(32);
export function movie(frames = 2) {
  const bytes = Buffer.alloc(570 + 36 * frames); bytes[0] = 1; bytes.write('PCSX2-test', 1);
  bytes.writeUInt32LE(frames, 561);
  for (let i = 570; i < bytes.length; i += 18) {
    bytes[i] = bytes[i + 1] = 255; bytes.fill(127, i + 2, i + 6);
  }
  return bytes;
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-input-movie-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const elf = path.join(dir, 'game.elf');
  const elfBytes = Buffer.alloc(84); elfBytes.set([127, 69, 76, 70, 1, 1, 1]);
  elfBytes.writeUInt16LE(2, 16); elfBytes.writeUInt16LE(8, 18); elfBytes.writeUInt32LE(1, 20);
  elfBytes.writeUInt32LE(52, 28); elfBytes.writeUInt16LE(52, 40); elfBytes.writeUInt16LE(32, 42); elfBytes.writeUInt16LE(1, 44);
  elfBytes.writeUInt32LE(1, 52); elfBytes.writeUInt32LE(84, 68); elfBytes.writeUInt32LE(84, 72); elfBytes.writeUInt32LE(5, 76);
  await fs.writeFile(elf, elfBytes); let crc = 0;
  for (let i = 0; i < elfBytes.length; i += 4) crc ^= elfBytes.readUInt32LE(i);
  const hash = createHash('sha256').update(elfBytes).digest('hex');
  const filename = path.join(dir, `${id}.p2m2`); await fs.writeFile(filename, movie());
  const caps = { ok: true, protocol_version: 2, process_id: 42, session: 2, execution_epoch: 3,
    elf: `host:${elf}`, elf_crc: '0x' + (crc >>> 0).toString(16).padStart(8, '0'), features: ['input_movies'] };
  const state = overrides => ({ ok: true, operation_id: id, mode: 'record', state: 'active', active: true, reason: '',
    path: filename, source: '', input_sha256: '', session: 2, execution_epoch: 4, elf: caps.elf, elf_crc: caps.elf_crc, elf_sha256: hash,
    frames: 0, max_frames: 2, start: 'power_on', paused: true, ...overrides });
  return { dir, elf, hash, filename, caps, state };
}
async function client(t, reply) {
  const mock = await debugServer(t, reply), value = new DebugServerClient('127.0.0.1', mock.port);
  await value.connect(); t.after(() => value.disconnect()); return { value, mock };
}

test('p2m2 v1 validates complete records on both ports and terminated metadata', () => {
  const valid = movie(); assert.equal(parseP2m2(valid).frames, 2);
  assert.equal(parseP2m2(valid).determinism, 'not_established');
  for (const mutate of [b => b.subarray(0, 569), b => b.subarray(0, b.length - 1), b => Buffer.concat([b, Buffer.alloc(1)]),
    b => { b[0] = 2; return b; }, b => { b[569] = 2; return b; },
    b => { b.writeUInt32LE(0, 561); return b; }, b => { b.writeUInt32LE(601, 561); return b; },
    b => { b.fill(65, 51, 306); return b; }]) assert.throws(() => parseP2m2(mutate(Buffer.from(valid))));
  const state = Buffer.from(valid); state[569] = 1; assert.equal(parseP2m2(state).from_savestate, true);
  assert.equal(parseP2m2(movie(600)).frames, 600);
});

test('movie options and native ownership/state/EOF counters reject inconsistent responses', async t => {
  const f = await fixture(t);
  for (const input of [{ frames: 0 }, { frames: 601 }, { timeout_ms: 99 }, { timeout_ms: 30001 }])
    assert.equal(movieOptions.safeParse(input).success, false);
  assert.equal(parseMovie(f.state(), id).active, true);
  for (const change of [{ operation_id: 'b'.repeat(32) }, { frames: 3 }, { active: false }, { path: 'relative.p2m2' },
    { path: path.join(f.dir, 'foreign.p2m2') }, { reason: 'eof' }, { source: f.filename }])
    assert.throws(() => parseMovie(f.state(change), id));
});

test('offline file inspection checks SHA256, absolute paths, actual size and cancellation', async t => {
  const f = await fixture(t), before = await fs.readFile(f.filename);
  const info = await inspectMovie(f.filename);
  assert.equal(info.sha256, createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(await fs.readFile(f.filename), before);
  await assert.rejects(inspectMovie('relative.p2m2'), /absolute/);
  await assert.rejects(hashLocalFile(f.filename, 20), /bounds/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(inspectMovie(f.filename, abort.signal), /abort/i);
});

test('record starts carry process/session/epoch/ELF file identity and leave the VM paused', async t => {
  const f = await fixture(t);
  const c = await client(t, req => req.cmd === 'capabilities' ? f.caps : f.state({ operation_id: req.operation_id,
    path: path.join(f.dir, `${req.operation_id}.p2m2`) }));
  const result = await startInputMovie(c.value, { frames: 2 }, 'record');
  assert.equal(result.paused, true);
  const request = c.mock.requests.find(req => req.cmd === 'input_movie_start');
  assert.equal(request.expected_execution_epoch, 3); assert.equal(request.elf_sha256, f.hash);
  assert.equal(c.mock.requests.some(req => req.cmd === 'resume'), false);
});

test('native refusal never cleans up a foreign recording, while uncertain starts clean only their own ID', async t => {
  const f = await fixture(t); let reject = true;
  const c = await client(t, req => req.cmd === 'capabilities' ? f.caps : req.cmd === 'input_movie_start'
    ? reject ? { ok: false, error: 'GUI input recording active' } : f.state({ operation_id: req.operation_id,
      path: path.join(f.dir, `${req.operation_id}.p2m2`), execution_epoch: 3 })
    : f.state({ operation_id: req.operation_id, path: path.join(f.dir, `${req.operation_id}.p2m2`), state: 'closed', active: false, reason: 'stopped' }));
  await assert.rejects(startInputMovie(c.value, { frames: 2 }, 'record'), /GUI/);
  assert.equal(c.mock.requests.some(req => req.cmd === 'input_movie_stop'), false);
  reject = false;
  await assert.rejects(startInputMovie(c.value, { frames: 2 }, 'record'), /identity/);
  const start = c.mock.requests.filter(req => req.cmd === 'input_movie_start').at(-1);
  assert.equal(c.mock.requests.at(-1).cmd, 'input_movie_stop'); assert.equal(c.mock.requests.at(-1).operation_id, start.operation_id);
});

test('replay validates supplied movie/ELF hashes and rejects savestate mode before any reset', async t => {
  const f = await fixture(t), source = await inspectMovie(f.filename);
  const c = await client(t, req => req.cmd === 'capabilities' ? f.caps : { ok: false, error: 'unexpected reset' });
  const options = { path: f.filename, movie_sha256: source.sha256, elf_sha256: f.hash };
  await assert.rejects(startInputMovie(c.value, { ...options, movie_sha256: '0'.repeat(64) }, 'replay'), /SHA256/);
  const bytes = movie(); bytes[569] = 1; await fs.writeFile(f.filename, bytes);
  await assert.rejects(startInputMovie(c.value, options, 'replay'), /Savestate/);
  assert.equal(c.mock.requests.some(req => req.cmd === 'input_movie_start'), false);
});

test('old native capability and mismatched loaded ELF CRC reject before any movie reset', async t => {
  const f = await fixture(t); let caps = { ...f.caps, features: [] };
  const c = await client(t, () => caps);
  await assert.rejects(startInputMovie(c.value, {}, 'record'), /Rebuild/);
  caps = { ...f.caps, elf_crc: '0x00000000' };
  await assert.rejects(startInputMovie(c.value, {}, 'record'), /CRC/);
  assert.equal(c.mock.requests.some(req => req.cmd === 'input_movie_start'), false);
});

test('replay detects a different native copy and closes only its owned operation', async t => {
  const f = await fixture(t), source = await inspectMovie(f.filename); let activeId;
  const c = await client(t, async req => {
    if (req.cmd === 'capabilities') return f.caps;
    activeId = req.operation_id; const filename = path.join(f.dir, `${activeId}.p2m2`);
    const bytes = movie(); bytes[570] = 0; await fs.writeFile(filename, bytes);
    return f.state({ operation_id: activeId, path: filename, mode: 'replay', source: f.filename, input_sha256: source.sha256,
      ...(req.cmd === 'input_movie_stop' ? { state: 'closed', active: false, reason: 'stopped' } : {}) });
  });
  await assert.rejects(startInputMovie(c.value, { path: f.filename, movie_sha256: source.sha256, elf_sha256: f.hash }, 'replay'), /copy differs/);
  assert.equal(c.mock.requests.at(-1).cmd, 'input_movie_stop');
  assert.equal((await inspectMovie(f.filename)).sha256, source.sha256);
});

test('closed record verification checks counter/ELF identity; empty or failed files stay unverified', async t => {
  const f = await fixture(t); let state = f.state({ state: 'closed', active: false, frames: 2, reason: 'frame_limit' });
  const c = await client(t, () => state);
  assert.equal((await readInputMovie(c.value, id)).artifact.verified, true);
  state = { ...state, frames: 1, reason: 'stopped' };
  await assert.rejects(readInputMovie(c.value, id), /count differs/);
  state = { ...state, frames: 0 }; assert.equal((await readInputMovie(c.value, id)).artifact.verified, false);
  state = { ...state, frames: 2, reason: 'io_error' }; assert.equal((await readInputMovie(c.value, id)).artifact.verified, false);
  state = { ...state, reason: 'stopped' }; await fs.writeFile(f.elf, 'changed build');
  await assert.rejects(readInputMovie(c.value, id), /ELF file identity changed/);
});

test('closed replay verifies the source is preserved and does not claim incomplete execution completed', async t => {
  const f = await fixture(t), source = path.join(f.dir, 'source.p2m2'); await fs.writeFile(source, movie());
  let state = f.state({ mode: 'replay', source, input_sha256: (await inspectMovie(source)).sha256,
    state: 'closed', active: false, frames: 1, reason: 'stopped' });
  const c = await client(t, () => state);
  const result = await readInputMovie(c.value, id);
  assert.equal(result.source_preserved, true); assert.equal(result.completed, false);
  const bytes = movie(); bytes[570] = 0; await fs.writeFile(source, bytes);
  await assert.rejects(readInputMovie(c.value, id), /source differs/);
  await fs.writeFile(f.filename, bytes);
  await assert.rejects(readInputMovie(c.value, id), /original identity/);
});

test('wait timeout and cancellation leave native movie lifetime in charge', async t => {
  const f = await fixture(t), c = await client(t, () => f.state());
  assert.equal((await readInputMovie(c.value, id)).timed_out, true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readInputMovie(c.value, id, 1000, abort.signal), /abort/i);
  assert.equal(c.mock.requests.some(req => req.cmd === 'input_movie_stop'), false);
});
