// node test/dap-live.mjs <PCSX2> <standalone render fixture> <configured root> <new output>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { DapClient } from './dap-client.mjs';

assert.equal(process.argv.length, 6);
const [executable, input, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const root = path.join(output, 'instance'), fixture = path.join(output, 'fixture');
const hash = b => createHash('sha256').update(b).digest('hex');
const report = { kind: 'native_DAP_MCP_crosscheck', passed: false, checks: [], dap_sessions: [], SMS_or_Jellyfin_involved: false, editor_acceptance: 'not_performed', physical_validation: 'not_performed' };
let native, inspector, dap, mcp, transport, log, watchdog;
const transcripts = [];
const passed = message => { report.checks.push(message); console.log('PASS ' + message); };
async function tool(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content[0].text);
}
async function stack() { return (await dap.call('stackTrace', { threadId: 1, levels: 1 })).stackFrames[0]; }
async function closeDap() { if (!dap) return; await dap.close(); report.dap_sessions.at(-1).stopped = true; transcripts.push(...dap.transcript); dap = undefined; }
try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'))); assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
  for (const [name, sha] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(hash(await fs.readFile(path.join(fixture, name))), sha); }
  const sources = fileURLToPath(new URL('./fixtures/standalone/', import.meta.url));
  for (const name of await fs.readdir(sources)) assert.equal(hash(await fs.readFile(path.join(sources, name))), manifest.sha256[name]);
  const elf = path.join(fixture, 'standalone.elf'), source = { path: path.join(fixture, 'standalone.c') };
  const iniPath = path.join(configured, 'inis/PCSX2.ini'), ini = await fs.readFile(iniPath); report.config_sha256 = hash(ini);
  await fs.mkdir(path.join(root, 'inis'), { recursive: true }); await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const port = server.address().port; await new Promise(ok => server.close(ok));
  report.native_sha256 = hash(await fs.readFile(executable)); report.elf_sha256 = manifest.sha256['standalone.elf'];
  report.inputs = {};
  for (const relative of ['../dist/dap.js', '../dist/dap-session.js', '../dist/dap-wire.js',
    '../src/dap.ts', '../src/dap-session.ts', '../src/dap-wire.ts', './dap-live.mjs', './dap-client.mjs'])
    report.inputs[relative] = hash(await fs.readFile(fileURLToPath(new URL(relative, import.meta.url))));
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); dap?.child.kill(); }, 180000);
  inspector = new DebugServerClient('127.0.0.1', port);
  for (let n = 0; ; n++) {
    assert.equal(native.exitCode, null);
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (e) { inspector.disconnect(); if (n >= 199) throw e; await delay(100); }
  }
  for (let n = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; n++) { assert.ok(n < 200); await delay(100); }
  await delay(1500);
  mcp = new Client({ name: 'dap-crosscheck', version: '1.0' });
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport);
  assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: port } })).isError);
  dap = new DapClient(); report.dap_pid = dap.child.pid;
  report.dap_sessions.push({ pid: dap.child.pid, stopped: false });
  const capabilities = await dap.call('initialize', { adapterID: 'pcsx2', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
  assert.equal(capabilities.supportsReadMemoryRequest, true); assert.equal(capabilities.supportsWriteMemoryRequest, false);
  await dap.call('attach', { port, elf, expectedSha256: report.elf_sha256, pathMappings: [{ from: '/fixture', to: fixture }] });
  report.initial = await inspector.getCapabilities();
  assert.equal(report.initial.process_id, native.pid); assert.equal(path.resolve(report.initial.data_directory), root);
  const bp = await dap.call('setBreakpoints', { source, breakpoints: [{ line: 7 }] }); assert.equal(bp.breakpoints[0].verified, true, JSON.stringify(bp));
  const entryCursor = dap.events.length; await dap.call('configurationDone'); await dap.waitStopped(entryCursor);
  const after = dap.events.length;
  await dap.call('continue', { threadId: 1 }); await dap.waitStopped(after);
  report.frame = await stack(); assert.equal(report.frame.line, 7); assert.equal(path.resolve(report.frame.source.path), source.path);
  const status = await inspector.getStatus(); assert.equal(status.paused, true); assert.equal(report.frame.instructionPointerReference, status.pc);
  const current = await tool('pcsx2_source_pc'); assert.equal(current.locations[0].frames[0].line, report.frame.line);
  report.mcp_source = current;
  passed('Real DAP stdio attaches to its private native instance and stops on the exact mapped C source line; MCP agrees');
  const scopes = (await dap.call('scopes', { frameId: report.frame.id })).scopes;
  const registers = (await dap.call('variables', { variablesReference: scopes[0].variablesReference })).variables;
  const locals = (await dap.call('variables', { variablesReference: scopes[1].variablesReference })).variables;
  const mcpVariables = await tool('pcsx2_variables', { frame_index: 0 }); report.mcp_variables = mcpVariables;
  assert.equal(mcpVariables.snapshot.pc, report.frame.instructionPointerReference);
  assert.deepEqual(registers.slice(0, 32).map(r => r.value), mcpVariables.snapshot.gpr);
  const increment = locals.find(v => v.name === 'increment'), mcpIncrement = mcpVariables.variables.find(v => v.name === 'increment');
  assert.equal(increment?.value, '1'); assert.equal(increment.value, mcpIncrement.value); assert.ok(increment.memoryReference);
  const memory = await dap.call('readMemory', { memoryReference: increment.memoryReference, count: 4 });
  assert.equal(Buffer.from(memory.data, 'base64').toString('hex'), await inspector.readMemoryStrict(increment.memoryReference, 4));
  assert.equal(Buffer.from(memory.data, 'base64').readUInt32LE(), 1);
  report.dap_locals = locals; report.dap_registers = registers; report.dap_memory = memory;
  assert.deepEqual(await inspector.getStatus(), status);
  passed('DAP frame-0 arguments, all 128-bit EE GPRs and guarded RAM agree with MCP/actual native state without advancing it');
  await dap.call('setBreakpoints', { source, breakpoints: [] }); assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  await dap.call('stepIn', { threadId: 1, granularity: 'instruction' });
  assert.equal((await inspector.getStatus()).pc, '0x' + (Number(status.pc) + 4).toString(16).padStart(8, '0'));
  const expired = await dap.raw('scopes', { frameId: report.frame.id }); assert.equal(expired.success, false);
  assert.equal((await dap.raw('variables', { variablesReference: scopes[0].variablesReference })).success, false);
  passed('Actual EE instruction step advances PC and old frame/scope references refuse reuse');
  const sourceSteps = [];
  for (const command of ['next', 'stepOut', 'stepIn']) {
    const before = await tool('pcsx2_source_pc');
    await dap.call(command, { threadId: 1, granularity: 'line' });
    const frame = await stack(), observed = await tool('pcsx2_source_pc');
    assert.equal(frame.instructionPointerReference, observed.locations[0].address);
    assert.equal(frame.line, observed.locations[0].frames[0].line);
    assert.notDeepEqual([before.locations[0].frames[0].file, before.locations[0].frames[0].line],
      [observed.locations[0].frames[0].file, observed.locations[0].frames[0].line]);
    sourceSteps.push({ command, frame, mcp_source: observed });
  }
  report.source_steps = sourceSteps;
  passed('Actual DAP source next/out/into execute the supported EE backend and match fresh MCP PC/source at each stop');
  const frameBeforeReset = await stack(); const beforeReset = await inspector.getCapabilities();
  await inspector.loadElf(elf); await inspector.resume(); await delay(1000); await inspector.pause();
  assert.ok((await inspector.getCapabilities()).execution_epoch > beforeReset.execution_epoch);
  assert.equal((await dap.raw('scopes', { frameId: frameBeforeReset.id })).success, false);
  await closeDap();
  dap = new DapClient(); report.dap_sessions.push({ pid: dap.child.pid, stopped: false });
  await dap.call('initialize');
  await dap.call('attach', { port, elf, expectedSha256: report.elf_sha256, pathMappings: [{ from: '/fixture', to: fixture }] });
  const resetEntry = dap.events.length; await dap.call('configurationDone'); await dap.waitStopped(resetEntry);
  passed('Real same-ELF reset invalidates pre-reset references; a fresh explicit DAP attach recovers the same owned emulator');
  const reinstalled = await dap.call('setBreakpoints', { source, breakpoints: [{ line: 7 }] }); assert.equal(reinstalled.breakpoints[0].verified, true);
  const address = reinstalled.breakpoints[0].instructionReference;
  await inspector.setBreakpoint(address, { description: 'DAP foreign control' });
  const foreign = await inspector.listBreakpoints('ee'), foreignState = await inspector.getStatus();
  const refused = await dap.raw('setBreakpoints', { source, breakpoints: [] }); assert.equal(refused.success, false); assert.match(refused.message, /ownership/);
  await dap.call('disconnect'); await closeDap(); report.dap_stopped = true;
  assert.deepEqual(await inspector.listBreakpoints('ee'), foreign); assert.deepEqual(await inspector.getStatus(), foreignState);
  assert.equal(native.exitCode, null); await inspector.removeBreakpoint(address);
  passed('Changed source point survives DAP replacement refusal and detach; the attached native process/pause are retained');
  assert.equal(hash(await fs.readFile(executable)), report.native_sha256); assert.equal(hash(await fs.readFile(iniPath)), report.config_sha256);
  report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; process.exitCode = 1; }
finally {
  clearTimeout(watchdog); inspector?.disconnect();
  if (dap && !report.dap_stopped) try { await closeDap(); report.dap_stopped = true; } catch (e) { report.dap_cleanup_error = String(e); report.passed = false; }
  try { await mcp?.close(); report.mcp_stopped = !transport || transport.pid === null; } catch (e) { report.mcp_cleanup_error = String(e); report.passed = false; }
  if (native && native.exitCode === null && native.signalCode === null) { const exited = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([exited, delay(5000)]); }
  report.native_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  if (!report.native_stopped || !report.mcp_stopped || !report.dap_stopped || report.dap_sessions.some(s => !s.stopped)) report.passed = false;
  if (dap) transcripts.push(...dap.transcript);
  await fs.writeFile(path.join(output, 'dap-transcript.json'), JSON.stringify(transcripts, null, 2) + '\n');
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) { process.exitCode = 1; console.log('FAIL ' + report.failure); }
}
