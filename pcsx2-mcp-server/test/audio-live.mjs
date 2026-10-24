// Offline real FFmpeg/AAC + MCP protocol validation; no BIOS, VM or network.
// node test/audio-live.mjs <new-output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runAudioProcess } from '../dist/audio-measurement.js';

assert.equal(process.argv.length, 3, 'Expected new output folder');
const output = path.resolve(process.argv[2]); await fs.mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mcp = new Client({ name: 'audio-measurement-live', version: '1.0' });
const results = { started_at: new Date().toISOString(), scope: 'host_generated_AAC_fixtures_not_PS2_audio_playback', checks: [] };
const passed = name => { results.checks.push(name); console.log('PASS ' + name); };
async function call(args, error = false) {
  const response = await mcp.callTool({ name: 'pcsx2_analyze_capture_audio', arguments: args });
  assert.equal(Boolean(response.isError), error, JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
const ffmpeg = process.env.PCSX2_FFMPEG || 'ffmpeg';
const tone = path.join(output, 'tone-gap.f32le'), capture = path.join(output, 'tone-gap.mp4');
const raw = Buffer.alloc(48000 * 8);
for (let f = 0; f < 48000; f++) {
  const gap = f >= 9600 && f < 19200;
  raw.writeFloatLE(gap ? 0 : .5 * Math.sin(2 * Math.PI * f / 48), f * 8);
}
await fs.writeFile(tone, raw, { flag: 'wx' });
await runAudioProcess(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', tone,
  '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', capture], 1024);
const source = await fs.readFile(capture), options = { capture_path: capture, capture_sha256: hash(source), output_directory: output };
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env }, stderr: 'pipe' }));
  assert.ok((await mcp.listTools()).tools.some(t => t.name === 'pcsx2_analyze_capture_audio'));
  const measured = await call(options); results.tone = measured;
  assert.equal(measured.metrics.sample_rate, 48000); assert.equal(measured.metrics.channels, 2);
  assert.ok(measured.metrics.frame_count >= 48000 && measured.metrics.frame_count <= 49152);
  const [left, right] = measured.metrics.channel_metrics;
  assert.ok(Math.abs(left.rms_amplitude - Math.sqrt(.8 * .5 ** 2 / 2)) < .02);
  assert.ok(left.peak_amplitude > .45 && left.peak_amplitude < .6);
  assert.ok(right.rms_amplitude < 0.0001); assert.equal(right.silent_window_fraction, 1);
  passed('offline MCP tool decodes real AAC with the expected tone RMS and independent silent channel');
  assert.ok(left.longest_silent_window_run_ms >= 140 && left.longest_silent_window_run_ms <= 240);
  assert.ok(left.silent_window_fraction > .1 && left.silent_window_fraction < .3);
  assert.equal(measured.acceptance, 'not_evaluated'); assert.equal(measured.audio_audibility, 'not_measured');
  assert.equal(measured.av_sync, 'not_measured'); assert.equal(measured.dropout_cause, 'not_determined');
  passed('known host-fixture gap appears in window metrics with AAC boundary tolerance and no causal or A/V assertion');
  assert.equal(hash(await fs.readFile(measured.source.snapshot_path)), options.capture_sha256);
  assert.equal(hash(await fs.readFile(measured.pcm.path)), measured.pcm.sha256);
  assert.equal(hash(await fs.readFile(measured.report_artifact.path)), measured.report_artifact.sha256);
  assert.equal(hash(await fs.readFile(capture)), options.capture_sha256);
  const saved = JSON.parse(await fs.readFile(measured.report_artifact.path, 'utf8'));
  assert.deepEqual(saved.metrics, measured.metrics); assert.equal(saved.source.vm_identity, 'not_observed_offline');
  passed('source snapshot, decoded PCM and saved measurement report have verified hashes; original file is preserved');
  const again = await call({ ...options, policy: { silence_rms_dbfs: -80, window_ms: 40 } }); results.alternate_policy = again.report_artifact;
  assert.notEqual(again.report_artifact.path, measured.report_artifact.path); assert.notEqual(again.policy_sha256, measured.policy_sha256);
  assert.ok(Math.abs(again.metrics.channel_metrics[0].rms_amplitude - left.rms_amplitude) < 1e-12);
  assert.equal(again.pcm.sha256, measured.pcm.sha256);
  passed('independent policy runs retain identical PCM and overall levels with distinct hashes and output folders');
  const concurrent = await Promise.all([mcp.callTool({ name: 'pcsx2_analyze_capture_audio', arguments: options }),
    mcp.callTool({ name: 'pcsx2_analyze_capture_audio', arguments: options })]);
  assert.equal(concurrent.filter(r => r.isError).length, 1);
  assert.match(JSON.parse(concurrent.find(r => r.isError).content[0].text).error, /Another audio measurement/);
  passed('concurrent MCP requests allow one bounded decoder pipeline and explicitly reject the competing request');
  const beforeMutation = new Set(await fs.readdir(output));
  const mutating = call(options, true);
  try {
    let changed = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const folders = (await fs.readdir(output)).filter(n => n.startsWith('pcsx2-audio-') && !beforeMutation.has(n));
      if (folders.length) {
        const copy = await fs.readFile(path.join(output, folders[0], 'capture.mp4')).catch(() => null);
        if (copy && hash(copy) === options.capture_sha256) { await fs.writeFile(capture, Buffer.concat([source, Buffer.from([0])])); changed = true; break; }
      }
      await delay(5);
    }
    assert.ok(changed, 'source mutation was not exercised');
    const refused = await mutating; assert.match(refused.error, /SHA256|changed during/); results.mutated_source_failure = refused;
    await assert.rejects(fs.stat(path.join(refused.artifact_directory, 'measurement.json')), { code: 'ENOENT' });
  } finally { await fs.writeFile(capture, source); }
  passed('changing the caller source after private snapshot creation prevents publication of a successful measurement');
  const mismatch = await call({ ...options, capture_sha256: '0'.repeat(64) }, true);
  assert.match(mismatch.error, /SHA256/); results.stale_sha_failure = mismatch;
  assert.equal(JSON.parse(await fs.readFile(path.join(mismatch.artifact_directory, 'failure.json'), 'utf8')).complete, false);
  passed('stale capture SHA is refused with failure evidence before successful analysis');
  const wrongRate = path.join(output, 'wrong-rate.mp4');
  await runAudioProcess(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', tone,
    '-ar', '44100', '-c:a', 'aac', '-f', 'mp4', wrongRate], 1024);
  assert.match((await call({ ...options, capture_path: wrongRate, capture_sha256: hash(await fs.readFile(wrongRate)) }, true)).error, /48000/);
  passed('real 44100 Hz AAC is refused rather than silently resampled');
  const damaged = Buffer.from(source), mdat = damaged.indexOf(Buffer.from('mdat'));
  assert.ok(mdat >= 4); const dataEnd = mdat - 4 + damaged.readUInt32BE(mdat - 4);
  assert.ok(dataEnd > mdat + 20 && dataEnd <= damaged.length);
  damaged.fill(255, mdat + 4, Math.min(dataEnd, mdat + 516));
  const corrupt = path.join(output, 'damaged-aac.mp4'); await fs.writeFile(corrupt, damaged);
  const decoderFailure = await call({ ...options, capture_path: corrupt, capture_sha256: hash(damaged) }, true);
  assert.match(decoderFailure.error, /Audio process failed/); results.damaged_aac_failure = decoderFailure;
  await assert.rejects(fs.stat(path.join(decoderFailure.artifact_directory, 'measurement.json')), { code: 'ENOENT' });
  passed('damaged AAC packets fail decoding rather than publishing partially decoded measurements');
  const long = path.join(output, 'too-long.mp4');
  await runAudioProcess(ffmpeg, ['-nostdin', '-v', 'error', '-stream_loop', '10', '-i', capture, '-c:a', 'copy', '-f', 'mp4', long], 1024);
  const over = await call({ ...options, capture_path: long, capture_sha256: hash(await fs.readFile(long)) }, true);
  assert.match(over.error, /output budget/); results.over_budget_failure = over;
  await assert.rejects(fs.stat(path.join(over.artifact_directory, 'measurement.json')), { code: 'ENOENT' });
  passed('over-ten-second decoded audio is rejected with no truncated success report');
} finally {
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2) + '\n');
}
