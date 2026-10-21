import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultPorts, tcpPort } from '../dist/ports.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { EmulatorLauncher } from '../dist/emulator-launcher.js';
import { debugServer } from './fixtures.mjs';

test('port defaults reject malformed overrides instead of connecting to a different instance', () => {
  assert.deepEqual(defaultPorts({}), { debug: 21512, pine: 28011 });
  assert.deepEqual(defaultPorts({ PCSX2_DEBUG_PORT: '22512', PCSX2_PINE_PORT: '29011' }), { debug: 22512, pine: 29011 });
  for (const value of ['', '0', '-1', '65536', '1.5', ' 21512', '21512x', '0x5408', '999999999999999999999']) {
    assert.throws(() => defaultPorts({ PCSX2_DEBUG_PORT: value }), /PCSX2_DEBUG_PORT/);
    assert.throws(() => defaultPorts({ PCSX2_PINE_PORT: value }), /PCSX2_PINE_PORT/);
  }
  for (const value of [0, -1, 65536, 1.1, NaN, Infinity]) {
    assert.equal(tcpPort.safeParse(value).success, false);
    assert.throws(() => new DebugServerClient('127.0.0.1', value));
  }
});

test('MCP connect/launch schemas share environment defaults and validate explicit ports', async t => {
  const mock = await debugServer(t, () => ({ ok: true, data: { pc: '0x00100000', paused: true } }));
  const client = new Client({ name: 'port-defaults', version: '1.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(mock.port), PCSX2_PINE_PORT: '29011' }, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools;
  const connect = tools.find(tool => tool.name === 'pcsx2_connect');
  const launch = tools.find(tool => tool.name === 'pcsx2_launch');
  assert.equal(connect.inputSchema.properties.debug_port.default, mock.port);
  assert.equal(connect.inputSchema.properties.pine_port.default, 29011);
  assert.equal(launch.inputSchema.properties.debug_port.default, mock.port);
  assert.ok(launch.inputSchema.properties.data_directory);
  const attached = await client.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } });
  assert.match(attached.content[0].text, /connected/);
  assert.equal(mock.requests[0].cmd, 'status');
  for (const debug_port of [0, 65536, 1.5]) {
    assert.equal((await client.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port } })).isError, true);
  }
  assert.equal(mock.requests.length, 1);
});

test('launcher checks its selected port and refuses an unconfigured or relative instance directory', async t => {
  const mock = await debugServer(t, () => ({ ok: true }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-instance-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elf = path.join(directory, 'game.elf');
  const header = Buffer.alloc(52);
  header.write('7f454c46', 0, 'hex'); header[4] = 1; header[5] = 1; header.writeUInt16LE(8, 18);
  await fs.writeFile(elf, header);
  const launcher = new EmulatorLauncher();
  const options = { executable: process.execPath, elf, debugPort: mock.port };
  await assert.rejects(launcher.launch(options), new RegExp(`port ${mock.port} is occupied`));
  await assert.rejects(launcher.launch({ ...options, dataDirectory: 'relative' }), /absolute/);
  await assert.rejects(launcher.launch({ ...options, dataDirectory: directory }), /ENOENT/);
  await assert.rejects(launcher.stop(), /No emulator owned/);
});
