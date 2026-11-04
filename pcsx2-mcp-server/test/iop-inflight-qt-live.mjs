// Real MCP Qt replacement of an armed IOP step-over point. No operator attestation.
// node test/iop-inflight-qt-live.mjs <PCSX2> <instruction fixture> <configured root> <new output>
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
const hash = b => createHash('sha256').update(b).digest('hex'), hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
assert.equal(manifest.kind, 'standalone_instruction_fixture');
for (const [name, digest] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), digest); }
for (const name of ['build.sh', 'ee-instructions.c', 'iop-instructions.c', 'instructions.S', 'Makefile.ee', 'Makefile.iop'])
  assert.deepEqual(await fs.readFile(path.join(fixture, name)), await fs.readFile(fileURLToPath(new URL('fixtures/instruction-control/' + name, import.meta.url))));
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8');
function setting(section, key, value) { ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), '');
  const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm'); ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`; }
setting('EmuCore', 'HostFs', 'true'); setting('EmuCore', 'EnablePINE', 'false'); setting('UI', 'ShowAdvancedSettings', 'true');
setting('UI', 'AdvancedSettingsWarningShown', 'true'); setting('AutoUpdater', 'CheckAtStartup', 'false');
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const debugPort = await port(), uiPort = await port(); assert.notEqual(debugPort, uiPort);
const elf = path.join(fixture, 'instruction-control.elf'), ee = await fs.readFile(elf), irx = await fs.readFile(path.join(fixture, 'instruction-control.debug.irx'));
function symbol(b, name) {
  const offset = b.readUInt32LE(32), stride = b.readUInt16LE(46), count = b.readUInt16LE(48);
  for (let i = 0; i < count; ++i) { const header = offset + i * stride; if (b.readUInt32LE(header + 4) !== 2) continue;
    const strings = b.readUInt32LE(offset + b.readUInt32LE(header + 24) * stride + 16), end = b.readUInt32LE(header + 16) + b.readUInt32LE(header + 20), step = b.readUInt32LE(header + 36); assert.ok(step >= 16);
    for (let at = b.readUInt32LE(header + 16); at < end; at += step) { const start = strings + b.readUInt32LE(at); if (b.subarray(start, b.indexOf(0, start)).toString() === name) return b.readUInt32LE(at + 4); } }
  throw new Error('Missing fixture symbol ' + name);
}
const words = text => { const b = Buffer.from(text, 'hex'); return Array.from({ length: b.length / 4 }, (_, i) => b.readUInt32LE(i * 4)); };
const inspector = new DebugServerClient('127.0.0.1', debugPort), mcp = new Client({ name: 'iop-inflight-qt', version: '1.0' });
const report = { kind: 'actual_qt_iop_inflight_ownership', actor: 'mcp_qt_ui', native_sha256: hash(await fs.readFile(executable)),
  executable, elf, elf_sha256: hash(ee), debug_port: debugPort, ui_port: uiPort, data_directory: root, checks: [], actions: [], passed: false,
  IRQ_scope: 'owned_fixture_masks_IOP_IRQ_for_instruction_isolation', Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, transport, log, watchdog, snapshot, stepPending;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 20000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, name + ': ' + JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap(options = {}) { snapshot = await call('pcsx2_ui_snapshot', { max_nodes: 5000, max_items: 128, ...options }); return snapshot; }
function one(s, predicate) { const values = s.controls.filter(predicate); assert.equal(values.length, 1, JSON.stringify(values)); return values[0]; }
async function action(s, control, input, wait = true) {
  const r = await call('pcsx2_ui_action', { snapshot_id: s.snapshot_id, control_id: control.id, ...input });
  const state = await call('pcsx2_ui_action_status', { action_id: r.action.action_id, wait_ms: wait ? 1000 : 0 });
  report.actions.push({ control, input, queued: r.action, status: state.action });
  assert.ok(!['failed', 'expired'].includes(state.action.state), JSON.stringify(state)); if (wait) assert.equal(state.action.state, 'completed'); return r.action.action_id;
}
async function until(predicate, options = {}) { for (let i = 0; ; ++i) { const s = await snap(options); if (predicate(s)) return s; assert.ok(i < 150, JSON.stringify(s.windows)); await delay(25); } }
async function cursor() { let h = await inspector.readEvents(0, 200); while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200); return h.next_cursor; }
async function pc(cpu) { return (await inspector.readRegisters(cpu, 0)).pc; }
async function machine() { return { identity: await inspector.getCapabilities(), status: await inspector.getStatus(), ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0), ram: await inspector.readMemoryStrict('0x00100000', 256), iop_ram: await inspector.readMemoryStrict(report.module_base, 256, 'iop') }; }
async function capture(s, name) { const r = await raw('pcsx2_ui_screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!r.isError, JSON.stringify(r));
  const image = r.content.find(c => c.type === 'image'); assert.ok(image); const b = Buffer.from(image.data, 'base64'); const decoded = PNG.sync.read(b); assert.ok(decoded.width > 100 && decoded.height > 100);
  await fs.writeFile(path.join(output, name + '.png'), b, { flag: 'wx' }); return { file: name + '.png', sha256: hash(b), width: decoded.width, height: decoded.height }; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable', '-debugger', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(debugPort), PCSX2_UI_PORT: String(uiPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { inspector.disconnect(); transport?.close().catch(() => {}); native.kill(); }, 120000); watchdog.unref();
  for (let i = 0; ; ++i) { try { await inspector.connect(); break; } catch (error) { assert.ok(i < 150 && native.exitCode === null, String(error)); await delay(100); } }
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  assert.ok(!(await raw('pcsx2_connect', { mode: 'debug', debug_port: debugPort })).isError);
  await call('pcsx2_ui_connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root });
  await inspector.pause(); const ready = hex(symbol(ee, 'instruction_ready')); await inspector.setBreakpoint(ready);
  const after = await cursor(); await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false); assert.equal(await pc('ee'), ready); await inspector.removeBreakpoint(ready);
  const caps = await inspector.getCapabilities(); assert.equal(caps.process_id, native.pid); assert.equal(caps.data_directory, root); assert.equal(caps.elf_crc === '0x00000000', false);
  const meta = words(await inspector.readMemoryStrict(hex(symbol(ee, 'instruction_meta')), 64)); assert.equal(meta[0], 0x53544545); assert.ok((meta[1] | 0) >= 0); assert.equal(meta[3], 1);
  const module = words(await inspector.readMemoryStrict(hex(meta[2]), 64, 'iop')); assert.equal(module[0], 0x5354494f);
  const base = module[1] - symbol(irx, 'fixture_normal'); assert.ok(base > 0 && base < 0x1fff00); report.module_base = hex(base);
  for (const [index, name] of [[1, 'fixture_normal'], [5, 'fixture_hang_call'], [6, 'fixture_spin'], [7, 'fixture_quiet'], [8, 'fixture_quiet_ready'], [9, 'fixture_status']]) assert.equal(module[index], base + symbol(irx, name));
  report.module = { meta, report: module, base, irx_sha256: hash(irx) };
  await inspector.setPC(hex(symbol(ee, 'fixture_spin')), 'ee'); await inspector.setPC(hex(module[7]), 'iop'); await inspector.setBreakpoint(hex(module[8]), { cpu: 'iop' });
  const beforeQuiet = await cursor(); await inspector.resume(); assert.equal((await inspector.waitEvent({ after: beforeQuiet, type: 'breakpoint', timeoutMs: 10000 })).timed_out, false);
  assert.equal(await pc('iop'), hex(module[8])); await inspector.removeBreakpoint(hex(module[8]), 'iop');
  report.IRQ_isolation = words(await inspector.readMemoryStrict(hex(module[9]), 8, 'iop')); assert.equal(report.IRQ_isolation[1], (report.IRQ_isolation[0] & 0xfffffffe) >>> 0);
  passed('actual resident IOP addresses agree with retained debug IRX; owned fixture masks IRQ and leaves exact quiet breakpoint');
  // The same numeric address belongs to separate CPU breakpoint namespaces.
  const iopReturn = hex(module[3]);
  await inspector.setBreakpoint(iopReturn, { cpu: 'ee', description: 'EE coincident return control' });
  const eeForeign = await inspector.listBreakpoints('ee'); assert.equal(eeForeign.length, 1);
  report.cpu_isolation_before = { ee: eeForeign, iop: await inspector.listBreakpoints('iop') };
  assert.deepEqual(report.cpu_isolation_before.iop, [], 'EE point leaked into IOP list');
  await inspector.setPC(hex(module[2]), 'iop'); await call('pcsx2_step_over', { cpu: 'iop', timeout_ms: 1000 });
  assert.equal(await pc('iop'), iopReturn); assert.deepEqual(await inspector.listBreakpoints('ee'), eeForeign); assert.deepEqual(await inspector.listBreakpoints('iop'), []);
  await inspector.removeBreakpoint(iopReturn, 'ee');
  await inspector.setPC(hex(module[8]), 'iop');
  passed('IOP list/step-over ignore and preserve an EE breakpoint at the exact same numeric return address');
  const eeReturn = hex(symbol(ee, 'fixture_return'));
  await inspector.setBreakpoint(eeReturn, { cpu: 'iop', description: 'IOP coincident return control' });
  const iopForeign = await inspector.listBreakpoints('iop'); assert.equal(iopForeign.length, 1); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  await inspector.setPC(hex(symbol(ee, 'fixture_jal')), 'ee'); await call('pcsx2_step_over', { cpu: 'ee', timeout_ms: 1000 });
  assert.equal(await pc('ee'), eeReturn); assert.deepEqual(await inspector.listBreakpoints('iop'), iopForeign); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  await inspector.removeBreakpoint(eeReturn, 'iop'); await inspector.setPC(hex(symbol(ee, 'fixture_spin')), 'ee');
  passed('EE list/step-over ignore and preserve an IOP breakpoint at the exact same numeric return address');
  const start = hex(module[5]), target = hex(module[5] + 8); report.step_pc = start; report.target = target;
  assert.equal(target, hex(base + symbol(irx, 'fixture_hang_return'))); await inspector.setPC(start, 'iop');
  const control = await raw('pcsx2_step_over', { cpu: 'iop', timeout_ms: 100 }); assert.equal(control.isError, true); assert.match(JSON.stringify(control), /timed out/);
  assert.equal((await inspector.getStatus()).paused, true); assert.deepEqual(await inspector.listBreakpoints('iop'), []); await inspector.setPC(start, 'iop');
  report.unchanged_control = control; passed('unchanged IOP nonreturning step times out, pauses and removes only its own point');
  let s = await until(v => v.windows.some(w => w.class === 'DebuggerWindow'));
  const debuggerID = s.windows.find(w => w.class === 'DebuggerWindow').window_id; s = await snap({ window_id: debuggerID });
  const cpuTabs = one(s, c => c.tabs?.some(t => /R3000.*IOP/.test(t.text)));
  await action(s, cpuTabs, { action: 'select_index', index: cpuTabs.tabs.find(t => /R3000.*IOP/.test(t.text)).index });
  s = await snap({ window_id: debuggerID }); const tabs = one(s, c => c.tabs?.some(t => t.text === 'Breakpoints') && c.visible);
  await action(s, tabs, { action: 'select_index', index: tabs.tabs.find(t => t.text === 'Breakpoints').index });
  s = await snap({ window_id: debuggerID }); const table = one(s, c => c.object_name === 'breakpointList' && c.visible);
  const viewport = one(s, c => c.parent_id === table.id && c.object_name === 'qt_scrollarea_viewport');
  await action(s, viewport, { action: 'context_menu', x: 20, y: 20 }, false);
  s = await until(v => v.controls.some(c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'New'));
  await action(s, one(s, c => c.kind === 'action' && c.text?.replaceAll('&', '') === 'New'), { action: 'trigger' }, false);
  s = await until(v => v.controls.some(c => c.class === 'BreakpointDialog'));
  await action(s, one(s, c => c.object_name === 'rdoExecute'), { action: 'click' });
  s = await snap(); await action(s, one(s, c => c.object_name === 'txtAddress'), { action: 'set_text', text: target });
  s = await snap(); await action(s, one(s, c => c.object_name === 'txtDescription'), { action: 'set_text', text: 'GUI-OWNED-IOP' });
  s = await snap(); await action(s, one(s, c => c.object_name === 'chkEnable'), { action: 'set_checked', checked: true });
  s = await snap(); report.prepared_dialog = await capture(s, 'prepared-dialog');
  assert.deepEqual(await inspector.listBreakpoints('ee'), []); assert.deepEqual(await inspector.listBreakpoints('iop'), []); assert.equal((await inspector.getStatus()).paused, true);
  await inspector.setBreakpoint(target, { cpu: 'ee', description: 'EE coincident GUI guard control' });
  const preservedEE = await inspector.listBreakpoints('ee'); assert.equal(preservedEE.length, 1); report.preserved_ee_control = preservedEE;
  const before = await inspector.getCapabilities(); report.before = before;
  passed('actual Qt IOP layout prepares New Execute dialog with exact target/description without creating a point early');
  const runningAfter = await cursor(); let stepSettled = false;
  const startedAt = performance.now(); stepPending = raw('pcsx2_step_over', { cpu: 'iop', timeout_ms: 5000 }).then(reply => { stepSettled = true; return { reply }; }, error => { stepSettled = true; return { error: String(error) }; });
  // Ordinary native queries serialize behind legacy step. Event long-polls are
  // explicitly independent; Qt's live model supplies the actual private marker.
  report.resumed = await inspector.waitEvent({ after: runningAfter, type: 'resumed', timeoutMs: 1500 });
  assert.equal(report.resumed.timed_out, false);
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && /:legacy-step:/.test(c.text ?? '')), { window_id: debuggerID });
  const marker = one(s, c => c.kind === 'model_item' && /:legacy-step:/.test(c.text ?? ''));
  report.armed_gui = { marker, row: s.controls.filter(c => c.kind === 'model_item' && c.row === marker.row && c.parent_id === marker.parent_id) };
  assert.equal(stepSettled, false, 'Step ended before GUI could apply');
  s = await snap(); await action(s, one(s, c => c.class === 'QPushButton' && /^&?OK$/.test(c.text ?? '')), { action: 'click' }, false);
  const outcome = await stepPending; stepPending = undefined; assert.ok(!outcome.error, outcome.error); report.reply = outcome.reply; report.elapsed_ms = performance.now() - startedAt;
  assert.equal(outcome.reply.isError, true); assert.match(JSON.stringify(outcome.reply), /changed ownership; preserved, cleanup unconfirmed/);
  const points = await inspector.listBreakpoints('iop'), point = points.find(p => p.address === target); assert.equal(points.length, 1); assert.equal(point.description, 'GUI-OWNED-IOP'); assert.equal(point.enabled, true); assert.equal(point.temporary, false); assert.equal(point.stepping, false);
  report.preserved = point; report.after = await machine(); assert.equal(report.after.status.paused, true);
  for (const key of ['process_id', 'session', 'execution_epoch', 'iop_lifetime_epoch', 'elf', 'elf_crc', 'data_directory']) assert.equal(report.after.identity[key], before[key]);
  assert.deepEqual(await inspector.listBreakpoints('ee'), preservedEE);
  passed('Qt applies during armed running IOP step; MCP refuses cleanup and preserves GUI-owned permanent point in same paused VM');
  s = await until(v => v.controls.some(c => c.kind === 'model_item' && c.text === 'GUI-OWNED-IOP'), { window_id: debuggerID });
  report.final_png = await capture(s, 'preserved-iop-point'); assert.deepEqual(await machine(), report.after); assert.deepEqual(await inspector.listBreakpoints('iop'), points);
  passed('actual IOP breakpoint view and PNG retain the GUI point; capture leaves both CPUs/RAM/identity unchanged');
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256); report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; console.error(error.stack); process.exitCode = 1;
  try { snapshot = await snap(); report.failure_png = await capture(snapshot, 'failure'); } catch (e) { report.failure_inspection_error = String(e); }
  if (snapshot) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(snapshot, null, 2));
} finally {
  if (stepPending) report.outstanding_step = await stepPending;
  clearTimeout(watchdog); inspector.disconnect(); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
