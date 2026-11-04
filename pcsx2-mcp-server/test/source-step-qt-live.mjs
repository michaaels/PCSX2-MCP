// Actual MCP source stepping + Qt edit, with bounded transparent response latency.
// node test/source-step-qt-live.mjs <PCSX2> <standalone fixture> <configured root> <new output> [into|over|out]
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
import { guardedResponseProxy } from './guarded-response-proxy.mjs';

assert.ok(process.argv.length === 6 || process.argv.length === 7);
const mode = process.argv[6] ?? 'into'; assert.ok(['into', 'over', 'out'].includes(mode));
const [executable, fixture, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex'), hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8')); assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
for (const [name, digest] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), digest); }
for (const name of ['standalone.c', 'Makefile']) assert.deepEqual(await fs.readFile(path.join(fixture, name)), await fs.readFile(fileURLToPath(new URL('fixtures/standalone/' + name, import.meta.url))));
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8');
function setting(section, key, value) { ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), ''); const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`; }
setting('EmuCore', 'EnablePINE', 'false'); setting('UI', 'ShowAdvancedSettings', 'true'); setting('UI', 'AdvancedSettingsWarningShown', 'true'); setting('AutoUpdater', 'CheckAtStartup', 'false');
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const debugPort = await port(), uiPort = await port(); assert.notEqual(debugPort, uiPort);
const elf = path.join(fixture, 'standalone.elf'), elfHash = manifest.sha256['standalone.elf'];
const inspector = new DebugServerClient('127.0.0.1', debugPort), mcp = new Client({ name: 'source-step-qt', version: '1.0' });
const report = { kind: 'actual_qt_source_step_ownership', mode, actor: 'mcp_qt_ui', native_sha256: hash(await fs.readFile(executable)),
  executable, elf, elf_sha256: elfHash, debug_port: debugPort, ui_port: uiPort, data_directory: root, checks: [], actions: [], passed: false,
  fault_scope: 'one_unmodified_guarded_step_response_held_at_most_700ms', Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, transport, log, watchdog, snapshot, proxy, held, sourcePending;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 25000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap(options = {}) { snapshot = await call('pcsx2_ui_snapshot', { max_nodes: 5000, max_items: 128, ...options }); return snapshot; }
function one(s, predicate) { const rows = s.controls.filter(predicate); assert.equal(rows.length, 1, JSON.stringify(rows)); return rows[0]; }
async function action(s, target, input, wait = true) { const r = await call('pcsx2_ui_action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  const status = await call('pcsx2_ui_action_status', { action_id: r.action.action_id, wait_ms: wait ? 500 : 0 }); report.actions.push({ target, input, queued: r.action, status: status.action });
  assert.ok(!['failed', 'expired'].includes(status.action.state), JSON.stringify(status)); if (wait) assert.equal(status.action.state, 'completed'); }
async function until(predicate, options = {}) { for (let i = 0; ; ++i) { const s = await snap(options); if (predicate(s)) return s; assert.ok(i < 100, JSON.stringify(s.windows)); await delay(10); } }
async function cursor() { let h = await inspector.readEvents(0, 200); while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200); return h.next_cursor; }
async function machine() { return { identity: await inspector.getCapabilities(), status: await inspector.getStatus(), ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0), ram: await inspector.readMemoryStrict('0x00100000', 256) }; }
async function capture(s, name) { const r = await raw('pcsx2_ui_screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!r.isError); const b = Buffer.from(r.content.find(c => c.type === 'image').data, 'base64');
  const image = PNG.sync.read(b); assert.ok(image.width > 100 && image.height > 100); await fs.writeFile(path.join(output, name + '.png'), b, { flag: 'wx' }); return { file: name + '.png', sha256: hash(b), width: image.width, height: image.height }; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(debugPort), PCSX2_UI_PORT: String(uiPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { held?.release(); inspector.disconnect(); native.kill(); transport?.close().catch(() => {}); }, 120000); watchdog.unref();
  for (let i = 0; ; ++i) { try { await inspector.connect(); break; } catch (error) { assert.ok(i < 150 && native.exitCode === null, String(error)); await delay(100); } }
  proxy = await guardedResponseProxy(debugPort); report.proxy_port = proxy.port;
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  assert.ok(!(await raw('pcsx2_connect', { mode: 'debug', debug_port: proxy.port })).isError);
  await call('pcsx2_ui_connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root });
  for (let i = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; ++i) { assert.ok(i < 150); await delay(50); }
  await inspector.pause();
  const line = (await fs.readFile(path.join(fixture, 'standalone.c'), 'utf8')).split(/\r?\n/).findIndex(v => v.includes('/* MCP_TICK:')) + 1; assert.ok(line > 0);
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'standalone.c', line, expected_sha256: elfHash });
  const at = await cursor(); await inspector.resume(); assert.equal((await inspector.waitEvent({ after: at, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  assert.equal((await inspector.getStatus()).pc, group.addresses[0]); await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const start = group.addresses[0], opcode = Buffer.from(await inspector.readMemoryStrict(start, 4), 'hex').readUInt32LE(); assert.equal(opcode >>> 26, 15, 'Retained first tick instruction must be LUI');
  const target = hex(Number(start) + 4); report.start = start; report.target = target;
  report.before = await machine(); assert.equal(report.before.identity.process_id, native.pid); assert.equal(report.before.identity.data_directory, root);
  const control = await call('pcsx2_source_step', { mode, timeout_ms: 5000, max_instruction_units: 64, expected_sha256: elfHash });
  assert.equal(control.completed, true); assert.equal(control.cleanup_complete, true); assert.equal(control.paused, true); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  report.unchanged_control = control; await inspector.setPC(start);
  passed('actual source-step through transparent unarmed relay completes with matching DWARF/ELF and clean paused native state');
  let s = await snap(); const mainID = s.windows.find(w => w.class === 'MainWindow').window_id;
  s = await snap({ window_id: mainID }); await action(s, one(s, c => c.object_name === 'actionDebugger'), { action: 'trigger' }, false);
  s = await until(v => v.windows.some(w => w.class === 'DebuggerWindow')); const debuggerID = s.windows.find(w => w.class === 'DebuggerWindow').window_id;
  s = await snap({ window_id: debuggerID }); const tabs = one(s, c => c.tabs?.some(t => t.text === 'Breakpoints') && c.visible);
  await action(s, tabs, { action: 'select_index', index: tabs.tabs.find(t => t.text === 'Breakpoints').index });
  s = await snap({ window_id: debuggerID }); const table = one(s, c => c.object_name === 'breakpointList' && c.kind === 'widget' && c.visible);
  await action(s, one(s, c => c.parent_id === table.id && c.object_name === 'qt_scrollarea_viewport'), { action: 'context_menu', x: 20, y: 20 }, false);
  s = await until(v => v.controls.some(c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'New')); await action(s, one(s, c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'New'), { action: 'trigger' }, false);
  s = await until(v => v.controls.some(c => c.class === 'BreakpointDialog')); await action(s, one(s, c => c.object_name === 'rdoExecute'), { action: 'click' });
  s = await snap(); await action(s, one(s, c => c.object_name === 'txtAddress'), { action: 'set_text', text: target });
  s = await snap(); await action(s, one(s, c => c.object_name === 'txtDescription'), { action: 'set_text', text: 'GUI-SOURCE-OWNED' });
  s = await snap(); await action(s, one(s, c => c.object_name === 'chkEnable'), { action: 'set_checked', checked: true });
  s = await snap(); report.prepared_png = await capture(s, 'prepared-dialog'); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  await inspector.setBreakpoint(target, { cpu: 'iop', description: 'IOP coincident source guard' }); report.foreign_iop = await inspector.listBreakpoints('iop'); assert.equal(report.foreign_iop.length, 1); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  passed('real Qt prepares exact successor replacement without early EE creation; coincident IOP control remains isolated');
  report.operation_before = await machine();
  proxy.arm(); const eventCursor = await cursor(); let sourceSettled = false;
  sourcePending = raw('pcsx2_source_step', { mode, timeout_ms: 5000, max_instruction_units: 64, expected_sha256: elfHash }).then(reply => { sourceSettled = true; return { reply }; }, error => { sourceSettled = true; return { error: String(error) }; });
  held = await proxy.waitHeld(); report.transport_hold = held.evidence;
  assert.equal(held.evidence.response.ok, true); assert.equal(held.evidence.response.active, true); assert.equal(held.evidence.response.old_pc, start); assert.equal(held.evidence.response.target, target);
  const markerText = 'MCP guarded step ' + held.evidence.response.operation_id;
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && c.text === markerText), { window_id: debuggerID }); report.armed_gui = one(s, c => c.kind === 'model_item' && c.text === markerText);
  report.armed_native_status = await inspector.getStatus(); assert.equal(report.armed_native_status.paused, true); assert.equal(report.armed_native_status.pc, target);
  report.arm_events = await inspector.readEvents(eventCursor, 200); assert.ok(report.arm_events.events.some(e => e.type === 'resumed')); assert.ok(report.arm_events.events.some(e => e.type === 'breakpoint' && e.pc === target));
  assert.equal(sourceSettled, false); assert.equal(held.evidence.released, false, 'Proxy hold expired before actual GUI edit');
  s = await snap(); await action(s, one(s, c => c.class === 'QPushButton' && /^&?OK$/.test(c.text ?? '')), { action: 'click' });
  assert.equal(held.evidence.released, false, 'GUI action missed bounded response hold'); held.release();
  const outcome = await sourcePending; sourcePending = undefined; assert.ok(!outcome.error, outcome.error); assert.ok(!outcome.reply.isError, JSON.stringify(outcome.reply));
  const result = JSON.parse(outcome.reply.content[0].text); report.result = result; assert.equal(result.completed, false); assert.equal(result.cleanup_complete, false); assert.equal(result.reason, 'cleanup_incomplete'); assert.equal(result.paused, true); assert.equal(result.identity_matches, true);
  assert.equal(result.trace[0].operation_id, held.evidence.response.operation_id); assert.equal(result.trace[0].cleanup_complete, false); assert.equal(result.pc, target); assert.equal(held.evidence.automatic_release, false);
  const points = await inspector.listBreakpoints('ee'); assert.equal(points.length, 1); assert.equal(points[0].address, target); assert.equal(points[0].description, 'GUI-SOURCE-OWNED'); assert.equal(points[0].enabled, true); assert.equal(points[0].temporary, false); assert.equal(points[0].stepping, false);
  assert.deepEqual(await inspector.listBreakpoints('iop'), report.foreign_iop); report.preserved = points[0]; report.after = await machine();
  for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc', 'data_directory']) assert.equal(report.after.identity[key], report.operation_before.identity[key]);
  report.IOP_lifetime_during_operation = { before: report.operation_before.identity.iop_lifetime_epoch, after: report.after.identity.iop_lifetime_epoch };
  passed('real Qt replaces a genuine source-step private point during bounded response latency; source API reports incomplete cleanup and preserves both CPU namespaces');
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && c.text === 'GUI-SOURCE-OWNED') &&
    !v.controls.some(c => c.kind === 'model_item' && c.text === markerText), { window_id: debuggerID });
  report.final_visible_model_items = s.controls.filter(c => c.kind === 'model_item' && c.object_name === 'breakpointList');
  report.stale_private_marker_in_Qt_model = report.final_visible_model_items.some(c => c.text === markerText);
  report.final_png = await capture(s, 'preserved-source-point'); assert.deepEqual(await machine(), report.after); assert.deepEqual(await inspector.listBreakpoints('ee'), points);
  passed('actual EE point and PNG retain GUI ownership; final inspection leaves both CPUs, sampled RAM and identity unchanged');
  assert.equal(report.stale_private_marker_in_Qt_model, false);
  const extra = hex(Number(target) + 64);
  await inspector.setBreakpoint(extra, { cpu: 'ee', description: 'MCP PAUSED SYNC CONTROL' });
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && c.text === 'MCP PAUSED SYNC CONTROL'), { window_id: debuggerID });
  await inspector.removeBreakpoint(extra, 'ee');
  s = await until(v => !v.controls.some(c => c.kind === 'model_item' && c.text === 'MCP PAUSED SYNC CONTROL'), { window_id: debuggerID });
  assert.deepEqual(await machine(), report.after); assert.deepEqual(await inspector.listBreakpoints('ee'), points);
  passed('native paused point creation/removal refreshes the actual Qt model without resume or guest-state movement');
  await action(s, one(s, c => c.kind === 'model_item' && c.text === 'GUI-SOURCE-OWNED'), { action: 'mouse', double_click: true });
  const inlineEditor = c => c.kind === 'widget' && c.actions.includes('set_text') && c.visible && c.text === 'GUI-SOURCE-OWNED';
  s = await until(v => v.controls.some(inlineEditor), { window_id: debuggerID });
  await inspector.setBreakpoint(extra, { cpu: 'ee', description: 'MCP DEFERRED SYNC CONTROL' });
  await delay(125); s = await snap({ window_id: debuggerID });
  assert.equal(one(s, inlineEditor).text, 'GUI-SOURCE-OWNED');
  assert.ok(!s.controls.some(c => c.kind === 'model_item' && c.text === 'MCP DEFERRED SYNC CONTROL'));
  await action(s, one(s, inlineEditor), { action: 'key', key: 'Escape' });
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && c.text === 'MCP DEFERRED SYNC CONTROL'), { window_id: debuggerID });
  await inspector.removeBreakpoint(extra, 'ee');
  await until(v => !v.controls.some(c => c.kind === 'model_item' && c.text === 'MCP DEFERRED SYNC CONTROL'), { window_id: debuggerID });
  assert.deepEqual(await machine(), report.after); assert.deepEqual(await inspector.listBreakpoints('ee'), points); assert.deepEqual(await inspector.listBreakpoints('iop'), report.foreign_iop);
  passed('native refresh preserves an actual inline Qt editor and reconciles after Escape without another native mutation');
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256); report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; console.error(error.stack); process.exitCode = 1;
  held?.release(); if (sourcePending) { report.outstanding_source = await sourcePending; sourcePending = undefined; }
  try { snapshot = await snap(); report.failure_png = await capture(snapshot, 'failure'); } catch (e) { report.failure_inspection_error = String(e); }
  if (snapshot) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(snapshot, null, 2));
} finally {
  held?.release(); clearTimeout(watchdog); inspector.disconnect(); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  await proxy?.close(); report.proxy_stopped = true;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
