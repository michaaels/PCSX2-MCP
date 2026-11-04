// Actual application-local Qt drag through MCP. No VM, OS injection or test hooks.
// node test/ui-drag-live.mjs <PCSX2> <configured root> <new output>
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
import { ApplicationUIClient } from '../dist/application-ui.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { PNG } from 'pngjs';

assert.equal(process.argv.length, 5);
const [executable, configured, output] = process.argv.slice(2).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
let ini = originalINI.toString('utf8').replace(/^CheckAtStartup\s*=.*\r?\n/gm, '');
ini = /^\[AutoUpdater\]\r?\n/m.test(ini) ? ini.replace(/^\[AutoUpdater\]\r?\n/m, '[AutoUpdater]\nCheckAtStartup = false\n') : ini + '\n[AutoUpdater]\nCheckAtStartup = false\n';
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_qt_local_drag', actor: 'mcp_qt_ui', executable, native_sha256: hash(await fs.readFile(executable)),
  data_directory: root, ui_port: uiPort, checks: [], actions: [], passed: false, Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const mcp = new Client({ name: 'ui-drag-live', version: '1.0' }), observer = new ApplicationUIClient();
let native, transport, log, watchdog, mainID, wire;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function call(name, args = {}) { const r = await mcp.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 15000 }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
const snap = () => call('snapshot', mainID ? { window_id: mainID } : {});
const slider = s => { const a = s.controls.filter(c => c.class === 'QSlider' && c.visible); assert.equal(a.length, 1); return a[0]; };
async function action(s, control, input, expected = 'completed') {
  const q = await call('action', { snapshot_id: s.snapshot_id, control_id: control.id, ...input });
  if (expected === null) return q.action.action_id;
  const done = await call('action_status', { action_id: q.action.action_id, wait_ms: 2000 }); report.actions.push({ input, receipt: done.action }); assert.equal(done.action.state, expected, JSON.stringify(done)); return done.action;
}
async function reset() { const s = await snap(); const c = slider(s); await action(s, c, { action: 'set_value', value: c.minimum }); return snap(); }
const gesture = (c, duration_ms = 600) => ({ action: 'drag', x: 7, y: Math.floor(c.height / 2), end_x: c.width - 8, end_y: Math.floor(c.height / 2), duration_ms });
async function held(wanted) { for (let i = 0; ; ++i) { const s = await observer.snapshot({ window_id: report.observer_window_id }); const c = slider(s); if (c.slider_down === wanted) return { s, c }; assert.ok(i < 100, JSON.stringify(c)); await delay(10); } }
async function connectPrimary() { await call('connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); const s = await snap(); mainID = s.windows.find(w => w.class === 'MainWindow').window_id; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); transport?.close().catch(() => {}); }, 60000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  for (let i = 0; ; ++i) { try { await connectPrimary(); break; } catch (e) { assert.ok(i < 100 && native.exitCode === null, String(e)); await delay(100); } }
  report.identity = (await call('status')).identity;
  assert.ok((await call('status')).features.includes('qt_local_drag'));
  let s = await snap(); const grid = s.controls.find(c => c.object_name === 'actionViewGameGrid'); assert.ok(grid); await action(s, grid, { action: 'trigger' });
  s = await snap(); report.original_value = slider(s).value; assert.equal(slider(s).orientation, 'horizontal');
  await observer.connect({ ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root });
  const os = await observer.snapshot(); report.observer_window_id = os.windows.find(w => w.class === 'MainWindow').window_id;
  s = await reset(); let c = slider(s); assert.equal(c.slider_down, false);
  let id = await action(s, c, gesture(c), null); const during = await held(true);
  assert.equal((await call('action_status', { action_id: id })).action.state, 'running');
  const done = await call('action_status', { action_id: id, wait_ms: 2000 }); assert.equal(done.action.state, 'completed');
  s = await snap(); c = slider(s); assert.equal(c.slider_down, false); assert.ok(c.value > c.minimum && c.value <= c.maximum);
  report.full_drag = { during: during.c, after: c, receipt: done.action };
  passed('actual slider press/motion/release changes its value and receipt stays running while the Qt handle is down');
  s = await reset(); c = slider(s); await action(s, c, { ...gesture(c), end_x: c.width + 1 }, 'failed');
  s = await snap(); assert.equal(slider(s).value, c.minimum); assert.equal(slider(s).slider_down, false);
  passed('out-of-control endpoint refuses before pressing or changing the actual slider');
  s = await reset(); c = slider(s); id = await action(s, c, gesture(c, 1000), null); const busy = await held(true);
  const conflict = await observer.action({ snapshot_id: busy.s.snapshot_id, control_id: busy.c.id, action: 'set_value', value: busy.c.minimum });
  const refused = await observer.actionStatus({ action_id: conflict.action.action_id, wait_ms: 500 }); assert.equal(refused.action.state, 'failed'); assert.match(refused.action.error, /drag is running/);
  assert.equal((await call('action_status', { action_id: id, wait_ms: 2000 })).action.state, 'completed'); assert.equal((await held(false)).c.slider_down, false);
  report.conflict = refused.action;
  passed('a second Qt peer can inspect the held handle but its conflicting mutation refuses until release');
  s = await reset(); c = slider(s); id = await action(s, c, gesture(c, 1000), null); await held(true);
  const disconnectedAt = performance.now(); await call('disconnect'); const released = await held(false); report.disconnect_release_ms = performance.now() - disconnectedAt; assert.ok(report.disconnect_release_ms < 750);
  const releasedValue = released.c.value; await delay(150); assert.equal((await held(false)).c.value, releasedValue);
  mainID = undefined; await connectPrimary(); s = await reset();
  passed('disconnect during the real held gesture releases promptly and stops further slider movement; reconnect does not replay it');
  wire = new DebugServerClient('127.0.0.1', uiPort); await wire.connect();
  const identity = (await wire.applicationUICommand('ui_status')).identity;
  const rawSnap = await wire.applicationUICommand('ui_snapshot', { expected_service_id: identity.service_id, expected_process_id: native.pid }); const rc = slider(rawSnap);
  const queued = await wire.applicationUICommand('ui_action', { expected_service_id: identity.service_id, expected_process_id: native.pid,
    snapshot_id: rawSnap.snapshot_id, control_id: rc.id, ...gesture(rc, 1000), deadline_ms: Date.now() + 300 }); assert.equal(queued.ok, true);
  await delay(25); const short = await wire.applicationUICommand('ui_action_status', { expected_service_id: identity.service_id, expected_process_id: native.pid, action_id: queued.action.action_id });
  assert.equal(short.action.state, 'failed'); assert.match(short.action.error, /remaining action deadline/); assert.equal((await held(false)).c.value, rc.value); report.short_deadline = short.action;
  passed('native service independently rejects a gesture that cannot finish inside its deadline before any press');
  s = await snap(); c = slider(s); await action(s, c, gesture(c, 100), 'completed');
  s = await snap(); assert.equal(slider(s).slider_down, false); await action(s, slider(s), { action: 'set_value', value: report.original_value });
  s = await snap(); assert.equal(slider(s).value, report.original_value);
  const image = await mcp.callTool({ name: 'pcsx2_ui_screenshot', arguments: { snapshot_id: s.snapshot_id, window_id: s.window_id } }); assert.ok(!image.isError);
  const png = Buffer.from(image.content.find(c => c.type === 'image').data, 'base64'); assert.ok(PNG.sync.read(png).width > 100); await fs.writeFile(path.join(output, 'restored.png'), png, { flag: 'wx' });
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('new gesture and semantic edits work after cancellation, original slider value restores and actual application PNG is captured'); report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; console.error(e.stack); process.exitCode = 1;
  try { await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(await snap(), null, 2)); } catch {}
} finally {
  clearTimeout(watchdog); observer.disconnect(); wire?.disconnect(); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
