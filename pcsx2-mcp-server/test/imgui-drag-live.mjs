// Real Big Picture slider drag, verified by presentation PNG + independent Qt setting.
// node test/imgui-drag-live.mjs <PCSX2> <configured root> <new output>
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
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8');
function setting(section, key, value) { ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), ''); const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm'); ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`; }
setting('AutoUpdater', 'CheckAtStartup', 'false'); setting('SPU2/Output', 'StandardVolume', '100');
setting('UI', 'FullscreenUIDefaultToGameList', 'false'); setting('UI', 'FullscreenUITheme', 'Dark');
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
async function closedPort(port) { return new Promise(resolve => { const s = createConnection({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => { s.destroy(); resolve(true); }); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); }); }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_imgui_drag', actor: 'mcp_qt_ui', executable, native_sha256: hash(await fs.readFile(executable)),
  data_directory: root, ui_port: uiPort, checks: [], actions: [], passed: false, Computer_Use_used: false, physical_validation: 'not_performed', SMS_or_Jellyfin_involved: false };
const mcp = new Client({ name: 'imgui-drag-live', version: '1.0' }); let native, transport, log, watchdog, mainID, surfaceID, last;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function call(name, args = {}) { const r = await mcp.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 15000 }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap(window_id) { last = await call('snapshot', window_id ? { window_id, max_nodes: 5000 } : { max_nodes: 5000 }); return last; }
function one(s, predicate) { const a = s.controls.filter(predicate); assert.equal(a.length, 1, JSON.stringify(a)); return a[0]; }
async function action(s, target, input, wait = true) { const q = await call('action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  const result = await call('action_status', { action_id: q.action.action_id, wait_ms: wait ? 2000 : 0 }); report.actions.push({ target, input, receipt: result.action });
  if (wait) assert.equal(result.action.state, 'completed', JSON.stringify(result)); return q.action.action_id; }
async function surfaceAction(input) { const s = await snap(surfaceID); return action(s, one(s, c => c.kind === 'surface'), input); }
async function clickFraction(x, y) { const s = await snap(surfaceID), c = one(s, c => c.kind === 'surface'); await action(s, c, { action: 'mouse', x: Math.floor(c.width * x), y: Math.floor(c.height * y) }); await delay(180); }
async function capture(name) { const s = await snap(surfaceID); const r = await mcp.callTool({ name: 'pcsx2_ui_screenshot', arguments: { snapshot_id: s.snapshot_id, window_id: s.window_id } }); assert.ok(!r.isError, JSON.stringify(r));
  const meta = JSON.parse(r.content.find(c => c.type === 'text').text); assert.equal(meta.capture_method, 'd3d11_present_buffer_with_imgui'); const bytes = Buffer.from(r.content.find(c => c.type === 'image').data, 'base64'); const image = PNG.sync.read(bytes);
  assert.ok(image.width > 500 && image.height > 300); const colors = new Set(); for (let i = 0; i < image.data.length; i += 4) colors.add(image.data.readUInt32LE(i)); assert.ok(colors.size > 32);
  await fs.writeFile(path.join(output, name + '.png'), bytes, { flag: 'wx' }); return { file: name + '.png', sha256: hash(bytes), width: image.width, height: image.height, capture_method: meta.capture_method }; }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); transport?.close().catch(() => {}); }, 90000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  for (let i = 0; ; ++i) { try { await call('connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); break; } catch (e) { assert.ok(i < 100 && native.exitCode === null, String(e)); await delay(100); } }
  let s = await snap(); mainID = s.windows.find(w => w.class === 'MainWindow').window_id; report.identity = s.identity;
  s = await snap(mainID); await action(s, one(s, c => c.object_name === 'actionStartFullscreenUI' && c.enabled), { action: 'trigger' }, false);
  for (let i = 0; ; ++i) { s = await snap(); surfaceID = s.windows.find(w => w.class === 'DisplaySurface')?.window_id; if (surfaceID) break; assert.ok(i < 100); await delay(25); }
  await surfaceAction({ action: 'focus' }); await delay(400); report.landing = await capture('landing');
  await clickFraction(0.61, 0.45); report.interface = await capture('interface');
  await clickFraction(0.646, 0.032); report.audio = await capture('audio');
  await clickFraction(0.6, 0.19); report.dialog_before = await capture('dialog-before');
  assert.equal(await closedPort(debugPort), true);
  passed('actual Big Picture Audio slider popup is reached/captured through MCP without starting a VM or DebugServer');
  // Coordinates are calibrated against the retained application presentation,
  // expressed as fractions of logical surface size (independent of PNG DPR).
  s = await snap(surfaceID); const c = one(s, v => v.kind === 'surface'); report.surface = c;
  const id = await action(s, c, { action: 'drag', x: Math.floor(c.width * 0.5), y: Math.floor(c.height * 0.48), end_x: Math.floor(c.width * 0.6), end_y: Math.floor(c.height * 0.48), duration_ms: 600 }, false);
  assert.equal((await call('action_status', { action_id: id })).action.state, 'running');
  assert.equal((await call('action_status', { action_id: id, wait_ms: 2000 })).action.state, 'completed'); await delay(150);
  report.dialog_after = await capture('dialog-after'); assert.notEqual(report.dialog_after.sha256, report.dialog_before.sha256);
  passed('actual Big Picture receives a timed MCP drag with a running/completed receipt and changed presentation');
  await surfaceAction({ action: 'key', key: 'Escape' }); await delay(150);
  s = await snap(mainID); await action(s, one(s, v => v.object_name === 'actionStartFullscreenUI'), { action: 'trigger' }, false);
  for (let i = 0; ; ++i) { s = await snap(mainID); if (!s.windows.some(w => w.class === 'DisplaySurface')) break; assert.ok(i < 100); await delay(25); }
  await action(s, one(s, v => v.object_name === 'actionAudioSettings'), { action: 'trigger' }, false); await delay(350); s = await snap();
  const volume = one(s, v => v.object_name === 'standardVolume' && v.visible); report.qt_volume = volume.value;
  assert.ok(volume.value > 100 && volume.value <= 200, JSON.stringify(volume));
  passed('independent actual Qt Audio Settings readback confirms the ImGui gesture changed StandardVolume above its exact baseline');
  await action(s, volume, { action: 'set_value', value: 100 }); s = await snap(); assert.equal(one(s, v => v.object_name === 'standardVolume' && v.visible).value, 100);
  await action(s, one(s, v => v.parent_id === '' && v.kind === 'widget'), { action: 'close' });
  assert.equal(await closedPort(debugPort), true); assert.deepEqual((await call('status')).identity, report.identity);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('original volume restores through Qt and configured source INI/native executable remain unchanged'); report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; console.error(e.stack); process.exitCode = 1;
  if (last) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(last, null, 2));
} finally {
  clearTimeout(watchdog); await mcp.close().catch(e => { report.cleanup_error = String(e); }); report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
