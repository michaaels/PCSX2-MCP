import assert from 'node:assert/strict';
import test from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { toneEvidence, playbackFixture } from './project-playback-audio.mjs';

function pcm(sample, frames = 48000) {
  const b = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) b.writeFloatLE(sample(i, c), i * 8 + c * 4);
  return b;
}
test('known-clip frequency search finds a coherent 440 Hz tone independently in both channels', () => {
  const result = toneEvidence(pcm((i, c) => .125 * Math.sin(2 * Math.PI * 440 * i / 48000 + c * .5)));
  for (const c of result) { assert.equal(c.frequency_hz, 440); assert.ok(Math.abs(c.tone_power_fraction - 1) < 1e-6); }
});
test('a wrong projected frequency or a silent channel cannot pass the known-tone presence gate', () => {
  const bytes = pcm((i, c) => c ? 0 : .25 * Math.sin(2 * Math.PI * 1000 * i / 48000));
  const right = toneEvidence(bytes, 1000), wrong = toneEvidence(bytes, 440);
  assert.ok(right[0].tone_power_fraction > .99); assert.equal(right[1].tone_power_fraction, 0);
  assert.equal(right[1].rms_amplitude, 0); assert.ok(wrong[0].tone_power_fraction < 1e-8);
});
test('tone projection removes DC for the power ratio while preserving the total RMS observation', () => {
  const r = toneEvidence(pcm(i => .25 + .125 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 1000);
  assert.ok(Math.abs(r[0].tone_power_fraction - 1) < 1e-6);
  assert.ok(Math.abs(r[0].rms_amplitude - Math.sqrt(.25 ** 2 + .125 ** 2 / 2)) < 1e-6);
});
test('tone fraction is gain and phase independent for a coherent tone, RMS retains the amplitude change', () => {
  const r = toneEvidence(pcm((i, c) => (c ? .5 : .125) * Math.sin(2 * Math.PI * 440 * i / 48000 + c * .7)), 440);
  assert.ok(Math.abs(r[0].tone_power_fraction - r[1].tone_power_fraction) < 1e-6);
  assert.ok(Math.abs(r[1].rms_amplitude / r[0].rms_amplitude - 4) < 1e-6);
});
test('projection uses at most one second; selecting the post-warmup buffer is explicit', () => {
  const bytes = pcm(i => i < 48000 ? 0 : .125 * Math.sin(2 * Math.PI * 440 * i / 48000), 96000);
  assert.equal(toneEvidence(bytes, 440)[0].rms_amplitude, 0);
  assert.ok(toneEvidence(bytes.subarray(48000 * 8), 440)[0].tone_power_fraction > .99);
});
test('invalid PCM frames, nonfinite samples/frequencies and excessive output are refused', () => {
  for (const b of [Buffer.alloc(0), Buffer.alloc(9), Buffer.alloc(3840008), pcm(() => NaN, 1)]) assert.throws(() => toneEvidence(b, 440));
  for (const hz of [NaN, Infinity, 0, 24000]) assert.throws(() => toneEvidence(pcm(() => 0, 1), hz));
});
test('known-clip fixture rejects unsupported parameters, relative files and unbounded repetitions or input', () => {
  const fixture = { library_id: 'a'.repeat(32), item_id: 'b'.repeat(32), reference_path: path.join(os.tmpdir(), 'known.mpg'), reference_sha256: 'c'.repeat(64) };
  assert.equal(playbackFixture.parse(fixture).input_frames, 12);
  for (const change of [{ reference_path: 'known.mpg' }, { repetitions: 4 }, { capture_frames: 241 }, { input_frames: 31 }, { token: 'rejected-placeholder' }])
    assert.equal(playbackFixture.safeParse({ ...fixture, ...change }).success, false);
});
