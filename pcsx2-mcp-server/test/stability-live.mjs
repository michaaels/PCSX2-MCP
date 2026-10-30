// node test/stability-live.mjs <PCSX2> <instruction fixture> <configured root> <new output> [cycles=100]
// Bounded standalone repetition; this does not exercise a game or measure leak freedom.
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

assert.ok(process.argv.length === 6 || process.argv.length === 7);
const [executable, input, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p));
const cycles = Number(process.argv[6] ?? 100);
assert.ok(Number.isInteger(cycles) && cycles >= 10 && cycles <= 500, 'cycles must be 10–500');
await fs.mkdir(output); // Never replace an earlier run.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.join(output, 'instance'), fixture = path.join(output, 'fixture');
const report = {
  kind: 'bounded_mcp_stability', created_at: new Date().toISOString(), cycles_requested: cycles,
  native_sha256: hash(await fs.readFile(executable)), checks: [], cycles: [], captures: [],
  mcp_sessions: [], passed: false, owned_emulator_stopped: false,
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed',
};
const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
const save = () => fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');
let child, log, inspector, mcp, transport;

async function raw(name, args = {}) {
  return mcp.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
}
async function call(name, args = {}) {
  const reply = await raw(name, args);
  assert.ok(!reply.isError, name + ': ' + JSON.stringify(reply.content));
  return JSON.parse(reply.content[0].text);
}
function symbol(elf, name) {
  const offset = elf.readUInt32LE(32), stride = elf.readUInt16LE(46), count = elf.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const header = offset + i * stride;
    if (elf.readUInt32LE(header + 4) !== 2) continue;
    const strings = elf.readUInt32LE(offset + elf.readUInt32LE(header + 24) * stride + 16);
    const start = elf.readUInt32LE(header + 16), end = start + elf.readUInt32LE(header + 20);
    const size = elf.readUInt32LE(header + 36);
    assert.ok(size >= 16);
    for (let item = start; item < end; item += size) {
      const at = strings + elf.readUInt32LE(item);
      if (elf.subarray(at, elf.indexOf(0, at)).toString() === name) return elf.readUInt32LE(item + 4);
    }
  }
  throw new Error('Missing fixture symbol ' + name);
}
async function pausedState() {
  const state = { status: await inspector.getStatus(), identity: await inspector.getCapabilities(),
    ee_points: await inspector.listBreakpoints('ee'), iop_points: await inspector.listBreakpoints('iop') };
  assert.equal(state.status.paused, true);
  return state;
}
async function t0() {
  return Number(BigInt('0x' + (await inspector.readRegisters('ee', 0)).GPR.regs[8].value) & 0xffffffffn);
}
async function closeMcp() {
  if (!mcp) return;
  const item = report.mcp_sessions.at(-1);
  await mcp.close();
  for (let n = 0; transport.pid !== null && n < 100; n++) await delay(20);
  item.stopped = transport.pid === null;
  assert.equal(item.stopped, true, 'Owned stdio server did not stop');
  mcp = undefined;
}
async function openMcp(port) {
  mcp = new Client({ name: 'bounded-stability', version: '1.0' });
  transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  report.mcp_sessions.push({ stopped: false });
  await mcp.connect(transport);
  report.mcp_sessions.at(-1).pid = transport.pid;
  assert.ok(!(await raw('pcsx2_connect', { mode: 'debug', debug_port: port })).isError);
}

