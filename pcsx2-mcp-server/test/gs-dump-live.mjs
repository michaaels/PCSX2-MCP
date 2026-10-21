// Optional acceptance with an owned native PCSX2 and a real rendering ELF.
// node test/gs-dump-live.mjs <PCSX2> <ELF> <configured-data-root> <new-output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6, 'Expected PCSX2, rendering ELF, configured data root, new output');
const [executable, elf, configured, output] = process.argv.slice(2).map(value => path.resolve(value));
await fs.mkdir(output);
const ini = await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'));
const root = path.join(output, 'instance'), replayRoot = path.join(output, 'replay');
for (const directory of [root, replayRoot]) {
  await fs.mkdir(path.join(directory, 'inis'), { recursive: true });
  await fs.writeFile(path.join(directory, 'inis', 'PCSX2.ini'), ini);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const port = await freePort(), replayPort = await freePort();
const mcp = new Client({ name: 'gs-dump-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const results = { started_at: new Date().toISOString(), executable, elf, checks: [] };
let owned = false, replay, replayInspector;
const passed = name => { results.checks.push(name); console.log('PASS ' + name); };
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
async function read(id) { return call('pcsx2_gs_dump_status', { operation_id: id, wait_ms: 5000 }); }
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
  // The reference SMS ELF loads its IOP modules before drawing its own UI.
  await delay(6500);
  const started = await call('pcsx2_gs_dump_start', { frames: 30 });
  const completed = await read(started.operation_id);
  assert.equal(completed.state, 'closed'); assert.equal(completed.artifact.verified, true);
  assert.ok(completed.artifact.vsync_packets >= 30); assert.match(completed.artifact.sha256, /^[a-f0-9]{64}$/);
  results.completed = completed;
  passed('captures a real closed uncompressed dump and verifies packets, byte count and SHA256 through MCP');
  await inspector.pause();
  const queued = await call('pcsx2_gs_dump_start', { frames: 2 });
  assert.equal((await inspector.getStatus()).paused, true);
  assert.equal((await call('pcsx2_gs_dump_status', { operation_id: queued.operation_id })).active, true);
  passed('start while paused queues without resuming or claiming a completed artifact');
  const foreign = await mcp.callTool({ name: 'pcsx2_gs_dump_cancel', arguments: { operation_id: 'f'.repeat(32) } });
  assert.equal(foreign.isError, true);
  const busy = await mcp.callTool({ name: 'pcsx2_gs_dump_start', arguments: { frames: 1 } });
  assert.equal(busy.isError, true);
  assert.equal((await call('pcsx2_gs_dump_status', { operation_id: queued.operation_id })).active, true);
  passed('foreign cancellation and a competing start preserve the active operation');
  const reconnected = await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } });
  assert.ok(!reconnected.isError); assert.match(reconnected.content[0].text, /connected/);
  assert.equal((await call('pcsx2_gs_dump_status', { operation_id: queued.operation_id })).operation_id, queued.operation_id);
  assert.equal((await call('pcsx2_gs_dump_cancel', { operation_id: queued.operation_id })).state, 'cancelled');
  assert.equal((await inspector.getStatus()).paused, true);
  passed('reconnect retains ownership; cancellation clears the pending snapshot without resuming');
  const expires = await call('pcsx2_gs_dump_start', { timeout_ms: 200 });
  const expired = await read(expires.operation_id);
  assert.equal(expired.state, 'expired'); assert.equal(expired.artifact.verified, false);
  assert.equal((await inspector.getStatus()).paused, true);
  passed('native timeout cleans a paused operation even without video frames');
  await inspector.resume(); await delay(200);
  await assert.rejects(fs.stat(queued.path), { code: 'ENOENT' });
  await assert.rejects(fs.stat(expires.path), { code: 'ENOENT' });
  await inspector.pause();
  const limited = await call('pcsx2_gs_dump_start', { frames: 300, max_bytes: 1024 * 1024 });
  await inspector.advanceFrames(12);
  const failed = await read(limited.operation_id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'size_limit');
  assert.equal(failed.artifact.verified, false); assert.ok((await fs.stat(failed.path)).size <= 1024 * 1024);
  results.size_limit = failed;
  passed('hard byte limit rejects partial output; cancelled snapshots do not appear after resume');
  await inspector.pause();
  const reset = await call('pcsx2_gs_dump_start', {});
  await inspector.loadElf(elf);
  assert.equal((await read(reset.operation_id)).state, 'invalidated');
  passed('ELF reset invalidates and cleans its queued dump');
  await call('pcsx2_stop'); owned = false; inspector.disconnect();

  // Replay using the native application's dump loader, without pretending it is an ELF.
  replay = spawn(executable, ['-portable', '-nogui', completed.path], { cwd: path.dirname(executable),
    env: { ...process.env, PCSX2_DEBUG_PORT: String(replayPort), PCSX2_MCP_DATA_DIR: replayRoot }, windowsHide: true, stdio: 'ignore' });
  let spawnError; replay.once('error', error => { spawnError = error; });
  for (let attempt = 0; ; ++attempt) {
    if (spawnError) throw spawnError;
    assert.equal(replay.exitCode, null, 'Dump replay exited unexpectedly');
    const candidate = new DebugServerClient('127.0.0.1', replayPort);
    try {
      await candidate.connect();
      const caps = await candidate.getCapabilities();
      assert.equal(caps.process_id, replay.pid);
      results.replay_status = await candidate.getStatus();
      await candidate.resume(); // Explicit test action for this owned replay process.
      await delay(100);
      const image = await candidate.captureScreenshot();
      await fs.writeFile(path.join(output, 'replayed.png'), Buffer.from(image.data, 'base64'));
      replayInspector = candidate; break;
    } catch (error) { candidate.disconnect(); if (attempt >= 30) throw error; await delay(250); }
  }
  passed('native PCSX2 reloads the captured GS file and produces a rendered PNG');
} finally {
  if (owned) { try { await call('pcsx2_stop'); } catch (error) { results.cleanup_error = String(error); } }
  if (replay && replay.exitCode === null && replay.signalCode === null && replay.pid) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned replay did not stop')), 5000);
      replay.once('exit', () => { clearTimeout(timer); resolve(); }); replay.kill();
    });
  }
  inspector.disconnect(); replayInspector?.disconnect(); await mcp.close();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2));
}
