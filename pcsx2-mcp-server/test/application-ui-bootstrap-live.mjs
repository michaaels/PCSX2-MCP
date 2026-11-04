// Actual first-run wizard control before MainWindow exists. Own process/root only.
// node test/application-ui-bootstrap-live.mjs <PCSX2> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { ApplicationUIClient } from '../dist/application-ui.js';

assert.equal(process.argv.length, 4);
const [executable, output] = process.argv.slice(2).map(p => path.resolve(p)); await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(root);
const sha = b => createHash('sha256').update(b).digest('hex');
async function port() { const s = createServer(); await new Promise(ok => s.listen(0, '127.0.0.1', ok)); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
const uiPort = await port(), debugPort = await port(); assert.notEqual(uiPort, debugPort);
const report = { kind: 'actual_mcp_setup_wizard', actor: 'mcp_qt_ui', executable, native_sha256: sha(await fs.readFile(executable)),
  data_directory: root, ui_port: uiPort, debug_port: debugPort, checks: [], passed: false, physical_validation: 'not_performed' };
const mcp = new Client({ name: 'ui-bootstrap-live', version: '1.0' }), other = new ApplicationUIClient();
let native, transport, log, watchdog, current;
const passed = name => { report.checks.push(name); console.log('PASS ' + name); };
async function raw(name, args = {}) { return mcp.callTool({ name: 'pcsx2_ui_' + name, arguments: args }, undefined, { timeout: 12000 }); }
async function call(name, args = {}) { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); }
async function snap() { current = await call('snapshot'); return current; }
function one(s, predicate) { const matches = s.controls.filter(predicate); assert.equal(matches.length, 1, JSON.stringify(matches)); return matches[0]; }
async function action(s, target, input, wait = true) {
  const r = await call('action', { snapshot_id: s.snapshot_id, control_id: target.id, ...input });
  const receipt = await call('action_status', { action_id: r.action.action_id, wait_ms: wait ? 1000 : 0 });
  assert.ok(!['failed', 'expired'].includes(receipt.action.state), JSON.stringify(receipt));
  if (wait) assert.equal(receipt.action.state, 'completed'); return r.action.action_id;
}
async function until(predicate) { for (let i = 0; ; ++i) { const s = await snap(); if (predicate(s)) return s; assert.ok(i < 100, JSON.stringify(s.windows)); await delay(50); } }
try {
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable'], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_MCP_DATA_DIR: root, PCSX2_UI_PORT: String(uiPort), PCSX2_DEBUG_PORT: String(debugPort) }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); transport?.close().catch(() => {}); }, 60000); watchdog.unref();
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  for (let i = 0; ; ++i) { const r = await raw('connect', { ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root }); if (!r.isError) break; assert.ok(i < 100 && native.exitCode === null); await delay(100); }
  let s = await until(v => v.controls.some(c => c.class === 'SetupWizardDialog'));
  assert.ok(!s.windows.some(w => w.class === 'MainWindow')); report.identity = s.identity;
  const png = await raw('screenshot', { snapshot_id: s.snapshot_id, window_id: s.window_id }); assert.ok(!png.isError);
  const bytes = Buffer.from(png.content.find(c => c.type === 'image').data, 'base64'), image = PNG.sync.read(bytes);
  assert.ok(image.width > 100 && image.height > 100); await fs.writeFile(path.join(output, 'wizard.png'), bytes, { flag: 'wx' }); report.png_sha256 = sha(bytes);
  passed('Qt service, inspection and genuine PNG operate inside first-run wizard before MainWindow/VM');
  await other.connect({ ui_port: uiPort, expected_process_id: native.pid, expected_data_directory: root });
  await assert.rejects(other.action({ snapshot_id: s.snapshot_id, control_id: one(s, c => c.object_name === 'next').id, action: 'click' }), /snapshot/);
  await assert.rejects(other.connect({ ui_port: uiPort, expected_process_id: native.pid + 1 }), /mismatch/);
  assert.equal((await call('status')).identity.service_id, report.identity.service_id);
  passed('actual second peer cannot consume another connection snapshot; wrong PID handshake refuses without affecting owner');
  await action(s, one(s, c => c.object_name === 'next'), { action: 'click' });
  s = await snap(); assert.equal(one(s, c => c.object_name === 'back').enabled, true);
  await action(s, one(s, c => c.object_name === 'back'), { action: 'click' });
  s = await snap(); assert.equal(one(s, c => c.object_name === 'back').enabled, false);
  passed('wizard Next and Back buttons genuinely change page navigation state');
  await action(s, one(s, c => c.object_name === 'cancel'), { action: 'click' }, false);
  s = await until(v => v.controls.some(c => c.class === 'QMessageBox'));
  await action(s, one(s, c => c.class === 'QPushButton' && /^&?No$/.test(c.text ?? '')), { action: 'click' });
  s = await until(v => v.controls.some(c => c.class === 'SetupWizardDialog'));
  assert.equal((await call('status')).identity.service_id, report.identity.service_id);
  passed('nested cancel confirmation remains controllable; No returns to same wizard/service');
  await action(s, one(s, c => c.object_name === 'cancel'), { action: 'click' }, false);
  s = await until(v => v.controls.some(c => c.class === 'QMessageBox'));
  await action(s, one(s, c => c.class === 'QPushButton' && /^&?Yes$/.test(c.text ?? '')), { action: 'click' }, false);
  for (let i = 0; native.exitCode === null && native.signalCode === null; ++i) { assert.ok(i < 100); await delay(50); }
  report.native_exit_code = native.exitCode;
  passed('confirmed wizard cancellation exits its owned native process');
  assert.equal(sha(await fs.readFile(executable)), report.native_sha256); report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; console.error(error.stack); process.exitCode = 1;
  if (current) await fs.writeFile(path.join(output, 'last-snapshot.json'), JSON.stringify(current, null, 2));
} finally {
  clearTimeout(watchdog); other.disconnect(); await mcp.close().catch(e => { report.cleanup_error = String(e); });
  report.mcp_stopped = !transport || transport.pid === null;
  if (native && native.exitCode === null && native.signalCode === null) { native.kill(); for (let i = 0; i < 100 && native.exitCode === null && native.signalCode === null; ++i) await delay(50); }
  report.owned_emulator_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  if (!report.mcp_stopped || !report.owned_emulator_stopped) { report.passed = false; process.exitCode = 1; }
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
}
