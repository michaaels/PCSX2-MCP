// Actual debugger docking through two MCP peers, with an independently paused VM.
// node test/ui-docking-live.mjs <PCSX2> <instruction fixture> <configured root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6);
const [executable, input, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output); const fixture = path.join(output, 'fixture'), root = path.join(output, 'instance');
await fs.cp(input, fixture, { recursive: true }); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8')); assert.equal(manifest.kind, 'standalone_instruction_fixture');
for (const [name, digest] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), digest); }
for (const name of ['build.sh', 'ee-instructions.c', 'iop-instructions.c', 'instructions.S', 'Makefile.ee', 'Makefile.iop'])
  assert.deepEqual(await fs.readFile(path.join(fixture, name)), await fs.readFile(fileURLToPath(new URL('fixtures/instruction-control/' + name, import.meta.url))));
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8');
for (const [section, key, value] of [['EmuCore', 'HostFs', 'true'], ['EmuCore', 'EnablePINE', 'false'], ['AutoUpdater', 'CheckAtStartup', 'false'], ['Debugger/UserInterface', 'LayoutLocked', 'true']]) {
  ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), ''); const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
}
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const n = s.address().port; await new Promise(ok => s.close(ok)); return n; }
const debugPort = await port(), uiPort = await port(); assert.notEqual(debugPort, uiPort);
const elf = path.join(fixture, 'instruction-control.elf'), inspector = new DebugServerClient('127.0.0.1', debugPort);
function symbol(b, name) {
  const offset = b.readUInt32LE(32), stride = b.readUInt16LE(46), count = b.readUInt16LE(48);
  for (let i = 0; i < count; ++i) { const h = offset + i * stride; if (b.readUInt32LE(h + 4) !== 2) continue;
    const strings = b.readUInt32LE(offset + b.readUInt32LE(h + 24) * stride + 16), end = b.readUInt32LE(h + 16) + b.readUInt32LE(h + 20), step = b.readUInt32LE(h + 36); assert.ok(step >= 16);
    for (let at = b.readUInt32LE(h + 16); at < end; at += step) { const start = strings + b.readUInt32LE(at); if (b.subarray(start, b.indexOf(0, start)).toString() === name) return b.readUInt32LE(at + 4); }
  }
  throw new Error('Missing fixture symbol ' + name);
}
const report = { kind: 'actual_mcp_debugger_docking', actor: 'mcp_qt_ui', executable, native_sha256: hash(await fs.readFile(executable)),
  elf, data_directory: root, checks: [], actions: [], placements: [], passed: false, Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const peers = []; let native, log, watchdog, last;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function peer(name) { const client = new Client({ name, version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume();
  const p = { client, transport }; peers.push(p); await client.connect(transport);
  await call(p, 'connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); return p; }
async function raw(p, name, args = {}) { return p.client.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 15000 }); }
async function call(p, name, args = {}) { const r = await raw(p, name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content.find(c => c.type === 'text').text); }
async function snap(p, window_id) { last = await call(p, 'snapshot', { max_nodes: 5000, max_items: 128, ...(window_id ? { window_id } : {}) }); return last; }
function one(s, predicate) { const a = s.controls.filter(predicate); assert.equal(a.length, 1, JSON.stringify(a)); return a[0]; }
function dock(s, name) { const a = s.dock_targets.filter(c => c.dock.unique_name === name); assert.equal(a.length, 1, JSON.stringify(s.dock_targets)); return a[0]; }
async function action(p, s, target, input, failure) {
  const q = await call(p, 'action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  const state = await call(p, 'action_status', { action_id: q.action.action_id, wait_ms: 2000 }); report.actions.push({ target, input, receipt: state.action });
  assert.equal(state.action.state, failure ? 'failed' : 'completed', JSON.stringify(state)); if (failure) assert.match(state.action.error, failure);
  await delay(150); return state.action;
}
async function until(p, predicate, window_id) { for (let i = 0; ; ++i) { const s = await snap(p, window_id); if (predicate(s)) return s; assert.ok(i < 100, JSON.stringify(s.windows)); await delay(25); } }
async function panel(p, name) {
  let s = await snap(p), entry = dock(s, name); s = await snap(p, entry.window_id);
  let c = one(s, c => c.dock?.unique_name === name);
  if (!c.visible) {
    const tabs = one(s, c => c.visible && c.tabs?.some(t => t.text === entry.dock.title));
    await action(p, s, tabs, { action: 'select_index', index: tabs.tabs.find(t => t.text === entry.dock.title).index }); s = await snap(p, entry.window_id); c = one(s, c => c.dock?.unique_name === name); assert.ok(c.visible);
  }
  return { s, c };
}
async function float(p, name, value) { const { s, c } = await panel(p, name); return action(p, s, c, { action: 'set_floating', floating: value }); }
async function place(p, name, target, location) { const { s, c } = await panel(p, name); return action(p, s, c, { action: 'dock', dock_target_id: dock(s, target).id, dock_location: location }); }
async function machine() { return { identity: await inspector.getCapabilities(), status: await inspector.getStatus(), ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0),
  ram: await inspector.readMemoryStrict('0x00100000', 256), iop_ram: await inspector.readMemoryStrict('0x00010000', 256, 'iop'), ee_points: await inspector.listBreakpoints('ee'), iop_points: await inspector.listBreakpoints('iop') }; }
async function capture(p, s, name) { const r = await raw(p, 'screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!r.isError, JSON.stringify(r.content.filter(c => c.type === 'text')));
  const meta = JSON.parse(r.content.find(c => c.type === 'text').text); assert.equal(meta.capture_method, 'qt_widget_render'); const b = Buffer.from(r.content.find(c => c.type === 'image').data, 'base64'), png = PNG.sync.read(b);
  assert.ok(png.width > 100 && png.height > 100); await fs.writeFile(path.join(output, name + '.png'), b, { flag: 'wx' }); return { sha256: hash(b), width: png.width, height: png.height }; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable', '-debugger', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(debugPort), PCSX2_UI_PORT: String(uiPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { inspector.disconnect(); native.kill(); for (const p of peers) p.transport.close().catch(() => {}); }, 180000); watchdog.unref();
  for (let i = 0; ; ++i) { try { await inspector.connect(); await inspector.getCapabilities(); break; } catch (e) { inspector.disconnect(); assert.ok(i < 150 && native.exitCode === null, String(e)); await delay(100); } }
  for (let i = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; ++i) { assert.ok(i < 200, 'Owned ELF did not boot'); await delay(100); }
  await inspector.pause();
  // Prepare the fixture at its known ready point; no guest instructions run
  // during the subsequent docking checks.
  const ready = '0x' + symbol(await fs.readFile(elf), 'instruction_ready').toString(16).padStart(8, '0');
  await inspector.setBreakpoint(ready); let history = await inspector.readEvents(0, 200);
  while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: history.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  assert.equal((await inspector.getStatus()).pc, ready); await inspector.removeBreakpoint(ready);
  const caps = await inspector.getCapabilities(); assert.equal(caps.process_id, native.pid); assert.equal(caps.data_directory, root); assert.notEqual(caps.elf_crc, '0x00000000');
  const owner = await peer('docking-owner'), actor = await peer('docking-actor');
  report.identity = (await call(owner, 'status')).identity; assert.deepEqual((await call(actor, 'status')).identity, report.identity);
  assert.ok((await call(owner, 'status')).features.includes('qt_debugger_docking'));
  let s = await until(owner, v => v.windows.some(w => w.class === 'DebuggerWindow'));
  const debuggerID = s.windows.find(w => w.class === 'DebuggerWindow').window_id; s = await snap(owner, debuggerID);
  const registers = s.dock_targets.find(c => /Registers/.test(c.dock.title) && c.visible && c.dock.in_main_window && c.dock.group.length > 1); assert.ok(registers, JSON.stringify(s.dock_targets));
  const originalGroup = registers.dock.group, sourceName = originalGroup.at(-1);
  const destination = s.dock_targets.find(c => /Disassembly/.test(c.dock.title) && c.visible && c.dock.in_main_window && !originalGroup.includes(c.dock.unique_name)); assert.ok(destination);
  const destinationName = destination.dock.unique_name, destinationGroup = destination.dock.group; report.source_name = sourceName; report.destination_name = destinationName; report.original_group = originalGroup;
  ({ s } = await panel(owner, sourceName)); const baseline = await machine(); assert.equal(baseline.status.paused, true); report.baseline = baseline;
  passed('actual paused owned fixture exposes scoped debugger dock targets to two real MCP peers');
  const source = one(s, c => c.dock?.unique_name === sourceName); assert.equal(source.dock.layout_locked, true);
  await action(owner, s, source, { action: 'set_floating', floating: true }, /layout is locked/); assert.deepEqual(await machine(), baseline);
  s = await snap(owner, debuggerID); assert.deepEqual(dock(s, sourceName).dock.group, originalGroup);
  passed('locked debugger layout refuses detachment without changing panel grouping, CPUs, RAM or native identity');
  s = await snap(owner, debuggerID); await action(owner, s, one(s, c => c.class === 'QPushButton' && c.checkable && /Layout Locked/.test(c.text)), { action: 'set_checked', checked: false });
  await float(owner, sourceName, true); let detached = await panel(owner, sourceName); assert.equal(detached.c.dock.floating, true); assert.equal(detached.c.dock.in_floating_window, true); assert.notEqual(detached.s.window_id, debuggerID);
  report.detached_png = await capture(owner, detached.s, 'detached'); assert.deepEqual(await machine(), baseline);
  await float(owner, sourceName, false); s = await snap(owner, debuggerID); assert.equal(dock(s, sourceName).dock.in_main_window, true); assert.deepEqual(dock(s, sourceName).dock.group, originalGroup); assert.deepEqual(await machine(), baseline);
  passed('MCP detaches a real debugger panel into its own captured Qt window and restores its previous group without guest execution');
  let current = await panel(owner, sourceName); const bad = await raw(owner, 'action', { snapshot_id: current.s.snapshot_id, control_id: current.c.id, action: 'dock', dock_target_id: 'd999', dock_location: 'tab' }); assert.equal(bad.isError, true);
  await action(owner, current.s, current.c, { action: 'dock', dock_target_id: dock(current.s, sourceName).id, dock_location: 'tab' }, /itself/); assert.deepEqual(await machine(), baseline);
  passed('unknown destination refuses without consuming the snapshot; self-docking refuses without moving the paused fixture');
  for (const side of ['left', 'right', 'top', 'bottom']) {
    await place(owner, sourceName, destinationName, side); s = await snap(owner, debuggerID);
    const a = one(s, c => c.dock?.unique_name === sourceName), b = one(s, c => c.dock?.unique_name === destinationName); assert.ok(a.visible && b.visible);
    const ar = a.bounds_in_window, br = b.bounds_in_window;
    if (side === 'left') assert.ok(ar.x + ar.width <= br.x + 4);
    if (side === 'right') assert.ok(br.x + br.width <= ar.x + 4);
    if (side === 'top') assert.ok(ar.y + ar.height <= br.y + 4);
    if (side === 'bottom') assert.ok(br.y + br.height <= ar.y + 4);
    report.placements.push({ side, source: ar, destination: br }); assert.deepEqual(await machine(), baseline);
    const restoreTarget = s.dock_targets.find(c => c.visible && originalGroup.includes(c.dock.unique_name) && c.dock.unique_name !== sourceName); assert.ok(restoreTarget);
    await place(owner, sourceName, restoreTarget.dock.unique_name, 'tab'); s = await snap(owner, debuggerID); assert.deepEqual(dock(s, sourceName).dock.group, originalGroup);
  }
  passed('all four relative sides produce actual nonoverlapping Qt panel geometry and restore original group order with both CPUs/RAM unchanged');
  await float(owner, sourceName, true); const old = await panel(owner, sourceName);
  await float(actor, destinationName, true);
  await action(owner, old.s, old.c, { action: 'dock', dock_target_id: dock(old.s, destinationName).id, dock_location: 'tab' }, /Dock target changed/);
  assert.deepEqual(await machine(), baseline);
  s = await snap(owner); assert.equal(dock(s, sourceName).dock.floating, true); assert.equal(dock(s, destinationName).dock.floating, true);
  passed('a second actual Qt peer changes the destination window and the old placement refuses before mutating either detached panel');
  const peerSnapshot = await panel(actor, sourceName);
  await place(owner, sourceName, destinationName, 'left'); s = await snap(owner);
  const split = dock(s, sourceName), splitTarget = dock(s, destinationName); assert.equal(split.window_id, splitTarget.window_id); assert.equal(split.dock.in_floating_window, true); assert.equal(split.dock.in_main_window, false); assert.notDeepEqual(split.dock.group, splitTarget.dock.group);
  const splitPanel = await panel(owner, sourceName), splitSource = one(splitPanel.s, c => c.dock?.unique_name === sourceName), splitDestination = one(splitPanel.s, c => c.dock?.unique_name === destinationName);
  assert.ok(splitSource.bounds_in_window.x + splitSource.bounds_in_window.width <= splitDestination.bounds_in_window.x + 4);
  report.split_png = await capture(owner, splitPanel.s, 'split-floating'); assert.deepEqual(await machine(), baseline);
  passed('cross-window side docking produces a real split floating window with separate groups and unchanged paused machine state');
  await place(owner, sourceName, destinationName, 'tab'); s = await snap(owner); const combined = dock(s, sourceName), combinedTarget = dock(s, destinationName);
  assert.equal(combined.window_id, combinedTarget.window_id); assert.equal(combined.dock.in_main_window, false); assert.equal(combined.dock.in_floating_window, true); assert.equal(combined.dock.floating, false); assert.ok(combined.dock.group.includes(destinationName));
  const combinedPanel = await panel(owner, sourceName); report.combined_png = await capture(owner, combinedPanel.s, 'combined-floating'); assert.deepEqual(await machine(), baseline);
  await action(actor, peerSnapshot.s, peerSnapshot.c, { action: 'set_floating', floating: false }, /destroyed|changed window/); assert.deepEqual(await machine(), baseline);
  passed('MCP tabs a panel into another floating window; grouped-floating state is distinct and stale source-window handles cannot act');
  s = await snap(owner); const restore = s.dock_targets.find(c => c.visible && originalGroup.includes(c.dock.unique_name) && c.dock.unique_name !== sourceName); assert.ok(restore);
  await place(owner, sourceName, restore.dock.unique_name, 'tab'); await float(owner, destinationName, false); s = await snap(owner, debuggerID);
  assert.deepEqual(dock(s, sourceName).dock.group, originalGroup); assert.deepEqual(dock(s, destinationName).dock.group, destinationGroup);
  assert.ok(s.dock_targets.every(c => c.dock.in_main_window));
  let modalSetup = await snap(actor); const mainID = modalSetup.windows.find(w => w.class === 'MainWindow').window_id;
  modalSetup = await snap(actor, mainID); const aboutAction = one(modalSetup, c => c.object_name === 'actionAbout');
  const about = await call(actor, 'action', { snapshot_id: modalSetup.snapshot_id, control_id: aboutAction.id, action: 'trigger' });
  const modal = await until(actor, v => v.windows.some(w => w.class === 'AboutDialog') && v.controls.some(c => c.class === 'AboutDialog'));
  const blocked = await panel(owner, sourceName); await action(owner, blocked.s, blocked.c, { action: 'set_floating', floating: true }, /modal|disabled/); assert.deepEqual(await machine(), baseline);
  await action(actor, modal, one(modal, c => c.class === 'AboutDialog'), { action: 'close' });
  assert.equal((await call(actor, 'action_status', { action_id: about.action.action_id, wait_ms: 1000 })).action.state, 'completed');
  s = await snap(owner, debuggerID); assert.deepEqual(dock(s, sourceName).dock.group, originalGroup);
  passed('an actual blocking Qt dialog prevents docking; closing it restores normal service without moving the paused fixture');
  await action(owner, s, one(s, c => c.class === 'QPushButton' && c.checkable && /Layout Unlocked/.test(c.text)), { action: 'set_checked', checked: true });
  s = await snap(owner, debuggerID); assert.ok(s.dock_targets.every(c => c.dock.layout_locked)); report.restored_png = await capture(owner, s, 'restored'); assert.deepEqual(await machine(), baseline);
  assert.deepEqual((await call(owner, 'status')).identity, report.identity); assert.deepEqual((await call(actor, 'status')).identity, report.identity);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('original panel groups and layout lock restore; final debugger PNG, UI identities, configured source INI and native binary remain intact');
  // Separately test running semantics. Guest execution is intentional here;
  // the exact paused-state equality checks above remain independently required.
  s = await snap(owner, debuggerID); await action(owner, s, one(s, c => c.class === 'QPushButton' && /Layout Locked/.test(c.text)), { action: 'set_checked', checked: false });
  await inspector.resume(); await delay(100); const runningBefore = await inspector.getStatus(); assert.equal(runningBefore.paused, false);
  await float(owner, sourceName, true); const during = await inspector.getStatus(); assert.equal(during.paused, false);
  await float(owner, sourceName, false); const runningAfter = await inspector.getStatus(); assert.equal(runningAfter.paused, false); assert.notEqual(runningAfter.cycles, runningBefore.cycles);
  const runningIdentity = await inspector.getCapabilities(); for (const key of ['process_id', 'session', 'execution_epoch', 'iop_lifetime_epoch', 'elf', 'elf_crc', 'data_directory']) assert.equal(runningIdentity[key], baseline.identity[key]);
  await inspector.pause(); const recovered = await machine(); assert.equal(recovered.status.paused, true); assert.deepEqual(recovered.ee_points, baseline.ee_points); assert.deepEqual(recovered.iop_points, baseline.iop_points);
  s = await snap(owner, debuggerID); assert.deepEqual(dock(s, sourceName).dock.group, originalGroup); assert.deepEqual(dock(s, destinationName).dock.group, destinationGroup);
  await action(owner, s, one(s, c => c.class === 'QPushButton' && /Layout Unlocked/.test(c.text)), { action: 'set_checked', checked: true });
  s = await snap(owner, debuggerID); report.running_restored_png = await capture(owner, s, 'running-restored'); assert.deepEqual(await machine(), recovered);
  report.running = { before: runningBefore, detached: during, restored: runningAfter, identity: runningIdentity, recovered };
  assert.deepEqual((await call(owner, 'status')).identity, report.identity); assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('actual running guest continues executing through detachment/restoration without forced pause or identity reset, then recovers to a stable paused state'); report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; console.error(e.stack);
  if (last) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(last, null, 2)); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); inspector.disconnect(); for (const p of peers) await p.client.close().catch(e => { report.cleanup_error = String(e); });
  report.mcp_sessions = peers.map(p => ({ stopped: p.transport.pid === null })); report.mcp_stopped = report.mcp_sessions.every(p => p.stopped);
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
