import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { mediaOptions, parseMedia, validateProbe, verifyMedia, probeMedia } from '../dist/media.js';
import { startMediaCapture, readMediaCapture, stopMediaCapture } from '../dist/media-tools.js';
import { debugServer } from './fixtures.mjs';

const id = 'b'.repeat(32);
const caps = { ok: true, protocol_version: 2, process_id: 42, session: 2, execution_epoch: 3,
  elf: 'game.elf', elf_crc: '0x12345678', features: ['media_capture'] };
const state = (overrides = {}) => ({ ok: true, operation_id: id, state: 'recording', active: true, reason: '',
  session: 2, execution_epoch: 3, elf: caps.elf, elf_crc: caps.elf_crc, path: path.join(os.tmpdir(), `${id}.mp4`),
  video: true, audio: true, width: 640, height: 480, video_frames: 0, max_frames: 120,
  payload_bytes: 0, max_payload_bytes: 64 * 1024 * 1024, container: 'mp4', ...overrides });
const closed = () => state({ state: 'closed', active: false, reason: 'frame_limit', video_frames: 120 });
const probe = () => ({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 640, height: 480, nb_read_frames: '120' },
  { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, nb_read_frames: '95' },
], format: { format_name: 'mov,mp4,m4a', duration: '2.000', size: '16' } });
async function setup(t, reply) {
  const mock = await debugServer(t, reply);
  const client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect(); t.after(() => client.disconnect()); return { client, mock };
}

test('capture options and native state require bounded aligned resolution and exact ownership', () => {
  assert.equal(mediaOptions.parse({}).audio, true);
  for (const value of [{ frames: 0 }, { frames: 301 }, { width: 641 }, { height: 1025 }, { timeout_ms: 30001 }, { max_payload_bytes: 1023 }])
    assert.equal(mediaOptions.safeParse(value).success, false);
  assert.equal(parseMedia(state(), id).state, 'recording');
  for (const value of [{ active: false }, { operation_id: 'a'.repeat(32) }, { video_frames: 121 },
    { payload_bytes: 64 * 1024 * 1024 + 1 }, { path: 'relative.mp4' }, { path: path.join(os.tmpdir(), 'other.mp4') }])
    assert.throws(() => parseMedia(state(value), id));
});

test('ffprobe validation checks tracks, actual frames and duration without declaring audible audio or sync', () => {
  assert.equal(validateProbe(probe(), closed()).duration_seconds, 2);
  for (const mutate of [p => p.streams.pop(), p => p.streams[0].width = 1280,
    p => p.streams[0].nb_read_frames = '119', p => p.streams[1].sample_rate = '44100',
    p => p.streams[1].nb_read_frames = '0', p => p.format.duration = 'NaN', p => p.format.format_name = 'wav']) {
    const value = probe(); mutate(value); assert.throws(() => validateProbe(value, closed()));
  }
  const videoOnly = probe(); videoOnly.streams.pop();
  assert.equal(validateProbe(videoOnly, { ...closed(), audio: false }).streams.length, 1);
});

test('closed file verification hashes bytes, checks file size and rejects mutation or probe failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, `${id}.mp4`); await fs.writeFile(filename, Buffer.alloc(16));
  const expected = { ...closed(), path: filename };
  const artifact = await verifyMedia(expected, undefined, async () => probe());
  assert.equal(artifact.verified, true); assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.audio_audibility, 'not_measured'); assert.equal(artifact.av_sync, 'not_measured');
  await assert.rejects(verifyMedia({ ...expected, active: true }, undefined, async () => probe()), /not confirmed closed/);
  await assert.rejects(verifyMedia(expected, undefined, async () => { throw new Error('decoder failed'); }), /decoder failed/);
  await assert.rejects(verifyMedia(expected, undefined, async () => {
    await fs.writeFile(filename, Buffer.alloc(17)); return probe();
  }), /changed during/);
});

test('ffprobe missing binary and pre-cancelled request are explicit failures', async () => {
  await assert.rejects(probeMedia('file.mp4', undefined, path.join(os.tmpdir(), 'missing-ffprobe-pcsx2.exe')), /ffprobe unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeMedia('file.mp4', controller.signal), { name: 'AbortError' });
});

test('start carries exact VM identity and mode; native busy refusal does not stop another capture', async t => {
  const { client, mock } = await setup(t, request => request.cmd === 'capabilities' ? caps :
    state({ operation_id: request.operation_id, path: path.join(os.tmpdir(), `${request.operation_id}.mp4`), audio: false, width: 320, height: 240 }));
  const result = await startMediaCapture(client, { audio: false, width: 320, height: 240 });
  assert.match(result.operation_id, /^[a-f0-9]{32}$/);
  assert.equal(mock.requests[1].expected_execution_epoch, 3); assert.equal(mock.requests[1].expected_process_id, 42);
  assert.equal(mock.requests[1].audio, false); assert.ok(!mock.requests.some(request => request.cmd === 'resume'));
  const busy = await setup(t, request => request.cmd === 'capabilities' ? caps : { ok: false, error: 'Capture busy' });
  await assert.rejects(startMediaCapture(busy.client), /Capture busy/);
  assert.ok(!busy.mock.requests.some(request => request.cmd === 'media_stop'));
});

test('old backend refuses before mutation; inconsistent accepted start cleans only its generated ID', async t => {
  const old = await setup(t, () => ({ ...caps, features: [] }));
  await assert.rejects(startMediaCapture(old.client), /Rebuild/); assert.equal(old.mock.requests.length, 1);
  const { client, mock } = await setup(t, request => {
    if (request.cmd === 'capabilities') return caps;
    return state({ operation_id: request.operation_id, path: path.join(os.tmpdir(), `${request.operation_id}.mp4`),
      ...(request.cmd === 'media_start' ? { execution_epoch: 8 } : { state: 'failed', active: false }) });
  });
  await assert.rejects(startMediaCapture(client), /start failed/);
  assert.equal(mock.requests.at(-1).cmd, 'media_stop'); assert.equal(mock.requests.at(-1).operation_id, mock.requests[1].operation_id);
});

test('wait timeout/cancellation leaves recording active and an unclosed file is never probed', async t => {
  const { client, mock } = await setup(t, () => state());
  const result = await readMediaCapture(client, id);
  assert.equal(result.timed_out, true); assert.equal(result.artifact.verified, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readMediaCapture(client, id, 100, controller.signal), { name: 'AbortError' });
  assert.deepEqual(mock.requests.map(request => request.cmd), ['media_status']);
});

test('stop waits for encoder finalization using only this capture ID', async t => {
  const { client, mock } = await setup(t, request => state(request.cmd === 'media_stop'
    ? { state: 'stopping' } : { state: 'closed', active: false, video_frames: 10 }));
  assert.equal((await stopMediaCapture(client, id)).state, 'closed');
  assert.deepEqual(mock.requests.map(request => request.cmd), ['media_stop', 'media_status']);
  assert.ok(mock.requests.every(request => request.operation_id === id));
});
