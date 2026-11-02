// Actual EE/IOP condition validation. This is API evidence, never a GUI edit.
// node conditional-points-live.mjs <PCSX2> <instruction fixture> <configured root> <new output> [--expect-old-bug|--legacy-capability-control]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.ok([6, 7].includes(process.argv.length));
const [executable, input, configured, output] = process.argv.slice(2, 6).map(p => path.resolve(p));
const oldBug = process.argv[6] === '--expect-old-bug', legacy = process.argv[6] === '--legacy-capability-control';
assert.ok(process.argv[6] === undefined || oldBug || legacy);
await fs.mkdir(output);
const fixture = path.join(output, 'fixture'), root = path.join(output, 'instance');
const sha = b => createHash('sha256').update(b).digest('hex');
const hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const words = b => Array.from({ length: b.length / 4 }, (_, i) => b.readUInt32LE(i * 4));
const report = { kind: 'conditional_point_atomic_validation', expected_old_bug: oldBug, passed: false, checks: [],
  legacy_capability_control: legacy, observations: [], GUI_acceptance: 'not_performed', SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, inspector, mcp, transport, log, watchdog;
const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
function symbol(elf, name) {
  const sh = elf.readUInt32LE(32), stride = elf.readUInt16LE(46), count = elf.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const at = sh + i * stride; if (elf.readUInt32LE(at + 4) !== 2) continue;
    const str = elf.readUInt32LE(sh + elf.readUInt32LE(at + 24) * stride + 16);
    const off = elf.readUInt32LE(at + 16), end = off + elf.readUInt32LE(at + 20), step = elf.readUInt32LE(at + 36);
    assert.ok(step >= 16);
    for (let p = off; p < end; p += step) {
      const n = str + elf.readUInt32LE(p); if (elf.subarray(n, elf.indexOf(0, n)).toString() === name) return elf.readUInt32LE(p + 4);
    }
  }
  throw new Error('Missing fixture symbol ' + name);
}
function elfBytes(elf, addr, size) {
  const ph = elf.readUInt32LE(28), stride = elf.readUInt16LE(42), count = elf.readUInt16LE(44);
  for (let i = 0; i < count; i++) {
    const p = ph + i * stride; if (elf.readUInt32LE(p) !== 1) continue;
    const off = elf.readUInt32LE(p + 4), base = elf.readUInt32LE(p + 8), len = elf.readUInt32LE(p + 16);
    if (addr >= base && addr + size <= base + len) return elf.subarray(off + addr - base, off + addr - base + size);
  }
  throw new Error('Missing PT_LOAD bytes');
}
async function eventCursor() { let h = await inspector.readEvents(0, 200); while (h.events.length === 200) h = await inspector.readEvents(h.next_cursor, 200); return h.next_cursor; }
async function resumeTo(cpu, target) {
  const after = await eventCursor(); await inspector.resume(cpu);
  assert.equal((await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 10000 })).timed_out, false);
  assert.equal((await inspector.readRegisters(cpu, 0)).pc, target);
}
async function snapshot() {
  const c = await inspector.getCapabilities();
  return { process: c.process_id, session: c.session, epoch: c.execution_epoch, reset: c.iop_reset_epoch, lifetime: c.iop_lifetime_epoch,
    elf: c.elf, crc: c.elf_crc, status: await inspector.getStatus(), ee: await inspector.readRegisters('ee', 0), iop: await inspector.readRegisters('iop', 0) };
}
async function rawTool(name, args = {}) { return mcp.callTool({ name, arguments: args }, undefined, { timeout: 20000 }); }
try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'))); assert.equal(manifest.kind, 'standalone_instruction_fixture');
  for (const [name, digest] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(sha(await fs.readFile(path.join(fixture, name))), digest); }
  const sources = fileURLToPath(new URL('./fixtures/instruction-control/', import.meta.url));
  for (const name of await fs.readdir(sources)) assert.equal(sha(await fs.readFile(path.join(sources, name))), manifest.sha256[name]);
  const elf = path.join(fixture, 'instruction-control.elf'), eeElf = await fs.readFile(elf);
  const irx = await fs.readFile(path.join(fixture, 'instruction-control.debug.irx'));
  const iniPath = path.join(configured, 'inis/PCSX2.ini'), originalIni = await fs.readFile(iniPath);
  report.config_sha256 = sha(originalIni); report.native_sha256 = sha(await fs.readFile(executable)); report.fixture = manifest;
  report.inputs = {};
  for (const relative of ['../dist/index.js', '../dist/debug-server-client.js', '../src/index.ts', '../src/debug-server-client.ts', './conditional-points-live.mjs'])
    report.inputs[relative] = sha(await fs.readFile(fileURLToPath(new URL(relative, import.meta.url))));
  if (!oldBug) for (const relative of ['../dist/breakpoint-tools.js', '../src/breakpoint-tools.ts'])
    report.inputs[relative] = sha(await fs.readFile(fileURLToPath(new URL(relative, import.meta.url))));
  await fs.mkdir(path.join(root, 'inis'), { recursive: true });
  let ini = originalIni.toString('utf8').replace(/^HostFs\s*=.*\r?\n/gm, '');
  ini = /^\[EmuCore\]\r?\n/m.test(ini) ? ini.replace(/^\[EmuCore\]\r?\n/m, '[EmuCore]\nHostFs = true\n') : ini + '\n[EmuCore]\nHostFs = true\n';
  await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port; await new Promise(ok => server.close(ok));
  log = await fs.open(path.join(output, 'native.log'), 'wx');
  native = spawn(executable, ['-portable', elf], { cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root }, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); }, 180000);
  inspector = new DebugServerClient('127.0.0.1', port);
  for (let i = 0; ; i++) {
    assert.equal(native.exitCode, null);
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (e) { inspector.disconnect(); if (i >= 199) throw e; await delay(100); }
  }
  for (let i = 0; !(Number((await inspector.getCapabilities()).elf_crc)); i++) { assert.ok(i < 200); await delay(100); }
  await inspector.pause(); const ready = hex(symbol(eeElf, 'instruction_ready'));
  await inspector.setBreakpoint(ready); await inspector.loadElf(elf); await resumeTo('ee', ready); await inspector.removeBreakpoint(ready);
  assert.equal((await inspector.getCapabilities()).process_id, native.pid);
  const metaAddress = hex(symbol(eeElf, 'instruction_meta'));
  const meta = words(Buffer.from(await inspector.readMemoryStrict(metaAddress, 64), 'hex'));
  assert.equal(meta[0], 0x53544545); assert.equal(meta[3], 1); assert.ok((meta[1] | 0) >= 0 && meta[2] > 0 && meta[2] <= 0x1fff00);
  const module = words(Buffer.from(await inspector.readMemoryStrict(hex(meta[2]), 64, 'iop'), 'hex')); assert.equal(module[0], 0x5354494f);
  const base = module[1] - symbol(irx, 'fixture_normal');
  for (const [name, at] of [['fixture_normal', 1], ['fixture_hang_call', 5], ['fixture_spin', 6], ['fixture_quiet', 7], ['fixture_quiet_ready', 8], ['fixture_status', 9]]) {
    assert.equal(module[at], base + symbol(irx, name));
    if (name === 'fixture_normal') assert.equal(await inspector.readMemoryStrict(hex(module[at]), 8, 'iop'), elfBytes(irx, symbol(irx, name), 8).toString('hex'));
  }
  await inspector.setPC(hex(symbol(eeElf, 'fixture_spin')));
  await inspector.setPC(hex(module[7]), 'iop'); await inspector.setBreakpoint(hex(module[8]), { cpu: 'iop' });
  await resumeTo('iop', hex(module[8])); await inspector.removeBreakpoint(hex(module[8]), 'iop');
  const quiet = words(Buffer.from(await inspector.readMemoryStrict(hex(module[9]), 8, 'iop'), 'hex'));
  assert.equal(quiet[1], (quiet[0] & 0xfffffffe) >>> 0); report.iop_irq_isolation = quiet;
  passed('resident IOP relocation/bytes and actual IRQ-isolating fixture agree with the retained artifacts');
  mcp = new Client({ name: 'conditional-points', version: '1.0' });
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' });
  transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
  assert.ok(!(await rawTool('pcsx2_connect', { mode: 'debug', debug_port: port })).isError);
  if (!oldBug) {
    const advertised = (await mcp.listTools()).tools;
    const names = ['set_breakpoint', 'remove_breakpoint', 'list_breakpoints', 'set_watchpoint', 'remove_watchpoint', 'list_watchpoints'];
    for (const name of names) {
      const entry = advertised.filter(t => t.name === 'pcsx2_' + name); assert.equal(entry.length, 1);
      assert.deepEqual(entry[0].inputSchema.properties.cpu.enum, ['ee', 'iop']); assert.equal(entry[0].inputSchema.properties.cpu.default, 'ee');
    }
    report.advertised_point_tools = names;
    passed('actual MCP discovery advertises six unique CPU-selectable schemas with EE defaults');
  }

  if (legacy) {
    assert.ok(!(await inspector.getCapabilities()).features.includes('atomic_point_conditions'));
    for (const cpu of ['ee', 'iop']) {
      const address = cpu === 'ee' ? hex(symbol(eeElf, 'fixture_normal') + 4) : hex(module[1] + 4);
      const watch = cpu === 'ee' ? hex(symbol(eeElf, 'instruction_meta') + 60) : hex(meta[2] + 128), end = hex(Number(watch) + 4);
      const before = await snapshot();
      for (const [name, args] of [['pcsx2_set_breakpoint', { cpu, address }], ['pcsx2_set_watchpoint', { cpu, address: watch, end }]]) {
        const response = await rawTool(name, { ...args, condition: '(' });
        assert.equal(response.isError, true); assert.match(JSON.stringify(response.content), /atomic_point_conditions/);
      }
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await inspector.listBreakpoints(cpu), []); assert.deepEqual(await inspector.listMemchecks(cpu), []);
      assert.ok(!(await rawTool('pcsx2_set_breakpoint', { cpu, address })).isError);
      assert.ok(!(await rawTool('pcsx2_list_breakpoints', { cpu })).isError);
      assert.equal((await inspector.listBreakpoints(cpu)).length, 1); await rawTool('pcsx2_remove_breakpoint', { cpu, address });
      assert.ok(!(await rawTool('pcsx2_set_watchpoint', { cpu, address: watch, end })).isError);
      assert.ok(!(await rawTool('pcsx2_list_watchpoints', { cpu })).isError);
      assert.equal((await inspector.listMemchecks(cpu)).length, 1); await rawTool('pcsx2_remove_watchpoint', { cpu, address: watch, end });
      passed(cpu + ': original native capability blocks conditional mutations while unconditional MCP point tools remain available');
    }
  } else for (const cpu of ['ee', 'iop']) {
    const address = cpu === 'ee' ? hex(symbol(eeElf, 'fixture_normal') + 4) : hex(module[1] + 4);
    const watch = cpu === 'ee' ? hex(symbol(eeElf, 'instruction_meta') + 60) : hex(meta[2] + 128), end = hex(Number(watch) + 4);
    assert.deepEqual(await inspector.listBreakpoints(cpu), []); assert.deepEqual(await inspector.listMemchecks(cpu), []);
    for (const kind of ['breakpoint', 'memcheck']) for (const existing of [false, true]) {
      const list = () => kind === 'breakpoint' ? inspector.listBreakpoints(cpu) : inspector.listMemchecks(cpu);
      if (existing) {
        if (kind === 'breakpoint') await inspector.setBreakpoint(address, { cpu, condition: '1 == 0', description: 'API-OWNED' });
        else await inspector.setMemcheck(watch, end, { cpu, condition: '1 == 0', description: 'API-OWNED' });
      }
      const before = await list(), paused = await snapshot();
      const reply = await inspector.send({ cmd: 'set_' + kind, cpu, address: kind === 'breakpoint' ? address : watch,
        end, type: 'read', action: 'both', condition: '(', description: 'INVALID-SHOULD-NOT-APPLY' });
      const after = await list(); report.observations.push({ cpu, kind, existing, reply, before, after });
      assert.deepEqual(await snapshot(), paused);
      if (oldBug) { assert.equal(reply.ok, true); assert.notDeepEqual(after, before); }
      else { assert.equal(reply.ok, false); assert.match(reply.error, /condition/i); assert.deepEqual(after, before); }
      if (kind === 'breakpoint') { if ((await list()).length) await inspector.removeBreakpoint(address, cpu); }
      else if ((await list()).length) await inspector.removeMemcheck(watch, end, cpu);
    }
    passed(cpu + ': ' + (oldBug ? 'reproduced false success and mutation' : 'invalid conditions reject atomically') + ' for new/existing execution and memory points');
    if (!oldBug) {
      const beforeBound = await snapshot();
      for (const condition of [false, 1]) for (const kind of ['breakpoint', 'memcheck']) {
        const response = await inspector.send({ cmd: 'set_' + kind, cpu, address: kind === 'breakpoint' ? address : watch, end, condition });
        assert.equal(response.ok, false); assert.match(response.error, /condition must be a string/i);
      }
      const limits = ['1' + ' '.repeat(4096), '1' + ' '.repeat(2050) + 'é'.repeat(1023)];
      for (const expression of limits) {
        assert.ok(Buffer.byteLength(expression) > 4096);
        for (const kind of ['breakpoint', 'memcheck']) {
          const response = await inspector.send({ cmd: 'set_' + kind, cpu, address: kind === 'breakpoint' ? address : watch, end,
            condition: expression, description: 'OVER-LIMIT' });
          assert.equal(response.ok, false); assert.match(response.error, /4096/);
        }
      }
      assert.deepEqual(await snapshot(), beforeBound); assert.deepEqual(await inspector.listBreakpoints(cpu), []); assert.deepEqual(await inspector.listMemchecks(cpu), []);
      await inspector.setBreakpoint(address, { cpu, condition: '1' + ' '.repeat(4095), description: 'exact condition bound' });
      assert.equal((await inspector.listBreakpoints(cpu))[0].condition.length, 4096); await inspector.removeBreakpoint(address, cpu);
      passed(cpu + ': native condition types/4096-byte bounds reject invalid values and accept the exact maximum without unintended mutation');
      // Route all six public MCP tools to this CPU, keeping the other list empty.
      const text = r => r.content.map(c => c.text ?? '').join('\n');
      assert.ok(!(await rawTool('pcsx2_set_breakpoint', { cpu, address, condition: '1 == 0', description: 'MCP-' + cpu })).isError);
      assert.ok((await inspector.listBreakpoints(cpu)).some(p => p.address === address && p.has_condition && p.condition === '1 == 0'));
      assert.match(text(await rawTool('pcsx2_list_breakpoints', { cpu })), new RegExp(address));
      const unchanged = await inspector.listBreakpoints(cpu);
      assert.equal((await rawTool('pcsx2_set_breakpoint', { cpu, address, condition: '(', description: 'MCP-INVALID' })).isError, true);
      assert.deepEqual(await inspector.listBreakpoints(cpu), unchanged);
      assert.ok(!(await rawTool('pcsx2_remove_breakpoint', { cpu, address })).isError); assert.deepEqual(await inspector.listBreakpoints(cpu), []);
      assert.ok(!(await rawTool('pcsx2_set_watchpoint', { cpu, address: watch, end, condition: '1 == 0', action: 'both', description: 'MCP-' + cpu })).isError);
      const listing = text(await rawTool('pcsx2_list_watchpoints', { cpu }));
      assert.match(listing, new RegExp(watch)); assert.match(listing, /cond: 1 == 0/); assert.match(listing, /log:/);
      const saved = await inspector.listMemchecks(cpu);
      assert.equal(saved[0].has_condition, true); assert.equal(saved[0].condition, '1 == 0'); assert.equal(saved[0].memory_condition, 2);
      assert.equal(saved[0].instrumentation_enabled, true); assert.equal(saved[0].continue_on_hit, false); assert.equal(saved[0].max_hits, 0);
      assert.equal((await rawTool('pcsx2_set_watchpoint', { cpu, address: watch, end, condition: '(' })).isError, true);
      assert.deepEqual(await inspector.listMemchecks(cpu), saved);
      assert.ok(!(await rawTool('pcsx2_remove_watchpoint', { cpu, address: watch, end })).isError); assert.deepEqual(await inspector.listMemchecks(cpu), []);
      passed(cpu + ': all six MCP point tools select the requested CPU and expose native condition errors without mutation');
      const spin = cpu === 'ee' ? hex(symbol(eeElf, 'fixture_spin')) : hex(module[6]);
      await inspector.setPC(spin, cpu); await inspector.setBreakpoint(spin, { cpu, condition: '0', description: 'false condition control' });
      const beforeRun = await inspector.getStatus(); await inspector.resume(cpu); await delay(75);
      const running = await inspector.getStatus(); assert.equal(running.paused, false); assert.ok(running.cycles > beforeRun.cycles);
      await inspector.pause(cpu); assert.equal((await inspector.listBreakpoints(cpu))[0].has_condition, true);
      await inspector.removeBreakpoint(spin, cpu);
      passed(cpu + ': a valid false condition leaves the actual spin running beyond the initial breakpoint skip');
      const start = cpu === 'ee' ? hex(symbol(eeElf, 'fixture_normal')) : hex(module[1]);
      await inspector.setPC(start, cpu);
      const value = Number(BigInt('0x' + (await inspector.readRegisters(cpu, 0)).GPR.regs[8].value) & 0xffffffffn);
      await inspector.setBreakpoint(address, { cpu, condition: 't0 == ' + hex(value + 1), description: 'conditional execution proof' });
      await resumeTo(cpu, address);
      assert.equal(Number(BigInt('0x' + (await inspector.readRegisters(cpu, 0)).GPR.regs[8].value) & 0xffffffffn), (value + 1) >>> 0);
      await inspector.removeBreakpoint(address, cpu);
      passed(cpu + ': a valid native condition stops actual guest execution at the expected PC/register value');
    }
  }
  if (!oldBug && !legacy) {
    const group = randomUUID().replaceAll('-', ''), address = hex(symbol(eeElf, 'fixture_normal'));
    const caps = await inspector.getCapabilities(); await inspector.installSourceBreakpoints(group, [address], caps);
    const before = await inspector.listBreakpoints('ee'), paused = await snapshot();
    assert.equal((await rawTool('pcsx2_set_breakpoint', { address, condition: '(', description: 'INVALID-REPLACEMENT' })).isError, true);
    assert.deepEqual(await inspector.listBreakpoints('ee'), before); assert.deepEqual(await snapshot(), paused);
    const removed = await inspector.removeSourceBreakpoints(group); assert.equal(removed.complete, true);
    passed('invalid MCP condition cannot relinquish a source group; its original owner still removes it completely');
  }
  assert.deepEqual(await inspector.listBreakpoints('ee'), []); assert.deepEqual(await inspector.listBreakpoints('iop'), []);
  assert.deepEqual(await inspector.listMemchecks('ee'), []); assert.deepEqual(await inspector.listMemchecks('iop'), []);
  assert.equal(sha(await fs.readFile(executable)), report.native_sha256); assert.equal(sha(await fs.readFile(iniPath)), report.config_sha256);
  report.passed = true;
} catch (e) { report.failure = String(e); report.stack = e.stack; process.exitCode = 1; }
finally {
  clearTimeout(watchdog); inspector?.disconnect();
  try { await mcp?.close(); report.mcp_stopped = !transport || transport.pid === null; } catch (e) { report.cleanup_error = String(e); report.passed = false; }
  if (native && native.exitCode === null && native.signalCode === null) {
    const done = new Promise(ok => native.once('exit', ok)); native.kill(); await Promise.race([done, delay(5000)]);
  }
  report.native_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  if (!report.native_stopped || !report.mcp_stopped) report.passed = false;
  await log?.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) { process.exitCode = 1; console.log('FAIL ' + report.failure); }
}
