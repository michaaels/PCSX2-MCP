// node test/input-movie-live.mjs <PCSX2> <homebrew ELF> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { PineClient } from '../dist/pine-client.js';
import { inspectMovie } from '../dist/input-movie.js';

assert.equal(process.argv.length, 6, 'Expected PCSX2, ELF, configured data root and a new output');
const [executable, elf, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output); const root = path.join(output, 'instance');
await fs.mkdir(path.join(root, 'inis'), { recursive: true });
// Only a private INI is changed. BIOS remains referenced in the configured root.
let ini = await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'), 'utf8');
async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); return port;
}
const port = await freePort(), pinePort = await freePort(); assert.notEqual(port, pinePort);
function setting(section, key, value) {
  const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), '');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
}
setting('Pad2', 'Type', 'DualShock2'); setting('EmuCore', 'EnablePINE', 'true'); setting('EmuCore', 'PINESlot', pinePort);
const states = path.join(root, 'sstates'); setting('Folders', 'Savestates', states);
await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
const mcp = new Client({ name: 'input-movie-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const pine = new PineClient('127.0.0.1', pinePort);
const results = { executable, elf, started_at: new Date().toISOString(), checks: [] };
let owned = false;
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
const passed = name => { results.checks.push(name); console.log('PASS ' + name); };
const record = args => call('pcsx2_input_record', args);
const status = (operation_id, wait_ms = 0) => call('pcsx2_input_movie_status', { operation_id, wait_ms });
async function ready() {
  await inspector.resume();
  for (let i = 0; ; ++i) {
    const caps = await inspector.getCapabilities();
    if (caps.elf && Number(caps.elf_crc)) break;
    assert.ok(i < 120, 'ELF did not boot after reset'); await delay(100);
  }
  await inspector.pause();
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  results.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true;
  await inspector.connect(); await ready();
  const first = await record({ frames: 60 });
  assert.equal(first.active, true); assert.equal(first.frames, 0); assert.equal(first.paused, true);
  assert.equal((await inspector.getStatus()).paused, true);
  assert.equal((await status(first.operation_id)).artifact.verified, false);
  await inspector.resume();
  const complete = await status(first.operation_id, 10000); results.record = complete;
  assert.equal(complete.completed, true); assert.equal(complete.reason, 'frame_limit'); assert.equal(complete.frames, 60);
  assert.equal(complete.artifact.bytes, 570 + 36 * 60); assert.equal(complete.artifact.verified, true);
  passed('records exactly 60 complete two-port input records, synchronously closes and pauses; actual header/size/SHA256 verify');

  await ready();
  const original = await fs.readFile(complete.path);
  const replay = await call('pcsx2_input_replay', { path: complete.path,
    movie_sha256: complete.artifact.sha256, elf_sha256: complete.elf_sha256 });
  const busy = await mcp.callTool({ name: 'pcsx2_input_record', arguments: {} }); assert.equal(busy.isError, true);
  const foreign = await mcp.callTool({ name: 'pcsx2_input_movie_stop', arguments: { operation_id: 'f'.repeat(32) } }); assert.equal(foreign.isError, true);
  await assert.rejects(inspector.startFrameAdvance(1, { buttons: ['cross'] }), /recording|replay/i);
  const mutation = await inspector.send({ cmd: 'write_memory', address: '0x00100000', hex: '00000000' }); assert.equal(mutation.ok, false);
  await assert.rejects(inspector.step(), /recording|replay/i);
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: port } })).isError);
  assert.equal((await status(replay.operation_id)).active, true);
  passed('foreign stop, competing start, input automation, step and debugger mutation refuse; reconnect preserves the owned movie');
  await inspector.resume(); const replayed = await status(replay.operation_id, 10000); results.replay = replayed;
  assert.equal(replayed.reason, 'eof'); assert.equal(replayed.frames, 60); assert.equal(replayed.source_preserved, true);
  assert.equal(replayed.artifact.sha256, complete.artifact.sha256); assert.deepEqual(await fs.readFile(complete.path), original);
  await ready(); await delay(150);
  assert.equal((await inspectMovie(replayed.path)).sha256, complete.artifact.sha256);
  passed('native replay stops exactly at EOF and cannot append after resume; both original and private copy retain identical bytes');

  // A controlled nonneutral route exercises the real native pad decoder on both
  // ports. It is synthetic input evidence, not a game/network determinism claim.
  const route = Buffer.alloc(570 + 36 * 240); original.copy(route, 0, 0, 570); route.writeUInt32LE(240, 561);
  for (let frame = 0; frame < 240; ++frame) for (let pad = 0; pad < 2; ++pad) {
    const offset = 570 + frame * 36 + pad * 18;
    route[offset] = pad ? 255 : 223; route[offset + 1] = pad ? 223 : 191;
    route.set([200, 127, 0, 255], offset + 2); route[offset + 6] = pad ? 0 : 255;
    route[offset + (pad ? 11 : 12)] = 255;
  }
  const routePath = path.join(output, 'route.p2m2'); await fs.writeFile(routePath, route);
  const routeInfo = await inspectMovie(routePath); const initial = [await inspector.getController(0), await inspector.getController(1)];
  const startRoute = () => call('pcsx2_input_replay', { path: routePath, movie_sha256: routeInfo.sha256, elf_sha256: complete.elf_sha256 });
  const routeReplay = await startRoute(); await inspector.resume();
  for (let i = 0; ; ++i) {
    const current = await status(routeReplay.operation_id);
    if (current.frames > 0) { assert.equal(current.active, true); break; }
    assert.ok(i < 100); await delay(20);
  }
  await inspector.pause();
  const pad0 = await inspector.getController(0), pad1 = await inspector.getController(1);
  assert.deepEqual(pad0.buttons, ['right', 'cross']); assert.deepEqual(pad1.buttons, ['circle']);
  assert.equal(pad0.left_x, 0); assert.equal(pad0.left_y, 255); assert.equal(pad0.right_x, 200);
  await inspector.resume(); const routed = await status(routeReplay.operation_id, 10000); results.route = routed;
  assert.equal(routed.frames, 240); assert.equal(routed.reason, 'eof');
  assert.deepEqual(await inspector.getController(0), initial[0]); assert.deepEqual(await inspector.getController(1), initial[1]);
  assert.deepEqual(await fs.readFile(routePath), route);
  passed('real native playback applies nonneutral digital/pressure/analog bytes to both controllers and restores their saved state at EOF');

  await ready();
  const cancelled = await startRoute();
  const stopped = await call('pcsx2_input_movie_stop', { operation_id: cancelled.operation_id });
  assert.equal(stopped.active, false); assert.equal(stopped.reason, 'stopped'); assert.equal(stopped.paused, true);
  assert.deepEqual(await fs.readFile(routePath), route);
  passed('owned cancellation closes immediately while paused and preserves replay source');

  await ready();
  const timed = await record({ timeout_ms: 200 });
  await delay(500);
  if (process.platform === 'win32') assert.equal((await fs.readFile(timed.path)).length, 570); // Closed before any status request.
  const expired = await status(timed.operation_id, 5000);
  assert.equal(expired.reason, 'time_limit'); assert.equal(expired.active, false); assert.equal(expired.frames, 0);
  assert.equal(expired.artifact.verified, false); assert.equal((await inspector.getStatus()).paused, true);
  passed('watchdog closes a paused empty recording at wall deadline without a client polling or resuming it');

  await ready();
  const reset = await record({ frames: 600 }); const beforeReset = await inspector.getCapabilities();
  await inspector.resume();
  assert.equal((await inspector.getStatus()).paused, false);
  await inspector.loadElf(elf);
  const resetState = await status(reset.operation_id); assert.equal(resetState.reason, 'vm_reset'); assert.equal(resetState.active, false);
  assert.ok((await inspector.getCapabilities()).execution_epoch > beforeReset.execution_epoch);
  passed('a foreign ELF reset during running execution closes the movie, preserves upstream deferred-reset behavior and advances identity');

  await ready();
  const restore = await record({ frames: 600 }); await ready();
  await pine.connect(); await pine.saveState(7); let saved;
  for (let n = 0; n < 200; ++n) {
    const names = await fs.readdir(states).catch(() => []), filename = names.find(name => name.endsWith('.07.p2s'));
    if (filename) { const b = await fs.readFile(path.join(states, filename)); if (b.length >= 22 && b.readUInt32LE(b.length - 22) === 0x06054b50) { saved = filename; break; } }
    await delay(50);
  }
  assert.ok(saved, 'Complete ZIP savestate not saved'); const oldCaps = await inspector.getCapabilities();
  const oldInspection = await inspector.inspectEE(oldCaps);
  const ee = await inspector.startMemoryWatch('e'.repeat(32), oldCaps, { cpu: 'ee', address: '0x00000000' });
  const iop = await inspector.startMemoryWatch('d'.repeat(32), oldCaps, { cpu: 'iop', address: '0x00000000' });
  await pine.loadState(7);
  for (let n = 0; n < 200; ++n) {
    if ((await inspector.getCapabilities()).execution_epoch > oldCaps.execution_epoch) break;
    assert.ok(n < 199, 'Restore did not advance identity'); await delay(50);
  }
  const restored = await status(restore.operation_id); results.restore = restored;
  assert.equal(restored.reason, 'savestate_load_attempt'); assert.equal(restored.active, false);
  assert.equal((await inspector.memoryWatchStatus(ee.watch_id)).state, 'vm_changed');
  assert.equal((await inspector.memoryWatchStatus(iop.watch_id)).state, 'lifetime_changed');
  await assert.rejects(inspector.inspectEE(oldCaps, oldInspection), /identity|changed/i);
  passed('actual savestate restore closes the movie, rejects old EE inspection identity and terminates EE/IOP memory observers with their respective boundary reasons');

  await ready();
  const locked = await startRoute();
  if (process.platform === 'win32') await assert.rejects(fs.truncate(locked.path, 570 + 18), /EBUSY|EPERM|EACCES/);
  await inspector.resume(); const lockedResult = await status(locked.operation_id, 10000);
  assert.equal(lockedResult.reason, 'eof'); assert.equal(lockedResult.artifact.verified, true);
  assert.deepEqual(await fs.readFile(routePath), route);
  passed('Windows replay opens the private copy read-only with writes denied; inspection still works and the replay completes unchanged');

  const malformed = path.join(output, 'truncated.p2m2'); await fs.writeFile(malformed, route.subarray(0, route.length - 1));
  const rejected = await mcp.callTool({ name: 'pcsx2_input_movie_inspect', arguments: { path: malformed } }); assert.equal(rejected.isError, true);
  const offline = await call('pcsx2_input_movie_inspect', { path: routePath }); assert.equal(offline.sha256, routeInfo.sha256);
  passed('offline inspection rejects incomplete frames and hashes complete artifacts independently of the current VM');

  await ready();
  const one = await record({ frames: 1 }); const beforeOne = await inspector.getCapabilities();
  await inspector.resume(); const oneResult = await status(one.operation_id, 10000);
  assert.equal(oneResult.frames, 1); assert.equal(oneResult.artifact.bytes, 606);
  assert.equal(oneResult.completed, true);
  // Real CPU execution between application and close: the frame cannot be
  // counted and restored entirely inside its first input-poll callback.
  assert.notEqual((await inspector.getStatus()).pc, '0xbfc00000');
  assert.equal(beforeOne.execution_epoch, oneResult.execution_epoch);
  await ready();
  const oneReplay = await call('pcsx2_input_replay', { path: oneResult.path,
    movie_sha256: oneResult.artifact.sha256, elf_sha256: oneResult.elf_sha256 });
  await inspector.resume(); const onePlayed = await status(oneReplay.operation_id, 10000);
  assert.equal(onePlayed.frames, 1); assert.equal(onePlayed.reason, 'eof'); assert.equal(onePlayed.source_preserved, true);
  passed('one-frame record/replay retains frame zero and closes only at the following input-poll boundary');
  results.passed = true;
} finally {
  inspector.disconnect(); pine.disconnect();
  if (owned) await mcp.callTool({ name: 'pcsx2_stop', arguments: {} }).catch(() => {});
  await mcp.close(); results.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2));
}
