// node test/irx-live.mjs <PCSX2> <built IOP fixture> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { inspectSourceElf, SourceResolver } from '../dist/source-debug.js';
import { inspectIrx } from '../dist/irx.js';
import { inspectRuntimeIrx } from '../dist/irx-tools.js';

assert.equal(process.argv.length, 6);
const [executable, fixture, configured, output] = process.argv.slice(2).map(v => path.resolve(v));
await fs.mkdir(output); const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
let ini = (await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'), 'utf8')).replace(/^HostFs\s*=.*\r?\n/gm, '');
ini = /^\[EmuCore\]\r?\n/m.test(ini) ? ini.replace(/^\[EmuCore\]\r?\n/m, '[EmuCore]\nHostFs = true\n') : ini + '\n[EmuCore]\nHostFs = true\n';
await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
const reservation = createServer(); await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'irx-live', version: '1.0' }), inspector = new DebugServerClient('127.0.0.1', port);
let owned = false;
const result = { started_at: new Date().toISOString(), fixture, checks: [], evidence: [] };
const passed = name => { result.checks.push(name); console.log('PASS ' + name); };
const hex = n => '0x' + n.toString(16).padStart(8, '0');
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!response.isError, name + ': ' + JSON.stringify(response.content)); return JSON.parse(response.content[0].text);
}
const rejected = async (name, args) => assert.equal((await mcp.callTool({ name, arguments: args })).isError, true);
function symbol(b, name) {
  const sh = b.readUInt32LE(32), stride = b.readUInt16LE(46), count = b.readUInt16LE(48);
  for (let i = 0; i < count; i++) {
    const at = sh + i * stride; if (b.readUInt32LE(at + 4) !== 2) continue;
    const str = b.readUInt32LE(sh + b.readUInt32LE(at + 24) * stride + 16);
    const off = b.readUInt32LE(at + 16), end = off + b.readUInt32LE(at + 20), step = b.readUInt32LE(at + 36); assert.ok(step >= 16);
    for (let p = off; p < end; p += step) {
      const n = str + b.readUInt32LE(p);
      if (b.subarray(n, b.indexOf(0, n)).toString() === name) return b.readUInt32LE(p + 4);
    }
  }
  throw new Error('Missing symbol ' + name);
}
const elf = path.join(fixture, 'normal.elf'), irx = path.join(fixture, 'iop-exceptions.debug.irx'), load = path.join(fixture, 'iop-exceptions.irx');
async function boot() {
  const identity = await inspectSourceElf(elf), source = await fs.readFile(path.join(fixture, 'ee-iop-exceptions.c'), 'utf8');
  const line = source.split(/\r?\n/).findIndex(s => s.includes('/* READY:')) + 1;
  const group = await call('pcsx2_breakpoint_source', { elf, file: 'ee-iop-exceptions.c', line, expected_sha256: identity.sha256 });
  let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.loadElf(elf); await inspector.resume();
  assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 20000 })).timed_out, false);
  await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id });
  const bytes = await fs.readFile(elf);
  assert.ok(Buffer.from(await inspector.readMemory(hex(symbol(bytes, 'fixture_result')), 4), 'hex').readInt32LE() >= 0, 'IRX loader failed');
  const table = await call('pcsx2_iop_modules'), matches = table.modules.filter(m => m.name === 'mcp_exception_fixture'); assert.equal(matches.length, 1);
  return { table, module: matches[0] };
}
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  result.launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true; await inspector.connect();
  for (let n = 0; !(await inspector.getCapabilities()).elf; n++) { assert.ok(n < 100); await delay(100); }
  await inspector.pause(); let loaded = await boot();
  const caps = await inspector.getCapabilities(), expected = { ...caps, revision: loaded.table.revision };
  await assert.rejects(inspector.iopModuleImage({ ...expected, revision: expected.revision + 1 }, loaded.module.record_address), /revision/);
  await assert.rejects(inspector.iopModuleImage({ ...expected, iop_reset_epoch: expected.iop_reset_epoch + 1 }, loaded.module.record_address), /identity/);
  await assert.rejects(inspector.iopModuleImage(expected, '0x10000000'), /revision|record/);
  passed('native image checks paused revision, IOP reset identity and canonical selected record before reading');
  const debug = await inspectIrx(irx), stripped = await inspectIrx(load);
  assert.deepEqual(debug.image, stripped.image); assert.equal(stripped.debugRelocationCount, 0); assert.ok(debug.debugRelocationCount > 0);
  const args = { irx, module_record: loaded.module.record_address, expected_sha256: debug.sha256 };
  const before = await inspector.getStatus();
  const verified = await call('pcsx2_iop_verify_irx', args); result.evidence.push(verified);
  assert.equal(verified.evidence.status, 'matched_relocated_readonly_image'); assert.equal(verified.evidence.relocation_count, 27);
  assert.ok(verified.evidence.compared_bytes >= 400); assert.equal(verified.evidence.import_targets_verified, false);
  assert.equal(verified.evidence.module_generation, null); assert.equal(verified.evidence.original_loaded_file_sha256, null);
  const loadProof = await call('pcsx2_iop_verify_irx', { ...args, irx: load, expected_sha256: stripped.sha256 });
  assert.equal(loadProof.evidence.normalized_readonly_sha256, verified.evidence.normalized_readonly_sha256);
  assert.deepEqual(await inspector.getStatus(), before);
  passed('loadable and DWARF IRX companions match the real relocated immutable image, with 27 relocations and explicit unverified data/import targets');
  const breakAddress = hex(Number(loaded.module.text_address) + symbol(debug.bytes, 'fixture_iop_break'));
  const source = await call('pcsx2_iop_source', { ...args, addresses: [breakAddress, loaded.module.entry] }); result.evidence.push(source);
  const rows = (await fs.readFile(path.join(fixture, 'iop-exceptions.c'), 'utf8')).split(/\r?\n/);
  const label = rows.findIndex(l => l.includes('.globl fixture_iop_break'));
  let asmLine = label; while (!rows[asmLine].includes('__asm__ volatile')) asmLine--;
  assert.equal(source.locations[0].frames[0].function, 'worker'); assert.equal(source.locations[0].frames[0].line, asmLine + 1);
  assert.ok(source.locations[0].frames[0].file.endsWith('/iop-exceptions.c')); assert.equal(source.locations[0].resolved, true);
  assert.equal(source.locations[1].frames[0].function, '_start'); assert.equal(source.runtime.elf_role, 'ee_boot_affinity_only');
  passed('real GNU addr2line resolves relocated IOP BREAK and entry through matching IRX DWARF2 to exact fixture function/file/line');
  const absent = await call('pcsx2_iop_source', { ...args, irx: load, expected_sha256: stripped.sha256, addresses: [breakAddress] });
  assert.equal(absent.locations[0].reason, 'no_debug_line_section'); assert.equal(absent.locations[0].resolved, false);
  const excluded = await call('pcsx2_iop_source', { ...args, addresses: [loaded.module.text_address,
    hex(Number(loaded.module.text_address) + loaded.module.text_size), '0x80045030'] });
  assert.ok(excluded.locations.every(l => !l.resolved));
  passed('stripped artifact, import table, readonly data and aliased addresses never invent IOP source locations');
  await rejected('pcsx2_iop_verify_irx', { ...args, expected_sha256: '0'.repeat(64) });
  const mismatch = path.join(output, 'wrong-code.irx'), wrong = Buffer.from(debug.bytes);
  const ph = wrong.readUInt32LE(28), offset = wrong.readUInt32LE(ph + 36); wrong[offset + debug.entry] ^= 1;
  await fs.writeFile(mismatch, wrong, { flag: 'wx' }); await rejected('pcsx2_iop_source', { ...args, irx: mismatch, expected_sha256: undefined, addresses: [breakAddress] });
  const unsupported = path.join(output, 'unsupported.irx'), newer = Buffer.from(debug.bytes); newer.writeUInt16LE(0xff81, 16);
  await fs.writeFile(unsupported, newer, { flag: 'wx' }); await rejected('pcsx2_iop_verify_irx', { ...args, irx: unsupported, expected_sha256: undefined });
  passed('wrong file hash, same-name/version altered code and unsupported IRX dialect refuse without a source mapping');
  const saved = await inspector.readMemory(breakAddress, 4, 'iop');
  try { await inspector.writeMemory(breakAddress, '00000000', 'iop'); await rejected('pcsx2_iop_verify_irx', args); }
  finally { await inspector.writeMemory(breakAddress, saved, 'iop'); }
  await call('pcsx2_iop_verify_irx', args); assert.equal((await inspector.getStatus()).paused, true);
  passed('changed guest instruction refuses verification; restoring test bytes permits a fresh guarded association');
  const mutableFile = path.join(output, 'mutable.irx'); await fs.copyFile(irx, mutableFile);
  class FileChange extends SourceResolver {
    async resolveIrx(...params) { const r = await super.resolveIrx(...params); await fs.appendFile(mutableFile, Buffer.from([0])); return r; }
  }
  await assert.rejects(inspectRuntimeIrx(inspector, { ...args, irx: mutableFile, addresses: [breakAddress] }, true, undefined, new FileChange()), /changed/);
  passed('file mutation after a real source worker invalidates its result before return');
  await inspector.setBreakpoint('0x001f0000', { description: 'foreign IRX lookup sentinel' });
  await inspector.setBreakpoint(breakAddress, { cpu: 'iop', description: 'real IOP source stop' });
  const bps = [await inspector.listBreakpoints(), await inspector.listBreakpoints('iop')];
  let events = await inspector.readEvents(0, 200); while (events.events.length === 200) events = await inspector.readEvents(events.next_cursor, 200);
  await inspector.resume(); assert.equal((await inspector.waitEvent({ after: events.next_cursor, type: 'breakpoint', timeoutMs: 10000 })).timed_out, false);
  const atPc = await call('pcsx2_iop_source', args); result.evidence.push(atPc);
  assert.equal(atPc.locations[0].runtime_address, breakAddress); assert.equal(atPc.locations[0].resolved, true);
  assert.deepEqual([await inspector.listBreakpoints(), await inspector.listBreakpoints('iop')], bps);
  passed('default IOP PC lookup resolves a genuine IOP instruction breakpoint and preserves foreign breakpoint ownership');
  class PauseChange extends SourceResolver {
    async resolveIrx(...params) { const r = await super.resolveIrx(...params); await inspector.resume(); await inspector.pause(); return r; }
  }
  await assert.rejects(inspectRuntimeIrx(inspector, { ...args, addresses: [breakAddress] }, true, undefined, new PauseChange()), /revision/);
  passed('resume/pause during an actual source lookup invalidates the paused revision and discards its mapping');
  await inspector.removeBreakpoint('0x001f0000'); await inspector.removeBreakpoint(breakAddress, 'iop');
  const oldCaps = await inspector.getCapabilities(), oldTable = await inspector.iopModuleSnapshot(oldCaps);
  await inspector.loadElf(elf); await assert.rejects(inspector.iopModuleImage({ ...oldCaps, revision: oldTable.revision }, args.module_record), /identity|revision/);
  await rejected('pcsx2_iop_verify_irx', args);
  passed('VM reset rejects old native identity and a fresh lookup cannot reuse a cached binding before loadcore is observed');
  result.passed = true;
} catch (error) { result.passed = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally {
  inspector.disconnect(); if (owned) await call('pcsx2_stop').catch(e => { result.cleanup_error = String(e); result.passed = false; process.exitCode = 1; });
  await mcp.close(); await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + path.join(output, 'validation.json')); if (result.error) console.error(result.error);
}
