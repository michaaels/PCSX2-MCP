// Actual cross-control drag of a moving QFileDialog splitter handle via MCP.
// node test/ui-cross-drag-live.mjs <PCSX2> <configured root> <new output>
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

assert.equal(process.argv.length, 5);
const [executable, configured, output] = process.argv.slice(2).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex'), originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
let ini = originalINI.toString('utf8').replace(/^CheckAtStartup\s*=.*\r?\n/gm, '');
ini = /^\[AutoUpdater\]\r?\n/m.test(ini) ? ini.replace(/^\[AutoUpdater\]\r?\n/m, '[AutoUpdater]\nCheckAtStartup = false\n') : ini + '\n[AutoUpdater]\nCheckAtStartup = false\n';
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_qt_cross_control_drag', actor: 'mcp_qt_ui', executable, native_sha256: hash(await fs.readFile(executable)), data_directory: root,
  checks: [], actions: [], passed: false, Computer_Use_used: false, physical_validation: 'not_performed', SMS_or_Jellyfin_involved: false };
const mcp = new Client({ name: 'ui-cross-drag-live', version: '1.0' }); let native, transport, log, watchdog, mainID, dialogID, last;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 15000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap(window_id) { last = await call('snapshot', { ...(window_id ? { window_id } : {}), max_nodes: 5000 }); return last; }
function one(s, predicate) { const a = s.controls.filter(predicate); assert.equal(a.length, 1, JSON.stringify(a)); return a[0]; }
async function action(s, target, input, expected = 'completed') { const q = await call('action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  if (expected === null) return q.action.action_id;
  const result = await call('action_status', { action_id: q.action.action_id, wait_ms: 2000 }); report.actions.push({ target, input, receipt: result.action }); assert.equal(result.action.state, expected, JSON.stringify(result)); return result.action; }
async function capture(s, name) { const r = await raw('screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!r.isError); const png = Buffer.from(r.content.find(c => c.type === 'image').data, 'base64'); assert.ok(PNG.sync.read(png).width > 100); await fs.writeFile(path.join(output, name + '.png'), png, { flag: 'wx' }); return hash(png); }
function parts(s) {
  const handles = s.controls.filter(c => c.class === 'QSplitterHandle' && c.visible && c.width > 0 && c.width < 20 && c.height > 100);
  assert.equal(handles.length, 1, JSON.stringify(handles)); const handle = handles[0], parent = one(s, c => c.id === handle.parent_id && c.class === 'QSplitter'); return { handle, parent };
}
function gesture(s, desiredRootX) { const { handle: h, parent: p } = parts(s); return { target: h, input: { action: 'drag', x: Math.floor(h.width / 2), y: Math.floor(h.height / 2),
  end_control_id: p.id, end_x: desiredRootX - p.bounds_in_window.x, end_y: h.bounds_in_window.y - p.bounds_in_window.y + Math.floor(h.height / 2), duration_ms: 600 } }; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); transport?.close().catch(() => {}); }, 60000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  for (let i = 0; ; ++i) { try { await call('connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); break; } catch (e) { assert.ok(i < 100 && native.exitCode === null, String(e)); await delay(100); } }
  let s = await snap(); mainID = s.windows.find(w => w.class === 'MainWindow').window_id; report.identity = s.identity;
  s = await snap(mainID); const openID = await action(s, one(s, c => c.object_name === 'actionStartFile'), { action: 'trigger' }, null);
  for (let i = 0; ; ++i) { s = await snap(); dialogID = s.windows.find(w => w.class === 'QFileDialog')?.window_id; if (dialogID) break; assert.ok(i < 100); await delay(25); }
  await delay(150); s = await snap(dialogID); report.original = parts(s); report.before_png = await capture(s, 'before');
  const { handle: h, parent: p } = parts(s); assert.ok(h.actions.includes('drag')); assert.ok(h.bounds_in_window.x >= p.bounds_in_window.x); report.root = one(s, c => c.parent_id === '' && c.kind === 'widget');
  passed('actual QFileDialog exposes its narrow moving splitter handle and both controls in window-local coordinates');
  let g = gesture(s, h.bounds_in_window.x + Math.floor(h.width / 2) + 60);
  const bad = await raw('action', { snapshot_id: s.snapshot_id, control_id: h.id, ...g.input, end_control_id: 'c9999' }); assert.equal(bad.isError, true);
  s = await snap(dialogID); assert.deepEqual(parts(s).handle.bounds_in_window, h.bounds_in_window);
  passed('unknown cross-control endpoint refuses before consuming a gesture or moving the splitter');
  g = gesture(s, h.bounds_in_window.x + Math.floor(h.width / 2) + 60);
  await action(s, g.target, { ...g.input, end_x: parts(s).parent.width + 1 }, 'failed');
  s = await snap(dialogID); assert.deepEqual(parts(s).handle.bounds_in_window, h.bounds_in_window);
  passed('endpoint outside the destination widget refuses before pressing or moving the narrow source handle');
  g = gesture(s, h.bounds_in_window.x + Math.floor(h.width / 2) + 60); await action(s, g.target, g.input);
  s = await snap(dialogID); const moved = parts(s).handle; report.moved = moved; report.after_png = await capture(s, 'after');
  const dx = moved.bounds_in_window.x - h.bounds_in_window.x; assert.ok(dx >= 50 && dx <= 70, JSON.stringify({ before: h, after: moved })); assert.notEqual(report.after_png, report.before_png);
  passed('MCP drag crosses the source handle boundary into its parent and actual splitter position advances by the requested distance');
  g = gesture(s, h.bounds_in_window.x + Math.floor(h.width / 2)); await action(s, g.target, g.input);
  s = await snap(dialogID); assert.ok(Math.abs(parts(s).handle.bounds_in_window.x - h.bounds_in_window.x) <= 2); report.restored_png = await capture(s, 'restored');
  await action(s, one(s, c => c.parent_id === '' && c.kind === 'widget'), { action: 'close' });
  assert.equal((await call('action_status', { action_id: openID, wait_ms: 1000 })).action.state, 'completed');
  assert.deepEqual((await call('status')).identity, report.identity); assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('reverse cross-control drag restores the splitter; its blocking dialog closes and original service/INI/executable remain intact'); report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; console.error(e.stack); process.exitCode = 1;
  try { const s = await snap(dialogID); await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(s, null, 2)); } catch {}
} finally {
  clearTimeout(watchdog); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