try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'standalone_instruction_fixture');
  for (const [name, sha] of Object.entries(manifest.sha256)) {
    assert.equal(path.basename(name), name);
    assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha);
  }
  const sources = fileURLToPath(new URL('./fixtures/instruction-control/', import.meta.url));
  for (const name of await fs.readdir(sources)) {
    if ((await fs.stat(path.join(sources, name))).isFile())
      assert.equal(hash(await fs.readFile(path.join(sources, name))), manifest.sha256[name], 'Stale fixture source ' + name);
  }
  const elfPath = path.join(fixture, 'instruction-control.elf'), elf = await fs.readFile(elfPath);
  report.elf_sha256 = hash(elf);
  const addresses = Object.fromEntries(['instruction_ready', 'fixture_normal', 'fixture_jal',
    'fixture_return', 'fixture_hang_call'].map(name => [name, symbol(elf, name)]));
  report.addresses = addresses;
  const iniPath = path.join(configured, 'inis/PCSX2.ini');
  const originalIni = await fs.readFile(iniPath, 'utf8');
  report.config_sha256 = hash(await fs.readFile(iniPath));
  let ini = originalIni.replace(/^HostFs\s*=.*\r?\n/gm, '');
  ini = /^\[EmuCore\]\r?\n/m.test(ini)
    ? ini.replace(/^\[EmuCore\]\r?\n/m, '[EmuCore]\nHostFs = true\n') : ini + '\n[EmuCore]\nHostFs = true\n';
  await fs.mkdir(path.join(root, 'inis'), { recursive: true });
  await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const listener = createServer();
  await new Promise((ok, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', ok); });
  const port = listener.address().port;
  await new Promise(ok => listener.close(ok));
  inspector = new DebugServerClient('127.0.0.1', port);
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  child = spawn(executable, ['-portable', '-debugger', elfPath], {
    cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root },
    stdio: ['ignore', log.fd, log.fd],
  });
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); });
  report.pid = child.pid; report.debug_port = port;
  for (let n = 0; ; n++) {
    assert.equal(child.exitCode, null, 'Owned emulator exited');
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (error) { inspector.disconnect(); if (n >= 199) throw error; await delay(100); }
  }
  for (let n = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; n++) {
    assert.ok(n < 200, 'ELF did not boot'); await delay(100);
  }
  await inspector.pause();
  await inspector.setBreakpoint(hex(addresses.instruction_ready), { description: 'Stability fixture ready' });
  let history = await inspector.readEvents(0, 200);
  while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
  // Replay this owned fixture's boot so ready cannot already have been passed.
  // Launch/debugger startup can otherwise supply an unrelated entrypoint stop.
  await inspector.loadElf(elfPath); await inspector.resume();
  report.ready_event = await inspector.waitEvent({ after: history.next_cursor, type: 'breakpoint', timeoutMs: 20000 });
  assert.equal(report.ready_event.timed_out, false);
  assert.equal((await inspector.getStatus()).pc, hex(addresses.instruction_ready));
  await inspector.removeBreakpoint(hex(addresses.instruction_ready));
  await openMcp(port);
  report.initial = await pausedState();
  assert.equal(report.initial.identity.process_id, child.pid);
  assert.equal(report.initial.identity.debug_port, port);
  assert.equal(path.resolve(report.initial.identity.data_directory), root);
  assert.equal(path.resolve(report.initial.identity.elf.replace(/^host:/, '')), elfPath);
  assert.ok(report.initial.identity.features.includes('application_screenshot'));
  assert.deepEqual(report.initial.ee_points, []); assert.deepEqual(report.initial.iop_points, []);
  passed('Owned process/port/root/ELF and hash-verified current fixture booted at its ready breakpoint');

  const start = performance.now(), deadline = start + 10 * 60 * 1000;
  let eventCursor = history.next_cursor;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    assert.ok(performance.now() < deadline, 'Ten-minute repetition budget exceeded');
    const began = performance.now();
    await inspector.setPC(hex(addresses.fixture_normal));
    const beforeStep = await t0();
    const step = await call('pcsx2_step', { cpu: 'ee', count: 2, timeout_ms: 1000 });
    assert.equal(step.completed, true); assert.equal(step.steps.length, 2);
    assert.equal(step.steps[1].new_pc, hex(addresses.fixture_normal + 8));
    assert.equal(await t0(), (beforeStep + 3) >>> 0);
    await inspector.setPC(hex(addresses.fixture_jal));
    const beforeOver = await t0();
    const over = await call('pcsx2_step_over', { cpu: 'ee', timeout_ms: 1000 });
    assert.equal(over.completed, true); assert.equal(over.steps[0].new_pc, hex(addresses.fixture_return));
    assert.equal(await t0(), (beforeOver + 4) >>> 0);
    assert.deepEqual(await inspector.listBreakpoints('ee'), []);
    const paused = await pausedState();
    await inspector.connect();
    assert.deepEqual(await pausedState(), paused);
    const events = await inspector.readEvents(eventCursor, 32);
    assert.ok(events.events.length <= 32); assert.ok(events.next_cursor >= eventCursor);
    eventCursor = events.next_cursor;
    const item = { cycle, elapsed_ms: 0, event_cursor: eventCursor };
    if (cycle % 10 === 0) {
      await inspector.setPC(hex(addresses.fixture_hang_call));
      const timeout = await raw('pcsx2_step_over', { cpu: 'ee', timeout_ms: 100 });
      assert.equal(timeout.isError, true); assert.match(JSON.stringify(timeout.content), /timed out/);
      assert.equal((await inspector.getStatus()).paused, true);
      assert.deepEqual(await inspector.listBreakpoints('ee'), []);
      await inspector.setPC(hex(addresses.fixture_normal));
      const successor = hex(addresses.fixture_normal + 4);
      await inspector.setBreakpoint(successor, { description: 'Stability foreign successor' });
      const foreign = await pausedState();
      const refused = await raw('pcsx2_step', { cpu: 'ee', timeout_ms: 1000 });
      assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /Existing breakpoint/);
      assert.deepEqual(await pausedState(), foreign);
      await inspector.removeBreakpoint(successor);
      const beforeReconnect = await pausedState();
      await closeMcp(); await openMcp(port);
      assert.deepEqual(await pausedState(), beforeReconnect);
      const reply = await raw('pcsx2_application_screenshot', { target: 'debugger', width: 320, height: 240 });
      assert.ok(!reply.isError, JSON.stringify(reply.content));
      const content = reply.content.find(c => c.type === 'image');
      assert.equal(content?.mimeType, 'image/png');
      const metadata = JSON.parse(reply.content.find(c => c.type === 'text').text);
      assert.equal(metadata.target, 'debugger'); assert.equal(metadata.source, 'qt_widget');
      const bytes = Buffer.from(content.data, 'base64'), png = PNG.sync.read(bytes);
      assert.equal(png.width, metadata.width); assert.equal(png.height, metadata.height);
      assert.ok(png.width <= 320 && png.height <= 240 && new Set(png.data).size > 8);
      assert.deepEqual(await pausedState(), beforeReconnect);
      const filename = `debugger-${cycle}.png`;
      await fs.writeFile(path.join(output, filename), bytes, { flag: 'wx' });
      report.captures.push({ cycle, filename, sha256: hash(bytes), ...metadata });
      item.timeout_recovered = true; item.foreign_preserved = true; item.mcp_restarted = true;
    }
    const after = await pausedState();
    for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc'])
      assert.equal(after.identity[key], report.initial.identity[key], 'Identity drift: ' + key);
    assert.deepEqual(after.ee_points, []); assert.deepEqual(after.iop_points, []);
    item.elapsed_ms = performance.now() - began;
    report.cycles.push(item);
    if (cycle % 10 === 0) { console.log('PROGRESS ' + cycle + '/' + cycles); await save(); }
  }
  report.elapsed_ms = performance.now() - start;
  assert.equal(report.cycles.length, cycles);
  assert.equal(report.captures.length, Math.floor(cycles / 10));
  passed(`${cycles} EE two-instruction/JAL cycles retained exact register/PC effects, empty breakpoint lists and native identity`);
  passed(`${cycles} actual native socket replacements preserved the complete sampled paused state`);
  passed(`${Math.floor(cycles / 10)} timeout/foreign-point controls recovered without erasing the foreign point`);
  passed(`${Math.floor(cycles / 10)} stdio restarts and decoded debugger captures preserved paused state`);
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  assert.equal(hash(await fs.readFile(iniPath)), report.config_sha256);
  report.final = await pausedState();
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = String(error); process.exitCode = 1;
} finally {
  inspector?.disconnect();
  try { await closeMcp(); } catch (error) { report.cleanup_failure = String(error); report.passed = false; }
  if (child) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(ok => child.once('exit', ok));
      child.kill(); await Promise.race([stopped, delay(5000)]);
    }
    report.owned_emulator_stopped = child.exitCode !== null || child.signalCode !== null;
  }
  if (!report.owned_emulator_stopped || report.mcp_sessions.some(s => !s.stopped)) report.passed = false;
  await log?.close();
  if (!report.passed) process.exitCode = 1;
  await save();
  console.log(report.passed ? 'PASS bounded stability; all owned processes stopped' : 'FAIL ' + (report.failure ?? report.cleanup_failure ?? 'cleanup unconfirmed'));
}
