// Optional Windows acceptance: two real PCSX2 processes, private data roots and ports.
// node test/instance-ports-live.mjs <executable> <rendering ELF> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6, 'Expected executable, rendering ELF, configured data root, new output');
const [executable, elf, configured, output] = process.argv.slice(2).map(value => path.resolve(value));
await fs.mkdir(output); // Refuse to replace a previous receipt.
const ini = await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'));
const results = { started_at: new Date().toISOString(), executable, elf, checks: [] };
const clients = [], inspectors = [], owned = new Set();
const reservations = [];
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  reservations.push(server);
  return server.address().port;
}
async function mcp(port) {
  const client = new Client({ name: 'instance-live', version: '1.0' });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
function passed(name) { results.checks.push(name); console.log('PASS ' + name); }
try {
  const ports = [await reservePort(), await reservePort()];
  const roots = [path.join(output, 'instance-a'), path.join(output, 'instance-b')];
  for (const root of roots) {
    await fs.mkdir(path.join(root, 'inis'), { recursive: true });
    await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
  }
  for (const server of reservations) await new Promise(resolve => server.close(resolve));
  const [a, b, outsider] = [await mcp(ports[0]), await mcp(ports[1]), await mcp(ports[0])];
  const launches = [];
  for (const [index, client] of [a, b].entries()) {
    launches.push(await call(client, 'pcsx2_launch', { executable, elf, data_directory: roots[index] }));
    owned.add(client);
    assert.equal(launches[index].debug_port, ports[index]);
    assert.equal(launches[index].pid, launches[index].capabilities.process_id);
    assert.equal(await fs.realpath(launches[index].data_directory), await fs.realpath(roots[index]));
    const inspector = new DebugServerClient('127.0.0.1', ports[index]);
    await inspector.connect(); inspectors.push(inspector);
  }
  results.launches = launches;
  assert.notEqual(launches[0].pid, launches[1].pid);
  passed('two MCP instances launch distinct PIDs with their environment-selected ports and independent data roots');
  const collision = createServer();
  await assert.rejects(new Promise((resolve, reject) => {
    collision.once('error', reject);
    collision.listen(ports[0], '127.0.0.1', resolve);
  }), error => ['EADDRINUSE', 'EACCES'].includes(error.code));
  passed('the native listener prevents a second bind on its selected Windows port');
  const occupied = await outsider.callTool({ name: 'pcsx2_launch', arguments: { executable, elf, data_directory: roots[1] } });
  assert.equal(occupied.isError, true); assert.match(occupied.content[0].text, /occupied/);
  assert.equal((await outsider.callTool({ name: 'pcsx2_stop', arguments: {} })).isError, true);
  passed('occupied custom port is refused and a foreign MCP cannot stop either instance');
  for (const inspector of inspectors) {
    for (let attempt = 0; ; ++attempt) {
      const caps = await inspector.getCapabilities();
      if (caps.elf && caps.elf_crc !== '0x00000000') break;
      assert.ok(attempt < 80, 'ELF did not boot'); await delay(250);
    }
  }
  await delay(1500);
  await inspectors[0].pause(); await inspectors[1].resume(); await delay(200);
  assert.equal((await inspectors[0].getStatus()).paused, true);
  assert.equal((await inspectors[1].getStatus()).paused, false);
  passed('pausing instance A leaves B running');
  for (const [index, inspector] of inspectors.entries()) {
    let image;
    for (let attempt = 0; ; ++attempt) {
      try { image = await inspector.captureScreenshot(); break; }
      catch (error) { if (attempt >= 20) throw error; await delay(250); }
    }
    await fs.writeFile(path.join(output, `instance-${index}.png`), Buffer.from(image.data, 'base64'));
    const caps = await inspector.getCapabilities();
    assert.equal(caps.process_id, launches[index].pid);
  }
  passed('both connections capture real rendered PNGs and retain their own process identities');
  await call(a, 'pcsx2_stop'); owned.delete(a); await delay(200);
  await assert.rejects(inspectors[0].getStatus(), /connect|closed/i);
  assert.equal((await inspectors[1].getStatus()).alive, true);
  passed('stopping A closes its old connection while B remains alive');
  const again = await call(a, 'pcsx2_launch', { executable, elf, data_directory: roots[0] }); owned.add(a);
  assert.notEqual(again.pid, launches[0].pid);
  await assert.rejects(inspectors[0].getStatus(), /connect|closed/i);
  assert.equal((await inspectors[1].getCapabilities()).process_id, launches[1].pid);
  passed('restart reuses the selected port with a new PID; the old connection cannot control it');
  results.restarted = again;
} finally {
  for (const client of owned) { try { await call(client, 'pcsx2_stop'); } catch (error) { results.cleanup_error = String(error); } }
  for (const inspector of inspectors) inspector.disconnect();
  for (const client of clients) await client.close();
  for (const server of reservations) { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(results, null, 2));
}
