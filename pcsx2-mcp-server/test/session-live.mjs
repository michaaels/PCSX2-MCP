// Optional native integration test. Starts/stops only its own emulator process.
// node test/session-live.mjs <pcsx2-qt executable> <homebrew ELF> <artifact directory>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

const [executable, elf, output] = process.argv.slice(2).map(value => path.resolve(value));
const nullRenderer = process.argv[5] === '--null-renderer';
assert.ok(executable && elf && output, 'Expected executable, ELF and artifact directory');
const probe = new DebugServerClient();
try { await probe.connect(); probe.disconnect(); throw new Error('Port 21512 already in use; close the existing VM before this test'); }
catch (error) { if (!/ECONNREFUSED/.test(error.message)) throw error; }
await fs.mkdir(output, { recursive: true });
const ini = path.join(path.dirname(executable), 'inis', 'PCSX2.ini');
let savedIni;
if (nullRenderer) {
  savedIni = await fs.readFile(ini, 'utf8');
  const replaced = savedIni.replace(/(\[EmuCore\/GS\][\s\S]*?\bRenderer\s*=\s*)-?\d+/, (_, prefix) => prefix + '11');
  assert.notEqual(replaced, savedIni, 'Expected a configured graphics renderer in portable INI');
  await fs.writeFile(ini, replaced);
}
const emulator = spawn(executable, ['-portable', '-nogui', '-fastboot', elf], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
let launchError;
emulator.on('error', error => { launchError = error; });
const client = new DebugServerClient();
let mcp;
const results = { emulator: executable, elf, started_at: new Date().toISOString(), checks: [] };
function passed(name) { results.checks.push(name); console.log('PASS ' + name); }
async function saveContext(name, context) {
  const { screenshot, ...metadata } = context;
  await fs.writeFile(path.join(output, name + '.json'), JSON.stringify({ ...metadata, screenshot: { ...screenshot, data: undefined } }, null, 2));
  if (screenshot.ok) await fs.writeFile(path.join(output, name + '.png'), Buffer.from(screenshot.data, 'base64'));
}
try {
  for (let attempt = 0; ; attempt++) {
    if (launchError) throw launchError;
    assert.equal(emulator.exitCode, null, 'Emulator exited during startup');
    try { await client.connect(); break; }
    catch (error) { client.disconnect(); if (attempt >= 80) throw error; await delay(250); }
  }
  const capabilities = await client.getCapabilities();
  for (const feature of ['screenshot', 'events', 'console_logs', 'capture_context', 'load_elf']) assert.ok(capabilities.features.includes(feature));
  results.capabilities = capabilities;
  passed('native protocol capabilities');
  if (nullRenderer) {
    await client.resume();
    await delay(500);
    const context = await client.captureContext();
    assert.equal(context.was_running, true);
    assert.equal(context.screenshot.ok, false);
    assert.equal((await client.getStatus()).paused, false);
    await saveContext('no-frame-context', context);
    await client.pause();
    assert.equal((await client.captureContext()).screenshot.ok, false);
    assert.equal((await client.getStatus()).paused, true);
    passed('no-frame partial contexts restore both running and paused states');
    results.passed = true;
  } else {
  for (let attempt = 0; ; attempt++) {
    try { await client.captureScreenshot(); break; }
    catch (error) { if (attempt >= 80) throw error; await delay(250); }
  }
  // Allow this homebrew's GS startup to produce its splash/menu after boot.
  await delay(2000);
  await client.resume();
  const running = await client.captureContext({ memoryAddress: '0x00100000', memoryLength: 64 });
  assert.equal(running.was_running, true);
  assert.equal(running.status.data.paused, true);
  assert.equal(running.read_registers.data.pc, running.status.data.pc);
  assert.equal(running.memory.hex.length, 128);
  assert.equal(running.screenshot.ok, true);
  assert.equal((await client.getStatus()).paused, false);
  await saveContext('running-context', running);
  passed('context collects a stopped CPU and restores running state');

  await client.pause();
  const paused = await client.captureContext();
  const repeated = await client.captureContext();
  assert.equal(paused.was_running, false);
  assert.equal((await client.getStatus()).paused, true);
  assert.equal(paused.screenshot.data, repeated.screenshot.data);
  await saveContext('paused-context', paused);
  passed('context preserves pause and yields identical paused frames');
  const logs = { logs: [] };
  let logCursor = 0;
  for (;;) {
    const page = await client.readLogs(logCursor, 200);
    logs.logs.push(...page.logs);
    if (page.next_cursor === logCursor) break;
    logCursor = page.next_cursor;
  }
  assert.ok(logs.logs.some(log => /Pausing|Resuming/.test(log.message)));
  await fs.writeFile(path.join(output, 'console-logs.json'), JSON.stringify(logs, null, 2));
  passed('independent console observer captures native VM logs');

  await assert.rejects(client.loadElf(path.join(output, 'missing.elf')), /does not exist/);
  const invalid = path.join(output, 'invalid.elf');
  await fs.writeFile(invalid, 'This is not an ELF'.repeat(4));
  await assert.rejects(client.loadElf(invalid), /MIPS ELF/);
  assert.equal((await client.getStatus()).paused, true);
  passed('missing and invalid ELF files do not reset or resume the VM');

  // Copy with spaces and Unicode to exercise the actual JSON/path boundary.
  const copy = path.join(path.dirname(executable), 'session test á.elf');
  await fs.copyFile(elf, copy);
  try {
    const bytes = await fs.readFile(copy);
    const entry = bytes.readUInt32LE(24);
    const address = '0x' + entry.toString(16).padStart(8, '0');
    await client.clearAllBreakpoints();
    await client.setBreakpoint(address);
    const loaded = await client.loadElf(copy);
    assert.equal(loaded.reset_requested, true);
    let events = await client.readEvents();
    assert.ok(events.events.some(event => event.type === 'elf_load_requested' && event.detail === copy));
    passed('loads and requests reset for a Windows ELF path with spaces and Unicode');
    const waiting = client.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 15000 });
    await client.resume();
    const hit = await waiting;
    assert.equal(hit.timed_out, false);
    assert.equal(hit.events[0].cpu, 'ee');
    assert.equal(hit.events[0].pc, address);
    assert.equal((await client.getStatus()).paused, true);
    await fs.writeFile(path.join(output, 'breakpoint-event.json'), JSON.stringify(hit, null, 2));
    passed('real EE breakpoint event reaches an already waiting client');
    await client.removeBreakpoint(address);

    await client.setMemcheck('0x00000000', '0x02000000', { type: 'write', action: 'break', cpu: 'ee' });
    events = await client.readEvents(hit.next_cursor);
    const watchWaiting = client.waitEvent({ after: events.next_cursor, type: 'watchpoint', timeoutMs: 10000 });
    await client.resume();
    const watch = await watchWaiting;
    assert.equal(watch.timed_out, false);
    assert.equal(watch.events[0].cpu, 'ee');
    await fs.writeFile(path.join(output, 'watchpoint-event.json'), JSON.stringify(watch, null, 2));
    passed('real EE write watchpoint is distinguished from an instruction breakpoint');
    await client.clearAllBreakpoints();
  } finally { await fs.rm(copy, { force: true }); }

  const cursor = (await client.readEvents(0, 200)).next_cursor;
  // Generate enough real transitions to overwrite the bounded 512-event ring.
  for (let i = 0; i < 260; i++) { await client.resume(); await client.pause(); }
  const overflow = await client.readEvents(0, 200);
  assert.equal(overflow.dropped, true);
  assert.equal(overflow.events.length, 200);
  assert.ok(overflow.oldest_sequence > 1);
  assert.ok(overflow.next_cursor > cursor);
  passed('bounded native history reports overwritten events and paginates');

  client.disconnect();
  mcp = new Client({ name: 'native-session-live', version: '1.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' }));
  await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug' } });
  const capture = await mcp.callTool({ name: 'pcsx2_capture_context', arguments: { output_directory: output } });
  assert.ok(!capture.isError, JSON.stringify(capture.content));
  assert.equal(capture.content[1].type, 'image');
  results.artifacts = JSON.parse(capture.content[0].text).artifacts;
  passed('real MCP stdio returns context JSON, PNG and saved artifacts');
  results.passed = true;
  }
} finally {
  client.disconnect();
  await mcp?.close();
  if (emulator.exitCode === null && !launchError) {
    const exited = new Promise(resolve => emulator.once('exit', resolve));
    emulator.kill();
    await Promise.race([exited, delay(2000)]);
  }
  if (savedIni !== undefined) await fs.writeFile(ini, savedIni);
  results.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
