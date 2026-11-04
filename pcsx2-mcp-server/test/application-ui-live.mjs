// Real MCP -> Qt widget/action -> native-state cross-checks. No Computer Use.
// node test/application-ui-live.mjs <PCSX2> <standalone fixture> <configured root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6);
const [executable, fixture, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const browse = path.join(output, 'browse'); await fs.mkdir(path.join(browse, 'child'), { recursive: true });
await fs.writeFile(path.join(browse, 'child/marker.txt'), 'Owned UI tree fixture\n', { flag: 'wx' });
const hash = b => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
for (const [name, sha] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha); }
for (const name of ['standalone.c', 'Makefile']) assert.deepEqual(await fs.readFile(path.join(fixture, name)), await fs.readFile(fileURLToPath(new URL('fixtures/standalone/' + name, import.meta.url))));
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
let ini = originalINI.toString('utf8');
function setting(section, key, value) {
  ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), '');
  const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
}
setting('UI', 'ShowAdvancedSettings', 'true'); setting('UI', 'AdvancedSettingsWarningShown', 'true'); setting('EmuCore', 'EnablePINE', 'false');
setting('AutoUpdater', 'CheckAtStartup', 'false');
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function freePort() { const s = createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(0, '127.0.0.1', ok); }); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await freePort(), debugPort = await freePort(); assert.notEqual(uiPort, debugPort);
const inspector = new DebugServerClient('127.0.0.1', debugPort), mcp = new Client({ name: 'real-qt-ui-live', version: '1.0' });
const elf = path.join(fixture, 'standalone.elf'), elfHash = manifest.sha256['standalone.elf'];
const report = { kind: 'real_mcp_qt_gui_control', executable, native_sha256: hash(await fs.readFile(executable)),
  elf, elf_sha256: elfHash, data_directory: root, ui_port: uiPort, debug_port: debugPort,
  actor: 'mcp_qt_ui', started_at: new Date().toISOString(), checks: [], ui_actions: [], qt_options: [], passed: false,
  Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, log, transport, watchdog, lastSnapshot, watchdogExpired = false;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 20000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, name + ': ' + JSON.stringify(r.content)); return JSON.parse(r.content.find(c => c.type === 'text').text); }
async function snap(options = {}) { lastSnapshot = await call('pcsx2_ui_snapshot', { max_nodes: 5000, max_items: 256, ...options }); return lastSnapshot; }
async function waitSnapshot(predicate, options = {}, milliseconds = 8000) {
  const deadline = performance.now() + milliseconds;
  for (;;) { const s = await snap(options); if (predicate(s)) return s; assert.ok(performance.now() < deadline, 'Qt snapshot predicate expired: ' + JSON.stringify(s.windows)); await delay(25); }
}
function unique(snapshot, predicate) { const rows = snapshot.controls.filter(predicate); assert.equal(rows.length, 1, 'Expected one UI target: ' + JSON.stringify(rows)); return rows[0]; }
async function action(snapshot, target, input, wait = true, expectedFailure = false) {
  assert.ok(target.actions.includes(input.action), 'Action absent from observed target');
  const r = await call('pcsx2_ui_action', { snapshot_id: snapshot.snapshot_id, control_id: target.id, ...input });
  assert.equal(r.action.state, 'queued');
  const entry = { control: target, input, queued: r.action }; report.ui_actions.push(entry);
  if (wait) {
    const status = await call('pcsx2_ui_action_status', { action_id: r.action.action_id, wait_ms: 1000 });
    entry.status = status.action; assert.equal(status.action.state, 'completed', JSON.stringify(status));
  } else {
    const status = await call('pcsx2_ui_action_status', { action_id: r.action.action_id });
    entry.status = status.action;
    if (!expectedFailure && ['failed', 'expired'].includes(status.action.state)) throw new Error('Qt action failed: ' + JSON.stringify(status.action));
  }
  return r.action.action_id;
}
async function capture(snapshot, name) {
  const r = await raw('pcsx2_ui_screenshot', { snapshot_id: snapshot.snapshot_id, window_id: snapshot.window_id });
  assert.ok(!r.isError); const image = r.content.find(c => c.type === 'image'); assert.ok(image && image.mimeType === 'image/png');
  const metadata = JSON.parse(r.content.find(c => c.type === 'text').text);
  const b = Buffer.from(image.data, 'base64'), decoded = PNG.sync.read(b);
  if (snapshot.controls.some(c => c.kind === 'surface')) {
    assert.equal(metadata.capture_method, 'd3d11_present_buffer_with_imgui');
    const colors = new Set();
    for (let i = 0; i < decoded.data.length; i += 4) colors.add(decoded.data.readUInt32LE(i));
    assert.ok(colors.size > 32, 'Rendered UI must contain actual varied content, not a black capture');
  }
  assert.ok(decoded.width > 0 && decoded.height > 0); await fs.writeFile(path.join(output, name + '.png'), b, { flag: 'wx' });
  return { file: name + '.png', sha256: hash(b), width: decoded.width, height: decoded.height, capture_method: metadata.capture_method };
}
async function machine() { return { identity: await inspector.getCapabilities(), status: await inspector.getStatus(),
  ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0), ram: await inspector.readMemory('0x00100000', 256) }; }
