// node test/media-live.mjs <PCSX2> <rendering ELF> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6, 'Expected PCSX2, rendering ELF, configured data root, new output');
const [executable, elf, configured, output] = process.argv.slice(2).map(value => path.resolve(value));
await fs.mkdir(output); const root = path.join(output, 'instance');
await fs.mkdir(path.join(root, 'inis'), { recursive: true });
await fs.copyFile(path.join(configured, 'inis', 'PCSX2.ini'), path.join(root, 'inis', 'PCSX2.ini'));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'media-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const results = { started_at: new Date().toISOString(), executable, elf, checks: [] };
let owned = false;
const passed = name => { results.checks.push(name); console.log('PASS ' + name); };
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
const start = args => call('pcsx2_capture_start', args);
const read = (id, wait_ms = 10000) => call('pcsx2_capture_status', { operation_id: id, wait_ms });
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  results.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true;
  await inspector.connect();
  for (let attempt = 0; ; ++attempt) {
    const caps = await inspector.getCapabilities();
    if (caps.elf && caps.elf_crc !== '0x00000000') break;
    assert.ok(attempt < 80, 'ELF did not boot'); await delay(250);
  }
  await delay(6500); // Reference SMS fixture startup, not a generic readiness claim.
  const a = await start({ frames: 60, width: 320, height: 240 });
  const completed = await read(a.operation_id);
  results.completed = completed;
  assert.equal(completed.state, 'closed', JSON.stringify(completed));
  assert.equal(completed.video_frames, 60); assert.equal(completed.reason, 'frame_limit');
  assert.equal(completed.artifact.verified, true); assert.equal(completed.artifact.streams.length, 2);
  assert.equal(completed.artifact.audio_audibility, 'not_measured');
  assert.equal((await inspector.getStatus()).paused, false);
  passed('records exactly 60 video frames and stereo audio to a closed MP4; ffprobe validates the actual tracks and SHA256');
  const measured = await call('pcsx2_analyze_capture_audio', { capture_path: completed.path,
    capture_sha256: completed.artifact.sha256, output_directory: output });
  results.audio_measurement = measured;
  assert.equal(measured.source.sha256, completed.artifact.sha256);
  assert.ok(measured.metrics.frame_count > 0); assert.equal(measured.metrics.sample_rate, 48000);
  assert.equal(measured.acceptance, 'not_evaluated'); assert.equal(measured.av_sync, 'not_measured');
  assert.equal((await inspector.getStatus()).paused, false);
  passed('fresh native SMS capture yields hash-pinned per-channel PCM metrics without pausing VM or claiming audible playback');
  await inspector.pause();
  const b = await start({ frames: 8, audio: false, width: 320, height: 240 });
  const pending = await read(b.operation_id, 0);
  assert.equal(pending.active, true); assert.equal(pending.artifact.verified, false);
  assert.equal((await inspector.getStatus()).paused, true);
  passed('paused start does not resume and never verifies an open capture file');
  const foreign = await mcp.callTool({ name: 'pcsx2_capture_stop', arguments: { operation_id: 'f'.repeat(32) } });
  assert.equal(foreign.isError, true);
  const busy = await mcp.callTool({ name: 'pcsx2_capture_start', arguments: {} }); assert.equal(busy.isError, true);
  const connected = await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } });
  assert.ok(!connected.isError); assert.equal((await read(b.operation_id, 0)).operation_id, b.operation_id);
  await inspector.advanceFrames(12);
  const limited = await read(b.operation_id);
  assert.equal(limited.state, 'closed'); assert.equal(limited.video_frames, 8);
  assert.equal(limited.artifact.streams.length, 1); assert.equal((await inspector.getStatus()).paused, true);
  results.video_only = limited;
  passed('foreign stop and competing start preserve ownership across reconnect; video-only capture caps frames during explicit frame advance');
  const noAudio = await mcp.callTool({ name: 'pcsx2_analyze_capture_audio', arguments: {
    capture_path: limited.path, capture_sha256: limited.artifact.sha256, output_directory: output } });
  assert.equal(noAudio.isError, true); assert.equal((await inspector.getStatus()).paused, true);
  results.no_audio_refusal = JSON.parse(noAudio.content[0].text);
  passed('actual native video-only MP4 refuses audio analysis and preserves paused VM');
  const c = await start({ timeout_ms: 200, audio: false });
  const expired = await read(c.operation_id);
  assert.equal(expired.active, false); assert.equal(expired.state, 'failed');
  assert.equal(expired.reason, 'no_video_frames'); assert.equal(expired.artifact.verified, false);
  assert.equal((await inspector.getStatus()).paused, true);
  passed('native wall limit finalizes a paused empty recording without resuming or claiming a playable file');
  const d = await start({ frames: 300, audio: false, max_payload_bytes: 1024 });
  await inspector.advanceFrames(12);
  const failed = await read(d.operation_id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'payload_limit');
  assert.ok(failed.payload_bytes <= 1024); assert.equal(failed.artifact.verified, false);
  results.payload_limit = failed;
  passed('encoded payload ceiling rejects a partial capture and keeps it unverified');
  const e = await start({ frames: 120, audio: false, width: 320, height: 240 });
  await inspector.advanceFrames(10);
  const stopped = await call('pcsx2_capture_stop', { operation_id: e.operation_id });
  assert.equal(stopped.state, 'closed'); assert.equal(stopped.video_frames, 10);
  assert.equal((await read(e.operation_id)).artifact.verified, true);
  assert.equal((await inspector.getStatus()).paused, true);
  passed('explicit owned stop flushes ten real frames without altering VM pause state');
  const f = await start({ frames: 120, audio: false }); await inspector.advanceFrames(3);
  await inspector.loadElf(elf);
  const invalidated = await read(f.operation_id);
  assert.equal(invalidated.state, 'invalidated'); assert.equal(invalidated.artifact.verified, false);
  passed('ELF reset invalidates the recording and never substitutes a new VM artifact');
  assert.equal((await read(a.operation_id, 0).catch(() => null)), null); // Retention is one operation, not an unbounded map.
  const original = await fs.stat(completed.path); assert.equal(original.size, completed.artifact.bytes);
  passed('completed files survive subsequent captures while native report retention remains bounded');
} finally {
  if (owned) { try { await call('pcsx2_stop'); } catch (error) { results.cleanup_error = String(error); } }
  inspector.disconnect(); await mcp.close();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2));
}
