// node test/application-screenshot-live.mjs <PCSX2> <render fixture> <configured root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6);
const [executable, fixture, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const hash = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json')));
assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
for (const [name, sha] of Object.entries(manifest.sha256)) {
  assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha);
}
const elf = path.join(fixture, 'standalone.elf'), ini = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'));
const result = { kind: 'application_screenshot_live', native_sha256: hash(await fs.readFile(executable)),
  checks: [], instances: [], images: [], passed: false, SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const passed = name => { result.checks.push(name); console.log('PASS ' + name); };
async function freePort() {
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port; await new Promise(ok => server.close(ok)); return port;
}
async function launch(name, mode) {
  const root = path.join(output, name); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
  await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const port = await freePort(), client = new DebugServerClient('127.0.0.1', port);
  const child = spawn(executable, ['-portable', mode, elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root }, stdio: 'ignore' });
  const mcp = new Client({ name: 'application-screenshot-live', version: '1.0' });
  const item = { name, root, port, child, client, mcp, owned_emulator_stopped: false }; instances.push(item);
  let spawnError; child.once('error', error => { spawnError = error; });
  for (let n = 0; ; n++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null);
    try {
      await client.connect(); const caps = await client.getCapabilities();
      assert.equal(caps.process_id, child.pid); assert.equal(caps.debug_port, port);
      assert.equal(path.normalize(caps.data_directory), path.normalize(root));
      if (!caps.elf || caps.elf_crc === '0x00000000') throw new Error('ELF not ready');
      assert.ok(caps.features.includes('application_screenshot')); item.identity = caps; break;
    } catch (error) { client.disconnect(); if (n >= 199) throw error; await delay(100); }
  }
  await client.pause();
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  const connected = await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: port } });
  assert.ok(!connected.isError); return item;
}
const instances = [];
async function capture(item, target, name, width = 1920, height = 1440) {
  const reply = await item.mcp.callTool({ name: 'pcsx2_application_screenshot', arguments: { target, width, height } });
  assert.ok(!reply.isError, JSON.stringify(reply.content));
  const content = reply.content.find(c => c.type === 'image'); assert.equal(content.mimeType, 'image/png');
  const metadata = JSON.parse(reply.content.find(c => c.type === 'text').text);
  assert.equal(metadata.target, target); assert.equal(metadata.source, 'qt_widget');
  const bytes = Buffer.from(content.data, 'base64'), image = PNG.sync.read(bytes);
  assert.equal(image.width, metadata.width); assert.equal(image.height, metadata.height);
  assert.ok(image.width <= width && image.height <= height);
  assert.ok(new Set(image.data).size > 8, 'Window image must contain actual nonuniform widget pixels');
  const filename = path.join(output, name + '.png'); await fs.writeFile(filename, bytes);
  result.images.push({ ...metadata, filename, sha256: hash(bytes) }); return metadata;
}
try {
  const gui = await launch('gui', '-debugger');
  const before = await gui.client.getStatus(), caps = await gui.client.getCapabilities();
  result.initial_gui_status = before;
  const debuggerImage = await capture(gui, 'debugger', 'debugger');
  assert.match(debuggerImage.window_title, /Debugger/);
  passed('MCP returns a real decoded PNG of the existing native debugger with Qt target metadata');
  await capture(gui, 'main', 'main');
  passed('the explicit main-window target returns application widgets independently of the debugger target');
  await capture(gui, 'debugger', 'debugger-small', 320, 240);
  passed('window capture scales the full client area within the requested pixel limits');
  assert.deepEqual(await gui.client.getStatus(), before);
  assert.deepEqual(await gui.client.getCapabilities(), caps);
  assert.deepEqual(await gui.client.listBreakpoints('ee'), []);
  passed('repeated application capture preserves paused CPU cycles/PC, native identity and breakpoints');
  const bad = await gui.mcp.callTool({ name: 'pcsx2_application_screenshot', arguments: { target: 'desktop' } });
  assert.equal(bad.isError, true); assert.deepEqual(await gui.client.getStatus(), before);
  passed('an unsupported desktop target is refused without affecting the paused instance');
  const hidden = await launch('hidden', '-nogui');
  const hiddenBefore = await hidden.client.getStatus();
  const missing = await hidden.mcp.callTool({ name: 'pcsx2_application_screenshot', arguments: { target: 'debugger' } });
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing.content), /not visible/);
  assert.deepEqual(await hidden.client.getStatus(), hiddenBefore);
  passed('a process without an open debugger refuses capture rather than creating a window or substituting another process');
  await capture(gui, 'debugger', 'debugger-after-other-instance');
  assert.deepEqual(await gui.client.getStatus(), before);
  passed('two native processes retain independent window targets and a rejected capture leaves the original connection usable');
  assert.equal(hash(await fs.readFile(executable)), result.native_sha256);
  assert.deepEqual(await fs.readFile(path.join(configured, 'inis/PCSX2.ini')), ini);
  result.passed = true;
} catch (error) { result.failure = String(error); throw error; }
finally {
  for (const item of instances) {
    item.client.disconnect(); await item.mcp.close().catch(() => {});
    if (item.child.pid && item.child.exitCode === null && item.child.signalCode === null) {
      await new Promise((ok, no) => { const timer = setTimeout(() => no(new Error('Owned instance did not stop')), 5000);
        item.child.once('exit', () => { clearTimeout(timer); ok(); }); item.child.kill(); });
    }
    item.owned_emulator_stopped = item.child.exitCode !== null || item.child.signalCode !== null;
    result.instances.push({ name: item.name, pid: item.child.pid, port: item.port, root: item.root,
      identity: item.identity, owned_emulator_stopped: item.owned_emulator_stopped });
    if (!item.owned_emulator_stopped) result.passed = false;
  }
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
}
