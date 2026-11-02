// Windows: node test/soak-live.mjs <PCSX2> <gs-replay fixture> <configured root> <new output> [seconds=600] [stall-control]
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { PineClient } from '../dist/pine-client.js';
import { resources, checkResources, artifactUsage, limits } from './soak-support.mjs';

assert.equal(process.platform, 'win32', 'Resource sampler currently supports Windows only');
assert.ok(process.argv.length >= 6 && process.argv.length <= 8);
const [executable, input, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p));
const seconds = Number(process.argv[6] ?? 600), control = process.argv[7];
assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'Duration must be 30–3600 seconds');
assert.ok(control === undefined || control === 'stall-control');
assert.ok(control || seconds >= 75, 'Normal runs need at least 75 seconds for both recovery kinds');
await fs.mkdir(output);
const root = path.join(output, 'instance'), fixture = path.join(output, 'fixture'), states = path.join(root, 'sstates');
const hash = b => createHash('sha256').update(b).digest('hex');
const report = { kind: 'duration_rendered_mcp_soak', created_at: new Date().toISOString(), seconds_requested: seconds,
  control: control ?? null, limits, samples: [], recoveries: [], mcp_sessions: [], passed: false,
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
report.node = process.version; report.platform = process.platform;
report.harness_sha256 = hash(await fs.readFile(fileURLToPath(import.meta.url)));
report.support_sha256 = hash(await fs.readFile(fileURLToPath(new URL('./soak-support.mjs', import.meta.url))));
let child, inspector, pine, mcp, transport, watchdog, log, logBytes = 0, logOverflow = false;
let logWrites = Promise.resolve();
let hardExpired = false, counterAddress, initial, start;
const baselines = new Map();
const save = () => fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
  assert.ok(!r.isError, name + ': ' + JSON.stringify(r.content));
  return JSON.parse(r.content.find(c => c.type === 'text').text);
}
async function closeMcp() {
  if (!mcp) return;
  const item = report.mcp_sessions.at(-1);
  await mcp.close();
  for (let n = 0; transport.pid !== null && n < 100; n++) await delay(20);
  item.stopped = transport.pid === null;
  assert.equal(item.stopped, true, 'MCP child still alive'); mcp = undefined;
}
async function openMcp(port) {
  mcp = new Client({ name: 'duration-soak', version: '1.0' });
  transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  report.mcp_sessions.push({ stopped: false });
  // Drain bounded diagnostic traffic without retaining potentially unbounded SDK logs.
  let stderrBytes = 0;
  transport.stderr?.on('data', b => { stderrBytes += b.length; if (stderrBytes > limits.log_bytes) logOverflow = true; });
  await mcp.connect(transport); report.mcp_sessions.at(-1).pid = transport.pid;
  const reply = await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: port } }, undefined, { timeout: 15000 });
  assert.ok(!reply.isError, JSON.stringify(reply.content));
}
async function freePort() {
  const s = createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(0, '127.0.0.1', ok); });
  const p = s.address().port; await new Promise(ok => s.close(ok)); return p;
}
async function identity() {
  const caps = await inspector.getCapabilities();
  for (const key of ['process_id', 'session', 'elf', 'elf_crc', 'data_directory', 'debug_port'])
    assert.equal(caps[key], initial[key], 'Identity changed: ' + key);
  assert.equal((await inspector.getStatus()).paused, true);
  assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  assert.deepEqual(await inspector.listBreakpoints('iop'), []);
  return caps;
}
async function capture(label) {
  const reply = await mcp.callTool({ name: 'pcsx2_screenshot', arguments: { width: 640, height: 480 } }, undefined, { timeout: 15000 });
  assert.ok(!reply.isError, JSON.stringify(reply.content));
  const image = reply.content.find(c => c.type === 'image'); assert.equal(image?.mimeType, 'image/png');
  const bytes = Buffer.from(image.data, 'base64'); assert.ok(bytes.length <= 2 * 1024 ** 2);
  const png = PNG.sync.read(bytes); assert.equal(png.width, 640); assert.equal(png.height, 480);
  assert.ok(new Set(png.data).size > 8, 'Blank rendered image');
  // Only retain first, last and recovery frames; hash decoded pixels at every probe.
  const result = { png_sha256: hash(bytes), pixels_sha256: hash(png.data), width: png.width, height: png.height };
  if (label) { result.file = label + '.png'; await fs.writeFile(path.join(output, result.file), bytes, { flag: 'wx' }); }
  return result;
}
async function counter() { return inspector.readMemoryStrict(counterAddress, 4); }
function elfSymbol(elf, name) {
  const offset = elf.readUInt32LE(32), stride = elf.readUInt16LE(46), count = elf.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const header = offset + i * stride;
    if (elf.readUInt32LE(header + 4) !== 2) continue;
    const strings = elf.readUInt32LE(offset + elf.readUInt32LE(header + 24) * stride + 16);
    const start = elf.readUInt32LE(header + 16), end = start + elf.readUInt32LE(header + 20);
    const size = elf.readUInt32LE(header + 36); assert.ok(size >= 16);
    for (let item = start; item < end; item += size) {
      const at = strings + elf.readUInt32LE(item);
      if (elf.subarray(at, elf.indexOf(0, at)).toString() === name) return '0x' + elf.readUInt32LE(item + 4).toString(16).padStart(8, '0');
    }
  }
  throw new Error('Missing fixture symbol ' + name);
}
async function recover(kind, index) {
  const before = await identity(), beforeCounter = await counter(), item = { kind, before, before_counter: beforeCounter };
  if (kind === 'restore') {
    await pine.saveState(4); let saved;
    for (let n = 0; n < 200; n++) {
      const name = (await fs.readdir(states).catch(() => [])).find(n => n.endsWith('.04.p2s'));
      if (name) { const bytes = await fs.readFile(path.join(states, name));
        if (bytes.length >= 22 && bytes.readUInt32LE(bytes.length - 22) === 0x06054b50) {
          saved = { file: path.relative(output, path.join(states, name)), sha256: hash(bytes), bytes: bytes.length }; break;
        }
      }
      await delay(50);
    }
    assert.ok(saved, 'Savestate not finalized'); item.saved = saved;
    await inspector.resume(); await delay(500); await inspector.pause();
    assert.notEqual(await counter(), beforeCounter, 'No progress before restore');
    item.load = await call('pcsx2_load_state', { slot: 4 });
    assert.equal(item.load.outcome, 'loaded'); assert.equal(item.load.completion_confirmed, true);
    assert.equal(await counter(), beforeCounter, 'Restore did not recover exact RAM');
  } else {
    await inspector.loadElf(path.join(fixture, 'gs-replay.elf')); await inspector.resume();
    // A fresh guest must actually initialize and draw again, rather than pass on an old GS frame.
    await delay(1500); await inspector.pause();
    assert.notEqual(await counter(), beforeCounter, 'Reset counter unchanged');
  }
  item.after = await identity(); assert.ok(item.after.execution_epoch > before.execution_epoch);
  await assert.rejects(inspector.sifSnapshot(before), /identity changed/);
  // State load invalidates the GS image. Resume useful guest work before requiring
  // a new frame; exact saved RAM was checked above, before advancing again.
  const checkpoint = await counter();
  await inspector.resume(); await delay(500);
  await inspector.connect();
  assert.equal((await inspector.getStatus()).paused, false, 'Socket reconnect changed running state');
  await closeMcp(); await openMcp(initial.debug_port);
  assert.equal((await inspector.getStatus()).paused, false, 'Stdio restart changed running state');
  await inspector.pause();
  assert.deepEqual(await identity(), item.after);
  assert.notEqual(await counter(), checkpoint, 'Guest did not recover after interruption');
  item.running_connection_recovery = true;
  item.capture = await capture(`recovery-${index}`); report.recoveries.push(item);
  // The slot is private and consumed; remove it so a later save cannot mistake an old ZIP for completion.
  for (const name of await fs.readdir(states).catch(() => [])) await fs.unlink(path.join(states, name));
}
try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'gs_replay_render_fixture');
  for (const [name, sha] of Object.entries(manifest.sha256)) {
    assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha);
  }
  const sources = fileURLToPath(new URL('./fixtures/gs-replay/', import.meta.url));
  for (const name of await fs.readdir(sources)) assert.equal(hash(await fs.readFile(path.join(sources, name))), manifest.sha256[name], 'Stale source ' + name);
  report.manifest = manifest; report.native_sha256 = hash(await fs.readFile(executable));
  const iniPath = path.join(configured, 'inis/PCSX2.ini'), originalIni = await fs.readFile(iniPath, 'utf8');
  report.config_sha256 = hash(originalIni); let ini = originalIni;
  function setting(section, key, value) {
    ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), '');
    const re = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
    ini = re.test(ini) ? ini.replace(re, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
  }
  const port = await freePort(), pinePort = await freePort(); assert.notEqual(port, pinePort);
  setting('EmuCore', 'EnablePINE', 'true'); setting('EmuCore', 'PINESlot', pinePort);
  setting('Folders', 'Savestates', states);
  await fs.mkdir(path.join(root, 'inis'), { recursive: true }); await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  inspector = new DebugServerClient('127.0.0.1', port); pine = new PineClient('127.0.0.1', pinePort);
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  child = spawn(executable, ['-portable', path.join(fixture, 'gs-replay.elf')], {
    cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    logBytes += b.length; if (logBytes <= limits.log_bytes) logWrites = logWrites.then(() => log.writeFile(b)).catch(() => { logOverflow = true; });
    else logOverflow = true;
  });
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); }); report.pid = child.pid;
  watchdog = setTimeout(() => { hardExpired = true; inspector.disconnect(); child.kill(); transport?.close().catch(() => {}); }, (seconds + 120) * 1000);
  for (let n = 0; ; n++) {
    assert.equal(child.exitCode, null);
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (e) { inspector.disconnect(); if (n >= 199) throw e; await delay(100); }
  }
  for (let n = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; n++) { assert.ok(n < 200); await delay(100); }
  await delay(1500); await inspector.pause(); await openMcp(port); await pine.connect();
  counterAddress = elfSymbol(await fs.readFile(path.join(fixture, 'gs-replay.elf')), 'gs_replay_counter');
  report.counter_address = counterAddress;
  initial = await inspector.getCapabilities(); report.initial = initial;
  assert.equal(initial.process_id, child.pid); assert.equal(initial.debug_port, port);
  assert.equal(path.resolve(initial.data_directory), root);
  assert.equal(path.resolve(initial.elf.replace(/^host:/, '')), path.join(fixture, 'gs-replay.elf'));
  await identity();
  let previousCounter = await counter(), previousImage = await capture('first'), nextRecovery = 30;
  start = performance.now(); let runningMs = 0, recoveryIndex = 0;
  while (performance.now() - start < seconds * 1000) {
    assert.ok(!hardExpired && !logOverflow, 'Watchdog or log budget exceeded');
    const runStart = performance.now();
    if (!control) await inspector.resume(); // Deliberate paused guest is the real negative control.
    await delay(5000); await inspector.pause(); runningMs += performance.now() - runStart;
    const caps = await identity(), value = await counter(), image = await capture();
    assert.notEqual(value, previousCounter, 'Guest progress stalled: counter unchanged');
    assert.notEqual(image.pixels_sha256, previousImage.pixels_sha256, 'Rendered progress stalled: identical pixels');
    const usage = await resources([child.pid, transport.pid]);
    const elapsed = (performance.now() - start) / 1000;
    for (const row of usage) {
      const role = row.pid === child.pid ? 'native' : 'mcp';
      checkResources(row, role, baselines.get(row.pid));
      if (elapsed >= 60 && !baselines.has(row.pid)) baselines.set(row.pid, row);
    }
    report.samples.push({ elapsed_seconds: elapsed, counter: value, execution_epoch: caps.execution_epoch, ...image, resources: usage });
    previousCounter = value; previousImage = image;
    if (elapsed >= nextRecovery) {
      await recover(recoveryIndex % 2 === 0 ? 'restore' : 'reset', ++recoveryIndex);
      previousCounter = await counter(); previousImage = await capture(); nextRecovery += 30;
    }
    report.artifacts = await artifactUsage(output); await save();
    console.log(`PROGRESS ${elapsed.toFixed(1)}/${seconds}s; probes=${report.samples.length}; recoveries=${report.recoveries.length}`);
  }
  report.elapsed_seconds = (performance.now() - start) / 1000; report.running_window_seconds = runningMs / 1000;
  assert.ok(report.elapsed_seconds >= seconds && runningMs >= seconds * 700, 'Insufficient sustained execution windows');
  assert.ok(report.recoveries.some(r => r.kind === 'restore') && report.recoveries.some(r => r.kind === 'reset'), 'Both recovery kinds required');
  report.final = await identity(); report.final_capture = await capture('last');
  report.resource_summary = [...new Set(report.samples.flatMap(s => s.resources.map(r => r.pid)))].map(pid => {
    const rows = report.samples.flatMap(s => s.resources).filter(r => r.pid === pid);
    return { pid, role: pid === child.pid ? 'native' : 'mcp', samples: rows.length,
      first: rows[0], last: rows.at(-1), growth_baseline: baselines.get(pid) ?? null,
      peak_private_bytes: Math.max(...rows.map(r => r.private_bytes)),
      peak_working_set: Math.max(...rows.map(r => r.working_set)), peak_handles: Math.max(...rows.map(r => r.handles)),
      sampled_cpu_seconds: rows.at(-1).cpu_seconds - rows[0].cpu_seconds };
  });
  assert.ok(!hardExpired && !logOverflow, 'Watchdog or log budget exceeded');
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  assert.equal(hash(await fs.readFile(iniPath, 'utf8')), report.config_sha256);
  report.artifacts = await artifactUsage(output); report.passed = true;
} catch (error) { report.failure = String(error); report.failure_stack = error.stack; report.passed = false; process.exitCode = 1; }
finally {
  clearTimeout(watchdog); inspector?.disconnect(); pine?.disconnect();
  try { await closeMcp(); } catch (e) { report.cleanup_failure = String(e); report.passed = false; }
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(ok => child.once('exit', ok)); child.kill(); await Promise.race([stopped, delay(5000)]);
  }
  report.owned_emulator_stopped = !!child && (child.exitCode !== null || child.signalCode !== null);
  if (!report.owned_emulator_stopped || hardExpired || report.mcp_sessions.some(s => !s.stopped)) report.passed = false;
  await logWrites; await log?.close(); if (!report.passed) process.exitCode = 1;
  await save(); console.log(report.passed ? 'PASS duration soak; owned processes stopped' : 'FAIL ' + report.failure);
}
