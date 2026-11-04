// Actual MCP window geometry/state before boot, with no native VM/DebugServer.
// node test/ui-window-live.mjs <PCSX2> <configured root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';

assert.equal(process.argv.length, 5);
const [executable, configured, output] = process.argv.slice(2).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8').replace(/^CheckAtStartup\s*=.*\r?\n/gm, '');
ini = /^\[AutoUpdater\]\r?\n/m.test(ini) ? ini.replace(/^\[AutoUpdater\]\r?\n/m, '[AutoUpdater]\nCheckAtStartup = false\n') : ini + '\n[AutoUpdater]\nCheckAtStartup = false\n';
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_qt_window_management', actor: 'mcp_qt_ui', executable, native_sha256: hash(await fs.readFile(executable)),
  data_directory: root, ui_port: uiPort, debug_port: debugPort, checks: [], actions: [], passed: false,
  Computer_Use_used: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const mcp = new Client({ name: 'ui-window-live', version: '1.0' }); let native, transport, log, watchdog, snapshot;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 15000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap(window_id) { snapshot = await call('snapshot', window_id ? { window_id } : {}); return snapshot; }
function window(s) { const candidates = s.controls.filter(c => c.class === 'MainWindow' && c.kind === 'widget'); assert.equal(candidates.length, 1); return candidates[0]; }
async function action(s, target, input, expected = 'completed') {
  assert.ok(target.actions.includes(input.action)); const r = await call('action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  const status = await call('action_status', { action_id: r.action.action_id, wait_ms: 1500 }); report.actions.push({ target, input, queued: r.action, status: status.action });
  assert.equal(status.action.state, expected, JSON.stringify(status));
}
async function until(id, predicate) { for (let i = 0; ; ++i) { const s = await snap(id); if (predicate(window(s))) return s; assert.ok(i < 100, JSON.stringify(window(s))); await delay(25); } }
async function capture(s, name) { const r = await raw('screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!r.isError); const bytes = Buffer.from(r.content.find(c => c.type === 'image').data, 'base64');
  const image = PNG.sync.read(bytes); assert.ok(image.width > 100 && image.height > 100); await fs.writeFile(path.join(output, name + '.png'), bytes, { flag: 'wx' }); return { file: name + '.png', sha256: hash(bytes), width: image.width, height: image.height }; }
async function noVM() { return new Promise(resolve => { const s = createConnection({ host: '127.0.0.1', port: debugPort }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => { s.destroy(); resolve(true); }); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); }); }
const equal = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); transport?.close().catch(() => {}); }, 60000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  for (let i = 0; ; ++i) { const r = await raw('connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); if (!r.isError) break; assert.ok(i < 100 && native.exitCode === null); await delay(100); }
  let s = await snap(); const id = s.windows.find(w => w.class === 'MainWindow').window_id; s = await snap(id); report.identity = s.identity;
  const original = window(s); assert.equal(original.window_state, 'normal'); assert.ok(original.can_maximize && original.can_minimize);
  assert.ok(Array.isArray(s.screens) && s.screens.length > 0); report.original = original; report.screens = s.screens;
  assert.equal(await noVM(), true); report.original_png = await capture(s, 'original');
  passed('actual main-window geometry, state and available Qt screen coordinates are inspected before any VM starts');
  const fits = (area, g) => g.x >= area.x && g.y >= area.y && g.x + g.width <= area.x + area.width && g.y + g.height <= area.y + area.height;
  const screen = s.screens.find(v => fits(v.available_geometry, original.geometry)); assert.ok(screen, 'Owned original window must fit an available screen'); const area = screen.available_geometry;
  const geometry = { x: area.x + 48, y: area.y + 48, width: Math.min(original.geometry.width + 32, area.width - 96), height: Math.min(original.geometry.height + 24, area.height - 96) };
  assert.ok(fits(area, geometry)); assert.ok(!equal(geometry, original.geometry)); report.requested_geometry = geometry;
  await action(s, original, { action: 'set_geometry', geometry }); s = await until(id, w => equal(w.geometry, geometry)); report.moved_png = await capture(s, 'moved-resized');
  passed('MCP moves/resizes its actual application window and exact Qt geometry readback matches the request');
  await action(s, window(s), { action: 'set_geometry', geometry: { ...geometry, x: -30000, y: -30000 } }, 'failed');
  s = await snap(id); assert.deepEqual(window(s).geometry, geometry); assert.equal(window(s).window_state, 'normal');
  passed('off-screen geometry refuses before moving or resizing the owned window');
  await action(s, window(s), { action: 'window_state', state: 'maximized' }); s = await until(id, w => w.window_state === 'maximized'); const maximized = window(s).geometry;
  report.maximized_png = await capture(s, 'maximized');
  await action(s, window(s), { action: 'set_geometry', geometry }, 'failed'); s = await snap(id); assert.equal(window(s).window_state, 'maximized'); assert.deepEqual(window(s).geometry, maximized);
  passed('actual maximization is visible in Qt/PNG; geometry edits refuse until normal state is restored');
  await action(s, window(s), { action: 'window_state', state: 'minimized' }); s = await until(id, w => w.window_state === 'minimized');
  assert.equal((await raw('screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id })).isError, true);
  const search = s.controls.find(c => c.object_name === 'searchText'); assert.ok(search);
  await action(s, search, { action: 'set_text', text: 'must-not-apply' }, 'failed'); s = await snap(id); assert.equal(s.controls.find(c => c.object_name === 'searchText').text, search.text);
  passed('minimized window stays inspectable; capture and child input refuse without changing its text');
  await action(s, window(s), { action: 'window_state', state: 'normal' }); s = await until(id, w => w.window_state === 'normal');
  await action(s, window(s), { action: 'set_geometry', geometry: original.geometry }); s = await until(id, w => equal(w.geometry, original.geometry));
  report.restored_png = await capture(s, 'restored'); assert.equal((await call('status')).identity.service_id, report.identity.service_id); assert.equal(await noVM(), true);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('normal state and exact original geometry restore under the same frontend identity with no VM or source INI changes'); report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; console.error(error.stack); process.exitCode = 1;
  if (snapshot) { await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(snapshot, null, 2)); try { report.failure_png = await capture(snapshot, 'failure'); } catch (e) { report.failure_capture_error = String(e); } }
} finally {
  clearTimeout(watchdog); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
