import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { measureAudioPcm, validateAudioProbe, analyzeCaptureAudio, audioMeasurementOptions, runAudioProcess } from '../dist/audio-measurement.js';

function pcm(frames, sample = () => 0) {
  const bytes = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) for (let c = 0; c < 2; c++) bytes.writeFloatLE(sample(frame, c), (frame * 2 + c) * 4);
  return bytes;
}
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const probe = () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } });
async function directoryFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-audio-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('digital zero has null negative-infinity dBFS and counts both channels without fabricating audible sound', async () => {
  const r = await measureAudioPcm(pcm(1920));
  assert.equal(r.decoded_duration_seconds, .04); assert.equal(r.windows.length, 2);
  for (const c of r.channel_metrics) {
    assert.equal(c.rms_dbfs, null); assert.equal(c.peak_dbfs, null); assert.equal(c.dc_offset, 0);
    assert.equal(c.exact_zero_samples, 1920); assert.equal(c.silent_window_fraction, 1); assert.equal(c.longest_silent_window_run_ms, 40);
  }
});
test('a coherent 1 kHz tone has independently known RMS, peak and zero DC; silent channel stays separate', async () => {
  const r = await measureAudioPcm(pcm(4800, (f, c) => c ? 0 : .5 * Math.sin(2 * Math.PI * f / 48)));
  close(r.channel_metrics[0].rms_amplitude, .5 / Math.sqrt(2)); close(r.channel_metrics[0].rms_dbfs, -9.03089987);
  close(r.channel_metrics[0].peak_amplitude, .5); close(r.channel_metrics[0].dc_offset, 0);
  assert.equal(r.channel_metrics[0].silent_window_fraction, 0); assert.equal(r.channel_metrics[1].silent_window_fraction, 1);
});
test('DC contributes to RMS and silence classification instead of being silently filtered', async () => {
  const r = await measureAudioPcm(pcm(960, () => .25));
  close(r.channel_metrics[0].rms_amplitude, .25); close(r.channel_metrics[0].dc_offset, .25);
  assert.equal(r.channel_metrics[0].silent_window_frames, 0);
});
test('near-full-scale uses inclusive absolute thresholds and preserves float overshoot', async () => {
  const r = await measureAudioPcm(pcm(4, f => [0.5, -0.5, 1.25, 0][f]), { near_full_scale_amplitude: .5 });
  assert.equal(r.channel_metrics[0].near_full_scale_samples, 3); assert.equal(r.channel_metrics[0].near_full_scale_fraction, .75);
  assert.equal(r.channel_metrics[0].peak_amplitude, 1.25); assert.ok(r.channel_metrics[0].peak_dbfs > 0);
});
test('silence RMS threshold is inclusive and changing it does not alter raw measurements', async () => {
  const bytes = pcm(960, () => .0625), threshold = 20 * Math.log10(.0625);
  const below = await measureAudioPcm(bytes, { silence_rms_dbfs: threshold - 1e-6 });
  const at = await measureAudioPcm(bytes, { silence_rms_dbfs: threshold });
  assert.equal(below.channel_metrics[0].silent_window_fraction, 0); assert.equal(at.channel_metrics[0].silent_window_fraction, 1);
  assert.equal(at.channel_metrics[0].rms_amplitude, below.channel_metrics[0].rms_amplitude);
});
test('aligned silent runs end at non-silent windows and include the final partial window with its actual duration', async () => {
  const r = await measureAudioPcm(pcm(4 * 960 + 240, f => f >= 960 && f < 1920 ? .5 : 0));
  assert.deepEqual(r.windows.map(w => w.frame_count), [960, 960, 960, 960, 240]);
  assert.equal(r.channel_metrics[0].longest_silent_window_run_ms, 45);
  assert.equal(r.channel_metrics[0].silent_window_frames, 3120); close(r.channel_metrics[0].silent_window_fraction, 3120 / 4080);
});
test('PCM bounds reject empty, partial, nonfinite and over-ten-second buffers rather than truncating', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(9), pcm(1, () => NaN), pcm(1, () => Infinity), pcm(480001)])
    await assert.rejects(measureAudioPcm(bytes));
  assert.equal((await measureAudioPcm(pcm(480000), { window_ms: 1000 })).frame_count, 480000);
});
test('measurement policy rejects invalid bounds and unknown keys', async () => {
  for (const policy of [{ window_ms: 9 }, { window_ms: 1001 }, { window_ms: 10.5 }, { silence_rms_dbfs: -19 },
    { silence_rms_dbfs: -121 }, { near_full_scale_amplitude: 1.01 }, { near_full_scale_amplitude: .49 }, { normalize: true }])
    await assert.rejects(measureAudioPcm(pcm(1), policy));
});
test('PCM calculation cooperatively supports cancellation before and during measurement', async () => {
  await assert.rejects(measureAudioPcm(pcm(1), {}, AbortSignal.abort()));
  const controller = new AbortController(), pending = measureAudioPcm(pcm(480000), {}, controller.signal);
  setImmediate(() => controller.abort()); await assert.rejects(pending);
});
test('probe accepts AAC-only or AAC plus video but refuses ambiguity, conversion and unrelated streams', () => {
  assert.equal(validateAudioProbe(probe()).streams.length, 2);
  const audioOnly = probe(); audioOnly.streams.shift(); assert.equal(validateAudioProbe(audioOnly).streams.length, 1);
  for (const mutate of [p => p.streams.pop(), p => p.streams[1].sample_rate = '44100', p => p.streams[1].channels = 1,
    p => p.streams[1].codec_name = 'mp3', p => p.streams.push({ ...p.streams[1], index: 2 }),
    p => p.streams[0].codec_type = 'subtitle', p => p.format.format_name = 'wav']) {
    const p = probe(); mutate(p); assert.throws(() => validateAudioProbe(p));
  }
});
test('source options require local absolute MP4, SHA and output paths', () => {
  const valid = { capture_path: path.join(os.tmpdir(), 'file.mp4'), capture_sha256: 'a'.repeat(64), output_directory: os.tmpdir() };
  assert.equal(audioMeasurementOptions.safeParse(valid).success, true);
  for (const change of [{ capture_path: 'http://example.org/a.mp4' }, { capture_path: 'local.mp4' },
    { capture_path: path.join(os.tmpdir(), 'a.wav') }, { capture_sha256: 'old' }, { output_directory: 'out' }, { elf_sha256: 'a'.repeat(64) }])
    assert.equal(audioMeasurementOptions.safeParse({ ...valid, ...change }).success, false);
});
test('stale SHA is refused before invoking external tools, preserving a failed evidence folder without a success report', async t => {
  const root = await directoryFor(t), capture = path.join(root, 'test.mp4'); await fs.writeFile(capture, 'fixture');
  let directory;
  await assert.rejects(analyzeCaptureAudio({ capture_path: capture, capture_sha256: '0'.repeat(64), output_directory: root }), e => {
    assert.match(e.message, /SHA256 mismatch/); directory = e.artifact_directory; return true;
  });
  const failure = JSON.parse(await fs.readFile(path.join(directory, 'failure.json'), 'utf8'));
  assert.equal(failure.complete, false); assert.equal(failure.acceptance, 'not_evaluated');
  await assert.rejects(fs.stat(path.join(directory, 'measurement.json')), { code: 'ENOENT' });
  assert.equal(createHash('sha256').update(await fs.readFile(capture)).digest('hex'), createHash('sha256').update('fixture').digest('hex'));
});
test('oversized or nonregular input is rejected before decoding and pre-cancelled requests create no outputs', async t => {
  const root = await directoryFor(t), capture = path.join(root, 'large.mp4');
  const fd = await fs.open(capture, 'wx'); await fd.truncate(144 * 1024 * 1024 + 1); await fd.close();
  const options = { capture_path: capture, capture_sha256: '0'.repeat(64), output_directory: root };
  await assert.rejects(analyzeCaptureAudio(options), /regular file/);
  await fs.mkdir(path.join(root, 'directory.mp4'));
  await assert.rejects(analyzeCaptureAudio({ ...options, capture_path: path.join(root, 'directory.mp4') }), /regular file/);
  const before = await fs.readdir(root); await assert.rejects(analyzeCaptureAudio(options, AbortSignal.abort()));
  assert.deepEqual(await fs.readdir(root), before);
});
test('subprocess buffers preserve binary bytes and report nonzero exit without leaking stderr', async () => {
  const bytes = await runAudioProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,1,0]))'], 4);
  assert.deepEqual(bytes, Buffer.from([0, 255, 1, 0]));
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'process.stderr.write("private-fixture");process.exit(3)'], 16), e => {
    assert.match(e.message, /exit 3/); assert.ok(!e.message.includes('private-fixture')); return true;
  });
});
test('subprocess output, stderr, runtime, missing executable and cancellation budgets fail explicitly', async () => {
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(17))'], 16), /output budget/);
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'process.stderr.write(Buffer.alloc(131073))'], 16), /stderr budget/);
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 16, undefined, 200), /runtime budget/);
  await assert.rejects(runAudioProcess(path.join(os.tmpdir(), 'missing-pcsx2-ffmpeg.exe'), [], 16), /unavailable/);
  const controller = new AbortController(), pending = runAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 16, controller.signal);
  setTimeout(() => controller.abort(), 100); await assert.rejects(pending, /cancelled/);
});