async function closedPort(port) { return new Promise(resolve => { const s = createConnection({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => { s.destroy(); resolve(true); }); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); }); }

try {
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { watchdogExpired = true; inspector.disconnect(); transport?.close().catch(() => {}); native?.kill(); }, 240000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort) }, stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  const tools = (await mcp.listTools()).tools.filter(t => t.name.startsWith('pcsx2_ui_')); assert.equal(tools.length, 7); assert.equal(new Set(tools.map(t => t.name)).size, 7);
  passed('actual MCP discovers seven independent Qt GUI tools');
  for (let n = 0; ; ++n) { const r = await raw('pcsx2_ui_connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); if (!r.isError) { report.ui_identity = JSON.parse(r.content[0].text).identity; break; } assert.ok(n < 150 && native.exitCode === null, JSON.stringify(r)); await delay(100); }
  assert.equal(await closedPort(debugPort), true);
  let s = await snap(); assert.ok(s.windows.some(w => w.class === 'MainWindow')); const mainID = s.windows.find(w => w.class === 'MainWindow').window_id;
  report.before_boot = { identity: report.ui_identity, screenshot: await capture(s, 'before-boot') };
  passed('Qt GUI identity, menu/widget inventory and real PNG work before any VM/DebugServer starts');
  const disabled = unique(s, c => c.object_name === 'actionPowerOff'); assert.equal(disabled.enabled, false);
  const disabledID = await action(s, disabled, { action: 'trigger' }, false, true);
  assert.equal((await call('pcsx2_ui_action_status', { action_id: disabledID, wait_ms: 1000 })).action.state, 'failed');
  assert.equal(await closedPort(debugPort), true);
  passed('disabled shutdown action is refused without starting or changing a VM');
  s = await snap({ window_id: mainID });
  const about = unique(s, c => c.object_name === 'actionAbout'); const oldSnapshot = s;
  await action(s, about, { action: 'trigger' }, false);
  s = await waitSnapshot(v => v.windows.some(w => /AboutDialog/.test(w.class)) && v.controls.some(c => c.class === 'AboutDialog'));
  report.about = await capture(s, 'about');
  assert.equal((await raw('pcsx2_ui_action', { snapshot_id: oldSnapshot.snapshot_id, control_id: about.id, action: 'trigger' })).isError, true);
  const dialog = unique(s, c => c.class === 'AboutDialog'); await action(s, dialog, { action: 'close' });
  passed('menu action opens an actual Qt dialog; modal PNG and close work, and consumed snapshot replay refuses');
  s = await snap({ window_id: mainID }); await action(s, unique(s, c => c.object_name === 'searchText'), { action: 'set_text', text: 'MCP GUI test' });
  s = await snap({ window_id: mainID }); assert.equal(unique(s, c => c.object_name === 'searchText').text, 'MCP GUI test');
  await action(s, unique(s, c => c.object_name === 'searchText'), { action: 'key', key: 'Ctrl+A' });
  s = await snap({ window_id: mainID }); await action(s, unique(s, c => c.object_name === 'searchText'), { action: 'key', key: 'Backspace' });
  s = await snap({ window_id: mainID }); assert.equal(unique(s, c => c.object_name === 'searchText').text, '');
  passed('Qt text editing, focus/key delivery and actual field readback work without global OS input');
  await action(s, unique(s, c => c.object_name === 'filterType'), { action: 'select_index', index: 1 });
  s = await snap({ window_id: mainID }); assert.equal(unique(s, c => c.object_name === 'filterType').current_index, 1);
  await action(s, unique(s, c => c.object_name === 'filterType'), { action: 'select_index', index: 0 });
  passed('combo selection changes the actual Qt option and restores its original selection');
  s = await snap({ window_id: mainID });
  await action(s, unique(s, c => c.object_name === 'actionViewGameGrid'), { action: 'trigger' });
  s = await snap({ window_id: mainID });
  const slider = unique(s, c => c.class === 'QSlider' && c.visible), oldValue = slider.value;
  const newValue = oldValue === slider.maximum ? slider.minimum : oldValue + 1;
  await action(s, slider, { action: 'set_value', value: newValue });
  s = await snap({ window_id: mainID }); assert.equal(unique(s, c => c.id === slider.id && c.class === 'QSlider').value, newValue);
  await action(s, unique(s, c => c.class === 'QSlider' && c.visible), { action: 'set_value', value: oldValue });
  passed('actual toolbar slider accepts a bounded value and restores its previous value');
  s = await snap({ window_id: mainID }); const startID = await action(s, unique(s, c => c.object_name === 'actionStartFile'), { action: 'trigger' }, false);
  s = await waitSnapshot(v => v.controls.some(c => c.class === 'QFileDialog'));
  assert.equal((await call('pcsx2_ui_action_status', { action_id: startID })).action.state, 'running');
  await action(s, unique(s, c => c.object_name === 'fileNameEdit' && c.class === 'QLineEdit'), { action: 'set_text', text: browse });
  s = await snap(); await action(s, unique(s, c => c.object_name === 'fileNameEdit' && c.class === 'QLineEdit'), { action: 'key', key: 'Return' });
  s = await snap(); await action(s, unique(s, c => c.object_name === 'detailModeButton'), { action: 'click' });
  s = await waitSnapshot(v => v.controls.some(c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child' && c.visible));
  await action(s, unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child'), { action: 'expand' });
  s = await waitSnapshot(v => v.controls.some(c => c.kind === 'model_item' && c.text === 'child' && c.expanded === true));
  await action(s, unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child'), { action: 'collapse' });
  s = await snap(); assert.equal(unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child').expanded, false);
  await action(s, unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child'), { action: 'select' });
  s = await snap();
  await action(s, unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'child'), { action: 'edit_text', text: 'renamed-child' });
  assert.equal((await fs.stat(path.join(browse, 'renamed-child/marker.txt'))).isFile(), true);
  s = await waitSnapshot(v => v.controls.some(c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'renamed-child'));
  await action(s, unique(s, c => c.kind === 'model_item' && c.class === 'QTreeView' && c.text === 'renamed-child'), { action: 'edit_text', text: 'child' });
  assert.equal((await fs.stat(path.join(browse, 'child/marker.txt'))).isFile(), true);
  s = await snap();
  passed('Qt file navigation, actual tree expansion/collapse and model selection operate on an owned directory fixture');
  await action(s, unique(s, c => c.object_name === 'fileNameEdit' && c.class === 'QLineEdit'), { action: 'set_text', text: elf });
  s = await snap(); report.file_picker = await capture(s, 'file-picker');
  await action(s, unique(s, c => c.class === 'QPushButton' && /^&?Open$/.test(c.text ?? '')), { action: 'click' });
  for (let n = 0; ; ++n) { try { await inspector.connect(); const caps = await inspector.getCapabilities(); assert.equal(caps.process_id, native.pid); if (!caps.elf || caps.elf_crc === '0x00000000') throw new Error('Boot pending'); assert.equal(path.normalize(caps.elf.replace(/^host\d*:/, '')), path.normalize(elf)); break; } catch (error) { inspector.disconnect(); if (n > 200) throw error; await delay(100); } }
  assert.equal((await call('pcsx2_ui_action_status', { action_id: startID, wait_ms: 1000 })).action.state, 'completed');
  passed('blocking Qt file dialog remains controllable through MCP and genuinely boots the selected exact ELF');
  await inspector.pause(); assert.ok(!(await raw('pcsx2_connect', { mode: 'debug', debug_port: debugPort })).isError);
  await call('pcsx2_import_symbols');
  const line = (await fs.readFile(path.join(fixture, 'standalone.c'), 'utf8')).split(/\r?\n/).findIndex(v => v.includes('/* MCP_TICK:')) + 1; assert.ok(line > 0);
  const install = () => call('pcsx2_breakpoint_source', { elf, file: 'standalone.c', line, expected_sha256: elfHash });
  async function stopOnGroup(group) {
    let history = await inspector.readEvents(0, 200);
    while (history.events.length === 200) history = await inspector.readEvents(history.next_cursor, 200);
    await inspector.resume();
    assert.equal((await inspector.waitEvent({ after: history.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
    assert.ok(group.addresses.includes((await inspector.getStatus()).pc));
  }
  const initialGroup = await install(); let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.resume(); assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  assert.ok(initialGroup.addresses.includes((await inspector.getStatus()).pc)); await call('pcsx2_remove_source_breakpoints', { group_id: initialGroup.group_id });
  s = await waitSnapshot(v => v.controls.some(c => c.object_name === 'actionDebugger' && c.enabled), { window_id: mainID });
  await action(s, unique(s, c => c.object_name === 'actionDebugger'), { action: 'trigger' }, false);
  s = await waitSnapshot(v => v.windows.some(w => w.class === 'DebuggerWindow'));
  const debuggerID = s.windows.find(w => w.class === 'DebuggerWindow').window_id;
  s = await snap({ window_id: debuggerID });
  const tabs = unique(s, c => c.tabs?.some(t => t.text === 'Breakpoints'));
  await action(s, tabs, { action: 'select_index', index: tabs.tabs.find(t => t.text === 'Breakpoints').index });
  passed('GUI debugger opening and tab selection use real Qt controls on the same paused native fixture');
  for (const edit of [
    { name: 'condition', expected: { has_condition: true, condition: 't0 == 0x42' } },
    { name: 'logging', expected: { instrumentation_enabled: true, log_format: 'GUI-LOG-S4' } },
    { name: 'max_hits', expected: { max_hits: 2 } },
  ]) {
    const group = await install(); await stopOnGroup(group);
    const target = group.addresses[0], points = await inspector.listBreakpoints('ee');
    const original = points.find(p => p.address === target), before = await machine(), marker = 'MCP source group ' + group.group_id;
    assert.equal(original.description, marker);
    s = await waitSnapshot(v => v.controls.some(c => c.kind === 'model_item' && c.text === marker), { window_id: debuggerID });
    const item = unique(s, c => c.kind === 'model_item' && c.text === marker);
    await action(s, item, { action: 'context_menu' }, false);
    s = await waitSnapshot(v => v.controls.some(c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'Edit'));
    await action(s, unique(s, c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'Edit'), { action: 'trigger' }, false);
    s = await waitSnapshot(v => v.controls.some(c => c.class === 'BreakpointDialog'));
    assert.equal(unique(s, c => c.object_name === 'txtDescription').text, marker);
    if (edit.name === 'condition') {
      const check = unique(s, c => c.class === 'QCheckBox' && c.text === 'Enable');
      await action(s, check, { action: 'set_check_state', check_state: 0 });
      s = await snap(); assert.equal(unique(s, c => c.class === 'QCheckBox' && c.text === 'Enable').check_state, 0);
      await action(s, unique(s, c => c.class === 'QCheckBox' && c.text === 'Enable'), { action: 'set_check_state', check_state: 2 });
      s = await snap(); assert.equal(unique(s, c => c.class === 'QCheckBox' && c.text === 'Enable').check_state, 2);
    }
    if (edit.name === 'condition') await action(s, unique(s, c => c.object_name === 'txtCondition'), { action: 'set_text', text: 't0 == 0x42' });
    else if (edit.name === 'logging') {
      await action(s, unique(s, c => c.object_name === 'grpLogWhenHit'), { action: 'set_checked', checked: true });
      s = await snap(); await action(s, unique(s, c => c.object_name === 'txtLogFormat'), { action: 'set_text', text: 'GUI-LOG-S4' });
    } else await action(s, unique(s, c => c.object_name === 'spnMaxHitCount'), { action: 'set_value', value: 2 });
    s = await snap(); assert.equal(unique(s, c => c.object_name === 'txtDescription').text, marker);
    const entry = { name: edit.name, group, before, actor: 'mcp_qt_ui', dialog_png: await capture(s, edit.name + '-dialog') };
    await action(s, unique(s, c => c.class === 'QPushButton' && /^&?OK$/.test(c.text ?? '')), { action: 'click' });
    let point;
    for (let n = 0; ; ++n) { point = (await inspector.listBreakpoints('ee')).find(p => p.address === target); if (Object.entries(edit.expected).every(([k, v]) => point?.[k] === v)) break; assert.ok(n < 100, JSON.stringify(point)); await delay(25); }
    assert.deepEqual(point, { ...original, ...edit.expected }); assert.deepEqual(await machine(), before);
    const cleanup = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id }); assert.equal(cleanup.isError, true);
    entry.cleanup = JSON.parse(cleanup.content[0].text); assert.equal(entry.cleanup.cleanup.complete, false); assert.deepEqual(entry.cleanup.cleanup.preserved_addresses, [target]);
    assert.deepEqual([...entry.cleanup.cleanup.removed_addresses].sort(), group.addresses.filter(v => v !== target).sort());
    assert.deepEqual(await inspector.listBreakpoints('ee'), [point]); assert.deepEqual(await machine(), before);
    const again = await raw('pcsx2_remove_source_breakpoints', { group_id: group.group_id }); assert.equal(again.isError, true); assert.match(JSON.stringify(again.content), /Unknown source breakpoint group/);
    assert.deepEqual(await inspector.listBreakpoints('ee'), [point]); assert.deepEqual(await machine(), before);
    entry.point = point; entry.accepted = true; report.qt_options.push(entry);
    await inspector.removeBreakpoint(target);
    passed('actual Qt ' + edit.name + ' edit preserves original marker; native cleanup preserves exact options and rejects repeat removal without CPU/RAM/identity movement');
  }
  const pausedBeforeWindowStates = await machine();
  for (const state of ['maximized', 'normal', 'minimized', 'normal']) {
    s = await snap({ window_id: mainID });
    await action(s, unique(s, c => c.class === 'MainWindow' && c.kind === 'widget'), { action: 'window_state', state });
    await waitSnapshot(v => v.controls.some(c => c.class === 'MainWindow' && c.window_state === state), { window_id: mainID });
    assert.deepEqual(await machine(), pausedBeforeWindowStates);
  }
  report.paused_window_states = { states: ['maximized', 'normal', 'minimized', 'normal'], native_state: pausedBeforeWindowStates };
  passed('actual maximize/minimize/restore retain the same paused fixture, both CPUs, sampled RAM and native identity');
  s = await snap({ window_id: mainID });
  await action(s, unique(s, c => c.object_name === 'actionPowerOffWithoutSaving'), { action: 'trigger' }, false);
  for (let n = 0; ; ++n) {
    s = await snap();
    const yes = s.controls.filter(c => c.class === 'QPushButton' && /^&?Yes$/.test(c.text ?? ''));
    if (yes.length === 1) await action(s, yes[0], { action: 'click' }, false);
    if (await closedPort(debugPort)) break;
    assert.ok(n < 100, 'GUI shutdown did not close DebugServer'); await delay(50);
  }
  assert.equal((await call('pcsx2_ui_status')).identity.service_id, report.ui_identity.service_id);
  s = await snap({ window_id: mainID }); report.after_shutdown = await capture(s, 'after-shutdown');
  passed('GUI shuts down its VM while frontend service, identity, inspection and PNG remain available');
  s = await waitSnapshot(v => v.controls.some(c => c.object_name === 'actionStartFullscreenUI' && c.enabled), { window_id: mainID });
  await action(s, unique(s, c => c.object_name === 'actionStartFullscreenUI'), { action: 'trigger' }, false);
  s = await waitSnapshot(v => v.windows.some(w => w.class === 'DisplaySurface'));
  const surfaceID = unique({ controls: s.windows }, w => w.class === 'DisplaySurface').window_id;
  s = await snap({ window_id: surfaceID });
  const surface = unique(s, c => c.kind === 'surface');
  assert.equal(surface.class, 'DisplaySurface'); assert.equal(surface.semantic_children, false);
  await action(s, surface, { action: 'focus' });
  await delay(400);
  s = await snap({ window_id: surfaceID }); report.big_picture_before = await capture(s, 'big-picture-before');
  await action(s, unique(s, c => c.kind === 'surface'), { action: 'key', key: 'F1' });
  await delay(150);
  s = await snap({ window_id: surfaceID }); report.big_picture_after_key = await capture(s, 'big-picture-after-key');
  assert.notEqual(report.big_picture_after_key.sha256, report.big_picture_before.sha256);
  await action(s, unique(s, c => c.kind === 'surface'), { action: 'key', key: 'Escape' });
  await delay(150); s = await snap({ window_id: surfaceID });
  await action(s, unique(s, c => c.kind === 'surface'), { action: 'mouse', x: Math.floor(surface.width * 0.61), y: Math.floor(surface.height * 0.45) });
  await delay(150); s = await snap({ window_id: surfaceID });
  report.big_picture_after_mouse = await capture(s, 'big-picture-after-mouse');
  assert.notEqual(report.big_picture_after_mouse.sha256, report.big_picture_before.sha256);
  await action(s, unique(s, c => c.kind === 'surface'), { action: 'wheel', x: 100, y: 100, delta_y: -120 });
  s = await snap({ window_id: surfaceID });
  const invalid = await action(s, unique(s, c => c.kind === 'surface'), { action: 'mouse', x: surface.width + 1, y: 10 }, false, true);
  assert.equal((await call('pcsx2_ui_action_status', { action_id: invalid, wait_ms: 1000 })).action.state, 'failed');
  s = await snap({ window_id: mainID });
  await action(s, unique(s, c => c.object_name === 'actionStartFullscreenUI'), { action: 'trigger' }, false);
  await waitSnapshot(v => !v.windows.some(w => w.class === 'DisplaySurface'), { window_id: mainID });
  passed('actual Big Picture QWindow is inventoried and captured; local key/wheel input and coordinate refusal work, and Qt menu stops the surface');
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI);
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  assert.equal(watchdogExpired, false); report.passed = true;
} catch (error) {
  report.failure = String(error); report.stack = error.stack; process.exitCode = 1;
  try { lastSnapshot = await snap(); report.failure_windows = lastSnapshot.windows; report.failure_png = await capture(lastSnapshot, 'failure'); } catch (e) { report.failure_inspection_error = String(e); }
  if (lastSnapshot) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(lastSnapshot, null, 2));
  console.error(error.stack);
} finally {
  clearTimeout(watchdog); inspector.disconnect();
  try { await mcp.close(); report.mcp_stopped = !transport || transport.pid === null; } catch (e) { report.cleanup_error = String(e); }
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
