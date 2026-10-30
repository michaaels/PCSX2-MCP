// node test/gui-ownership-live.mjs <PCSX2> <standalone fixture> <configured root> <new output> [--preflight]
// Opens the native debugger; only the operator edits the GUI. No UI automation.
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
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.ok(process.argv.length === 6 || process.argv.length === 7);
const preflight = process.argv[6] === '--preflight';
if (process.argv.length === 7) assert.ok(preflight, 'Unknown option');
const [executable, fixture, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p));
await fs.mkdir(output);
const root = path.join(output, 'instance');
await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
for (const [name, sha] of Object.entries(manifest.sha256)) {
  assert.equal(path.basename(name), name);
  assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha);
}
const originalIni = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), originalIni);
const elf = path.join(fixture, 'standalone.elf'), elfHash = manifest.sha256['standalone.elf'];
const server = createServer();
await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
const port = server.address().port;
await new Promise(ok => server.close(ok));
const inspector = new DebugServerClient('127.0.0.1', port);
const mcp = new Client({ name: 'guided-gui-ownership', version: '1.0' });
const report = { kind: 'guided_source_breakpoint_gui_ownership', executable, elf, elf_sha256: elfHash,
  native_sha256: hash(await fs.readFile(executable)), debug_port: port, data_directory: root,
  started_at: new Date().toISOString(), checks: [], attempts: [], preflight, passed: false,
  gui_accepted: false, operator_confirmed_gui_edit: false, GUI_automated: false,
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const controlPath = path.join(output, 'control.json');
await fs.writeFile(controlPath, JSON.stringify({ sequence: 0, action: 'wait' }) + '\n');
const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
async function phase(value, extra = {}) {
  Object.assign(report, extra, { phase: value });
  await fs.writeFile(path.join(output, 'session.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PHASE ' + value);
}
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 30000 }); }
async function call(name, args = {}) {
  const reply = await raw(name, args);
  assert.ok(!reply.isError, JSON.stringify(reply.content));
  return JSON.parse(reply.content[0].text);
}
async function install(line) {
  return call('pcsx2_breakpoint_source', { elf, file: 'standalone.c', line, expected_sha256: elfHash });
}
async function state() {
  return { identity: await inspector.getCapabilities(), cpu: await inspector.getStatus(),
    points: await inspector.listBreakpoints('ee') };
}
let child, log;
try {
  log = await fs.open(path.join(output, 'native-stdout.log'), 'wx');
  child = spawn(executable, ['-portable', '-debugger', elf], {
    cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root } });
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); });
  report.pid = child.pid;
  await phase('launching');
  for (let attempt = 0; ; attempt++) {
    assert.equal(child.exitCode, null, 'Owned emulator exited before readiness');
    try {
      await inspector.connect();
      const caps = await inspector.getCapabilities();
      assert.equal(caps.process_id, child.pid);
      assert.equal(caps.debug_port, port);
      assert.equal(path.normalize(caps.data_directory), path.normalize(root));
      if (!caps.elf || caps.elf_crc === '0x00000000') throw new Error('ELF not ready');
      assert.equal(path.normalize(caps.elf.replace(/^host\d*:/, '')), path.normalize(elf));
      report.initial_identity = caps;
      break;
    } catch (error) { inspector.disconnect(); if (attempt >= 199) throw error; await delay(100); }
  }
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  const connected = await raw('pcsx2_connect', { mode: 'debug', debug_port: port });
  assert.ok(!connected.isError, JSON.stringify(connected.content));
  await inspector.pause();
  await call('pcsx2_import_symbols');
  const line = (await fs.readFile(path.join(fixture, 'standalone.c'), 'utf8')).split(/\r?\n/).findIndex(v => v.includes('/* MCP_TICK:')) + 1;
  assert.ok(line > 0);
  const control = await install(line);
  let history = await inspector.readEvents(0, 200);
  while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
  await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: history.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  assert.ok(control.addresses.includes((await inspector.getStatus()).pc));
  passed('separate native debugger process and exact ELF/source group stop genuine homebrew execution');
  const before = await state();
  await call('pcsx2_remove_source_breakpoints', { group_id: control.group_id });
  assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  assert.deepEqual(await inspector.getStatus(), before.cpu);
  assert.deepEqual(await inspector.getCapabilities(), before.identity);
  passed('an unchanged owned source group is fully removed without resuming or changing native identity');
  const group = await install(line), points = await inspector.listBreakpoints('ee');
  assert.equal(points.length, group.addresses.length);
  const marker = 'MCP source group ' + group.group_id;
  assert.ok(points.every(v => group.addresses.includes(v.address) && v.description === marker));
  report.gui_group = group; report.gui_target = group.addresses[0]; report.gui_description = 'GUI-OWNED';
  report.before_gui = await state();
  passed('a fresh owned group is paused and ready for a stable manual GUI edit, with no timed editing race');
  if (preflight) {
    report.passed = true;
    await phase('preflight_only_not_gui_accepted');
  } else {
    await phase('awaiting_gui_edit');
    const deadline = Date.now() + 20 * 60 * 1000;
    let sequence = 0;
    while (Date.now() < deadline && !report.gui_accepted) {
      assert.equal(child.exitCode, null, 'Owned emulator closed during guided test');
      let command;
      try { command = JSON.parse(await fs.readFile(controlPath, 'utf8')); }
      catch { await delay(250); continue; }
      if (!Number.isInteger(command.sequence) || command.sequence <= sequence) { await delay(250); continue; }
      sequence = command.sequence;
      if (command.action === 'stop') { await phase('stopped_without_gui_acceptance'); break; }
      if (command.action !== 'verify' || command.confirmed_gui_edit !== true) {
        await phase('awaiting_gui_edit', { last_control_error: 'verify requires explicit confirmed_gui_edit=true' }); continue;
      }
      const observed = await state();
      assert.deepEqual(observed.identity, report.before_gui.identity, 'Native identity changed during manual editing');
      assert.deepEqual(observed.cpu, report.before_gui.cpu, 'VM moved during manual editing');
      const point = observed.points.find(v => v.address === report.gui_target && v.description === 'GUI-OWNED');
      if (!point) {
        report.attempts.push({ sequence, state: observed, accepted: false, reason: 'expected GUI description not observed; no cleanup attempted' });
        await phase('awaiting_gui_edit'); continue;
      }
      assert.equal(observed.points.length, group.addresses.length);
      assert.ok(observed.points.every(v => group.addresses.includes(v.address)));
      assert.ok(observed.points.filter(v => v.address !== report.gui_target).every(v => v.description === marker));
      report.operator_confirmed_gui_edit = true; report.gui_point = point;
      const reply = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
      assert.equal(reply.isError, true, 'A changed GUI breakpoint must not report complete cleanup');
      const payload = JSON.parse(reply.content[0].text);
      assert.match(payload.error, /changed ownership and were preserved/);
      assert.equal(payload.cleanup.complete, false);
      assert.deepEqual(payload.cleanup.preserved_addresses, [report.gui_target]);
      assert.deepEqual([...payload.cleanup.removed_addresses].sort(), group.addresses.filter(v => v !== report.gui_target).sort());
      report.cleanup_reply = payload;
      assert.deepEqual(await inspector.listBreakpoints('ee'), [point]);
      assert.deepEqual(await inspector.getStatus(), observed.cpu);
      assert.deepEqual(await inspector.getCapabilities(), observed.identity);
      passed('native source cleanup preserves the operator-confirmed GUI replacement and removes only unchanged owned points');
      const again = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
      assert.equal(again.isError, true);
      assert.match(JSON.stringify(again.content), /Unknown source breakpoint group/);
      assert.deepEqual(await inspector.listBreakpoints('ee'), [point]);
      assert.deepEqual(await inspector.getStatus(), observed.cpu);
      report.repeat_removal_reply = again;
      passed('repeated removal refuses the retired group without erasing the preserved GUI breakpoint or moving CPU');
      report.gui_accepted = true; report.passed = true;
      await phase('accepted_with_operator_confirmation');
    }
    if (!report.gui_accepted) {
      process.exitCode = 1;
      if (report.phase !== 'stopped_without_gui_acceptance') await phase('expired_without_gui_acceptance');
    }
  }
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  assert.equal(hash(await fs.readFile(elf)), elfHash);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalIni);
} catch (error) {
  report.passed = false; report.failure = String(error); process.exitCode = 1;
  await phase('failed');
} finally {
  inspector.disconnect(); await mcp.close().catch(() => {});
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      await new Promise((ok, no) => {
        const timer = setTimeout(() => no(new Error('Owned debugger did not stop')), 5000);
        child.once('exit', () => { clearTimeout(timer); ok(); }); child.kill();
      });
    } catch (error) { report.passed = false; report.cleanup_error = String(error); process.exitCode = 1; }
  }
  report.owned_emulator_stopped = !!child?.pid && (child.exitCode !== null || child.signalCode !== null);
  if (!report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
