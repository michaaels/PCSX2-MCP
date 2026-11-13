// Two real MCP peers race a rendered capture with actual surface destruction.
// node test/ui-capture-lifetime-live.mjs <PCSX2> <configured root> <new output> [d3d11|d3d12|opengl]
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

assert.ok(process.argv.length === 5 || process.argv.length === 6);
const renderer = process.argv[5] ?? 'd3d12'; assert.ok(['d3d11', 'd3d12', 'opengl'].includes(renderer));
const captureSupported = renderer !== 'opengl';
const [executable, configured, output] = process.argv.slice(2, 5).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
const originalINI = await fs.readFile(path.join(configured, 'inis/PCSX2.ini')); let ini = originalINI.toString('utf8');
for (const [section, key, value] of [['AutoUpdater', 'CheckAtStartup', 'false'], ['EmuCore/GS', 'Renderer', renderer === 'd3d12' ? '15' : renderer === 'opengl' ? '12' : '3'], ['UI', 'FullscreenUIDefaultToGameList', 'false']]) {
  ini = ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`, 'gm'), ''); const marker = new RegExp(`^\\[${section}\\]\\r?\\n`, 'm');
  ini = marker.test(ini) ? ini.replace(marker, `[${section}]\n${key} = ${value}\n`) : ini + `\n[${section}]\n${key} = ${value}\n`;
}
await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_rendered_capture_window_lifetime', renderer, capture_supported: captureSupported, executable, native_sha256: hash(await fs.readFile(executable)),
  actor: 'mcp_qt_ui', data_directory: root, checks: [], rounds: [], passed: false, SMS_or_Jellyfin_involved: false, Computer_Use_used: false, physical_validation: 'not_performed' };
const peers = []; let native, log, watchdog;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function peer(name) {
  const client = new Client({ name, version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }); transport.stderr?.resume();
  const p = { client, transport }; peers.push(p); await client.connect(transport); return p;
}
async function raw(p, name, args = {}) { return p.client.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 13000 }); }
async function call(p, name, args = {}) { const r = await raw(p, name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content[0].text); }
async function snap(p, window_id) { return call(p, 'snapshot', window_id ? { window_id } : {}); }
async function toggle(p) {
  let s, target;
  for (let i = 0; ; ++i) { s = await snap(p, p.mainID); target = s.controls.find(c => c.object_name === 'actionStartFullscreenUI'); if (target?.enabled) break; assert.ok(i < 200); await delay(25); }
  const q = await call(p, 'action', { snapshot_id: s.snapshot_id, control_id: target.id, action: 'trigger' });
  const done = await call(p, 'action_status', { action_id: q.action.action_id, wait_ms: 2000 }); assert.equal(done.action.state, 'completed', JSON.stringify(done)); return done.action;
}
async function surface(p, visible = true) {
  for (let i = 0; ; ++i) { const s = await snap(p, p.mainID), list = s.windows.filter(w => w.class === 'DisplaySurface');
    if (!visible && list.length === 0) return s;
    if (visible && list.length === 1) return snap(p, list[0].window_id);
    assert.ok(i < 200, JSON.stringify(s.windows)); await delay(25);
  }
}
function png(result, windowID) {
  assert.ok(!result.isError, JSON.stringify(result.content.filter(c => c.type === 'text')));
  const metadata = JSON.parse(result.content.find(c => c.type === 'text').text); assert.equal(metadata.window_id, windowID); assert.equal(metadata.capture_method, renderer + '_present_buffer_with_imgui');
  const bytes = Buffer.from(result.content.find(c => c.type === 'image').data, 'base64'); assert.ok(PNG.sync.read(bytes).width > 100); return bytes;
}
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx'); native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); for (const p of peers) p.transport.close().catch(() => {}); }, 90000); watchdog.unref();
  const reader = await peer('capture-lifetime-reader'), actor = await peer('capture-lifetime-actor');
  for (const p of peers) {
    for (let i = 0; ; ++i) { try { await call(p, 'connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); break; } catch (e) { assert.ok(i < 100 && native.exitCode === null, String(e)); await delay(100); } }
    const s = await snap(p); p.mainID = s.windows.find(w => w.class === 'MainWindow').window_id;
  }
  report.identity = (await call(reader, 'status')).identity; assert.deepEqual((await call(actor, 'status')).identity, report.identity);
  await toggle(actor); let s = await surface(reader); await delay(150); s = await snap(reader, s.window_id);
  const initialCapture = await raw(reader, 'screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id });
  if (captureSupported) await fs.writeFile(path.join(output, 'initial.png'), png(initialCapture, s.window_id), { flag: 'wx' });
  else { assert.equal(initialCapture.isError, true); assert.match(JSON.stringify(initialCapture.content), /Rendered UI capture timed out/); report.unsupported_control = initialCapture.content; }
  passed('two actual MCP stdio peers share the pinned frontend identity and the renderer-specific capture/refusal contract');
  for (let round = 0; round < 6; ++round) {
    if (round) { await toggle(actor); await surface(reader); await delay(100); }
    s = await surface(reader); const closing = await snap(actor, actor.mainID), action = closing.controls.find(c => c.object_name === 'actionStartFullscreenUI'); assert.ok(action?.enabled);
    const started = performance.now(), entry = { round, window_id: s.window_id, state: 'pending' }; report.rounds.push(entry);
    // Different native UI sockets: the close action is not serialized behind
    // the reader's pending screenshot. No Qt/GPU test hook delays the response.
    const capture = raw(reader, 'screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }).then(value => ({ value }), error => ({ error: String(error) }));
    await delay(captureSupported ? round % 3 : 100);
    const queued = await call(actor, 'action', { snapshot_id: closing.snapshot_id, control_id: action.id, action: 'trigger' });
    await surface(actor, false);
    const outcome = await capture; entry.elapsed_ms = performance.now() - started;
    assert.ok(!outcome.error, JSON.stringify(outcome)); assert.ok(entry.elapsed_ms < 1500, JSON.stringify(entry));
    if (outcome.value.isError) {
      entry.state = 'native_refusal'; entry.error = outcome.value.content.filter(c => c.type === 'text');
      assert.doesNotMatch(JSON.stringify(entry.error), /Command timeout|not connected|connection changed/);
    } else { entry.state = 'completed_before_close'; entry.png_sha256 = hash(png(outcome.value, s.window_id)); }
    const receipt = await call(actor, 'action_status', { action_id: queued.action.action_id, wait_ms: 1000 }); assert.equal(receipt.action.state, 'completed');
    assert.deepEqual((await call(reader, 'status')).identity, report.identity); assert.deepEqual((await call(actor, 'status')).identity, report.identity);
    const now = await snap(reader, reader.mainID);
    const retired = await raw(reader, 'screenshot', { snapshot_id: now.snapshot_id, window_id: s.window_id }); assert.equal(retired.isError, true);
    entry.state_verified = true;
  }
  if (!captureSupported) assert.ok(report.rounds.every(r => r.state === 'native_refusal' && /Capture window was destroyed/.test(JSON.stringify(r.error))), 'Unsupported presentation leaves genuine pending requests which must cancel on actual window destruction');
  passed('six real surface-close races finish promptly with an explicit result/refusal and both original UI connections usable');
  passed('closed surfaces refuse capture under fresh snapshots without substituting another window image');
  await toggle(actor); s = await surface(reader); await delay(150); s = await snap(reader, s.window_id);
  const recreated = await raw(reader, 'screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id });
  if (captureSupported) await fs.writeFile(path.join(output, 'recreated.png'), png(recreated, s.window_id), { flag: 'wx' });
  else { assert.equal(recreated.isError, true); assert.match(JSON.stringify(recreated.content), /Rendered UI capture timed out/); }
  assert.deepEqual((await call(reader, 'status')).identity, report.identity);
  await toggle(actor); await surface(actor, false);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), originalINI); assert.equal(hash(await fs.readFile(executable)), report.native_sha256);
  passed('a recreated rendered surface retains its capture/refusal contract without reconnecting; source INI/native file and frontend identity stay unchanged'); report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; console.error(e.stack); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const p of peers) await p.client.close().catch(e => { report.cleanup_error = String(e); });
  report.mcp_sessions = peers.map(p => ({ stopped: p.transport.pid === null })); report.mcp_stopped = report.mcp_sessions.every(p => p.stopped);
  if (native && native.exitCode === null && native.signalCode === null) { const stopped = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([stopped, delay(5000)]); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null); if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
