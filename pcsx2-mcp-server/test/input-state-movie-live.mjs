// Own Windows/PCSX2 integration only. No SMS, network media or physical PS2.
// node test/input-state-movie-live.mjs <PCSX2> <standalone fixture> <configured root> <new output>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectInputState } from '../dist/input-state.js';
import { inspectMovie } from '../dist/input-movie.js';
import { watch, mkdirSync } from 'node:fs';
import { stateZip, stateEntries } from './input-state-fixtures.mjs';

assert.equal(process.argv.length, 6);
const [executable, input, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const root = path.join(output, 'instance'), fixture = path.join(output, 'fixture');
const hash = b => createHash('sha256').update(b).digest('hex');
function elfSymbol(elf, name) {
  const offset = elf.readUInt32LE(32), stride = elf.readUInt16LE(46), count = elf.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const header = offset + i * stride;
    if (elf.readUInt32LE(header + 4) !== 2) continue;
    const strings = elf.readUInt32LE(offset + elf.readUInt32LE(header + 24) * stride + 16);
    const start = elf.readUInt32LE(header + 16), end = start + elf.readUInt32LE(header + 20), size = elf.readUInt32LE(header + 36);
    assert.ok(size >= 16);
    for (let item = start; item < end; item += size) {
      const at = strings + elf.readUInt32LE(item);
      if (elf.subarray(at, elf.indexOf(0, at)).toString() === name) return '0x' + elf.readUInt32LE(item + 4).toString(16).padStart(8, '0');
    }
  }
  throw new Error('Missing fixture symbol ' + name);
}
const report = { kind: 'native_state_start_movies', passed: false, checks: [], started_at: new Date().toISOString(),
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, inspector, mcp, transport, log, watchdog, faultWatcher;
const passed = message => { report.checks.push(message); console.log('PASS ' + message); };
async function tool(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 40000 });
  assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content[0].text);
}
async function refused(name, args) {
  const r = await mcp.callTool({ name, arguments: args }); assert.equal(r.isError, true, JSON.stringify(r.content));
}
async function until(read, predicate, label) {
  for (let i = 0; i < 200; i++) { const r = await read(); if (predicate(r)) return r; await delay(25); }
  throw new Error(label + ' deadline');
}
const state = id => inspector.inputMovieStatus(id);
const status = (id, wait_ms = 0) => tool('pcsx2_input_movie_status', { operation_id: id, wait_ms });
async function rawStart(options = {}) {
  const caps = await inspector.getCapabilities(), id = randomUUID().replaceAll('-', '');
  return inspector.send({ cmd: 'input_movie_start', operation_id: id, mode: 'record', start: 'savestate', frames: 2, timeout_ms: 30000,
    elf_sha256: report.elf_sha256, expected_process_id: caps.process_id, expected_session: caps.session,
    expected_execution_epoch: caps.execution_epoch, expected_elf: caps.elf, expected_elf_crc: caps.elf_crc, ...options });
}
try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json')));
  assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
  for (const [name, sha] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha); }
  const sources = fileURLToPath(new URL('./fixtures/standalone/', import.meta.url));
  for (const name of await fs.readdir(sources)) assert.equal(hash(await fs.readFile(path.join(sources, name))), manifest.sha256[name]);
  const elf = path.join(fixture, 'standalone.elf'), iniPath = path.join(configured, 'inis/PCSX2.ini');
  const originalIni = await fs.readFile(iniPath); report.config_sha256 = hash(originalIni);
  await fs.mkdir(path.join(root, 'inis'), { recursive: true });
  let ini = originalIni.toString('utf8');
  for (const section of ['Pad1', 'Pad2']) {
    const block = new RegExp(`^\\[${section}\\]\\r?\\n([^]*?)(?=^\\[|$(?![^]))`, 'm');
    ini = block.test(ini) ? ini.replace(block, (_, body) => `[${section}]\nType = DualShock2\n` + body.replace(/^Type\s*=.*\r?\n/gm, ''))
      : ini + `\n[${section}]\nType = DualShock2\n`;
  }
  await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port; await new Promise(ok => server.close(ok));
  report.native_sha256 = hash(await fs.readFile(executable)); report.elf_sha256 = manifest.sha256['standalone.elf'];
  report.inputs = {};
  for (const name of ['../dist/input-movie.js', '../dist/input-movie-tools.js', '../dist/input-state.js', '../dist/debug-server-client.js',
    '../src/input-movie.ts', '../src/input-movie-tools.ts', '../src/input-state.ts', '../src/debug-server-client.ts', './input-state-movie-live.mjs'])
    report.inputs[name] = hash(await fs.readFile(fileURLToPath(new URL(name, import.meta.url))));
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); }, 180000);
  inspector = new DebugServerClient('127.0.0.1', port);
  for (let i = 0; ; i++) {
    assert.equal(native.exitCode, null);
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (e) { inspector.disconnect(); if (i >= 199) throw e; await delay(100); }
  }
  await until(() => inspector.getCapabilities(), c => Number(c.elf_crc), 'ELF boot'); await delay(1500); await inspector.pause();
  assert.equal((await inspector.getCapabilities()).process_id, native.pid);
  const address = elfSymbol(await fs.readFile(elf), 'standalone_counter'); report.counter_address = address;
  const counter = () => inspector.readMemoryStrict(address, 4);
  mcp = new Client({ name: 'state-movies-live', version: '1.0' });
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport);
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: port } })).isError);

  const raw = await rawStart(); assert.equal(raw.ok, true, JSON.stringify(raw)); assert.ok(['preparing', 'prepared'].includes(raw.state));
  const unchanged = await counter(); await inspector.resume(); assert.equal((await inspector.getStatus()).paused, true);
  assert.equal(await counter(), unchanged);
  const prepared = await until(() => state(raw.operation_id), s => s.state === 'prepared', 'async save');
  assert.equal(prepared.state_outcome, 'saved'); assert.equal(prepared.frames, 0);
  const receipt = await inspectInputState({ path: prepared.state_path });
  const badAccept = await inspector.send({ cmd: 'input_movie_accept', operation_id: raw.operation_id, state_sha256: '0'.repeat(64) });
  assert.equal(badAccept.active, false); assert.equal(badAccept.reason, 'state_verification_failed');
  assert.equal(await counter(), unchanged); report.prepared = { ...prepared, companion_sha256: receipt.sha256 };
  passed('actual async zip-close receipt stays paused until verification; mismatched acceptance SHA closes only its empty movie');

  const before = await inspector.getCapabilities(), savedCounter = await counter();
  const record = await tool('pcsx2_input_record', { start: 'savestate', frames: 12, timeout_ms: 30000 });
  assert.equal(record.state, 'active'); assert.equal(record.state_outcome, 'saved'); assert.equal(record.paused, true);
  assert.equal(record.execution_epoch, before.execution_epoch); assert.equal(await counter(), savedCounter);
  await inspector.resume(); const recorded = await status(record.operation_id, 10000); report.record = recorded;
  assert.equal(recorded.completed, true); assert.equal(recorded.frames, 12); assert.equal(recorded.artifact.from_savestate, true);
  const bytes = await fs.readFile(recorded.path), stateBytes = await fs.readFile(recorded.state_path);
  passed('MCP records twelve complete frames from a finalized verified native savestate without resetting paused guest RAM');

  // Only our fixture is intentionally altered to prove a real native restore.
  const changed = savedCounter === '12345678' ? '87654321' : '12345678'; await inspector.writeMemory(address, changed);
  const oldCaps = await inspector.getCapabilities(), oldInspection = await inspector.inspectEE(oldCaps);
  const ee = await inspector.startMemoryWatch('e'.repeat(32), oldCaps, { cpu: 'ee', address });
  const iop = await inspector.startMemoryWatch('d'.repeat(32), oldCaps, { cpu: 'iop', address: '0x00000000' });
  const replayOptions = { path: recorded.path, movie_sha256: recorded.artifact.sha256, elf_sha256: recorded.elf_sha256,
    state_path: recorded.state_path, state_sha256: recorded.state_sha256, timeout_ms: 30000 };
  const replay = await tool('pcsx2_input_replay', replayOptions); report.replay_start = replay;
  assert.equal(replay.state_outcome, 'loaded'); assert.equal(replay.execution_epoch, oldCaps.execution_epoch + 1);
  assert.equal(await counter(), savedCounter); assert.equal((await inspector.getStatus()).paused, true);
  assert.equal((await inspector.memoryWatchStatus(ee.watch_id)).state, 'vm_changed');
  assert.equal((await inspector.memoryWatchStatus(iop.watch_id)).state, 'lifetime_changed');
  await assert.rejects(inspector.inspectEE(oldCaps, oldInspection), /identity|changed/i);
  if (process.platform === 'win32') {
    await assert.rejects(fs.truncate(replay.state_path, 1), /EBUSY|EPERM|EACCES/);
    await assert.rejects(fs.truncate(replay.path, 1), /EBUSY|EPERM|EACCES/);
  }
  await refused('pcsx2_input_movie_stop', { operation_id: 'f'.repeat(32) });
  await inspector.resume(); const replayed = await status(replay.operation_id, 10000); report.replay = replayed;
  assert.equal(replayed.reason, 'eof'); assert.equal(replayed.frames, 12); assert.equal(replayed.state_source_preserved, true);
  assert.deepEqual(await fs.readFile(recorded.path), bytes); assert.deepEqual(await fs.readFile(recorded.state_path), stateBytes);
  assert.equal((await inspectMovie(replayed.path)).sha256, recorded.artifact.sha256);
  passed('native state replay restores exact captured RAM, invalidates epoch/EE/IOP observers, pins read-only copies and stops at EOF preserving sources');

  const route = Buffer.alloc(570 + 36 * 24); bytes.copy(route, 0, 0, 570); route.writeUInt32LE(24, 561);
  for (let frame = 0; frame < 24; frame++) for (let pad = 0; pad < 2; pad++) {
    const at = 570 + frame * 36 + pad * 18;
    route[at] = pad ? 255 : 223; route[at + 1] = pad ? 223 : 191; route.set([200, 127, 0, 255], at + 2);
    route[at + 6] = pad ? 0 : 255; route[at + (pad ? 11 : 12)] = 255;
  }
  const routePath = path.join(output, 'state-route.p2m2'); await fs.writeFile(routePath, route);
  const initialPads = [await inspector.getController(0), await inspector.getController(1)];
  const routed = await tool('pcsx2_input_replay', { ...replayOptions, path: routePath, movie_sha256: hash(route) });
  await inspector.resume(); await until(() => state(routed.operation_id), s => s.frames > 0, 'nonneutral input'); await inspector.pause();
  assert.deepEqual((await inspector.getController(0)).buttons, ['right', 'cross']);
  assert.deepEqual((await inspector.getController(1)).buttons, ['circle']);
  assert.equal((await inspector.getController(0)).left_x, 0); assert.equal((await inspector.getController(0)).right_x, 200);
  await inspector.resume(); const routeEnd = await status(routed.operation_id, 10000);
  assert.equal(routeEnd.reason, 'eof'); assert.equal(routeEnd.frames, 24);
  assert.deepEqual([await inspector.getController(0), await inspector.getController(1)], initialPads);
  assert.deepEqual(await fs.readFile(routePath), route);
  const one = await tool('pcsx2_input_record', { start: 'savestate', frames: 1, timeout_ms: 30000 });
  await inspector.resume(); const oneEnd = await status(one.operation_id, 10000); assert.equal(oneEnd.frames, 1);
  const onePlay = await tool('pcsx2_input_replay', { path: oneEnd.path, movie_sha256: oneEnd.artifact.sha256, elf_sha256: oneEnd.elf_sha256,
    state_path: oneEnd.state_path, state_sha256: oneEnd.state_sha256 });
  await inspector.resume(); const onePlayed = await status(onePlay.operation_id, 10000);
  assert.equal(onePlayed.frames, 1); assert.equal(onePlayed.reason, 'eof');
  passed('state playback applies nonneutral input to both pads then restores them; repeated recording and one-frame state record/replay retain frame zero');

  const paused = await inspector.getStatus(), epoch = (await inspector.getCapabilities()).execution_epoch;
  await refused('pcsx2_input_replay', { ...replayOptions, state_path: path.join(output, 'missing.p2s') });
  await refused('pcsx2_input_replay', { ...replayOptions, state_sha256: '0'.repeat(64) });
  const corrupt = path.join(output, 'corrupt.p2s'); await fs.writeFile(corrupt, stateBytes.subarray(0, stateBytes.length - 1));
  await refused('pcsx2_input_replay', { ...replayOptions, state_path: corrupt, state_sha256: hash(await fs.readFile(corrupt)) });
  assert.equal((await inspector.getCapabilities()).execution_epoch, epoch); assert.deepEqual(await inspector.getStatus(), paused);
  // Skip Node preflight deliberately: native still must reject a changed source
  // against the originally verified hash BEFORE invoking its loader.
  const rawMismatch = await rawStart({ mode: 'replay', path: recorded.path, movie_sha256: recorded.artifact.sha256,
    state_path: corrupt, state_sha256: recorded.state_sha256 }); assert.equal(rawMismatch.ok, false);
  assert.equal((await inspector.getCapabilities()).execution_epoch, epoch); assert.deepEqual(await inspector.getStatus(), paused);
  passed('missing, wrong-hash, corrupt and changed-after-preflight companions reject before native load/epoch changes');

  const cancelled = await rawStart(); assert.equal(cancelled.ok, true); assert.equal(cancelled.state, 'preparing');
  const unfinished = await fs.readFile(cancelled.state_path).catch(() => Buffer.alloc(0));
  assert.ok(unfinished.length < 22 || unfinished.readUInt32LE(unfinished.length - 22) !== 0x06054b50, 'Old archive already finalized before cancellation');
  const cancelledState = await inspector.inputMovieStatus(cancelled.operation_id, true); assert.equal(cancelledState.state_outcome, 'pending');
  const next = await rawStart(); assert.equal(next.ok, true);
  await until(() => state(next.operation_id), s => s.state === 'prepared', 'next save');
  await until(async () => inspectInputState({ path: cancelled.state_path }).catch(() => null), Boolean, 'late old archive completion');
  assert.equal((await state(next.operation_id)).state, 'prepared'); assert.equal((await state(next.operation_id)).frames, 0);
  await assert.rejects(inspector.inputMovieStatus(cancelled.operation_id), /superseded|Unknown/);
  await inspector.inputMovieStatus(next.operation_id, true);
  const timed = await rawStart({ timeout_ms: 100 }); assert.equal(timed.ok, true);
  await delay(500); const expired = await state(timed.operation_id);
  assert.equal(expired.active, false); assert.equal(expired.reason, 'time_limit'); assert.equal(expired.frames, 0);
  assert.equal((await inspector.getStatus()).paused, true);
  passed('cancelled save completion cannot activate a newer ticket; pending/verified saves remain subject to native wall deadlines without resume');

  // Filesystem fault only inside the owned test directory. Occupy the future
  // state pathname with a directory during CPU-side capture, before zip writes.
  let faultPath;
  faultWatcher = watch(root, { recursive: true }, (_, name) => {
    if (!name || !String(name).endsWith('.p2m2') || faultPath) return;
    const candidate = path.join(root, String(name)) + '_SaveState.p2s';
    try { mkdirSync(candidate); faultPath = candidate; } catch { /* Writer may have won; acceptance below still requires the actual fault. */ }
  });
  const saveFault = await rawStart(); faultWatcher.close(); faultWatcher = undefined;
  assert.equal(saveFault.ok, true); assert.equal(faultPath, saveFault.state_path, 'Did not inject the scoped save failure');
  const failedSave = await until(() => state(saveFault.operation_id), s => !s.active, 'save error receipt');
  assert.equal(failedSave.state_outcome, 'failed'); assert.equal(failedSave.reason, 'state_save_failed'); assert.equal(failedSave.frames, 0);
  assert.equal((await inspector.getStatus()).paused, true); report.failed_save = failedSave;
  passed('an actual filesystem save failure publishes a failed worker receipt, closes the empty owned movie and keeps the guest paused');

  // A complete CRC-correct archive can still fail the core deserializer. Use
  // structural synthetic data, explicitly not a valid emulated machine state.
  const invalidNative = path.join(output, 'native-invalid.p2s'), invalidEntries = stateEntries();
  invalidEntries.find(e => e.name === 'PCSX2 Internal Structures.dat').data = Buffer.alloc(1024);
  await fs.writeFile(invalidNative, stateZip(invalidEntries));
  await inspectInputState({ path: invalidNative, expected_sha256: hash(await fs.readFile(invalidNative)) });
  const loadFailure = await rawStart({ mode: 'replay', path: recorded.path, movie_sha256: recorded.artifact.sha256,
    state_path: invalidNative, state_sha256: hash(await fs.readFile(invalidNative)) });
  report.failed_load = loadFailure;
  assert.equal(loadFailure.ok, true); assert.equal(loadFailure.active, false); assert.equal(loadFailure.state, 'failed');
  assert.equal(loadFailure.state_outcome, 'load_failed'); assert.equal(loadFailure.reason, 'start_failed');
  assert.equal((await inspector.getCapabilities()).execution_epoch, loadFailure.execution_epoch);
  assert.equal((await state(loadFailure.operation_id)).state_outcome, 'load_failed');
  passed('CRC-correct but non-loadable companion reports the actual native load failure; no rollback or unchanged VM claim is made');

  assert.equal(hash(await fs.readFile(executable)), report.native_sha256); assert.equal(hash(await fs.readFile(iniPath)), report.config_sha256);
  report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; report.native_exit_at_failure = native?.exitCode; process.exitCode = 1; }
finally {
  faultWatcher?.close(); clearTimeout(watchdog); inspector?.disconnect();
  try { await mcp?.close(); report.mcp_stopped = !transport || transport.pid === null; } catch (e) { report.cleanup_error = String(e); report.passed = false; }
  if (native && native.exitCode === null && native.signalCode === null) {
    const done = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([done, delay(5000)]);
  }
  report.native_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  report.native_exit_code = native?.exitCode; report.native_exit_signal = native?.signalCode;
  if (!report.native_stopped || !report.mcp_stopped) report.passed = false;
  report.finished_at = new Date().toISOString(); await log?.close();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) { process.exitCode = 1; console.log('FAIL ' + report.failure); }
}
