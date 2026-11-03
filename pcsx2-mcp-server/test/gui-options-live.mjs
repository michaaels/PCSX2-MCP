// node test/gui-options-live.mjs <PCSX2> <standalone fixture> <configured root> <new output> [--preflight]
// Opens the native debugger; only the operator edits the GUI. No UI automation.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
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
for (const name of ['standalone.c', 'Makefile']) {
  const source = fileURLToPath(new URL('fixtures/standalone/' + name, import.meta.url));
  assert.deepEqual(await fs.readFile(path.join(fixture, name)), await fs.readFile(source), 'Fixture source differs: ' + name);
}
const originalIni = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), originalIni);
const elf = path.join(fixture, 'standalone.elf'), elfHash = manifest.sha256['standalone.elf'];
const server = createServer();
await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
const port = server.address().port;
await new Promise(ok => server.close(ok));
const inspector = new DebugServerClient('127.0.0.1', port);
const mcp = new Client({ name: 'qt-point-options', version: '1.0' });
const report = { kind: 'real_qt_point_options_ownership', executable, elf, elf_sha256: elfHash,
  native_sha256: hash(await fs.readFile(executable)), debug_port: port, data_directory: root,
  started_at: new Date().toISOString(), checks: [], attempts: [], cases: [], preflight, passed: false,
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
    ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0),
    ram: await inspector.readMemory('0x00100000', 256),
    points: await inspector.listBreakpoints('ee') };
}
function unchangedMachine(actual, expected) {
  for (const key of ['identity', 'cpu', 'ee', 'iop', 'ram']) assert.deepEqual(actual[key], expected[key], key + ' moved');
}
async function screenshot(name) {
  const reply = await raw('pcsx2_application_screenshot', { target: 'debugger' });
  assert.ok(!reply.isError, JSON.stringify(reply));
  const image = reply.content.find(value => value.type === 'image');
  assert.ok(image && image.mimeType === 'image/png');
  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await fs.writeFile(path.join(output, name + '.png'), bytes, { flag: 'wx' });
  return { file: name + '.png', sha256: hash(bytes) };
}
let child, log, transport;
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
  transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  transport.stderr?.resume();
  await mcp.connect(transport); report.mcp_pid = transport.pid;
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
  let sequence = 0;
  for (const edit of [
    { name: 'condition', fields: { has_condition: true, condition: 't0 == 0x42' } },
    { name: 'logging', fields: { instrumentation_enabled: true, log_format: 'GUI-LOG-S4' } },
    { name: 'max_hits', fields: { max_hits: 2 } },
  ]) {
    const group = await install(line), points = await inspector.listBreakpoints('ee');
    assert.equal(points.length, group.addresses.length);
    const marker = 'MCP source group ' + group.group_id;
    assert.ok(points.every(v => group.addresses.includes(v.address) && v.description === marker));
    const target = group.addresses[0], original = points.find(v => v.address === target);
    assert.equal(original.options_available, true);
    const before = await state();
    const entry = { name: edit.name, group, target, marker, before, expected_point: { ...original, ...edit.fields }, accepted: false };
    report.cases.push(entry);
    report.gui_target = target; report.gui_case = edit.name; report.expected_point = entry.expected_point;
    await phase('awaiting_gui_edit');
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline && !entry.accepted && !entry.preflight_checked) {
      assert.equal(child.exitCode, null, 'Owned emulator closed during Qt test');
      let command;
      try { command = preflight ? { sequence: sequence + 1, action: 'verify', confirmed_gui_edit: true,
        actor: 'negative-control', case: edit.name } : JSON.parse(await fs.readFile(controlPath, 'utf8')); }
      catch { await delay(250); continue; }
      if (!Number.isInteger(command.sequence) || command.sequence <= sequence) { await delay(250); continue; }
      sequence = command.sequence;
      if (command.action === 'stop') throw new Error('Stopped without matrix acceptance');
      if (command.action !== 'verify' || command.confirmed_gui_edit !== true ||
          !(preflight ? command.actor === 'negative-control' : ['human', 'computer-use'].includes(command.actor)) || command.case !== edit.name) {
        await phase('awaiting_gui_edit', { last_control_error: 'verify requires case, actor and explicit Qt attestation' }); continue;
      }
      const observed = await state(); unchangedMachine(observed, before);
      const point = observed.points.find(v => v.address === target);
      if (!isDeepStrictEqual(point, entry.expected_point)) {
        report.attempts.push({ sequence, case: edit.name, state: observed, accepted: false, reason: 'exact single-option edit not observed; no cleanup attempted' });
        if (preflight) {
          assert.deepEqual(observed, before, 'Negative verification mutated state');
          assert.deepEqual(await state(), before);
          entry.preflight_checked = true;
          entry.cleanup_after_rejection = await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
          const cleaned = await state(); unchangedMachine(cleaned, before); assert.deepEqual(cleaned.points, []);
          passed(edit.name + ' negative control refuses acceptance/cleanup without an observed Qt edit; unchanged source group subsequently removes completely');
          break;
        }
        await phase('awaiting_gui_edit'); continue;
      }
      assert.equal(preflight, false, 'Negative control unexpectedly matched a real Qt edit');
      assert.deepEqual(observed.points.filter(v => v.address !== target), points.filter(v => v.address !== target));
      entry.observed = observed; entry.actor = command.actor;
      entry.screenshot = await screenshot(edit.name + '-before-cleanup');
      unchangedMachine(await state(), before);
      const reply = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
      assert.equal(reply.isError, true);
      const payload = JSON.parse(reply.content[0].text);
      assert.match(payload.error, /changed ownership and were preserved/);
      assert.equal(payload.cleanup.complete, false);
      assert.deepEqual(payload.cleanup.preserved_addresses, [target]);
      assert.deepEqual([...payload.cleanup.removed_addresses].sort(), group.addresses.filter(v => v !== target).sort());
      entry.cleanup_reply = payload;
      const after = await state(); unchangedMachine(after, before); assert.deepEqual(after.points, [point]);
      const again = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
      assert.equal(again.isError, true); assert.match(JSON.stringify(again.content), /Unknown source breakpoint group/);
      entry.repeat_removal_reply = again;
      const repeated = await state(); unchangedMachine(repeated, before); assert.deepEqual(repeated.points, [point]);
      entry.after = repeated; entry.accepted = true;
      passed('real Qt ' + edit.name + ' edit alone preserves original marker; cleanup preserves exact point and repeat removal refuses without CPU/identity/RAM movement');
      // Explicit cleanup of this disposable test point, after preservation proof.
      await inspector.removeBreakpoint(target);
      const cleaned = await state(); unchangedMachine(cleaned, before); assert.deepEqual(cleaned.points, []);
    }
    assert.equal(preflight ? entry.preflight_checked : entry.accepted, true, 'Qt case expired without verified edit');
  }
  report.gui_accepted = !preflight; report.operator_confirmed_gui_edit = !preflight;
  report.GUI_automated = !preflight && report.cases.every(entry => entry.actor === 'computer-use');
  report.passed = true; await phase(preflight ? 'preflight_only_not_gui_accepted' : 'accepted_real_qt_options');
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  assert.equal(hash(await fs.readFile(elf)), elfHash);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalIni);
} catch (error) {
  report.passed = false; report.failure = String(error); process.exitCode = 1;
  await phase('failed');
} finally {
  inspector.disconnect();
  try { await mcp.close(); report.mcp_stopped = !transport || transport.pid === null; }
  catch (error) { report.mcp_stopped = false; report.mcp_cleanup_error = String(error); }
  if (!report.mcp_stopped) { report.passed = false; process.exitCode = 1; }
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
